using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class MotionMetricsTests
    {
        private static MotionMetrics.Sample S(double t, float x, float y)
        {
            return new MotionMetrics.Sample(t, new Vector3(x, y, 0f));
        }

        private static MotionMetrics.Sample S3(double t, float x, float y, float z)
        {
            return new MotionMetrics.Sample(t, new Vector3(x, y, z));
        }

        [Test]
        public void Compute_EmptySamples_ReturnsZeroCount()
        {
            JObject result = MotionMetrics.Compute(new List<MotionMetrics.Sample>());
            Assert.AreEqual(0, result.Value<int>("sampleCount"));
        }

        [Test]
        public void Compute_JumpArc_FindsApexHeightAndTime()
        {
            // Parabolic-ish arc: starts at y=0, peaks at y=2.5 at t=0.3s, falls back.
            var samples = new List<MotionMetrics.Sample>
            {
                S(0.0, 0f, 0f),
                S(0.1, 0f, 1.5f),
                S(0.2, 0f, 2.3f),
                S(0.3, 0f, 2.5f),  // apex
                S(0.4, 0f, 2.3f),
                S(0.5, 0f, 1.5f),
                S(0.6, 0f, 0f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(0f, r.Value<float>("startY"), 0.001f);
            Assert.AreEqual(2.5f, r.Value<float>("peakY"), 0.001f);
            Assert.AreEqual(2.5f, r.Value<float>("deltaY"), 0.001f);
            Assert.AreEqual(300.0, r.Value<double>("timeToApexMs"), 0.5);
            Assert.AreEqual(7, r.Value<int>("sampleCount"));
        }

        [Test]
        public void Compute_HorizontalRun_ComputesAvgSpeed()
        {
            // Moves from x=0 to x=6 over 1 second => 6 units/sec.
            var samples = new List<MotionMetrics.Sample>
            {
                S(0.0, 0f, 0f),
                S(0.5, 3f, 0f),
                S(1.0, 6f, 0f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(6f, r.Value<float>("deltaX"), 0.001f);
            Assert.AreEqual(6.0, r.Value<double>("avgRunSpeed"), 0.01);
            Assert.AreEqual(1000.0, r.Value<double>("durationMs"), 0.5);
        }

        [Test]
        public void Compute_LeftwardRun_AvgSpeedIsAbsolute()
        {
            var samples = new List<MotionMetrics.Sample>
            {
                S(0.0, 0f, 0f),
                S(1.0, -4f, 0f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(-4f, r.Value<float>("deltaX"), 0.001f);
            Assert.AreEqual(4.0, r.Value<double>("avgRunSpeed"), 0.01);
        }

        [Test]
        public void Compute_TracksMinY()
        {
            var samples = new List<MotionMetrics.Sample>
            {
                S(0.0, 0f, 0f),
                S(0.1, 0f, -1.2f),
                S(0.2, 0f, 0.5f)
            };

            JObject r = MotionMetrics.Compute(samples);
            Assert.AreEqual(-1.2f, r.Value<float>("minY"), 0.001f);
            Assert.AreEqual(0.5f, r.Value<float>("peakY"), 0.001f);
        }

        [Test]
        public void Compute_SingleSample_ZeroDurationNoDivideByZero()
        {
            var samples = new List<MotionMetrics.Sample> { S(5.0, 2f, 3f) };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(1, r.Value<int>("sampleCount"));
            Assert.AreEqual(0.0, r.Value<double>("avgRunSpeed"), 0.0001);
            Assert.AreEqual(0.0, r.Value<double>("durationMs"), 0.0001);
            Assert.AreEqual(3f, r.Value<float>("peakY"), 0.001f);
        }

        // ── RCL-T02: Z-aware top-level metrics (measure_motion was Z-blind) ───────

        [Test]
        public void Compute_ForwardMove_ReportsZAxisAndPlanarSpeed()
        {
            // Pure forward move (W=+Z): the OLD schema read deltaX=0/avgRunSpeed=0 — a FALSE
            // "motionless" report. avgPlanarSpeed (XZ displacement) must now read the real speed.
            var samples = new List<MotionMetrics.Sample>
            {
                S3(0.0, 0f, 0f, 0f),
                S3(0.5, 0f, 0f, 3f),
                S3(1.0, 0f, 0f, 6f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(0f, r.Value<float>("startZ"), 0.001f);
            Assert.AreEqual(6f, r.Value<float>("endZ"), 0.001f);
            Assert.AreEqual(6f, r.Value<float>("deltaZ"), 0.001f);
            // Legacy X fields are honestly zero (no X motion)…
            Assert.AreEqual(0f, r.Value<float>("deltaX"), 0.001f);
            Assert.AreEqual(0.0, r.Value<double>("avgRunSpeed"), 0.01);
            // …but the planar/3D speed captures the forward motion.
            Assert.AreEqual(6.0, r.Value<double>("avgPlanarSpeed"), 0.01);
            Assert.AreEqual(6.0, r.Value<double>("speed3D"), 0.01);
        }

        [Test]
        public void Compute_DiagonalGroundMove_PlanarSpeedIsXzHypotenuse()
        {
            // Move +3 on X and +4 on Z over 1s => planar displacement 5 => 5 u/s.
            var samples = new List<MotionMetrics.Sample>
            {
                S3(0.0, 0f, 0f, 0f),
                S3(1.0, 3f, 0f, 4f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(3f, r.Value<float>("deltaX"), 0.001f);
            Assert.AreEqual(4f, r.Value<float>("deltaZ"), 0.001f);
            Assert.AreEqual(5.0, r.Value<double>("avgPlanarSpeed"), 0.001);
            Assert.AreEqual(5.0, r.Value<double>("speed3D"), 0.001);
            // avgRunSpeed stays X-only (back-compat) — does NOT silently become the planar speed.
            Assert.AreEqual(3.0, r.Value<double>("avgRunSpeed"), 0.001);
        }

        [Test]
        public void Compute_Speed3D_IncludesVerticalDisplacement()
        {
            // +3 X, +4 Z (planar 5) plus +12 Y => 3D displacement 13 over 1s.
            var samples = new List<MotionMetrics.Sample>
            {
                S3(0.0, 0f, 0f, 0f),
                S3(1.0, 3f, 12f, 4f)
            };

            JObject r = MotionMetrics.Compute(samples);

            Assert.AreEqual(5.0, r.Value<double>("avgPlanarSpeed"), 0.001);
            Assert.AreEqual(13.0, r.Value<double>("speed3D"), 0.001);
        }

        [Test]
        public void Compute_SingleSample_ZAxisSpeedsAreZero()
        {
            JObject r = MotionMetrics.Compute(new List<MotionMetrics.Sample> { S3(5.0, 2f, 3f, 4f) });

            Assert.AreEqual(4f, r.Value<float>("startZ"), 0.001f);
            Assert.AreEqual(4f, r.Value<float>("endZ"), 0.001f);
            Assert.AreEqual(0f, r.Value<float>("deltaZ"), 0.001f);
            Assert.AreEqual(0.0, r.Value<double>("avgPlanarSpeed"), 0.0001);
            Assert.AreEqual(0.0, r.Value<double>("speed3D"), 0.0001);
        }

        // ── S5c-b: includeSamples + fixed-timestep provenance ────────────────────

        [Test]
        public void Compute_DefaultArgs_OmitsSamplesAndTimestepProvenance()
        {
            // Back-compat: legacy single-arg callers get exactly the old shape.
            JObject r = MotionMetrics.Compute(new List<MotionMetrics.Sample> { S(0.0, 0f, 0f), S(0.1, 1f, 0f) });

            Assert.IsNull(r["samples"], "samples must be absent unless includeSamples=true");
            Assert.IsNull(r["projectFixedTimestepBeforeMeasurement"], "timestep provenance must be absent unless supplied");
            Assert.IsNull(r["measurementFixedTimestep"]);
        }

        [Test]
        public void Compute_IncludeSamples_EmitsRelativeTrajectory()
        {
            // tMs is relative to the first sample (start=0), x/y carried through —
            // the FeelTrajectorySample shape the TS re-derivation consumes.
            var samples = new List<MotionMetrics.Sample>
            {
                S(10.00, 2f, 1f),
                S(10.10, 3f, 2.5f),
                S(10.25, 5f, 0.5f)
            };

            JObject r = MotionMetrics.Compute(samples, includeSamples: true);

            var arr = r["samples"] as JArray;
            Assert.IsNotNull(arr, "samples array must be present");
            Assert.AreEqual(3, arr.Count);

            Assert.AreEqual(0.0, arr[0].Value<double>("tMs"), 0.001);
            Assert.AreEqual(2f, arr[0].Value<float>("x"), 0.001f);
            Assert.AreEqual(1f, arr[0].Value<float>("y"), 0.001f);

            Assert.AreEqual(100.0, arr[1].Value<double>("tMs"), 0.01);
            Assert.AreEqual(3f, arr[1].Value<float>("x"), 0.001f);
            Assert.AreEqual(2.5f, arr[1].Value<float>("y"), 0.001f);

            Assert.AreEqual(250.0, arr[2].Value<double>("tMs"), 0.01);
            Assert.AreEqual(5f, arr[2].Value<float>("x"), 0.001f);
            Assert.AreEqual(0.5f, arr[2].Value<float>("y"), 0.001f);
        }

        [Test]
        public void Compute_IncludeSamples_EmitsRotationEulerAngles()
        {
            // 3D measurement substrate v2: a sample built with eulerAngles emits rx/ry/rz so an
            // offline rotation calculator (aimTurnRateDegPerSec — yaw=ry) can re-derive a turn rate.
            var samples = new List<MotionMetrics.Sample>
            {
                new MotionMetrics.Sample(0.0, new Vector3(0f, 1f, 0f), new Vector3(0f, 0f, 0f)),
                new MotionMetrics.Sample(0.1, new Vector3(0f, 1f, 0f), new Vector3(0f, 9f, 0f)),
                new MotionMetrics.Sample(0.2, new Vector3(0f, 1f, 0f), new Vector3(0f, 18f, 0f))
            };

            JObject r = MotionMetrics.Compute(samples, includeSamples: true);
            var arr = r["samples"] as JArray;
            Assert.IsNotNull(arr);
            Assert.AreEqual(0f, arr[0].Value<float>("ry"), 0.001f);
            Assert.AreEqual(9f, arr[1].Value<float>("ry"), 0.001f);   // yaw turning
            Assert.AreEqual(18f, arr[2].Value<float>("ry"), 0.001f);
            Assert.AreEqual(0f, arr[2].Value<float>("rx"), 0.001f);
            Assert.AreEqual(0f, arr[2].Value<float>("rz"), 0.001f);
        }

        [Test]
        public void Compute_PositionOnlySample_EmitsZeroRotation()
        {
            // Back-compat: the two-arg constructor leaves rotation at zero, so legacy position-only
            // captures still emit rx/ry/rz = 0 (additive, never a fabricated turn).
            JObject r = MotionMetrics.Compute(
                new List<MotionMetrics.Sample> { S(0.0, 1f, 2f), S(0.1, 1f, 2f) }, includeSamples: true);
            var arr = r["samples"] as JArray;
            Assert.AreEqual(0f, arr[0].Value<float>("ry"), 0.001f);
            Assert.AreEqual(0f, arr[1].Value<float>("rx"), 0.001f);
        }

        [Test]
        public void Compute_FixedTimestepProvenance_EmittedAndRounded()
        {
            var samples = new List<MotionMetrics.Sample> { S(0.0, 0f, 0f), S(0.1, 1f, 0f) };

            // measure_motion never pins physics, so observed before==measurement.
            JObject r = MotionMetrics.Compute(samples, includeSamples: false,
                projectFixedTimestep: 0.02, measurementFixedTimestep: 0.02);

            Assert.AreEqual(0.02, r.Value<double>("projectFixedTimestepBeforeMeasurement"), 1e-9);
            Assert.AreEqual(0.02, r.Value<double>("measurementFixedTimestep"), 1e-9);
        }

        [Test]
        public void Compute_EmptySamples_IncludeSamples_EmitsEmptyArrayNotError()
        {
            JObject r = MotionMetrics.Compute(new List<MotionMetrics.Sample>(), includeSamples: true,
                projectFixedTimestep: 0.0166667, measurementFixedTimestep: 0.0166667);

            Assert.AreEqual(0, r.Value<int>("sampleCount"));
            var arr = r["samples"] as JArray;
            Assert.IsNotNull(arr, "samples must be an (empty) array, not absent");
            Assert.AreEqual(0, arr.Count);
            // Provenance still attaches on the empty path. AttachProvenance rounds the
            // timestep to 6 dp (0.0166667 -> 0.016667), so allow for that rounding —
            // well within the physics-timestep gate's 1e-4 comparison tolerance.
            Assert.AreEqual(0.0166667, r.Value<double>("projectFixedTimestepBeforeMeasurement"), 1e-6);
        }
    }
}
