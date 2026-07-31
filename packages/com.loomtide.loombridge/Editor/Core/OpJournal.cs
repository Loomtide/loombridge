using System;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// THE BRIDGE OP JOURNAL (evidence-trust wave, stage B1; ledger backlog 1).
    ///
    /// A bounded, in-memory, append-only record of every op the executor dispatched:
    /// what was called, when, on which frame, against which object, and a hash of the
    /// params. It exists because a self-consistent observation buffer with forged
    /// producer markers is undetectable offline. The journal does not make forgery
    /// impossible: a local process with write access can forge any file, and any script
    /// compiled into the project can call into this class. What it does is raise the
    /// COST, from typing one JSON file to forging N INDEPENDENT records that must agree
    /// (this journal's sequence, the recorder's drained buffers, the recorder's own
    /// continuity, the CLI's op log, the editor session id), each produced by a
    /// different code path.
    ///
    /// WHAT IT DOES NOT SURVIVE, recorded rather than papered over:
    ///   - a DOMAIN RELOAD wipes these statics. The journal comes back with a NEW
    ///     journalInstanceId and seq back at 0, which is exactly what a consumer needs:
    ///     an instanceId that changed between window open and window drain refuses,
    ///     because a reset must never read as a clean window;
    ///   - a RING WRAP is counted, never hidden (droppedEntries), and a window whose
    ///     requested range fell off the ring reports wrapped:true;
    ///   - an append that THROWS is swallowed (journaling must never fail the op it is
    ///     recording) but COUNTED in failedAppends, and it does not consume a sequence
    ///     number, so a swallowed failure can never masquerade as a clean gap.
    ///
    /// SEQ IS ASSIGNED LAST. The entry is fully built (hash, target resolution, clocks)
    /// before the lock is taken and the sequence number is minted, so seq is dense by
    /// construction: any hole in the sequence a consumer sees is a ring wrap, never a
    /// dropped write.
    /// </summary>
    [InitializeOnLoad]
    public static class OpJournal
    {
        /// <summary>
        /// Ring capacity, in ENTRIES.
        ///
        /// Size arithmetic, conservative: an entry is 4 value fields (seq 8B, tMs 8B,
        /// frameCount 4B, effectFrameCount 4B = 24B) plus 4 string references (32B on a
        /// 64-bit runtime) whose contents dominate: opName ~24 chars (~70B), opKind
        /// ~10 chars (interned constant, but count it at ~40B), targetDescriptor ~40
        /// chars (~100B), paramsSha256 exactly 64 chars (~150B). Round the whole entry
        /// UP to 200 bytes and 4096 entries is ~800 KB of managed memory held for the
        /// life of the editor session.
        ///
        /// 4096 is chosen against the workload rather than the memory: a full build
        /// slice (create + configure + a few hundred component writes) plus a play-mode
        /// observation window is low thousands of ops, so a window that matters fits
        /// without wrapping, and a session long enough to wrap says so.
        /// </summary>
        public const int Capacity = 4096;

        private const string LogPrefix = "[Loombridge]";

        private struct Entry
        {
            public long Seq;
            public double TMs;
            public int FrameCount;
            /// <summary>-1 means "no effect frame recorded" (a synchronous op).</summary>
            public int EffectFrameCount;
            public string OpName;
            public string OpKind;
            public string TargetDescriptor;
            public string ParamsSha256;
        }

        private static readonly Entry[] _ring = new Entry[Capacity];
        private static readonly object _lock = new object();
        private static readonly SHA256 _sha = SHA256.Create();

        private static string _instanceId;
        private static double _epochUnscaled;
        private static string _epochUtc;
        private static long _seq;
        private static long _failedAppends;
        private static bool _warnedOnce;

#if UNITY_INCLUDE_TESTS
        private static bool _faultNextAppend;
#endif

        static OpJournal()
        {
            InitInstance();
        }

        private static void InitInstance()
        {
            lock (_lock)
            {
                _instanceId = Guid.NewGuid().ToString();
                _epochUtc = DateTime.UtcNow.ToString("o");
                try
                {
                    _epochUnscaled = Time.unscaledTimeAsDouble;
                }
                catch
                {
                    // Time is main-thread only; a journal born off the main thread still
                    // gets an identity, and its tMs column is measured from zero.
                    _epochUnscaled = 0.0;
                }
                _seq = 0;
                _failedAppends = 0;
                _warnedOnce = false;
                Array.Clear(_ring, 0, Capacity);
            }
        }

        /// <summary>
        /// GUID minted when this journal instance came up. It changes on every domain
        /// reload and on every reset, which is the point: a consumer that captured it at
        /// window open and sees a different one at drain must refuse the window rather
        /// than read a fresh journal as a clean one.
        /// </summary>
        public static string InstanceId
        {
            get { lock (_lock) { return _instanceId; } }
        }

        /// <summary>UTC wall clock at journal init, so a consumer can map tMs to real time.</summary>
        public static string EpochUtc
        {
            get { lock (_lock) { return _epochUtc; } }
        }

        /// <summary>The last sequence number assigned; 0 when nothing has been journaled.</summary>
        public static long CurrentSeq
        {
            get { lock (_lock) { return _seq; } }
        }

        /// <summary>
        /// Appends one dispatched op and returns its sequence number, or 0 when the
        /// append failed (the caller must treat 0 as "not journaled" and skip the effect
        /// patch). NEVER throws: journaling an op must not be able to fail the op.
        /// </summary>
        public static long Append(string opName, JObject parameters)
        {
            try
            {
#if UNITY_INCLUDE_TESTS
                if (_faultNextAppend)
                {
                    _faultNextAppend = false;
                    throw new InvalidOperationException("Injected OpJournal fault (test seam).");
                }
#endif
                string kind = OpJournalOpTable.KindOf(opName);
                var entry = new Entry
                {
                    TMs = ElapsedMs(),
                    FrameCount = Time.frameCount,
                    EffectFrameCount = -1,
                    OpName = opName ?? string.Empty,
                    OpKind = kind,
                    TargetDescriptor = ResolveTargetDescriptor(opName, kind, parameters),
                    ParamsSha256 = HashParams(parameters),
                };

                lock (_lock)
                {
                    _seq++;
                    entry.Seq = _seq;
                    _ring[(int)((_seq - 1) % Capacity)] = entry;
                    return _seq;
                }
            }
            catch (Exception ex)
            {
                NoteFailure(ex);
                return 0;
            }
        }

        /// <summary>
        /// Records the frame on which an ASYNC op's completion callback ran, against the
        /// entry appended at dispatch. Silently does nothing when the sequence is 0 (the
        /// append failed) or when the entry has already fallen off the ring: a patch that
        /// cannot land is not an error, it is a wrapped journal, and the wrap is already
        /// counted.
        /// </summary>
        public static void RecordEffectFrame(long seq)
        {
            try
            {
                if (seq <= 0)
                    return;
                int frame = Time.frameCount;
                lock (_lock)
                {
                    int slot = (int)((seq - 1) % Capacity);
                    if (_ring[slot].Seq != seq)
                        return; // wrapped away
                    _ring[slot].EffectFrameCount = frame;
                }
            }
            catch (Exception ex)
            {
                NoteFailure(ex);
            }
        }

        /// <summary>
        /// Counters only, for a cheap poll at window open: journalInstanceId, seq,
        /// totalJournaled, droppedEntries, failedAppends, capacity, oldestRetainedSeq.
        /// <c>seq</c> and <c>totalJournaled</c> are equal BY CONSTRUCTION (every append
        /// mints exactly one sequence number); both are reported so a consumer can assert
        /// the invariant, which a hand-edited stats block will not generally satisfy.
        /// </summary>
        public static JObject Stats()
        {
            lock (_lock)
            {
                return new JObject
                {
                    ["journalInstanceId"] = _instanceId,
                    ["epochUtc"] = _epochUtc,
                    ["seq"] = _seq,
                    ["totalJournaled"] = _seq,
                    ["droppedEntries"] = DroppedLocked(),
                    ["failedAppends"] = _failedAppends,
                    ["capacity"] = Capacity,
                    ["oldestRetainedSeq"] = OldestRetainedSeqLocked(),
                    ["nowTMs"] = Math.Round(ElapsedMs(), 3),
                };
            }
        }

        /// <summary>
        /// A slice of the journal, oldest first. Exactly one selector may be supplied:
        /// <paramref name="fromSeq"/> (with an optional inclusive <paramref name="toSeq"/>)
        /// or <paramref name="fromTMs"/>. With neither, the whole retained ring is
        /// returned.
        ///
        /// <c>wrapped</c> is true when the REQUESTED range fell off the ring: the caller
        /// asked for entries the journal no longer holds, so the returned slice is not
        /// the whole story and must refuse rather than read as complete.
        /// </summary>
        public static JObject Window(long? fromSeq, long? toSeq, double? fromTMs)
        {
            lock (_lock)
            {
                long oldest = OldestRetainedSeqLocked();
                long newest = _seq;

                long start = fromSeq ?? oldest;
                long end = toSeq ?? newest;
                bool wrapped = false;

                if (fromSeq.HasValue && fromSeq.Value < oldest && _seq > 0)
                    wrapped = true;
                if (!fromSeq.HasValue && !fromTMs.HasValue && DroppedLocked() > 0)
                    wrapped = true;

                var entries = new JArray();
                // Sequence numbers begin at 1, so an EMPTY journal has oldest == 0 and
                // the floor of 1 is what keeps this loop from running at all (and from
                // indexing the ring at -1). Found by the EditMode swallow test, which is
                // the only case that reaches a window with nothing in it.
                long first = Math.Max(Math.Max(start, oldest), 1);
                for (long s = first; s <= end && s <= newest; s++)
                {
                    Entry e = _ring[(int)((s - 1) % Capacity)];
                    if (e.Seq != s)
                        continue; // defensive: only reachable if the ring moved under us
                    if (fromTMs.HasValue && e.TMs < fromTMs.Value)
                        continue;
                    entries.Add(ToJson(e));
                }

                if (fromTMs.HasValue && DroppedLocked() > 0)
                {
                    // The oldest retained entry starts AFTER the requested instant, so
                    // entries inside the requested range have already been overwritten.
                    Entry oldestEntry = _ring[(int)((oldest - 1) % Capacity)];
                    if (oldestEntry.Seq == oldest && oldestEntry.TMs > fromTMs.Value)
                        wrapped = true;
                }

                var requested = new JObject
                {
                    ["fromSeq"] = fromSeq.HasValue ? (JToken)fromSeq.Value : JValue.CreateNull(),
                    ["toSeq"] = toSeq.HasValue ? (JToken)toSeq.Value : JValue.CreateNull(),
                    ["fromTMs"] = fromTMs.HasValue ? (JToken)fromTMs.Value : JValue.CreateNull(),
                };

                return new JObject
                {
                    ["journalInstanceId"] = _instanceId,
                    ["epochUtc"] = _epochUtc,
                    ["seq"] = _seq,
                    ["totalJournaled"] = _seq,
                    ["droppedEntries"] = DroppedLocked(),
                    ["failedAppends"] = _failedAppends,
                    ["capacity"] = Capacity,
                    ["oldestRetainedSeq"] = oldest,
                    ["requested"] = requested,
                    ["wrapped"] = wrapped,
                    ["entries"] = entries,
                };
            }
        }

        // ─────────────────────────────────────────────
        // Internals
        // ─────────────────────────────────────────────

        private static JObject ToJson(Entry e)
        {
            return new JObject
            {
                ["seq"] = e.Seq,
                ["tMs"] = Math.Round(e.TMs, 3),
                ["frameCount"] = e.FrameCount,
                ["effectFrameCount"] = e.EffectFrameCount >= 0
                    ? (JToken)e.EffectFrameCount
                    : JValue.CreateNull(),
                ["opName"] = e.OpName,
                ["opKind"] = e.OpKind,
                ["targetDescriptor"] = string.IsNullOrEmpty(e.TargetDescriptor)
                    ? JValue.CreateNull()
                    : (JToken)e.TargetDescriptor,
                ["paramsSha256"] = e.ParamsSha256,
            };
        }

        private static long DroppedLocked()
        {
            return Math.Max(0, _seq - Capacity);
        }

        private static long OldestRetainedSeqLocked()
        {
            if (_seq <= 0)
                return 0;
            return _seq <= Capacity ? 1 : _seq - Capacity + 1;
        }

        private static double ElapsedMs()
        {
            try
            {
                return (Time.unscaledTimeAsDouble - _epochUnscaled) * 1000.0;
            }
            catch
            {
                return 0.0;
            }
        }

        /// <summary>
        /// SHA-256 (lowercase hex) of the UTF-8 bytes of the params object serialized
        /// with <c>Formatting.None</c>.
        ///
        /// NOT A CANONICALIZATION. Key order is whatever arrived on the wire, and no
        /// number/whitespace normalization happens, so two semantically identical
        /// param objects written in a different key order hash differently. That is
        /// deliberate: this hash exists to CROSS-BIND a journal entry to the CLI's own
        /// op log (re-hash the bytes the CLI sent and require agreement), and the CLI
        /// sends the same serialization it logged. It is not a content-addressing
        /// scheme and must never be used as one. Params themselves are never stored:
        /// no secrets, no bloat.
        /// </summary>
        private static string HashParams(JObject parameters)
        {
            string json = parameters == null ? "{}" : parameters.ToString(Formatting.None);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            byte[] hash;
            lock (_lock)
            {
                hash = _sha.ComputeHash(bytes);
            }
            var sb = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++)
                sb.Append(hash[i].ToString("x2"));
            return sb.ToString();
        }

        /// <summary>
        /// The resolved "Scene:/Path/To/Object[index]" of the op's PRIMARY target, for
        /// write-classified ops only. Null for reads (they are not bound to a target by
        /// this record), for write ops that have no locator parameter, and for targets
        /// that do not resolve. Never throws: an unresolvable target is reported as
        /// absent, and an absent target is never invented.
        /// </summary>
        private static string ResolveTargetDescriptor(string opName, string kind, JObject parameters)
        {
            try
            {
                if (kind == OpJournalOpTable.KindRead)
                    return null;
                if (parameters == null)
                    return null;
                string param = OpJournalOpTable.TargetParamOf(opName);
                if (string.IsNullOrEmpty(param))
                    return null;

                JToken token = parameters[param];
                if (token is JArray array)
                    token = array.Count > 0 ? array[0] : null; // the primary target is the first
                JObject locator = token as JObject;
                if (locator == null)
                    return null;

                GameObject go = LocatorResolver.Resolve(locator);
                if (go == null)
                    return null;
                JObject built = LocatorResolver.BuildLocator(go);
                if (built == null)
                    return null;
                string scene = built.Value<string>("scene");
                string path = built.Value<string>("path");
                if (string.IsNullOrEmpty(path))
                    return null;
                return string.IsNullOrEmpty(scene) ? path : scene + ":" + path;
            }
            catch
            {
                // An unresolvable locator throws (LOCATOR_UNRESOLVED); that is a null
                // descriptor, not a journal failure, so it is NOT counted as one.
                return null;
            }
        }

        private static void NoteFailure(Exception ex)
        {
            try
            {
                lock (_lock)
                {
                    _failedAppends++;
                    if (_warnedOnce)
                        return;
                    _warnedOnce = true;
                }
                Debug.LogWarning(
                    $"{LogPrefix} Op journal append failed and was swallowed (the op itself is unaffected): "
                    + $"{ex.GetType().Name}: {ex.Message}. Further failures are counted in journal.stats "
                    + "failedAppends rather than logged.");
            }
            catch
            {
                // Never let the failure path fail.
            }
        }

#if UNITY_INCLUDE_TESTS
        /// <summary>
        /// TEST SEAM. Drops the ring, resets the counters and mints a NEW instance id.
        ///
        /// The new id is not a convenience: a reset that KEPT the id would be a
        /// laundering path. This way a reset is indistinguishable from a domain reload to
        /// a consumer, which already refuses on an id change.
        ///
        /// The UNITY_INCLUDE_TESTS guard keeps this out of player builds. It does not
        /// keep it out of a consumer's EDITOR, and that is stated rather than implied:
        /// any script compiled into the project can call into an in-process journal, so
        /// the journal's value was never "unreachable", it is "one more independent
        /// record that has to agree with the others".
        /// </summary>
        public static void ResetForTests()
        {
            InitInstance();
        }

        /// <summary>TEST SEAM. Makes the next <see cref="Append"/> throw internally.</summary>
        public static void SimulateNextAppendFault()
        {
            _faultNextAppend = true;
        }

        /// <summary>TEST SEAM. Appends that threw and were swallowed.</summary>
        public static long FailedAppendsForTests
        {
            get { lock (_lock) { return _failedAppends; } }
        }
#endif
    }
}
