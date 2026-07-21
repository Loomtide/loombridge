using System.Collections.Generic;
using NUnit.Framework;
using UnityBridge.Core;

namespace UnityBridge.Tests
{
    /// <summary>
    /// Unit tests for the PURE phase-scheduling logic behind runtime.capture_input_motion
    /// (which keys are held at a given elapsed time). The live in-loop INJECTION itself —
    /// driving the controller through the InputService/backend on each sampling tick — is
    /// only provable on a real bridge in Play Mode and is NOT covered here.
    /// </summary>
    [TestFixture]
    public class CaptureInputMotionTests
    {
        private static List<CaptureInputMotion.Phase> Phases(params CaptureInputMotion.Phase[] phases)
        {
            return new List<CaptureInputMotion.Phase>(phases);
        }

        private static CaptureInputMotion.Phase P(double durationMs, params string[] keys)
        {
            return new CaptureInputMotion.Phase(new List<string>(keys), durationMs);
        }

        [Test]
        public void PhaseIndex_BoundaryPicksNextPhase()
        {
            // Two 100ms phases. Boundaries are half-open [start, end): elapsed exactly at
            // 100ms must belong to the SECOND phase, not the first.
            var phases = Phases(P(100, "RightArrow"), P(100, "LeftArrow"));

            Assert.AreEqual(0, CaptureInputMotion.PhaseIndexAtElapsed(phases, 0));
            Assert.AreEqual(0, CaptureInputMotion.PhaseIndexAtElapsed(phases, 99.9));
            Assert.AreEqual(1, CaptureInputMotion.PhaseIndexAtElapsed(phases, 100), "elapsed exactly at the boundary picks the next phase");
            Assert.AreEqual(1, CaptureInputMotion.PhaseIndexAtElapsed(phases, 150));
        }

        [Test]
        public void PhaseIndex_PastEndReturnsNegativeOne()
        {
            var phases = Phases(P(100, "RightArrow"));
            Assert.AreEqual(-1, CaptureInputMotion.PhaseIndexAtElapsed(phases, 100), "elapsed at total duration is past the final phase");
            Assert.AreEqual(-1, CaptureInputMotion.PhaseIndexAtElapsed(phases, 250));
        }

        [Test]
        public void PhaseIndex_EmptyPhaseListReturnsNegativeOne()
        {
            Assert.AreEqual(-1, CaptureInputMotion.PhaseIndexAtElapsed(new List<CaptureInputMotion.Phase>(), 0));
            Assert.AreEqual(-1, CaptureInputMotion.PhaseIndexAtElapsed(null, 0));
        }

        [Test]
        public void ActiveKeys_AtBoundaryAreTheNextPhasesKeys()
        {
            var phases = Phases(P(100, "RightArrow"), P(100, "LeftArrow"));

            CollectionAssert.AreEquivalent(new[] { "RightArrow" }, CaptureInputMotion.ActiveKeysAtElapsed(phases, 50));
            CollectionAssert.AreEquivalent(new[] { "LeftArrow" }, CaptureInputMotion.ActiveKeysAtElapsed(phases, 100));
        }

        [Test]
        public void ActiveKeys_EmptyKeysSettlePhaseYieldsNoKeys()
        {
            // Middle phase is a settle phase (no keys held).
            var phases = Phases(P(100, "RightArrow"), P(100 /* settle: no keys */), P(100, "Space"));

            CollectionAssert.AreEquivalent(new[] { "RightArrow" }, CaptureInputMotion.ActiveKeysAtElapsed(phases, 50));
            Assert.IsEmpty(CaptureInputMotion.ActiveKeysAtElapsed(phases, 150), "settle phase holds no keys");
            CollectionAssert.AreEquivalent(new[] { "Space" }, CaptureInputMotion.ActiveKeysAtElapsed(phases, 250));
        }

        [Test]
        public void ActiveKeys_PastTheEndYieldsNoKeys()
        {
            var phases = Phases(P(100, "RightArrow"));
            Assert.IsEmpty(CaptureInputMotion.ActiveKeysAtElapsed(phases, 100), "past the end every key is released");
            Assert.IsEmpty(CaptureInputMotion.ActiveKeysAtElapsed(phases, 500));
        }

        [Test]
        public void ActiveKeys_MultiKeyPhaseHoldsAllKeys()
        {
            // e.g. run + jump simultaneously.
            var phases = Phases(P(200, "RightArrow", "Space"));
            CollectionAssert.AreEquivalent(new[] { "RightArrow", "Space" }, CaptureInputMotion.ActiveKeysAtElapsed(phases, 100));
        }

        [Test]
        public void TotalDuration_SumsAllPhases()
        {
            var phases = Phases(P(100, "RightArrow"), P(50), P(200, "Space"));
            Assert.AreEqual(350, CaptureInputMotion.TotalDurationMs(phases), 1e-9);
            Assert.AreEqual(0, CaptureInputMotion.TotalDurationMs(null), 1e-9);
        }
    }
}
