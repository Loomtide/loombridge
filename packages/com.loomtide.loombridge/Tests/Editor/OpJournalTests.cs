using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the bridge op journal (evidence-trust wave, stage B1).
    ///
    /// The journal is a pure state machine over a ring, so every property that matters
    /// runs headless: sequence density across BOTH executor doors, the ops.batch child
    /// entries (the ledger's H5(a) hole), wrap accounting, instance identity, target
    /// binding, the params hash, and the swallow rule.
    ///
    /// Each test resets the journal first. A reset mints a NEW instance id on purpose,
    /// so a test that asserts identity stability asserts it WITHIN its own reset.
    /// </summary>
    [TestFixture]
    public class OpJournalTests
    {
        private OpExecutor _executor;
        private JObject _lastResponse;
        private JournalHandler _journal;
        private string _fixturePath;
        private GameObject _player;

        private static BridgeRequestContext Context(string command, JObject parameters = null)
        {
            return new BridgeRequestContext("req-1", command, parameters ?? new JObject(), "test-session");
        }

        private void Respond(JObject response)
        {
            _lastResponse = response;
        }

        [SetUp]
        public void SetUp()
        {
            _fixturePath = "Assets/OpJournalTests_Fixture.unity";
            Scene fixture = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(fixture, _fixturePath);

            _player = new GameObject("Player");
            _player.transform.position = Vector3.zero;

            _executor = new OpExecutor();
            _executor.RegisterCategory("scene", new SceneHandler());
            _executor.RegisterCategory("ops", new OpsHandler(_executor));
            _journal = new JournalHandler();
            _executor.RegisterCategory("journal", _journal);

            _lastResponse = null;
            OpJournal.ResetForTests();
        }

        [TearDown]
        public void TearDown()
        {
            OpJournal.ResetForTests();
            if (!string.IsNullOrEmpty(_fixturePath) && File.Exists(_fixturePath))
                AssetDatabase.DeleteAsset(_fixturePath);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        // ── helpers ──────────────────────────────────────────────────────────

        private JObject Window()
        {
            return OpJournal.Window(null, null, null);
        }

        private static JArray Entries(JObject window)
        {
            return (JArray)window["entries"];
        }

        private static JObject EntryAt(JObject window, int index)
        {
            return (JObject)Entries(window)[index];
        }

        private static JObject SetTransformParams(float x)
        {
            return new JObject
            {
                ["locator"] = new JObject { ["path"] = "/Player" },
                ["position"] = new JObject { ["x"] = x, ["y"] = 0f, ["z"] = 0f },
            };
        }

        // ── sequence, both doors, and the H5(a) batch hole ────────────────────

        [Test]
        public void Execute_AppendsOneDenseEntryPerOp()
        {
            _executor.Execute(Context("scene.set_transform", SetTransformParams(1f)), Respond);
            _executor.Execute(Context("scene.get_hierarchy"), Respond);

            JObject window = Window();
            Assert.AreEqual(2, Entries(window).Count, "one entry per dispatched op");
            Assert.AreEqual(1, EntryAt(window, 0).Value<long>("seq"));
            Assert.AreEqual(2, EntryAt(window, 1).Value<long>("seq"));
            Assert.AreEqual("scene.set_transform", EntryAt(window, 0).Value<string>("opName"));
            Assert.AreEqual("scene.get_hierarchy", EntryAt(window, 1).Value<string>("opName"));
            Assert.AreEqual(2, window.Value<long>("seq"));
            Assert.AreEqual(2, window.Value<long>("totalJournaled"),
                "seq and totalJournaled are equal by construction; a consumer asserts that invariant");
        }

        [Test]
        public void Batch_JournalsEveryChildIndividually_H5aLitmus()
        {
            // THE LITMUS. A batch-wrapped scene.set_transform must appear as its own
            // entry, with its own op name and its own resolved target. If ops.batch were
            // the only entry, ops.batch would be a laundering wrapper: an arbitrary
            // number of scene writes behind one innocent-looking record.
            var batch = new JObject
            {
                ["operations"] = new JArray
                {
                    new JObject
                    {
                        ["command"] = "scene.set_transform",
                        ["params"] = SetTransformParams(3f),
                    },
                    new JObject
                    {
                        ["command"] = "scene.get_hierarchy",
                        ["params"] = new JObject(),
                    },
                },
            };

            _executor.Execute(Context("ops.batch", batch), Respond);
            Assert.AreEqual("success", _lastResponse.Value<string>("status"));

            JObject window = Window();
            Assert.AreEqual(3, Entries(window).Count,
                "the batch parent plus one entry per child, in dispatch order");

            Assert.AreEqual("ops.batch", EntryAt(window, 0).Value<string>("opName"));
            Assert.AreEqual(1, EntryAt(window, 0).Value<long>("seq"));

            JObject child = EntryAt(window, 1);
            Assert.AreEqual("scene.set_transform", child.Value<string>("opName"),
                "the batch CHILD must be journaled under its own op name");
            Assert.AreEqual(2, child.Value<long>("seq"));
            Assert.AreEqual("write", child.Value<string>("opKind"));
            Assert.AreEqual("OpJournalTests_Fixture:/Player", child.Value<string>("targetDescriptor"),
                "a batch child's target must be resolved exactly like a top-level op's");

            Assert.AreEqual("scene.get_hierarchy", EntryAt(window, 2).Value<string>("opName"));
            Assert.AreEqual(3, EntryAt(window, 2).Value<long>("seq"));
        }

        [Test]
        public void Execute_UnknownCategory_IsStillJournaledAsAttemptedTraffic()
        {
            _executor.Execute(Context("nosuch.op"), Respond);

            Assert.AreEqual("error", _lastResponse.Value<string>("status"));
            JObject window = Window();
            Assert.AreEqual(1, Entries(window).Count);
            Assert.AreEqual("nosuch.op", EntryAt(window, 0).Value<string>("opName"));
            Assert.AreEqual("unknown", EntryAt(window, 0).Value<string>("opKind"),
                "an op this bridge's table has never heard of is 'unknown', never an innocent read");
        }

        // ── target binding ───────────────────────────────────────────────────

        [Test]
        public void TargetDescriptor_ResolvedForAWrite_NullForARead()
        {
            _executor.Execute(Context("scene.set_transform", SetTransformParams(5f)), Respond);
            _executor.Execute(Context("scene.get_bounds",
                new JObject { ["locator"] = new JObject { ["path"] = "/Player" } }), Respond);

            JObject window = Window();
            Assert.AreEqual("write", EntryAt(window, 0).Value<string>("opKind"));
            Assert.AreEqual("OpJournalTests_Fixture:/Player", EntryAt(window, 0).Value<string>("targetDescriptor"));

            Assert.AreEqual("read", EntryAt(window, 1).Value<string>("opKind"));
            Assert.AreEqual(JTokenType.Null, EntryAt(window, 1)["targetDescriptor"].Type,
                "a read op is not bound to a target by this record, even when it names a locator");
        }

        [Test]
        public void TargetDescriptor_UnresolvableLocator_IsNullAndIsNotAJournalFailure()
        {
            long failedBefore = OpJournal.FailedAppendsForTests;

            _executor.Execute(Context("scene.set_transform", new JObject
            {
                ["locator"] = new JObject { ["path"] = "/NoSuchObject" },
                ["position"] = new JObject { ["x"] = 1f },
            }), Respond);

            JObject window = Window();
            Assert.AreEqual(1, Entries(window).Count, "the attempt is journaled even though it failed");
            Assert.AreEqual("write", EntryAt(window, 0).Value<string>("opKind"));
            Assert.AreEqual(JTokenType.Null, EntryAt(window, 0)["targetDescriptor"].Type);
            Assert.AreEqual(failedBefore, OpJournal.FailedAppendsForTests,
                "an unresolvable target is an absent descriptor, not a journal failure");
        }

        // ── params hash ──────────────────────────────────────────────────────

        [Test]
        public void ParamsSha256_IsPresentAndStableForIdenticalParams()
        {
            _executor.Execute(Context("scene.set_transform", SetTransformParams(7f)), Respond);
            _executor.Execute(Context("scene.set_transform", SetTransformParams(7f)), Respond);
            _executor.Execute(Context("scene.set_transform", SetTransformParams(8f)), Respond);

            JObject window = Window();
            string a = EntryAt(window, 0).Value<string>("paramsSha256");
            string b = EntryAt(window, 1).Value<string>("paramsSha256");
            string c = EntryAt(window, 2).Value<string>("paramsSha256");

            Assert.AreEqual(64, a.Length, "SHA-256 as lowercase hex");
            StringAssert.IsMatch("^[0-9a-f]{64}$", a);
            Assert.AreEqual(a, b, "identical params hash identically");
            Assert.AreNotEqual(a, c, "different params must not collide into one record");
        }

        [Test]
        public void ParamsSha256_MatchesTheWireBytes()
        {
            // The cross-binding contract B2 depends on: re-hashing the exact bytes the
            // caller serialized reproduces the journal's hash.
            JObject parameters = SetTransformParams(9f);
            string wire = parameters.ToString(Newtonsoft.Json.Formatting.None);

            _executor.Execute(Context("scene.set_transform", parameters), Respond);

            string expected;
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(wire));
                var sb = new System.Text.StringBuilder(hash.Length * 2);
                foreach (byte item in hash)
                    sb.Append(item.ToString("x2"));
                expected = sb.ToString();
            }

            Assert.AreEqual(expected, EntryAt(Window(), 0).Value<string>("paramsSha256"));
        }

        // ── frames ───────────────────────────────────────────────────────────

        [Test]
        public void EffectFrame_NullForSync_RecordedForAsync()
        {
            _executor.Execute(Context("scene.get_hierarchy"), Respond);

            var async = new AsyncMockHandler();
            _executor.RegisterCategory("mock", async);
            _lastResponse = null;
            _executor.Execute(Context("mock.slow"), Respond);
            Assert.IsNull(_lastResponse, "the async mock has not completed yet");

            JObject beforeCompletion = Window();
            Assert.AreEqual(JTokenType.Null, EntryAt(beforeCompletion, 1)["effectFrameCount"].Type,
                "an async op has no effect frame until its completion callback runs");

            async.Complete(new JObject { ["done"] = true });

            JObject window = Window();
            Assert.AreEqual(JTokenType.Null, EntryAt(window, 0)["effectFrameCount"].Type,
                "a synchronous op's effect IS its dispatch frame; it never gets a copy of it");
            Assert.AreEqual(JTokenType.Integer, EntryAt(window, 1)["effectFrameCount"].Type,
                "the async op records the frame its completion callback ran on");
            // In a headless EditMode test both frames are the same editor frame; the
            // SEPARATION is what is pinned here. A real domain-reloading async op moves
            // the effect frame past the dispatch frame, which only a live editor shows.
            Assert.GreaterOrEqual(EntryAt(window, 1).Value<int>("effectFrameCount"),
                EntryAt(window, 1).Value<int>("frameCount"));
        }

        // ── identity ─────────────────────────────────────────────────────────

        [Test]
        public void InstanceId_IsStableAcrossCallsWithinASession()
        {
            JObject first = _journal.HandleOp("stats", new JObject());
            _executor.Execute(Context("scene.get_hierarchy"), Respond);
            JObject second = _journal.HandleOp("stats", new JObject());
            JObject window = _journal.HandleOp("window", new JObject());

            string id = first.Value<string>("journalInstanceId");
            Assert.IsFalse(string.IsNullOrEmpty(id));
            Assert.AreEqual(id, second.Value<string>("journalInstanceId"));
            Assert.AreEqual(id, window.Value<string>("journalInstanceId"),
                "stats and window must name the SAME journal or a consumer cannot bind them");
        }

        [Test]
        public void Reset_MintsANewInstanceId_SoAResetCannotReadAsACleanWindow()
        {
            string before = OpJournal.InstanceId;
            OpJournal.ResetForTests();
            Assert.AreNotEqual(before, OpJournal.InstanceId,
                "a reset (and a domain reload) must be visible as an identity change");
        }

        [Test]
        public void Stats_ReportsTheJournalsOwnAccounting()
        {
            _executor.Execute(Context("scene.get_hierarchy"), Respond);

            JObject stats = _journal.HandleOp("stats", new JObject());
            Assert.AreEqual(1, stats.Value<long>("seq"));
            Assert.AreEqual(1, stats.Value<long>("totalJournaled"));
            Assert.AreEqual(0, stats.Value<long>("droppedEntries"));
            Assert.AreEqual(OpJournal.Capacity, stats.Value<int>("capacity"));
            Assert.AreEqual(1, stats.Value<long>("oldestRetainedSeq"));
        }

        // ── wrap ─────────────────────────────────────────────────────────────

        [Test]
        public void RingWrap_CountsDroppedEntries_AndTheWindowReportsWrapped()
        {
            int overflow = 5;
            for (int i = 0; i < OpJournal.Capacity + overflow; i++)
                OpJournal.Append("scene.get_hierarchy", new JObject { ["i"] = i });

            JObject stats = OpJournal.Stats();
            Assert.AreEqual(OpJournal.Capacity + overflow, stats.Value<long>("totalJournaled"));
            Assert.AreEqual(overflow, stats.Value<long>("droppedEntries"),
                "a wrap is counted, never hidden");
            Assert.AreEqual(overflow + 1, stats.Value<long>("oldestRetainedSeq"));

            JObject whole = OpJournal.Window(null, null, null);
            Assert.AreEqual(OpJournal.Capacity, Entries(whole).Count, "the ring holds exactly its capacity");
            Assert.IsTrue(whole.Value<bool>("wrapped"), "a drained wrapped journal must say so");

            JObject fellOff = OpJournal.Window(1, null, null);
            Assert.IsTrue(fellOff.Value<bool>("wrapped"),
                "a range whose start was overwritten must refuse to read as complete");
            Assert.AreEqual(overflow + 1, EntryAt(fellOff, 0).Value<long>("seq"));

            JObject intact = OpJournal.Window(overflow + 1, null, null);
            Assert.IsFalse(intact.Value<bool>("wrapped"),
                "a range still entirely inside the ring is complete");
        }

        // ── window selectors ─────────────────────────────────────────────────

        [Test]
        public void Window_SelectsBySequenceRange()
        {
            for (int i = 0; i < 5; i++)
                OpJournal.Append("scene.get_hierarchy", new JObject { ["i"] = i });

            JObject window = OpJournal.Window(2, 4, null);
            Assert.AreEqual(3, Entries(window).Count);
            Assert.AreEqual(2, EntryAt(window, 0).Value<long>("seq"));
            Assert.AreEqual(4, EntryAt(window, 2).Value<long>("seq"));
            Assert.AreEqual(2, window["requested"].Value<long>("fromSeq"));
            Assert.AreEqual(4, window["requested"].Value<long>("toSeq"));
        }

        [Test]
        public void Window_OnAnEmptyJournal_IsAnEmptySliceNotACrash()
        {
            // REGRESSION. Sequence numbers start at 1, so an empty journal's
            // oldestRetainedSeq is 0 and a naive range walk indexed the ring at -1. The
            // first journal.window against a freshly reloaded bridge is exactly this
            // case, and it answered INTERNAL_ERROR.
            foreach (JObject window in new[]
            {
                OpJournal.Window(null, null, null),
                OpJournal.Window(0, null, null),
                OpJournal.Window(1, 10, null),
                OpJournal.Window(null, null, 0.0),
            })
            {
                Assert.AreEqual(0, Entries(window).Count);
                Assert.IsFalse(window.Value<bool>("wrapped"), "nothing was dropped, so nothing wrapped");
                Assert.AreEqual(0, window.Value<long>("oldestRetainedSeq"));
            }
        }

        [Test]
        public void Window_RefusesTwoSelectors()
        {
            var ex = Assert.Throws<BridgeException>(() => _journal.HandleOp("window",
                new JObject { ["fromSeq"] = 1, ["fromTMs"] = 0.0 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Window_RefusesAnInvertedRange()
        {
            var ex = Assert.Throws<BridgeException>(() => _journal.HandleOp("window",
                new JObject { ["fromSeq"] = 9, ["toSeq"] = 2 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Window_RefusesToSeqWithoutFromSeq()
        {
            var ex = Assert.Throws<BridgeException>(() => _journal.HandleOp("window",
                new JObject { ["toSeq"] = 2 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void UnknownJournalOp_IsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _journal.HandleOp("drain", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ── the swallow rule ─────────────────────────────────────────────────

        [Test]
        public void JournalFailure_DoesNotFailTheOp_AndIsCountedNotHidden()
        {
            long failedBefore = OpJournal.FailedAppendsForTests;
            LogAssert.Expect(LogType.Warning, new System.Text.RegularExpressions.Regex(
                @"\[Loombridge\] Op journal append failed"));

            OpJournal.SimulateNextAppendFault();
            _executor.Execute(Context("scene.set_transform", SetTransformParams(11f)), Respond);

            Assert.AreEqual("success", _lastResponse.Value<string>("status"),
                "journaling an op must never be able to fail the op");
            Assert.AreEqual(11f, _player.transform.position.x, 0.0001f, "the op itself still ran");

            Assert.AreEqual(failedBefore + 1, OpJournal.FailedAppendsForTests,
                "a swallowed failure is COUNTED; a silent swallow would be an invisible hole");
            Assert.AreEqual(0, OpJournal.CurrentSeq,
                "a failed append does not consume a sequence number, so it cannot look like a gap");
            Assert.AreEqual(0, Entries(Window()).Count);
        }

        // ── the classification table ─────────────────────────────────────────

        [Test]
        public void OpTable_ClassifiesTheOpsTheJournalBindsTargetsFor()
        {
            Assert.AreEqual(OpJournalOpTable.KindWrite, OpJournalOpTable.KindOf("scene.set_transform"));
            Assert.AreEqual("locator", OpJournalOpTable.TargetParamOf("scene.set_transform"));
            Assert.AreEqual(OpJournalOpTable.KindWrite, OpJournalOpTable.KindOf("component.set_property"));
            Assert.AreEqual(OpJournalOpTable.KindRead, OpJournalOpTable.KindOf("observe.status"));
            Assert.AreEqual(OpJournalOpTable.KindRead, OpJournalOpTable.KindOf("journal.stats"));
            Assert.IsNull(OpJournalOpTable.TargetParamOf("observe.status"));
            Assert.AreEqual(OpJournalOpTable.KindUnknown, OpJournalOpTable.KindOf("scene.teleport_everything"),
                "an op the table has never heard of must be unclassified, never a read");
        }

        // ── mock ─────────────────────────────────────────────────────────────

        private sealed class AsyncMockHandler : IOpHandler
        {
            private Action<JObject> _respond;

            public bool IsAsync(string opName) => true;

            public JObject HandleOp(string opName, JObject parameters) => new JObject();

            public void HandleOpAsync(string opName, JObject parameters,
                Action<JObject> respond, Action<BridgeException> onError)
            {
                _respond = respond;
            }

            public void Complete(JObject result)
            {
                _respond?.Invoke(result);
            }
        }
    }
}
