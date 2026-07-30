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
        }

        [TearDown]
        public void TearDown()
        {
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
    }
}
