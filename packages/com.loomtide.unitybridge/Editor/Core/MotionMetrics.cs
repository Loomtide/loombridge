using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Pure motion-metric computation over a time-stamped position series.
    ///
    /// Separated from the sampling loop so the math is deterministic and unit-testable
    /// without a running editor. Used by runtime.measure_motion to derive game-feel
    /// metrics (jump apex height, time-to-apex, run speed) from a captured trajectory.
    /// </summary>
    public static class MotionMetrics
    {
        public struct Sample
        {
            public double TimeSeconds;
            public Vector3 Position;

            /// <summary>
            /// World rotation in degrees (<c>transform.eulerAngles</c>) at the sample time.
            /// 3D measurement substrate v2 — rotation/aim sampling: emitted per sample as
            /// <c>rx</c>/<c>ry</c>/<c>rz</c> so an offline rotation calculator (e.g.
            /// <c>aimTurnRateDegPerSec</c>) can re-derive an aim turn rate. Position-only
            /// callers leave this <see cref="Vector3.zero"/> (the value is additive provenance).
            /// </summary>
            public Vector3 EulerAngles;

            public Sample(double timeSeconds, Vector3 position)
                : this(timeSeconds, position, Vector3.zero)
            {
            }

            public Sample(double timeSeconds, Vector3 position, Vector3 eulerAngles)
            {
                TimeSeconds = timeSeconds;
                Position = position;
                EulerAngles = eulerAngles;
            }
        }

        /// <summary>
        /// Computes feel metrics from an ordered (by time) list of position samples.
        /// timeToApex is measured from the first sample to the sample with maximum Y.
        /// avgRunSpeed is absolute horizontal displacement over the sampled duration.
        ///
        /// S5c-b: when <paramref name="includeSamples"/> is true the raw trajectory is
        /// emitted (tMs relative to the first sample, x, y — the FeelTrajectorySample
        /// shape) so the offline re-derivation (feel-rederive / verify --profile §0)
        /// can re-compute each value from the raw samples and reject a tampered one.
        /// The optional fixed-timestep arguments are recorded as provenance so the
        /// physics-timestep gate can confirm the project's real physics rate; verify-
        /// first OBSERVES it (measure_motion never pins physics) so the "before" and
        /// "measurement" values are the same here.
        /// </summary>
        public static JObject Compute(
            IReadOnlyList<Sample> samples,
            bool includeSamples = false,
            double? projectFixedTimestep = null,
            double? measurementFixedTimestep = null)
        {
            if (samples == null || samples.Count == 0)
            {
                var empty = new JObject
                {
                    ["sampleCount"] = 0,
                    ["error"] = "no samples captured"
                };
                AttachProvenance(empty, samples, includeSamples, projectFixedTimestep, measurementFixedTimestep);
                return empty;
            }

            Sample first = samples[0];
            Sample last = samples[samples.Count - 1];

            double startT = first.TimeSeconds;
            float startX = first.Position.x;
            float startY = first.Position.y;
            float startZ = first.Position.z;
            float endX = last.Position.x;
            float endZ = last.Position.z;

            float peakY = startY;
            float minY = startY;
            double peakT = startT;

            foreach (Sample s in samples)
            {
                if (s.Position.y > peakY)
                {
                    peakY = s.Position.y;
                    peakT = s.TimeSeconds;
                }
                if (s.Position.y < minY)
                    minY = s.Position.y;
            }

            double durationSec = last.TimeSeconds - startT;
            double timeToApexMs = (peakT - startT) * 1000.0;
            float deltaX = endX - startX;
            float deltaZ = endZ - startZ;
            double avgRunSpeed = durationSec > 0 ? Mathf.Abs(deltaX) / durationSec : 0.0;
            // 3D measurement substrate v3: motion is no longer X/Y-only. A top-down / forward
            // (W=+Z) move used to read avgRunSpeed=0/deltaX=0 — a FALSE "motionless" report.
            // avgPlanarSpeed is ground-plane (XZ) displacement speed; speed3D is full 3D
            // displacement speed (includes vertical). Both are ADDITIVE — existing X/Y consumers
            // (avgRunSpeed/deltaX/peakY/timeToApexMs) are unchanged.
            double planarDisplacement = System.Math.Sqrt((double)deltaX * deltaX + (double)deltaZ * deltaZ);
            double avgPlanarSpeed = durationSec > 0 ? planarDisplacement / durationSec : 0.0;
            float deltaY3D = last.Position.y - startY;
            double spatialDisplacement = System.Math.Sqrt(
                (double)deltaX * deltaX + (double)deltaY3D * deltaY3D + (double)deltaZ * deltaZ);
            double speed3D = durationSec > 0 ? spatialDisplacement / durationSec : 0.0;

            var result = new JObject
            {
                ["startY"] = startY,
                ["peakY"] = peakY,
                ["deltaY"] = peakY - startY,
                ["minY"] = minY,
                ["timeToApexMs"] = System.Math.Round(timeToApexMs, 2),
                ["startX"] = startX,
                ["endX"] = endX,
                ["deltaX"] = deltaX,
                ["startZ"] = startZ,
                ["endZ"] = endZ,
                ["deltaZ"] = deltaZ,
                ["avgRunSpeed"] = System.Math.Round(avgRunSpeed, 4),
                ["avgPlanarSpeed"] = System.Math.Round(avgPlanarSpeed, 4),
                ["speed3D"] = System.Math.Round(speed3D, 4),
                ["durationMs"] = System.Math.Round(durationSec * 1000.0, 2),
                ["sampleCount"] = samples.Count
            };
            AttachProvenance(result, samples, includeSamples, projectFixedTimestep, measurementFixedTimestep);
            return result;
        }

        /// <summary>
        /// Appends S5c-b provenance to a computed result: the optional fixed-timestep
        /// fields (omitted when not supplied, so legacy callers are unchanged) and,
        /// when requested, the raw trajectory. tMs is relative to the first sample so
        /// it matches the FeelTrajectorySample contract the TS re-derivation consumes.
        /// </summary>
        private static void AttachProvenance(
            JObject result,
            IReadOnlyList<Sample> samples,
            bool includeSamples,
            double? projectFixedTimestep,
            double? measurementFixedTimestep)
        {
            if (projectFixedTimestep.HasValue)
                result["projectFixedTimestepBeforeMeasurement"] = System.Math.Round(projectFixedTimestep.Value, 6);
            if (measurementFixedTimestep.HasValue)
                result["measurementFixedTimestep"] = System.Math.Round(measurementFixedTimestep.Value, 6);

            if (!includeSamples)
                return;

            var arr = new JArray();
            if (samples != null && samples.Count > 0)
            {
                double startT = samples[0].TimeSeconds;
                foreach (Sample s in samples)
                {
                    arr.Add(new JObject
                    {
                        ["tMs"] = System.Math.Round((s.TimeSeconds - startT) * 1000.0, 2),
                        ["x"] = s.Position.x,
                        ["y"] = s.Position.y,
                        // 3D measurement substrate v1: emit z so a true {x,y,z} trajectory can be
                        // re-derived (e.g. a +Z projectile's speed). Additive — existing 2D
                        // consumers that read only x/y are unaffected.
                        ["z"] = s.Position.z,
                        // 3D measurement substrate v2: emit world rotation (eulerAngles, degrees)
                        // so a rotation/aim metric (e.g. aimTurnRateDegPerSec — yaw=ry) can be
                        // re-derived. Additive — position-only consumers ignore rx/ry/rz.
                        ["rx"] = s.EulerAngles.x,
                        ["ry"] = s.EulerAngles.y,
                        ["rz"] = s.EulerAngles.z
                    });
                }
            }
            result["samples"] = arr;
        }
    }
}
