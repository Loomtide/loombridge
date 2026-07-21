using System;
using System.Collections.Generic;

namespace UnityBridge.Core
{
    /// <summary>
    /// Pure, editor-free phase-scheduling logic for runtime.capture_input_motion.
    ///
    /// Separated from the sampling/injection loop so the "which keys should be held at
    /// elapsed time T" decision is deterministic and unit-testable without Play Mode.
    /// The live in-loop INJECTION itself (driving the controller as the sim ticks) is
    /// only provable on a real bridge and is NOT covered here.
    /// </summary>
    public static class CaptureInputMotion
    {
        /// <summary>One timed input phase: a set of KeyCode names held for durationMs.</summary>
        public struct Phase
        {
            /// <summary>KeyCode names held during this phase. Empty = a settle phase (no keys held).</summary>
            public IReadOnlyList<string> Keys;
            public double DurationMs;
            public double? RequestedFixedTicks;

            public Phase(IReadOnlyList<string> keys, double durationMs, double? requestedFixedTicks = null)
            {
                Keys = keys ?? Array.Empty<string>();
                DurationMs = durationMs;
                RequestedFixedTicks = requestedFixedTicks;
            }
        }

        /// <summary>
        /// Total duration of all phases in milliseconds.
        /// </summary>
        public static double TotalDurationMs(IReadOnlyList<Phase> phases)
        {
            if (phases == null)
                return 0;
            double total = 0;
            for (int i = 0; i < phases.Count; i++)
                total += phases[i].DurationMs;
            return total;
        }

        /// <summary>
        /// Index of the phase active at <paramref name="elapsedMs"/>. Phase boundaries are
        /// half-open [start, end): elapsed exactly AT a boundary picks the NEXT phase
        /// (matching runtime.probe's <c>elapsed &lt; cumulativeEnd</c> rule). Past the end of
        /// the last phase returns -1 (no active phase — the loop is finished). Returns -1
        /// for an empty/null phase list.
        /// </summary>
        public static int PhaseIndexAtElapsed(IReadOnlyList<Phase> phases, double elapsedMs)
        {
            if (phases == null || phases.Count == 0)
                return -1;
            if (elapsedMs < 0)
                return 0;

            double cumulativeEnd = 0;
            for (int i = 0; i < phases.Count; i++)
            {
                cumulativeEnd += phases[i].DurationMs;
                if (elapsedMs < cumulativeEnd)
                    return i;
            }
            return -1; // past the end of the final phase
        }

        /// <summary>
        /// The SET of KeyCode names that should be held at <paramref name="elapsedMs"/>.
        /// An empty-keys settle phase yields an empty set; past-the-end yields an empty set
        /// (every key released). The caller diffs this against the currently-held set and
        /// only injects the changes (idempotent, minimal churn).
        /// </summary>
        public static ISet<string> ActiveKeysAtElapsed(IReadOnlyList<Phase> phases, double elapsedMs)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            int index = PhaseIndexAtElapsed(phases, elapsedMs);
            if (index < 0)
                return result;

            IReadOnlyList<string> keys = phases[index].Keys;
            if (keys == null)
                return result;

            for (int i = 0; i < keys.Count; i++)
            {
                string key = keys[i];
                if (!string.IsNullOrEmpty(key))
                    result.Add(key);
            }
            return result;
        }
    }
}
