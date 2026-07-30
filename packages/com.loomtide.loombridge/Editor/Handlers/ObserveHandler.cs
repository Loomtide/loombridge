using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// THE PLAYABILITY OBSERVATION OPS (evidence arc stage 3; ledger L97/L98/L106/L122).
    ///
    /// Three ops around one runtime recorder (<c>PlayStateRecorderPump</c>, reached by
    /// reflection because it lives in the runtime observe assembly this Editor asmdef
    /// does not reference, exactly like <c>InputObserverBridge</c>):
    ///
    ///   observe.start   open a recording window. IDEMPOTENT: starting an already
    ///                   active recorder returns the LIVE session rather than
    ///                   restarting it, so a retried op cannot silently discard a
    ///                   window someone is mid-drive through. Reads the scene ONCE at
    ///                   open for the things the derivation has to bind to (the
    ///                   player's spawn, the goal, the respawn point, the collectible
    ///                   COUNT), so those numbers come from the bridge, never from an
    ///                   agent-authored file.
    ///   observe.status  counters only. It is polled while the agent plays, so it must
    ///                   stay cheap: no buffers cross the wire until the drain.
    ///   observe.drain   the whole window plus the recorder's OWN accounting (sample
    ///                   count, effective rate, dropped samples if the ring wrapped,
    ///                   fields it could not read), and then it stops. Destructive by
    ///                   construction: the buffers are released with the session.
    ///
    /// Everything here is a READ plus a buffer handoff. No op in this category judges
    /// the game: the derivation lives in the CLI (domain/playability-observation.ts)
    /// and is re-run by the gate over the same buffers.
    /// </summary>
    public class ObserveHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "start":
                    return HandleStart(parameters);
                case "status":
                    return HandleStatus();
                case "drain":
                    return HandleDrain();
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND, $"Unknown observe op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            onError(new BridgeException(ErrorCodes.NOT_FOUND, $"Observe op '{opName}' is not async."));
        }

        // ── start ────────────────────────────────────────────────────────────

        private JObject HandleStart(JObject parameters)
        {
            if (!EditorApplication.isPlaying)
                throw new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "observe.start requires Play Mode: the recorder samples the game's own Update loop. Enter play, then open the window.");

            string playerPath = RequireString(parameters, "playerPath");
            string statePath = RequireString(parameters, "statePath");
            string stateComponent = RequireString(parameters, "stateComponent");
            string winField = RequireString(parameters, "winField");
            string scoreField = RequireString(parameters, "scoreField");
            string livesField = RequireString(parameters, "livesField");
            int capacity = parameters?.Value<int?>("capacity") ?? 0;
            if (capacity < 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'capacity' must be >= 0 (0 uses the recorder's default ring size).");

            // Refuse a seam that does not resolve BEFORE opening a window: a recorder
            // that samples nulls for five minutes is a wasted drive, and its buffer
            // would refuse downstream anyway.
            GameObject player = ResolvePath(playerPath);
            if (player == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"observe.start: no GameObject at playerPath '{playerPath}' in the running scene(s).");
            GameObject stateObject = ResolvePath(statePath);
            if (stateObject == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"observe.start: no GameObject at statePath '{statePath}' in the running scene(s).");
            // The string GetComponent overload returns null for nested and some namespaced
            // types; resolve by type name over the live components (same rule as the pump's
            // FindComponentByTypeName, duplicated locally because this Editor asmdef does not
            // reference the runtime observe assembly and reaches the pump by reflection).
            Component state = FindComponentByTypeName(stateObject, stateComponent);
            if (state == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"observe.start: '{statePath}' carries no component named '{stateComponent}'.");
            foreach (string field in new[] { winField, scoreField, livesField })
            {
                if (!HasPublicMember(state, field))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"observe.start: '{stateComponent}' has no readable public field or property '{field}'. " +
                        "The recorder never coerces an unreadable field to a value, so a wrong name is refused here rather than recorded as false/0.");
            }

            if (PlayStateRecorderBridge.IsRecording())
            {
                // IDEMPOTENT: hand back the live session untouched.
                JObject live = BaseSessionInfo();
                live["started"] = false;
                live["alreadyRecording"] = true;
                live["note"] = "a recording session was already live; it was left running and its identity is returned unchanged.";
                return live;
            }

            string sessionId = Guid.NewGuid().ToString();
            PlayStateRecorderBridge.Begin(sessionId, playerPath, statePath, stateComponent,
                winField, scoreField, livesField, capacity);

            JObject result = BaseSessionInfo();
            result["started"] = true;
            result["alreadyRecording"] = false;
            result["startedAtUtc"] = DateTime.UtcNow.ToString("o");
            result["fixedTimestep"] = Math.Round((double)Time.fixedDeltaTime, 6);
            result["spawn"] = Vector(player.transform.position);
            result["initial"] = LatestSample();

            string goalPath = parameters?.Value<string>("goalPath");
            if (!string.IsNullOrEmpty(goalPath))
            {
                GameObject goal = ResolvePath(goalPath);
                if (goal == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"observe.start: no GameObject at goalPath '{goalPath}'; the reach-goal rule cannot be checked without it.");
                result["goal"] = Vector(goal.transform.position);
            }

            string respawnPath = parameters?.Value<string>("respawnPath");
            if (!string.IsNullOrEmpty(respawnPath))
            {
                GameObject respawn = ResolvePath(respawnPath);
                if (respawn == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"observe.start: no GameObject at respawnPath '{respawnPath}'.");
                result["respawn"] = Vector(respawn.transform.position);
            }

            string namePattern = parameters?.Value<string>("collectibleNamePattern");
            string tag = parameters?.Value<string>("collectibleTag");
            if (!string.IsNullOrEmpty(namePattern) || !string.IsNullOrEmpty(tag))
            {
                var paths = new List<string>();
                int inactive;
                int total = CountCollectibles(namePattern, tag, paths, out inactive);
                result["collectibleTotal"] = total;
                result["collectibleInactive"] = inactive;
                var arr = new JArray();
                foreach (string path in paths)
                    arr.Add(path);
                result["collectiblePaths"] = arr;
            }

            Debug.Log($"[Loombridge] observe.start: recording session {sessionId} (player '{playerPath}', state '{stateComponent}').");
            return result;
        }

        // ── status ───────────────────────────────────────────────────────────

        private JObject HandleStatus()
        {
            JObject result = BaseSessionInfo();
            result["latest"] = LatestSample();
            return result;
        }

        // ── drain ────────────────────────────────────────────────────────────

        private JObject HandleDrain()
        {
            // Liveness BEFORE collecting, the observe_stop lesson: recording=false with
            // an empty buffer means the recorder DIED (play exit, domain reload), which
            // must never read like a short clean window.
            bool wasRecording = PlayStateRecorderBridge.IsRecording();
            JObject result = BaseSessionInfo();
            result["wasRecording"] = wasRecording;
            result["samples"] = PlayStateRecorderBridge.CollectSamples();
            PlayStateRecorderBridge.End();
            result["recording"] = false;
            return result;
        }

        // ── shared readers ───────────────────────────────────────────────────

        /// <summary>Counters every response carries, so status and drain cannot disagree.</summary>
        private static JObject BaseSessionInfo()
        {
            int sampleCount = PlayStateRecorderBridge.GetSampleCount();
            long total = PlayStateRecorderBridge.GetTotalSampled();
            long dropped = PlayStateRecorderBridge.GetDroppedSamples();
            double elapsedMs = PlayStateRecorderBridge.GetElapsedMs();
            var result = new JObject
            {
                ["sessionId"] = PlayStateRecorderBridge.GetSessionId(),
                // The editor session the window belongs to: the co-temporality binding
                // (ledger L106, where three evidence files from three different play
                // sessions all carried the same runId and nothing noticed).
                ["editorSessionId"] = UnityBridgeBootstrap.Server != null ? UnityBridgeBootstrap.Server.SessionId : null,
                ["recording"] = PlayStateRecorderBridge.IsRecording(),
                ["sampleCount"] = sampleCount,
                ["totalSampled"] = total,
                ["droppedSamples"] = dropped,
                ["capacity"] = PlayStateRecorderBridge.GetCapacity(),
                ["fixedTickCount"] = PlayStateRecorderBridge.GetFixedTickCount(),
                ["elapsedMs"] = Math.Round(elapsedMs, 2),
                // The recorder's OWN rate accounting: N samples span N-1 intervals.
                ["effectiveSampleRateHz"] = sampleCount > 1 && elapsedMs > 0
                    ? (JToken)Math.Round((sampleCount - 1) / (elapsedMs / 1000.0), 3)
                    : JValue.CreateNull(),
                ["playMode"] = EditorApplication.isPlaying,
            };
            var unreadable = new JArray();
            foreach (string field in PlayStateRecorderBridge.GetUnreadableFields())
                unreadable.Add(field);
            result["unreadableFields"] = unreadable;
            return result;
        }

        /// <summary>
        /// The most recent sample, for the cheap poll (never the whole buffer). Returns
        /// an explicit JSON null rather than a C# null: assigning a null JToken to a
        /// JObject property is an ArgumentNullException, and "no sample yet" has to be
        /// reportable.
        /// </summary>
        private static JToken LatestSample()
        {
            JObject sample = PlayStateRecorderBridge.LatestSample();
            return sample != null ? (JToken)sample : JValue.CreateNull();
        }

        private static JObject Vector(Vector3 v)
        {
            return new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z };
        }

        private static string RequireString(JObject parameters, string name)
        {
            string value = parameters?.Value<string>(name);
            if (string.IsNullOrEmpty(value))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, $"Missing required parameter '{name}'.");
            return value;
        }

        private static bool HasPublicMember(Component component, string member)
        {
            Type type = component.GetType();
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;
            PropertyInfo property = type.GetProperty(member, flags);
            if (property != null && property.CanRead)
                return true;
            return type.GetField(member, flags) != null;
        }

        /// <summary>
        /// Resolve a hierarchy path, accepting both the bare "/A/B" form and the
        /// scene-qualified "Scene:/A/B" locator string the acceptance contract uses.
        /// </summary>
        private static GameObject ResolvePath(string path)
        {
            if (string.IsNullOrEmpty(path))
                return null;
            string scene = null;
            string hierarchy = path;
            int colon = path.IndexOf(":/", StringComparison.Ordinal);
            if (colon > 0)
            {
                scene = path.Substring(0, colon);
                hierarchy = path.Substring(colon + 1);
            }
            var locator = new JObject { ["path"] = hierarchy };
            if (!string.IsNullOrEmpty(scene))
                locator["scene"] = scene;
            GameObject resolved = LocatorResolver.Resolve(locator);
            if (resolved == null && !string.IsNullOrEmpty(scene))
            {
                // A scene-qualified locator whose scene name does not match the RUNNING
                // scene still names a real object; fall back to a scene-less resolve
                // rather than refusing on a stale scene label.
                resolved = LocatorResolver.Resolve(new JObject { ["path"] = hierarchy });
            }
            return resolved;
        }

        /// <summary>
        /// Count the scene's collectibles at window open: THE cross-check the score
        /// increments are bound to (review H7). Matching is a case-insensitive name
        /// substring and/or an exact tag, both declared by the harness. Inactive
        /// matches are counted separately rather than folded in, because a collectible
        /// that starts disabled is not one the player can collect.
        /// </summary>
        private static int CountCollectibles(string namePattern, string tag, List<string> paths, out int inactive)
        {
            inactive = 0;
            int total = 0;
            const int maxRecordedPaths = 200;
            for (int s = 0; s < SceneManager.sceneCount; s++)
            {
                Scene scene = SceneManager.GetSceneAt(s);
                if (!scene.IsValid() || !scene.isLoaded)
                    continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (Transform t in root.GetComponentsInChildren<Transform>(true))
                    {
                        GameObject go = t.gameObject;
                        if (!Matches(go, namePattern, tag))
                            continue;
                        if (!go.activeInHierarchy)
                        {
                            inactive++;
                            continue;
                        }
                        total++;
                        if (paths.Count < maxRecordedPaths)
                            paths.Add(LocatorResolver.BuildLocator(go).Value<string>("path"));
                    }
                }
            }
            return total;
        }

        private static bool Matches(GameObject go, string namePattern, string tag)
        {
            if (!string.IsNullOrEmpty(namePattern)
                && go.name.IndexOf(namePattern, StringComparison.OrdinalIgnoreCase) < 0)
                return false;
            if (!string.IsNullOrEmpty(tag))
            {
                try
                {
                    if (go.tag != tag)
                        return false;
                }
                catch
                {
                    // An undefined tag throws; treat it as no match rather than failing
                    // the whole count.
                    return false;
                }
            }
            return !string.IsNullOrEmpty(namePattern) || !string.IsNullOrEmpty(tag);
        }

        /// <summary>
        /// Resolve a component by type name (Type.Name, then FullName) over the live
        /// components: Unity's string GetComponent overload returns null for nested
        /// types and is fragile for namespaced ones.
        /// </summary>
        private static Component FindComponentByTypeName(GameObject go, string typeName)
        {
            if (go == null || string.IsNullOrEmpty(typeName))
                return null;
            foreach (Component component in go.GetComponents<Component>())
            {
                if (component == null)
                    continue;
                Type type = component.GetType();
                if (type.Name == typeName || type.FullName == typeName)
                    return component;
            }
            return null;
        }

        /// <summary>
        /// Reflection bridge to the runtime <c>PlayStateRecorderPump</c> (separate
        /// assembly, no Editor reference), mirroring <c>InputObserverBridge</c>.
        /// </summary>
        private static class PlayStateRecorderBridge
        {
            private static Type _type;
            private static MethodInfo _begin;
            private static MethodInfo _end;
            private static MethodInfo _isRecording;
            private static MethodInfo _getSessionId;
            private static MethodInfo _getSampleCount;
            private static MethodInfo _getTotalSampled;
            private static MethodInfo _getDropped;
            private static MethodInfo _getCapacity;
            private static MethodInfo _getFixedTickCount;
            private static MethodInfo _getUnreadableFields;
            private static MethodInfo _getTimesMs;
            private static MethodInfo _getFrames;
            private static MethodInfo _getFixedTicks;
            private static MethodInfo _getX;
            private static MethodInfo _getY;
            private static MethodInfo _getZ;
            private static MethodInfo _getWin;
            private static MethodInfo _getScore;
            private static MethodInfo _getLives;

            private static void Resolve()
            {
                if (_type != null)
                    return;
                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type candidate = assembly.GetType("UnityBridge.Runtime.PlayStateRecorderPump");
                    if (candidate == null)
                        continue;
                    _type = candidate;
                    break;
                }
                if (_type == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        "PlayStateRecorderPump was not found: the Loombridge runtime observe assembly is not loaded in this project.");

                const BindingFlags flags = BindingFlags.Public | BindingFlags.Static;
                _begin = _type.GetMethod("BeginRecording", flags);
                _end = _type.GetMethod("EndRecording", flags);
                _isRecording = _type.GetMethod("IsRecording", flags);
                _getSessionId = _type.GetMethod("GetSessionId", flags);
                _getSampleCount = _type.GetMethod("GetSampleCount", flags);
                _getTotalSampled = _type.GetMethod("GetTotalSampled", flags);
                _getDropped = _type.GetMethod("GetDroppedSamples", flags);
                _getCapacity = _type.GetMethod("GetCapacity", flags);
                _getFixedTickCount = _type.GetMethod("GetFixedTickCount", flags);
                _getUnreadableFields = _type.GetMethod("GetUnreadableFields", flags);
                _getTimesMs = _type.GetMethod("GetTimesMs", flags);
                _getFrames = _type.GetMethod("GetFrames", flags);
                _getFixedTicks = _type.GetMethod("GetFixedTicks", flags);
                _getX = _type.GetMethod("GetX", flags);
                _getY = _type.GetMethod("GetY", flags);
                _getZ = _type.GetMethod("GetZ", flags);
                _getWin = _type.GetMethod("GetWin", flags);
                _getScore = _type.GetMethod("GetScore", flags);
                _getLives = _type.GetMethod("GetLives", flags);
            }

            private static object Invoke(MethodInfo method, object[] args = null)
            {
                Resolve();
                if (method == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        "PlayStateRecorderPump is missing an expected member: the runtime assembly is out of sync with this Editor package.");
                return method.Invoke(null, args);
            }

            public static void Begin(string sessionId, string playerPath, string statePath, string stateComponent,
                string winField, string scoreField, string livesField, int capacity)
            {
                Resolve();
                Invoke(_begin, new object[]
                {
                    sessionId, playerPath, statePath, stateComponent, winField, scoreField, livesField, capacity
                });
            }

            public static void End()
            {
                Resolve();
                Invoke(_end);
            }

            public static bool IsRecording()
            {
                Resolve();
                return Invoke(_isRecording) is bool live && live;
            }

            public static string GetSessionId()
            {
                Resolve();
                return Invoke(_getSessionId) as string;
            }

            public static int GetSampleCount()
            {
                Resolve();
                return Convert.ToInt32(Invoke(_getSampleCount));
            }

            public static long GetTotalSampled()
            {
                Resolve();
                return Convert.ToInt64(Invoke(_getTotalSampled));
            }

            public static long GetDroppedSamples()
            {
                Resolve();
                return Convert.ToInt64(Invoke(_getDropped));
            }

            public static int GetCapacity()
            {
                Resolve();
                return Convert.ToInt32(Invoke(_getCapacity));
            }

            public static long GetFixedTickCount()
            {
                Resolve();
                return Convert.ToInt64(Invoke(_getFixedTickCount));
            }

            public static string[] GetUnreadableFields()
            {
                Resolve();
                return (string[])Invoke(_getUnreadableFields) ?? new string[0];
            }

            public static double GetElapsedMs()
            {
                double[] times = (double[])Invoke(_getTimesMs);
                if (times == null || times.Length < 1)
                    return 0;
                return times[times.Length - 1] - times[0];
            }

            /// <summary>The last sample as an object, for the cheap status poll.</summary>
            public static JObject LatestSample()
            {
                double[] times = (double[])Invoke(_getTimesMs);
                if (times == null || times.Length == 0)
                    return null;
                int last = times.Length - 1;
                int[] frames = (int[])Invoke(_getFrames);
                float[] xs = (float[])Invoke(_getX);
                float[] ys = (float[])Invoke(_getY);
                int[] wins = (int[])Invoke(_getWin);
                double[] scores = (double[])Invoke(_getScore);
                double[] lives = (double[])Invoke(_getLives);
                return new JObject
                {
                    ["tMs"] = Math.Round(times[last], 2),
                    ["frame"] = frames[last],
                    ["x"] = xs[last],
                    ["y"] = ys[last],
                    ["win"] = BoolToken(wins[last]),
                    ["score"] = NumberToken(scores[last]),
                    ["lives"] = NumberToken(lives[last]),
                };
            }

            /// <summary>
            /// The whole window as PARALLEL ARRAYS. Arrays rather than per-sample
            /// objects because a ten-minute window is tens of thousands of samples and
            /// the evidence file keeps every one: the continuity proof needs the frame
            /// a teleport would hide in, so nothing is decimated.
            /// </summary>
            public static JObject CollectSamples()
            {
                double[] times = (double[])Invoke(_getTimesMs);
                if (times == null)
                    return new JObject();
                int[] frames = (int[])Invoke(_getFrames);
                long[] fixedTicks = (long[])Invoke(_getFixedTicks);
                float[] xs = (float[])Invoke(_getX);
                float[] ys = (float[])Invoke(_getY);
                float[] zs = (float[])Invoke(_getZ);
                int[] wins = (int[])Invoke(_getWin);
                double[] scores = (double[])Invoke(_getScore);
                double[] lives = (double[])Invoke(_getLives);

                var tArr = new JArray();
                var frameArr = new JArray();
                var tickArr = new JArray();
                var xArr = new JArray();
                var yArr = new JArray();
                var zArr = new JArray();
                var winArr = new JArray();
                var scoreArr = new JArray();
                var livesArr = new JArray();
                for (int i = 0; i < times.Length; i++)
                {
                    tArr.Add(Math.Round(times[i], 3));
                    frameArr.Add(frames[i]);
                    tickArr.Add(fixedTicks[i]);
                    xArr.Add(xs[i]);
                    yArr.Add(ys[i]);
                    zArr.Add(zs[i]);
                    winArr.Add(BoolToken(wins[i]));
                    scoreArr.Add(NumberToken(scores[i]));
                    livesArr.Add(NumberToken(lives[i]));
                }
                return new JObject
                {
                    ["tMs"] = tArr,
                    ["frame"] = frameArr,
                    ["fixedTick"] = tickArr,
                    ["x"] = xArr,
                    ["y"] = yArr,
                    ["z"] = zArr,
                    ["win"] = winArr,
                    ["score"] = scoreArr,
                    ["lives"] = livesArr,
                };
            }

            /// <summary>1/0 map to true/false; the -1 sentinel maps to JSON null (unreadable).</summary>
            private static JToken BoolToken(int value)
            {
                if (value == 1)
                    return new JValue(true);
                if (value == 0)
                    return new JValue(false);
                return JValue.CreateNull();
            }

            /// <summary>A NaN sentinel maps to JSON null: an unread field is never a 0.</summary>
            private static JToken NumberToken(double value)
            {
                if (double.IsNaN(value) || double.IsInfinity(value))
                    return JValue.CreateNull();
                return new JValue(value);
            }
        }
    }
}
