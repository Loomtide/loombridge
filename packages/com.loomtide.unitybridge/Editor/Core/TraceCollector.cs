using System;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Console log ring buffer with op-scoped trace collection.
    /// Hooks Application.logMessageReceived to capture all console output.
    /// Thread-safe: the log callback fires from background threads.
    /// </summary>
    [InitializeOnLoad]
    public static class TraceCollector
    {
        private const int BufferSize = 1000;
        private const string ScreenshotDir = "Logs/UnityBridge/screenshots";

        // Ring buffer
        private static readonly LogEntry[] _buffer = new LogEntry[BufferSize];
        private static int _writeIndex;
        private static int _totalCount;
        private static readonly object _bufferLock = new object();

        /// <summary>
        /// Captures buffer state at BeginOp time. Safe for concurrent/overlapping ops.
        /// </summary>
        public struct TraceScope
        {
            internal int Mark;
            internal int TotalAtMark;
            internal string OpName;
        }

        private struct LogEntry
        {
            public string Type;
            public string Message;
            public string StackTrace;
            public long Timestamp;
        }

        static TraceCollector()
        {
            Application.logMessageReceived += OnLogMessage;
        }

        // ─────────────────────────────────────────────
        // Log Capture
        // ─────────────────────────────────────────────

        private static void OnLogMessage(string message, string stackTrace, LogType logType)
        {
            string type;
            switch (logType)
            {
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert:
                    type = "error";
                    break;
                case LogType.Warning:
                    type = "warning";
                    break;
                default:
                    type = "log";
                    break;
            }

            lock (_bufferLock)
            {
                _buffer[_writeIndex] = new LogEntry
                {
                    Type = type,
                    Message = message,
                    StackTrace = stackTrace,
                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                _writeIndex = (_writeIndex + 1) % BufferSize;
                _totalCount++;
            }
        }

        // ─────────────────────────────────────────────
        // Op Scope
        // ─────────────────────────────────────────────

        /// <summary>
        /// Marks the current buffer position as the start of an operation.
        /// Returns a TraceScope token that must be passed to EndOp.
        /// Safe for concurrent/overlapping ops — each scope captures its own mark.
        /// </summary>
        public static TraceScope BeginOp(string opName)
        {
            lock (_bufferLock)
            {
                return new TraceScope
                {
                    Mark = _writeIndex,
                    TotalAtMark = _totalCount,
                    OpName = opName
                };
            }
        }

        /// <summary>
        /// Returns a trace JObject with all console entries since the given scope's BeginOp.
        /// </summary>
        public static JObject EndOp(TraceScope scope)
        {
            lock (_bufferLock)
            {
                int entriesSinceMark = _totalCount - scope.TotalAtMark;
                if (entriesSinceMark <= 0)
                {
                    return new JObject { ["consoleDelta"] = new JArray() };
                }

                // Clamp to buffer size
                if (entriesSinceMark > BufferSize)
                    entriesSinceMark = BufferSize;

                var consoleDelta = new JArray();
                int startIndex = (_writeIndex - entriesSinceMark + BufferSize) % BufferSize;

                for (int i = 0; i < entriesSinceMark; i++)
                {
                    int idx = (startIndex + i) % BufferSize;
                    var entry = _buffer[idx];
                    if (entry.Message == null)
                        continue;

                    consoleDelta.Add(new JObject
                    {
                        ["type"] = entry.Type,
                        ["message"] = entry.Message,
                        ["stackTrace"] = entry.StackTrace ?? "",
                        ["timestamp"] = entry.Timestamp
                    });
                }

                return new JObject { ["consoleDelta"] = consoleDelta };
            }
        }

        /// <summary>
        /// Attaches an artifact (e.g., error screenshot) to a trace JObject.
        /// </summary>
        public static void AttachArtifact(JObject trace, JObject artifact)
        {
            if (artifact == null || trace == null) return;
            JArray artifacts = trace["artifacts"] as JArray;
            if (artifacts == null)
            {
                artifacts = new JArray();
                trace["artifacts"] = artifacts;
            }
            artifacts.Add(artifact);
        }

        // ─────────────────────────────────────────────
        // Public API
        // ─────────────────────────────────────────────

        /// <summary>
        /// Returns the last N log entries as a JArray.
        /// </summary>
        public static JArray GetRecentLogs(int count)
        {
            lock (_bufferLock)
            {
                int available = Math.Min(count, Math.Min(_totalCount, BufferSize));
                var result = new JArray();

                int startIndex = (_writeIndex - available + BufferSize) % BufferSize;
                for (int i = 0; i < available; i++)
                {
                    int idx = (startIndex + i) % BufferSize;
                    var entry = _buffer[idx];
                    if (entry.Message == null)
                        continue;

                    result.Add(new JObject
                    {
                        ["type"] = entry.Type,
                        ["message"] = entry.Message,
                        ["stackTrace"] = entry.StackTrace ?? "",
                        ["timestamp"] = entry.Timestamp
                    });
                }

                return result;
            }
        }

        /// <summary>
        /// GRL-B03: like GetRecentLogs(count) but with a severity filter — collects up to `count` of
        /// the MOST RECENT entries whose type matches `severity` (one of error/warning/log; null =
        /// any), returned oldest→newest (chronological), same per-entry shape. Walking newest-first
        /// BEFORE taking `count` means an errors-only request returns the last N ERRORS, not "errors
        /// that happen to fall within the last N entries of any type".
        /// </summary>
        public static JArray GetRecentLogs(int count, string severity)
        {
            if (severity == null)
                return GetRecentLogs(count);

            lock (_bufferLock)
            {
                var collected = new System.Collections.Generic.List<JObject>();
                int available = Math.Min(_totalCount, BufferSize);
                for (int i = 0; i < available && collected.Count < count; i++)
                {
                    int idx = (_writeIndex - 1 - i + BufferSize) % BufferSize;
                    var entry = _buffer[idx];
                    if (entry.Message == null) continue;
                    if (entry.Type != severity) continue;
                    collected.Add(new JObject
                    {
                        ["type"] = entry.Type,
                        ["message"] = entry.Message,
                        ["stackTrace"] = entry.StackTrace ?? "",
                        ["timestamp"] = entry.Timestamp
                    });
                }
                collected.Reverse(); // chronological (oldest → newest), matching GetRecentLogs(count)
                var result = new JArray();
                foreach (var e in collected) result.Add(e);
                return result;
            }
        }

        /// <summary>
        /// Summarizes error/exception/assert entries currently in the buffer: a count plus the most
        /// recent one (message + first stack line). Reflects errors since the last ClearLogs() — clear
        /// the console before entering Play Mode, then read this to know if anything threw. Surfaced by
        /// editor.get_state so play-mode exceptions are impossible to miss (the agent doesn't have to
        /// remember to pull console_logs).
        /// </summary>
        public static JObject GetErrorSummary()
        {
            lock (_bufferLock)
            {
                int count = 0;
                LogEntry last = default;
                bool hasLast = false;

                int available = Math.Min(_totalCount, BufferSize);
                int startIndex = (_writeIndex - available + BufferSize) % BufferSize;
                for (int i = 0; i < available; i++)
                {
                    int idx = (startIndex + i) % BufferSize;
                    var entry = _buffer[idx];
                    if (entry.Message == null || entry.Type != "error")
                        continue;
                    count++;
                    last = entry;
                    hasLast = true;
                }

                var summary = new JObject { ["error_count"] = count };
                if (hasLast)
                {
                    string msg = last.Message ?? "";
                    if (msg.Length > 500) msg = msg.Substring(0, 500);
                    string stackFirstLine = string.IsNullOrEmpty(last.StackTrace)
                        ? ""
                        : last.StackTrace.Split('\n')[0];
                    summary["last_error"] = new JObject
                    {
                        ["message"] = msg,
                        ["stackTrace"] = stackFirstLine
                    };
                }
                return summary;
            }
        }

        /// <summary>
        /// Clears all log entries from the buffer.
        /// </summary>
        public static void ClearLogs()
        {
            lock (_bufferLock)
            {
                Array.Clear(_buffer, 0, BufferSize);
                _writeIndex = 0;
                _totalCount = 0;
            }
        }

        /// <summary>
        /// Logs deterministic input action diagnostics that are captured by consoleDelta traces.
        /// </summary>
        public static void LogInputAction(string action, string backend, string sessionId, string key = null)
        {
            string keyFragment = string.IsNullOrEmpty(key) ? string.Empty : $" key={key}";
            Debug.Log($"[UnityBridge] input action={action} backend={backend ?? "unknown"} session={sessionId ?? ""}{keyFragment}");
        }

        /// <summary>
        /// Logs deterministic input failure diagnostics with structured error code context.
        /// </summary>
        public static void LogInputFailure(
            string action,
            string backend,
            string sessionId,
            string errorCode,
            string message)
        {
            Debug.LogWarning(
                $"[UnityBridge] input failure action={action} backend={backend ?? "unknown"} "
                + $"session={sessionId ?? ""} code={errorCode ?? "UNKNOWN"} message={message ?? ""}");
        }

        /// <summary>
        /// Captures a screenshot from the Scene View on error.
        /// Must be called on the main thread. Returns null if SceneView is unavailable.
        /// </summary>
        public static JObject CaptureErrorScreenshot(string opName)
        {
            try
            {
                SceneView sceneView = SceneView.lastActiveSceneView;
                if (sceneView == null || sceneView.camera == null)
                    return null;

                Camera cam = sceneView.camera;
                int srcWidth = (int)cam.pixelRect.width;
                int srcHeight = (int)cam.pixelRect.height;

                if (srcWidth <= 0 || srcHeight <= 0)
                    return null;

                // Render to temporary RenderTexture
                RenderTexture rt = new RenderTexture(srcWidth, srcHeight, 24, RenderTextureFormat.ARGB32);
                rt.antiAliasing = 1;

                RenderTexture previousTarget = cam.targetTexture;
                RenderTexture previousActive = RenderTexture.active;

                try
                {
                    cam.targetTexture = rt;
                    cam.Render();

                    // Scale down if large
                    int maxWidth = 1024;
                    int finalWidth = srcWidth;
                    int finalHeight = srcHeight;

                    if (srcWidth > maxWidth)
                    {
                        float aspect = (float)srcHeight / srcWidth;
                        finalWidth = maxWidth;
                        finalHeight = Mathf.RoundToInt(maxWidth * aspect);
                    }

                    Texture2D outputTex;

                    if (finalWidth != srcWidth)
                    {
                        RenderTexture resizedRt = new RenderTexture(finalWidth, finalHeight, 0, RenderTextureFormat.ARGB32);
                        Graphics.Blit(rt, resizedRt);
                        RenderTexture.active = resizedRt;
                        outputTex = new Texture2D(finalWidth, finalHeight, TextureFormat.RGB24, false);
                        outputTex.ReadPixels(new Rect(0, 0, finalWidth, finalHeight), 0, 0);
                        outputTex.Apply();
                        RenderTexture.active = null;
                        resizedRt.Release();
                        UnityEngine.Object.DestroyImmediate(resizedRt);
                    }
                    else
                    {
                        RenderTexture.active = rt;
                        outputTex = new Texture2D(finalWidth, finalHeight, TextureFormat.RGB24, false);
                        outputTex.ReadPixels(new Rect(0, 0, finalWidth, finalHeight), 0, 0);
                        outputTex.Apply();
                    }

                    byte[] jpg = outputTex.EncodeToJPG(75);
                    UnityEngine.Object.DestroyImmediate(outputTex);

                    // Save to disk
                    string safeOpName = opName.Replace('.', '_').Replace('/', '_');
                    string timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
                    string fileName = $"error_{timestamp}_{safeOpName}.jpg";

                    if (!Directory.Exists(ScreenshotDir))
                        Directory.CreateDirectory(ScreenshotDir);

                    string filePath = Path.Combine(ScreenshotDir, fileName);
                    File.WriteAllBytes(filePath, jpg);

                    return new JObject
                    {
                        ["kind"] = "screenshot",
                        ["sourcePath"] = filePath,
                        ["format"] = "jpeg",
                        ["width"] = finalWidth,
                        ["height"] = finalHeight,
                        ["sizeBytes"] = jpg.Length,
                        ["description"] = "Auto-captured on op failure"
                    };
                }
                finally
                {
                    cam.targetTexture = previousTarget;
                    RenderTexture.active = previousActive;
                    rt.Release();
                    UnityEngine.Object.DestroyImmediate(rt);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[UnityBridge] Error screenshot capture failed: {ex.Message}");
                return null;
            }
        }
    }
}
