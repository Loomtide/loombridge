using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for ReplayHandler (replay.settle_and_capture).
    ///
    /// The settle's happy path needs a running player loop, which EditMode tests cannot
    /// drive cleanly (same limitation EditorHandlerTests records for editor.tick): the
    /// in-loop capture, the frame accounting, and the wall-deadline error are validated by
    /// the live replay. What IS drivable headless, and pinned here, is every SYNCHRONOUS
    /// refusal: they all fire BEFORE the tick callback is registered, which is also what
    /// makes the pin-hygiene assertion below meaningful: a refused call must never leave
    /// Time.captureDeltaTime or Application.runInBackground touched.
    /// </summary>
    [TestFixture]
    public class ReplayHandlerTests
    {
        private ReplayHandler _handler;
        private float _restoreCaptureDeltaTime;
        private bool _restoreRunInBackground;

        [SetUp]
        public void SetUp()
        {
            _handler = new ReplayHandler();
            _restoreCaptureDeltaTime = Time.captureDeltaTime;
            _restoreRunInBackground = Application.runInBackground;
            // SessionState is editor-session state shared with every other test in the run:
            // start each case from "no settle owns the pin" so one leaked marker cannot make
            // the next test pass (or fail) for a reason it never set up.
            ReplayCapturePin.Release();
        }

        [TearDown]
        public void TearDown()
        {
            ReplayCapturePin.Release();
            Time.captureDeltaTime = _restoreCaptureDeltaTime;
            Application.runInBackground = _restoreRunInBackground;
        }

        // Runs the async op and returns whichever of {result, error} fired synchronously.
        private (JObject result, BridgeException error) RunSync(JObject parameters)
        {
            JObject captured = null;
            BridgeException capturedError = null;
            _handler.HandleOpAsync("settle_and_capture", parameters,
                r => captured = r,
                e => capturedError = e);
            return (captured, capturedError);
        }

        [Test]
        public void SettleAndCapture_IsAsync()
        {
            Assert.IsTrue(_handler.IsAsync("settle_and_capture"),
                "replay.settle_and_capture spans editor ticks and must be async");
        }

        [Test]
        public void UnknownOp_Sync_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("nope", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void UnknownOp_Async_ReportsNotFound()
        {
            BridgeException capturedError = null;
            _handler.HandleOpAsync("nope", new JObject(), r => { }, e => capturedError = e);
            Assert.IsNotNull(capturedError);
            Assert.AreEqual(ErrorCodes.NOT_FOUND, capturedError.Code);
        }

        [Test]
        public void MissingSettleFrames_ThrowsInvalidParams()
        {
            var (result, error) = RunSync(new JObject());
            Assert.IsNull(result);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("settleFrames", error.Message);
        }

        [Test]
        public void NonPositiveSettleFrames_ThrowsInvalidParams()
        {
            var (_, error) = RunSync(new JObject { ["settleFrames"] = 0 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void SettleFramesAboveCap_ThrowsInvalidParams()
        {
            var (_, error) = RunSync(new JObject { ["settleFrames"] = 100001 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("cap", error.Message);
        }

        // captureFps 0 means "do not pin" for editor.tick. Here it must REFUSE: an unpinned
        // settle is the nondeterminism the op exists to remove, so accepting it would return
        // an unaligned frame under an aligned name.
        [Test]
        public void CaptureFpsZero_ThrowsInvalidParams()
        {
            var (_, error) = RunSync(new JObject { ["settleFrames"] = 10, ["captureFps"] = 0 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("captureFps", error.Message);
        }

        [Test]
        public void CaptureFpsAboveCap_ThrowsInvalidParams()
        {
            var (_, error) = RunSync(new JObject { ["settleFrames"] = 10, ["captureFps"] = 1001 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void UnknownFormat_ThrowsInvalidParams()
        {
            var (_, error) = RunSync(new JObject { ["settleFrames"] = 10, ["format"] = "webp" });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("format", error.Message);
        }

        [Test]
        public void ValidParamsButNotPlaying_ThrowsPlayModeRequired()
        {
            Assert.IsFalse(Application.isPlaying, "this EditMode test must run outside Play Mode");
            var (result, error) = RunSync(new JObject { ["settleFrames"] = 10 });
            Assert.IsNull(result);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.PLAY_MODE_REQUIRED, error.Code);
        }

        // PIN HYGIENE ON THE REFUSAL PATHS. Time.captureDeltaTime is a NATIVE global that
        // nothing resets for us; a refusal that pinned it first would leave the editor
        // rendering as fast as it can, forever. Every validation refusal must happen before
        // the pin.
        [Test]
        public void Refusals_DoNotTouchCaptureDeltaTimeOrRunInBackground()
        {
            Time.captureDeltaTime = 0f;
            Application.runInBackground = false;

            RunSync(new JObject());
            RunSync(new JObject { ["settleFrames"] = 0 });
            RunSync(new JObject { ["settleFrames"] = 10, ["captureFps"] = 0 });
            RunSync(new JObject { ["settleFrames"] = 10, ["format"] = "webp" });
            RunSync(new JObject { ["settleFrames"] = 10 }); // PLAY_MODE_REQUIRED

            Assert.AreEqual(0f, Time.captureDeltaTime,
                "a refused settle must leave Time.captureDeltaTime unpinned");
            Assert.IsFalse(Application.runInBackground,
                "a refused settle must leave Application.runInBackground as it found it");
        }

        // A refusal must not claim ownership either: the marker is what entitles the bootstrap
        // (and the next settle) to write global Time state on this op's behalf, so a call that
        // never pinned anything must leave nothing to recover.
        [Test]
        public void Refusals_DoNotClaimThePin()
        {
            RunSync(new JObject());
            RunSync(new JObject { ["settleFrames"] = 10, ["captureFps"] = 0 });
            RunSync(new JObject { ["settleFrames"] = 10 }); // PLAY_MODE_REQUIRED
            Assert.IsFalse(ReplayCapturePin.IsOwned,
                "a settle that never pinned must not leave an ownership marker behind");
        }

        // ───────────────── BX7: pin ownership against a never-ticking editor ─────────────────
        //
        // These drive ReplayCapturePin directly rather than through the op, and that IS the
        // seam: the leak they defend against happens when the editor stops ticking, so the tick
        // callback that would restore never runs and no EditMode test can produce the state by
        // driving the op (the same constraint EditorHandlerTests records for editor.tick's
        // in-loop behaviour). The pure state machine is drivable headless, so it is pinned here
        // and the op's use of it is one call at the top of the settle.

        [Test]
        public void Pin_RememberThenRestore_RoundTripsTheOriginals()
        {
            Time.captureDeltaTime = 0f;
            Application.runInBackground = false;

            ReplayCapturePin.Pinned original = ReplayCapturePin.Remember();
            Assert.AreEqual(0f, original.CaptureDeltaTime);
            Assert.IsFalse(original.RunInBackground);
            Assert.IsTrue(ReplayCapturePin.IsOwned, "Remember claims ownership");

            // The settle pins.
            Time.captureDeltaTime = 1f / 60f;
            Application.runInBackground = true;

            // Its cleanup restores from the values Remember handed back, then releases.
            Time.captureDeltaTime = original.CaptureDeltaTime;
            Application.runInBackground = original.RunInBackground;
            ReplayCapturePin.Release();

            Assert.AreEqual(0f, Time.captureDeltaTime);
            Assert.IsFalse(Application.runInBackground);
            Assert.IsFalse(ReplayCapturePin.IsOwned, "Release drops the marker");
        }

        // THE POLLUTED-CLOCK-BECOMES-ORIGINAL BUG. A previous settle pinned 1/60 and never
        // reached its cleanup. Reading the LIVE value here would record 1/60 as "the original"
        // and write it back forever; Remember instead restores the leaked pin first and returns
        // the true pre-pin value.
        [Test]
        public void Pin_LeakedPin_IsRestoredFirstAndNeverBecomesTheOriginal()
        {
            Time.captureDeltaTime = 0f;
            Application.runInBackground = false;
            ReplayCapturePin.Remember();          // settle #1 claims the pin
            Time.captureDeltaTime = 1f / 60f;     // ... pins ...
            Application.runInBackground = true;
            // ... and the editor stops ticking: no cleanup, marker still set.

            ReplayCapturePin.Pinned original = ReplayCapturePin.Remember(); // settle #2

            Assert.AreEqual(0f, original.CaptureDeltaTime,
                "the true pre-pin value, not the leaked 1/60");
            Assert.IsFalse(original.RunInBackground);
            Assert.AreEqual(0f, Time.captureDeltaTime,
                "the leaked pin is restored BEFORE the next settle pins over it");
            Assert.IsFalse(Application.runInBackground);
            Assert.IsTrue(ReplayCapturePin.IsOwned, "settle #2 now owns the pin");
        }

        [Test]
        public void Pin_RestoreLeakedPin_RecoversOnceAndThenReportsNothingToDo()
        {
            Time.captureDeltaTime = 0f;
            Application.runInBackground = false;
            ReplayCapturePin.Remember();
            Time.captureDeltaTime = 1f / 120f;
            Application.runInBackground = true;

            Assert.IsTrue(ReplayCapturePin.RestoreLeakedPin(),
                "a leaked pin is reported so the bootstrap logs exactly one line");
            Assert.AreEqual(0f, Time.captureDeltaTime);
            Assert.IsFalse(Application.runInBackground);
            Assert.IsFalse(ReplayCapturePin.IsOwned);

            Assert.IsFalse(ReplayCapturePin.RestoreLeakedPin(),
                "a clean boot restores nothing and announces nothing");
        }
    }
}
