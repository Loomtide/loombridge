using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine;

namespace UnityBridge.Tests
{
    /// <summary>
    /// Edit-mode + pure-logic coverage for runtime.sample_animator (animation-verification
    /// honesty). Play-mode cross-frame sampling — the actual freeze detection — is live-smoke
    /// deferred (it requires Play Mode + real Animator time advancement, which EditMode tests
    /// cannot exercise); here we lock down the parts that ARE deterministically testable without
    /// entering Play Mode: the edit-mode single-shot path, the NOT_FOUND refusal, and the pure
    /// verdict math (status classification incl. blocked_culled/blocked_unfocused precedence,
    /// per-state time-advancing semantics, bone-motion epsilon on LOCAL pose).
    /// </summary>
    [TestFixture]
    public class AnimatorSampleTests
    {
        private RuntimeHandler _handler;
        private GameObject _go;

        [SetUp]
        public void SetUp()
        {
            _handler = new RuntimeHandler();
            _go = new GameObject("AnimatorSampleTestObject");
        }

        [TearDown]
        public void TearDown()
        {
            if (_go != null)
                Object.DestroyImmediate(_go);
        }

        // ── Handler: refusals + edit-mode single-shot ──────────────────────────────

        [Test]
        public void SampleAnimator_NoAnimator_ThrowsNotFound()
        {
            JObject response = null;
            BridgeException error = null;

            _handler.HandleOpAsync("sample_animator", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_go)
            },
            result => response = result,
            ex => error = ex);

            Assert.IsNull(response, "Must not produce a result when the Animator is absent.");
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.NOT_FOUND, error.Code);
            StringAssert.Contains("no Animator", error.Message);
        }

        [Test]
        public void SampleAnimator_MissingLocator_ThrowsInvalidParams()
        {
            JObject response = null;
            BridgeException error = null;

            _handler.HandleOpAsync("sample_animator", new JObject(),
                result => response = result,
                ex => error = ex);

            Assert.IsNull(response);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void SampleAnimator_EditMode_ReturnsPoseAndStaticStatus()
        {
            _go.AddComponent<Animator>();

            JObject response = null;
            BridgeException error = null;

            // EditMode tests run with EditorApplication.isPlaying == false, so this resolves
            // synchronously via the single-shot edit-mode path.
            _handler.HandleOpAsync("sample_animator", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_go)
            },
            result => response = result,
            ex => error = ex);

            Assert.IsNull(error);
            Assert.IsNotNull(response);
            Assert.AreEqual("edit_mode_static", response.Value<string>("status"));
            Assert.AreEqual(false, response.Value<bool>("time_advancing"),
                "A paused-scene single-shot can NEVER report time_advancing.");
            Assert.AreEqual(false, response.Value<bool>("bones_moving"));
            Assert.AreEqual(false, response.Value<bool>("playMode"));
            Assert.AreEqual(1, response.Value<int>("sampleCount"));

            // Focus-independent freeze diagnostics must be present so a culled/inactive/
            // uninitialized animator can never masquerade as a focus problem (or as ok).
            Assert.IsNotNull(response["culling_mode"], "culling_mode must be reported");
            Assert.AreEqual(true, response.Value<bool>("active_in_hierarchy"));
            Assert.IsNotNull(response["is_initialized"], "is_initialized must be reported");

            JArray samples = response.Value<JArray>("samples");
            Assert.IsNotNull(samples);
            Assert.AreEqual(1, samples.Count, "Edit-mode is a single-shot pose read.");
            // The pose sample is present even without a controller (hasState:false, honest).
            Assert.AreEqual(false, samples[0].Value<bool>("hasState"));
            Assert.IsNotNull(samples[0]["bones"]);
        }

        [Test]
        public void SampleAnimator_EditMode_ResolvesRequestedBoneLocalPose()
        {
            _go.AddComponent<Animator>();

            var root = new GameObject("Root");
            root.transform.SetParent(_go.transform, false);
            var hand = new GameObject("Hand");
            hand.transform.SetParent(root.transform, false);
            hand.transform.localRotation = Quaternion.Euler(0f, 30f, 0f);
            hand.transform.localPosition = new Vector3(1f, 2f, 3f);

            JObject response = null;
            BridgeException error = null;

            _handler.HandleOpAsync("sample_animator", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_go),
                ["bones"] = new JArray("Root/Hand", "Root/DoesNotExist")
            },
            result => response = result,
            ex => error = ex);

            Assert.IsNull(error);
            Assert.IsNotNull(response);

            JArray bones = response.Value<JArray>("bones");
            Assert.IsNotNull(bones);
            Assert.AreEqual(2, bones.Count);
            Assert.AreEqual("Root/Hand", bones[0].Value<string>("path"));
            Assert.AreEqual(true, bones[0].Value<bool>("resolved"));
            // An unresolvable bone path is reported honestly, never fabricated.
            Assert.AreEqual("Root/DoesNotExist", bones[1].Value<string>("path"));
            Assert.AreEqual(false, bones[1].Value<bool>("resolved"));

            JArray sampleBones = response.Value<JArray>("samples")[0].Value<JArray>("bones");
            Assert.AreEqual(true, sampleBones[0].Value<bool>("resolved"));
            Assert.IsNotNull(sampleBones[0]["localRotation"], "Resolved bone must carry its localRotation.");
            // LOCAL position (never world): bones_moving measures skeletal-local motion — a
            // physics-moved root must not make every bone read as "moving".
            Assert.IsNotNull(sampleBones[0]["localPosition"], "Resolved bone must carry its localPosition.");
            Assert.IsNull(sampleBones[0]["position"], "World position must NOT be emitted as bone pose.");
            Assert.AreEqual(1f, sampleBones[0]["localPosition"].Value<float>("x"), 1e-5f);
            Assert.AreEqual(2f, sampleBones[0]["localPosition"].Value<float>("y"), 1e-5f);
            Assert.IsNull(sampleBones[1]["localRotation"], "Unresolved bone carries no pose.");
        }

        // ── Pure verdict math: status classification ───────────────────────────────

        [Test]
        public void ClassifyStatus_EditMode_IsAlwaysStatic()
        {
            Assert.AreEqual("edit_mode_static",
                RuntimeHandler.ClassifyAnimatorStatus(editMode: true, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: true, distinctSampleCount: 8, timeAdvancing: true));
        }

        [Test]
        public void ClassifyStatus_FewerThanTwoDistinctSamples_IsInsufficient()
        {
            // Refuse, not skip: a window with <2 distinct samples cannot establish advancement,
            // and this takes precedence even over the blocked-* diagnoses (which themselves
            // require having observed non-advancement across a real window).
            Assert.AreEqual("insufficient_samples",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: true, distinctSampleCount: 1, timeAdvancing: false));
            Assert.AreEqual("insufficient_samples",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: false, distinctSampleCount: 0, timeAdvancing: true));
        }

        [Test]
        public void ClassifyStatus_CulledFreeze_IsBlockedCulled_EvenWhenUnfocused()
        {
            // blocked_culled takes precedence over blocked_unfocused: CullCompletely stops
            // animator time regardless of focus, so the freeze must not be blamed on focus.
            Assert.AreEqual("blocked_culled",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: true, distinctSampleCount: 8, timeAdvancing: false));
        }

        [Test]
        public void ClassifyStatus_CulledFreeze_IsBlockedCulled_EvenWhenFocused()
        {
            // A FOCUSED editor must not launder a culled freeze into "ok" — this was the D2
            // laundering path: focused + frozen + culled used to read ok.
            Assert.AreEqual("blocked_culled",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: true, culledCompletely: true, distinctSampleCount: 8, timeAdvancing: false));
        }

        [Test]
        public void ClassifyStatus_CulledButAdvancing_IsOk()
        {
            // CullCompletely with a VISIBLE renderer still animates — advancing wins.
            Assert.AreEqual("ok",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: true, culledCompletely: true, distinctSampleCount: 8, timeAdvancing: true));
        }

        [Test]
        public void ClassifyStatus_ExpectedToAdvanceButFrozenUnfocused_IsBlocked()
        {
            Assert.AreEqual("blocked_unfocused",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: false, distinctSampleCount: 8, timeAdvancing: false));
        }

        [Test]
        public void ClassifyStatus_FrozenButFocused_IsOk_NotBlocked()
        {
            // No focus problem, no culling — a non-advancing but focused animator is honest
            // idleness, not a block.
            Assert.AreEqual("ok",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: true, culledCompletely: false, distinctSampleCount: 8, timeAdvancing: false));
        }

        [Test]
        public void ClassifyStatus_IdleAnimatorUnfocused_IsOk_NotBlocked()
        {
            // Animator not expected to advance (paused/no controller/inactive/uninitialized):
            // "no advance" is not a block — blaming focus would mislabel the cause.
            Assert.AreEqual("ok",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: false,
                    editorHasFocus: false, culledCompletely: false, distinctSampleCount: 8, timeAdvancing: false));
        }

        [Test]
        public void ClassifyStatus_Advancing_IsOk()
        {
            Assert.AreEqual("ok",
                RuntimeHandler.ClassifyAnimatorStatus(false, animatorPlaying: true,
                    editorHasFocus: false, culledCompletely: false, distinctSampleCount: 8, timeAdvancing: true));
        }

        // ── Pure verdict math: per-state time-advancing ────────────────────────────

        private static bool Advancing(int[] hashes, double[] times)
        {
            return RuntimeHandler.ComputeTimeAdvancing(new List<int>(hashes), new List<double>(times));
        }

        [Test]
        public void ComputeTimeAdvancing_SingleSample_IsFalse()
        {
            Assert.IsFalse(Advancing(new[] { 1 }, new[] { 0.5 }));
            Assert.IsFalse(Advancing(new int[0], new double[0]));
            Assert.IsFalse(RuntimeHandler.ComputeTimeAdvancing(null, null));
        }

        [Test]
        public void ComputeTimeAdvancing_MismatchedSeries_IsFalse()
        {
            // Refuse malformed evidence rather than guessing an alignment.
            Assert.IsFalse(Advancing(new[] { 1, 1 }, new[] { 0.1, 0.2, 0.3 }));
        }

        [Test]
        public void ComputeTimeAdvancing_IdenticalSamples_IsFalse()
        {
            Assert.IsFalse(Advancing(new[] { 1, 1, 1, 1 }, new[] { 0.42, 0.42, 0.42, 0.42 }));
        }

        [Test]
        public void ComputeTimeAdvancing_IncreasingWithinOneState_IsTrue()
        {
            Assert.IsTrue(Advancing(new[] { 1, 1, 1, 1 }, new[] { 0.1, 0.2, 0.35, 0.5 }));
        }

        [Test]
        public void ComputeTimeAdvancing_MonotonicLoopingState_IsTrue()
        {
            // Unity's normalizedTime for a looping state is MONOTONIC: the integer part is the
            // loop count. A second loop reads 1.1, 1.4 — not a reset toward 0.
            Assert.IsTrue(Advancing(new[] { 1, 1, 1 }, new[] { 0.9, 1.1, 1.4 }));
        }

        [Test]
        public void ComputeTimeAdvancing_StateTransitionAlone_IsNotAdvancement()
        {
            // A mid-window STATE TRANSITION makes normalizedTime drop (the new state starts near
            // 0) — that cross-state delta must contribute NOTHING: two frozen states separated
            // by a transition are still frozen. (The old "wrap" branch mis-read exactly this
            // shape as looping progress.)
            Assert.IsFalse(Advancing(new[] { 1, 1, 2, 2 }, new[] { 0.9, 0.9, 0.1, 0.1 }));
        }

        [Test]
        public void ComputeTimeAdvancing_TransitionWithProgressWithinAState_IsTrue()
        {
            // Same transition shape, but state 2 actually progresses after the switch.
            Assert.IsTrue(Advancing(new[] { 1, 1, 2, 2 }, new[] { 0.9, 0.9, 0.1, 0.25 }));
        }

        // ── Pure verdict math: bone motion epsilon (LOCAL pose) ────────────────────

        [Test]
        public void BoneMoved_IdenticalPose_IsFalse()
        {
            var r = Quaternion.Euler(10f, 20f, 30f);
            var p = new Vector3(1f, 2f, 3f);
            Assert.IsFalse(RuntimeHandler.BoneMoved(r, r, p, p));
        }

        [Test]
        public void BoneMoved_Rotation_IsTrue()
        {
            var p = new Vector3(1f, 2f, 3f);
            Assert.IsTrue(RuntimeHandler.BoneMoved(
                Quaternion.identity, Quaternion.Euler(0f, 5f, 0f), p, p));
        }

        [Test]
        public void BoneMoved_Translation_IsTrue()
        {
            var r = Quaternion.identity;
            Assert.IsTrue(RuntimeHandler.BoneMoved(
                r, r, new Vector3(0f, 0f, 0f), new Vector3(0.5f, 0f, 0f)));
        }
    }
}
