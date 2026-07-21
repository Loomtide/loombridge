using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Deterministic wait system. Polls conditions each EditorApplication.update tick
    /// and resolves when all conditions are met or timeout is exceeded.
    /// Supports multiple concurrent waits.
    /// </summary>
    public static class WaitEngine
    {
        private static readonly List<ActiveWait> _activeWaits = new List<ActiveWait>();
        private static bool _isHooked;

        private class ActiveWait
        {
            public JObject Condition;
            public Action<JObject> OnComplete;
            public Action<BridgeException> OnError;
            public long WaitStartMs;
            public long TimeoutMs;
            public int RemainingFrames;
            public long DelayUntilMs;
            public bool IsCompleted;
            public Func<bool> Predicate;
            public Func<JObject> ResultFactory;
            public Func<string> TimeoutMessageFactory;
        }

        /// <summary>
        /// Starts a wait that polls each update tick until all conditions are met.
        /// Conditions object may contain:
        ///   - compiling (bool): wait until EditorApplication.isCompiling matches
        ///   - updating (bool): wait until EditorApplication.isUpdating matches
        ///   - playMode (string): "playing", "paused", or "stopped"
        ///   - frames (int): wait N editor frames before evaluating completion
        ///   - delayMs (long): wait at least N milliseconds before evaluating completion
        ///     If both frames and delayMs are specified, both conditions must be satisfied.
        ///   - timeoutMs (long): maximum wait time in milliseconds (default 30000)
        /// </summary>
        public static void WaitFor(JObject condition, Action<JObject> onComplete, Action<BridgeException> onError)
        {
            WaitFor(condition, null, null, null, onComplete, onError);
        }

        /// <summary>
        /// Starts a wait with an optional predicate evaluated after built-in condition checks.
        /// When predicate is supplied, the wait completes only when both built-in conditions
        /// and predicate evaluate true.
        /// </summary>
        public static void WaitFor(
            JObject condition,
            Func<bool> predicate,
            Func<JObject> resultFactory,
            Func<string> timeoutMessageFactory,
            Action<JObject> onComplete,
            Action<BridgeException> onError)
        {
            JObject conditionCopy = condition?.DeepClone() as JObject ?? new JObject();
            long timeoutMs = conditionCopy.Value<long?>("timeoutMs") ?? 30000;
            int frames = conditionCopy.Value<int?>("frames") ?? 0;
            long delayMs = conditionCopy.Value<long?>("delayMs") ?? 0;

            if (frames < 0)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'frames' must be >= 0.");
            }

            if (delayMs < 0)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'delayMs' must be >= 0.");
            }

            long waitStartMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            var wait = new ActiveWait
            {
                Condition = conditionCopy,
                OnComplete = onComplete,
                OnError = onError,
                WaitStartMs = waitStartMs,
                TimeoutMs = timeoutMs,
                RemainingFrames = frames,
                DelayUntilMs = delayMs > 0 ? waitStartMs + delayMs : 0,
                IsCompleted = false,
                Predicate = predicate,
                ResultFactory = resultFactory,
                TimeoutMessageFactory = timeoutMessageFactory
            };

            _activeWaits.Add(wait);
            EnsureHooked();
        }

        private static void EnsureHooked()
        {
            if (!_isHooked)
            {
                EditorApplication.update += PollAllWaits;
                _isHooked = true;
            }
        }

        private static void PollAllWaits()
        {
            // Process in reverse so removal is safe
            for (int i = _activeWaits.Count - 1; i >= 0; i--)
            {
                var wait = _activeWaits[i];
                if (wait.IsCompleted)
                {
                    _activeWaits.RemoveAt(i);
                    continue;
                }

                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long elapsed = now - wait.WaitStartMs;

                // Check timeout
                if (elapsed > wait.TimeoutMs)
                {
                    string timeoutMessage = wait.TimeoutMessageFactory != null
                        ? wait.TimeoutMessageFactory()
                        : null;
                    if (string.IsNullOrEmpty(timeoutMessage))
                        timeoutMessage = $"Wait timed out after {elapsed}ms (timeout: {wait.TimeoutMs}ms)";

                    wait.IsCompleted = true;
                    _activeWaits.RemoveAt(i);
                    try
                    {
                        wait.OnError(new BridgeException(ErrorCodes.TIMEOUT, timeoutMessage));
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[UnityBridge] WaitEngine error callback threw: {ex.Message}");
                    }
                    continue;
                }

                // Check all conditions
                if (wait.DelayUntilMs > 0 && now < wait.DelayUntilMs)
                    continue;

                if (wait.RemainingFrames > 0)
                {
                    wait.RemainingFrames--;
                    continue;
                }

                if (!CheckConditions(wait.Condition))
                    continue;

                if (wait.Predicate != null)
                {
                    bool predicateSatisfied;
                    try
                    {
                        predicateSatisfied = wait.Predicate();
                    }
                    catch (BridgeException bex)
                    {
                        wait.IsCompleted = true;
                        _activeWaits.RemoveAt(i);
                        try
                        {
                            wait.OnError(bex);
                        }
                        catch (Exception ex)
                        {
                            Debug.LogError($"[UnityBridge] WaitEngine error callback threw: {ex.Message}");
                        }
                        continue;
                    }
                    catch (Exception ex)
                    {
                        wait.IsCompleted = true;
                        _activeWaits.RemoveAt(i);
                        try
                        {
                            wait.OnError(new BridgeException(
                                ErrorCodes.INVALID_PARAMS,
                                $"Wait predicate failed: {ex.Message}",
                                ex));
                        }
                        catch (Exception callbackEx)
                        {
                            Debug.LogError($"[UnityBridge] WaitEngine error callback threw: {callbackEx.Message}");
                        }
                        continue;
                    }

                    if (!predicateSatisfied)
                        continue;
                }

                // All conditions met
                wait.IsCompleted = true;
                _activeWaits.RemoveAt(i);

                long waitedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - wait.WaitStartMs;

                var result = new JObject
                {
                    ["waited_ms"] = waitedMs
                };

                // Check for compile result attributed to this wait
                JObject compileResult = CompileWatcher.GetCompileResultIfAfter(wait.WaitStartMs);
                if (compileResult != null)
                {
                    result["compileResult"] = compileResult;
                }

                // Play-mode compile-deferral hint (INFORMATIONAL). A caller that waited for
                // { compiling: false } to confirm a script edit landed can be misled in
                // Play Mode: Unity does NOT recompile edited scripts while playing, so the
                // condition resolves WITHOUT a compilation having run. We CANNOT tell an
                // edited-during-play wait apart from an innocent play-mode settle wait (no
                // cheap pending-recompile signal exists), so the hint fires on BOTH shapes
                // and its message is explicitly conditional — it never asserts that edits
                // exist, and never prescribes stopping Play Mode unconditionally.
                JObject deferredHint = BuildCompileDeferredHint(
                    wait.Condition, EditorApplication.isPlaying, compileResult != null);
                if (deferredHint != null)
                {
                    foreach (JProperty prop in deferredHint.Properties())
                        result[prop.Name] = prop.Value;
                }

                if (wait.ResultFactory != null)
                {
                    try
                    {
                        JObject customResult = wait.ResultFactory();
                        if (customResult != null)
                        {
                            foreach (JProperty prop in customResult.Properties())
                                result[prop.Name] = prop.Value;
                        }
                    }
                    catch (BridgeException bex)
                    {
                        try
                        {
                            wait.OnError(bex);
                        }
                        catch (Exception ex)
                        {
                            Debug.LogError($"[UnityBridge] WaitEngine error callback threw: {ex.Message}");
                        }
                        continue;
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            wait.OnError(new BridgeException(
                                ErrorCodes.INVALID_PARAMS,
                                $"Wait result evaluation failed: {ex.Message}",
                                ex));
                        }
                        catch (Exception callbackEx)
                        {
                            Debug.LogError($"[UnityBridge] WaitEngine error callback threw: {callbackEx.Message}");
                        }
                        continue;
                    }
                }

                try
                {
                    wait.OnComplete(result);
                }
                catch (Exception ex)
                {
                    Debug.LogError($"[UnityBridge] WaitEngine complete callback threw: {ex.Message}");
                }
            }

            // Unhook if no more active waits
            if (_activeWaits.Count == 0 && _isHooked)
            {
                EditorApplication.update -= PollAllWaits;
                _isHooked = false;
            }
        }

        /// <summary>
        /// Checks whether all specified conditions are currently met.
        /// </summary>
        private static bool CheckConditions(JObject condition)
        {
            // Check compiling condition
            if (condition["compiling"] != null)
            {
                bool wantCompiling = condition.Value<bool>("compiling");
                if (EditorApplication.isCompiling != wantCompiling)
                    return false;
            }

            // Check updating condition
            if (condition["updating"] != null)
            {
                bool wantUpdating = condition.Value<bool>("updating");
                if (EditorApplication.isUpdating != wantUpdating)
                    return false;
            }

            // Check playMode condition
            string wantPlayMode = condition.Value<string>("playMode");
            if (!string.IsNullOrEmpty(wantPlayMode))
            {
                string currentPlayMode;
                if (EditorApplication.isPlaying)
                {
                    currentPlayMode = EditorApplication.isPaused ? "paused" : "playing";
                }
                else
                {
                    currentPlayMode = "stopped";
                }

                if (currentPlayMode != wantPlayMode)
                    return false;
            }

            return true;
        }

        /// <summary>
        /// Builds the play-mode compile-deferral advisory, or null when it does not apply.
        /// Pure (reads no editor state) so it is unit-testable offline — the live PollAllWaits
        /// passes <see cref="EditorApplication.isPlaying"/> and whether a compilation was
        /// attributed to the wait.
        ///
        /// The hint is INFORMATIONAL, not a defect signal. Unity exposes no cheap "pending
        /// script recompile queued" flag (script-asset imports themselves are restricted during
        /// play, so an AssetPostprocessor-based "did a .cs change since play started?" tracker
        /// is not reliable either), so we CANNOT distinguish "the caller edited scripts during
        /// Play Mode" (where the wait is misleading — Unity defers compilation until Play Mode
        /// stops) from "an innocent play-mode settle wait" (the NORMAL outcome of every explicit
        /// play-mode { compiling:false } wait). The hint therefore fires on any wait where:
        ///   - the caller waited for <c>{ compiling: false }</c>,
        ///   - the editor is in Play Mode, and
        ///   - NO compilation was attributed to this wait
        /// and its message is explicitly CONDITIONAL: it states only what this wait cannot
        /// prove, tells the caller when it applies (they edited scripts during play) and when to
        /// ignore it (they didn't), and never prescribes stopping Play Mode unconditionally.
        /// </summary>
        public static JObject BuildCompileDeferredHint(JObject condition, bool isPlaying, bool compileAttributed)
        {
            if (condition == null)
                return null;
            if (condition["compiling"] == null)
                return null;

            bool wantCompiling;
            try
            {
                wantCompiling = condition.Value<bool>("compiling");
            }
            catch (Exception)
            {
                return null;
            }

            // Only the "wait until NOT compiling" intent is at risk of the false-confirm.
            if (wantCompiling)
                return null;
            if (!isPlaying)
                return null;
            if (compileAttributed)
                return null;

            return new JObject
            {
                ["compileDeferred"] = true,
                ["compileDeferredMessage"] =
                    "No compilation occurred during this play-mode wait. NOTE: if you edited " +
                    "scripts during Play Mode, Unity defers their compilation until Play Mode " +
                    "stops — this wait CANNOT confirm such edits compiled (after you exit Play " +
                    "Mode, wait_for { compiling: false } again and read compileResult). If you " +
                    "did not edit scripts, this is the normal play-mode settle result — ignore " +
                    "this hint."
            };
        }
    }
}
