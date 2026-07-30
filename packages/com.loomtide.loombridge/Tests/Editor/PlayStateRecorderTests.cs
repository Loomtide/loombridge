using System;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the play-mode state recorder (evidence arc stage 3).
    ///
    /// Two halves, split the way the ReplayHandler tests split:
    ///
    ///   THE PUMP is driven DIRECTLY through reflection (it lives in the runtime
    ///   observe assembly this test asmdef does not reference, same as
    ///   InputObserverPathTests). Its ring, its wrap accounting, its unreadable-field
    ///   honesty and its idempotent start are all pure state machine, so they run
    ///   headless with no player loop: <c>SampleNow</c> is public precisely so a test
    ///   can advance the ring a sample at a time.
    ///
    ///   THE HANDLER's synchronous refusals are pinned here too. Every one of them
    ///   fires BEFORE a recording window is opened, which is the property that
    ///   matters: a seam that does not resolve must cost the operator nothing, and
    ///   must never leave a half-configured recorder behind.
    ///
    /// The happy path (a real drive sampling a real Update loop) needs Play Mode and
    /// is covered by the TS unit suite against a scripted bridge plus the live run.
    /// </summary>
    [TestFixture]
    public class PlayStateRecorderTests
    {
        private Type _pump;
        private GameObject _player;
        private GameObject _state;
        private ObserveHandler _handler;

        /// <summary>A stand-in GameManager: the exact member shapes the recorder reads.</summary>
        private sealed class FakeGameManager : MonoBehaviour
        {
            public bool isWin;
            public int score;
            public int lives = 3;
            public string notABool = "nope";
        }

        [SetUp]
        public void SetUp()
        {
            _pump = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("UnityBridge.Runtime.PlayStateRecorderPump"))
                .FirstOrDefault(t => t != null);
            Assert.NotNull(_pump, "PlayStateRecorderPump type not found (observe runtime assembly not loaded).");
            _handler = new ObserveHandler();

            _player = new GameObject("Player");
            _player.transform.position = new Vector3(1f, 2f, 3f);
            _state = new GameObject("GameManager");
            _state.AddComponent<FakeGameManager>();

            EndRecording();
        }

        [TearDown]
        public void TearDown()
        {
            EndRecording();
            if (_player != null)
                UnityEngine.Object.DestroyImmediate(_player);
            if (_state != null)
                UnityEngine.Object.DestroyImmediate(_state);
        }

        // ── reflection helpers ───────────────────────────────────────────────

        private object Invoke(string name, params object[] args)
        {
            MethodInfo method = _pump.GetMethod(name, BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(method, $"PlayStateRecorderPump.{name} not found");
            return method.Invoke(null, args);
        }

        private bool BeginRecording(int capacity = 0, string winField = "isWin",
            string scoreField = "score", string livesField = "lives")
        {
            return (bool)Invoke("BeginRecording", "session-1", "/Player", "/GameManager", "FakeGameManager",
                winField, scoreField, livesField, capacity);
        }

        private void EndRecording()
        {
            Invoke("EndRecording");
        }

        private void SampleNow()
        {
            Invoke("SampleNow");
        }

        private int SampleCount()
        {
            return (int)Invoke("GetSampleCount");
        }

        private long Dropped()
        {
            return (long)Invoke("GetDroppedSamples");
        }

        private float[] X()
        {
            return (float[])Invoke("GetX");
        }

        private int[] Win()
        {
            return (int[])Invoke("GetWin");
        }

        private double[] Score()
        {
            return (double[])Invoke("GetScore");
        }

        private string[] Unreadable()
        {
            return (string[])Invoke("GetUnreadableFields");
        }

        private FakeGameManager Manager()
        {
            return _state.GetComponent<FakeGameManager>();
        }

        // ── the pump ─────────────────────────────────────────────────────────

        [Test]
        public void BeginRecording_TakesTheOpeningSampleSynchronously()
        {
            // The win-already-true refusal (H7) binds to the recorder's OWN read at
            // window open, so the opening sample cannot wait for the next Update.
            Assert.IsTrue(BeginRecording());
            Assert.AreEqual(1, SampleCount());
            Assert.AreEqual(0, Win()[0], "the fake starts unwon, and false must read as 0, not as unreadable");
            Assert.AreEqual(1f, X()[0], 1e-4f);
        }

        [Test]
        public void BeginRecording_IsIdempotent_WhileASessionIsLive()
        {
            Assert.IsTrue(BeginRecording());
            SampleNow();
            int before = SampleCount();
            // A retried start must NOT restart the ring: a window someone is mid-drive
            // through would be silently discarded.
            Assert.IsFalse(BeginRecording(), "starting an active recorder must report 'already recording'");
            Assert.AreEqual(before, SampleCount(), "the live window must be untouched");
            Assert.AreEqual("session-1", (string)Invoke("GetSessionId"));
        }

        [Test]
        public void Ring_RetainsTheLastNSamplesInChronologicalOrder()
        {
            Assert.IsTrue(BeginRecording(capacity: 4));
            // Opening sample is x=1; move the player one unit per sample.
            for (int i = 1; i <= 5; i++)
            {
                _player.transform.position = new Vector3(1f + i, 0f, 0f);
                SampleNow();
            }
            Assert.AreEqual(4, SampleCount(), "the ring holds exactly its capacity");
            float[] xs = X();
            // 6 samples taken (1 opening + 5), capacity 4, so the first two are gone and
            // what remains reads oldest-first from the wrap point.
            CollectionAssert.AreEqual(new[] { 3f, 4f, 5f, 6f }, xs);
        }

        [Test]
        public void Ring_CountsWhatItDropped_NeverHidesTheHole()
        {
            Assert.IsTrue(BeginRecording(capacity: 3));
            Assert.AreEqual(0, Dropped(), "an unwrapped ring drops nothing");
            for (int i = 0; i < 5; i++)
                SampleNow();
            Assert.AreEqual(6, (long)Invoke("GetTotalSampled"));
            Assert.AreEqual(3, SampleCount());
            // The derivation REFUSES a window with a hole in it, so the count has to be
            // reported rather than absorbed.
            Assert.AreEqual(3, Dropped());
        }

        [Test]
        public void Sampling_RecordsTheStateFieldsAsTheyChange()
        {
            Assert.IsTrue(BeginRecording());
            Manager().score = 1;
            SampleNow();
            Manager().isWin = true;
            SampleNow();

            int[] win = Win();
            double[] score = Score();
            Assert.AreEqual(new[] { 0, 0, 1 }, win);
            Assert.AreEqual(0d, score[0], 1e-9);
            Assert.AreEqual(1d, score[1], 1e-9);
        }

        [Test]
        public void Sampling_AnUnreadableFieldIsNullSentinel_NeverZero()
        {
            // A field that exists but is not a bool: the recorder must not coerce it.
            Assert.IsTrue(BeginRecording(winField: "notABool"));
            SampleNow();
            foreach (int value in Win())
                Assert.AreEqual(-1, value, "an unreadable bool must be the sentinel, never false");
            Assert.IsTrue(Unreadable().Any(f => f.StartsWith("notABool")),
                "the failing field must be named, so the refusal downstream can say which one");
        }

        [Test]
        public void Sampling_ADestroyedPlayerRecordsNaN_NotTheLastKnownPosition()
        {
            Assert.IsTrue(BeginRecording());
            UnityEngine.Object.DestroyImmediate(_player);
            _player = null;
            SampleNow();
            float[] xs = X();
            Assert.IsTrue(float.IsNaN(xs[xs.Length - 1]),
                "a repeated position would read as 'standing still'; an absent player must read as absent");
            Assert.IsTrue(Unreadable().Any(f => f.Contains("player.position")));
        }

        [Test]
        public void EndRecording_ReleasesTheSession()
        {
            Assert.IsTrue(BeginRecording());
            EndRecording();
            Assert.IsFalse((bool)Invoke("IsRecording"));
            Assert.AreEqual(0, SampleCount());
            Assert.IsNull((string)Invoke("GetSessionId"));
        }

        // ── the handler's synchronous refusals ───────────────────────────────

        [Test]
        public void Handler_OpsAreSynchronous()
        {
            Assert.IsFalse(_handler.IsAsync("start"));
            Assert.IsFalse(_handler.IsAsync("status"));
            Assert.IsFalse(_handler.IsAsync("drain"));
        }

        [Test]
        public void Handler_UnknownOpIsNotFound()
        {
            BridgeException error = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("drain_and_stop", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, error.Code);
        }

        [Test]
        public void Handler_StartRequiresPlayMode()
        {
            // EditMode: isPlaying is false, so this is the refusal under test.
            BridgeException error = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("start", StartParams()));
            Assert.AreEqual(ErrorCodes.PLAY_MODE_REQUIRED, error.Code);
            Assert.IsFalse((bool)Invoke("IsRecording"), "a refused start must leave no recorder behind");
        }

        [Test]
        public void Handler_StatusAndDrainAreSafeWithNoLiveRecorder()
        {
            JObject status = _handler.HandleOp("status", new JObject());
            Assert.IsFalse(status.Value<bool>("recording"));
            Assert.AreEqual(0, status.Value<int>("sampleCount"));

            JObject drain = _handler.HandleOp("drain", new JObject());
            // wasRecording:false is the signal the CLI refuses on: an empty buffer must
            // never read like a clean short window.
            Assert.IsFalse(drain.Value<bool>("wasRecording"));
            Assert.IsFalse(drain.Value<bool>("recording"));
        }

        private static JObject StartParams()
        {
            return new JObject
            {
                ["playerPath"] = "/Player",
                ["statePath"] = "/GameManager",
                ["stateComponent"] = "FakeGameManager",
                ["winField"] = "isWin",
                ["scoreField"] = "score",
                ["livesField"] = "lives",
            };
        }
    }
}
