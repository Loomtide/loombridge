using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Tracks compilation events and provides compile results for attribution.
    /// Hooks into CompilationPipeline to capture per-assembly errors and overall completion.
    /// </summary>
    [InitializeOnLoad]
    public static class CompileWatcher
    {
        private static int _lastCompileId;
        private static long _lastCompileFinishedAtMs;
        private static JObject _lastCompileResult;
        private static readonly List<JObject> _pendingErrors = new List<JObject>();
        private static readonly object _lock = new object();

        static CompileWatcher()
        {
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            lock (_lock)
            {
                foreach (var msg in messages)
                {
                    if (msg.type == CompilerMessageType.Error)
                    {
                        _pendingErrors.Add(new JObject
                        {
                            ["file"] = msg.file,
                            ["line"] = msg.line,
                            ["column"] = msg.column,
                            ["message"] = msg.message
                        });
                    }
                }
            }
        }

        private static void OnCompilationFinished(object context)
        {
            lock (_lock)
            {
                _lastCompileId++;
                _lastCompileFinishedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                var errors = new JArray();
                foreach (var error in _pendingErrors)
                    errors.Add(error);

                _lastCompileResult = new JObject
                {
                    ["compileId"] = _lastCompileId,
                    ["finishedAtMs"] = _lastCompileFinishedAtMs,
                    ["succeeded"] = _pendingErrors.Count == 0,
                    ["errorCount"] = _pendingErrors.Count,
                    ["errors"] = errors
                };

                _pendingErrors.Clear();

                Debug.Log($"[Loombridge] Compilation finished (id: {_lastCompileId}, errors: {errors.Count})");
            }
        }

        /// <summary>
        /// Returns the last compile result, or null if no compilation has completed.
        /// </summary>
        public static JObject GetCompileResult()
        {
            lock (_lock)
            {
                return _lastCompileResult?.DeepClone() as JObject;
            }
        }

        /// <summary>
        /// GRL-B01: honest "is a compile error blocking the editor RIGHT NOW?" probe, for
        /// editor.play settle-failure attribution. A pre-existing compile error (in ANY assembly,
        /// including an EditMode test asmdef) silently blocks Play Mode — the bridge stays connected
        /// (no domain reload fires), so editor.play just times out settling and the old message
        /// misattributed it as "the bridge did not settle". Returns a structured block ONLY when a
        /// compile error is AFFIRMATIVELY present, else null (never a guess). Two sources:
        ///   1. EditorUtility.scriptCompilationFailed (reflected) — an internal flag that PERSISTS
        ///      across domain reloads, catching a pre-existing error from before the bridge loaded.
        ///   2. The last captured compile result this bridge session — carries per-assembly errors
        ///      (file/line/message) when a compilation actually ran while the watcher was alive.
        /// </summary>
        public static JObject GetCompileErrorState()
        {
            JObject lastResult;
            lock (_lock)
            {
                lastResult = _lastCompileResult?.DeepClone() as JObject;
            }

            bool lastResultFailed = lastResult != null && lastResult.Value<bool?>("succeeded") == false;
            bool? persistentFailed = TryGetScriptCompilationFailed();

            // Only claim a compile error when a source AFFIRMATIVELY reports one.
            if (persistentFailed != true && !lastResultFailed)
                return null;

            var block = new JObject
            {
                ["scriptCompilationFailed"] = persistentFailed.HasValue
                    ? (JToken)new JValue(persistentFailed.Value)
                    : JValue.CreateNull(),
            };

            if (lastResultFailed)
            {
                block["errorCount"] = lastResult["errorCount"];
                JArray errs = lastResult["errors"] as JArray;
                block["errors"] = errs != null ? TrimCompileErrors(errs) : new JArray();
                if (errs != null && errs.Count > 0)
                {
                    string firstFile = (errs[0] as JObject)?.Value<string>("file");
                    if (!string.IsNullOrEmpty(firstFile))
                        block["firstFile"] = firstFile;
                }
            }

            return block;
        }

        // Reflect the internal EditorUtility.scriptCompilationFailed flag (persists across domain
        // reloads). Returns null when the member is unavailable/changed so the caller stays honest
        // (unknown ≠ "no error") instead of throwing.
        private static bool? TryGetScriptCompilationFailed()
        {
            const System.Reflection.BindingFlags flags =
                System.Reflection.BindingFlags.Static
                | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Public;
            try
            {
                var prop = typeof(EditorUtility).GetProperty("scriptCompilationFailed", flags);
                if (prop != null && prop.PropertyType == typeof(bool))
                    return (bool)prop.GetValue(null);

                // Some Unity versions expose it as a field rather than a property.
                var field = typeof(EditorUtility).GetField("scriptCompilationFailed", flags);
                if (field != null && field.FieldType == typeof(bool))
                    return (bool)field.GetValue(null);
            }
            catch
            {
                // Member renamed/removed on this Unity version — report unknown, never guess.
            }
            return null;
        }

        // Keep the attribution block small: cap the number of errors and each message length.
        private static JArray TrimCompileErrors(JArray errors)
        {
            const int maxErrors = 5;
            const int maxMsgLen = 500;
            var trimmed = new JArray();
            int n = Math.Min(errors.Count, maxErrors);
            for (int i = 0; i < n; i++)
            {
                JObject e = errors[i] as JObject;
                if (e == null) continue;
                string msg = e.Value<string>("message") ?? "";
                if (msg.Length > maxMsgLen) msg = msg.Substring(0, maxMsgLen);
                trimmed.Add(new JObject
                {
                    ["file"] = e.Value<string>("file"),
                    ["line"] = e["line"],
                    ["column"] = e["column"],
                    ["message"] = msg
                });
            }
            return trimmed;
        }

        /// <summary>
        /// Returns the compile result ONLY if it finished at or after the given timestamp.
        /// This is the v2.3.1 compile attribution rule — ensures we only return
        /// compile results that are relevant to the operation that triggered them.
        /// </summary>
        public static JObject GetCompileResultIfAfter(long waitStartMs)
        {
            lock (_lock)
            {
                if (_lastCompileResult != null && _lastCompileFinishedAtMs >= waitStartMs)
                {
                    return _lastCompileResult.DeepClone() as JObject;
                }
                return null;
            }
        }
    }
}
