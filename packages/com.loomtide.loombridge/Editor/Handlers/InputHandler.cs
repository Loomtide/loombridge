using System;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityBridge.Core;
using UnityBridge.Core.Input;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles input automation operations.
    /// </summary>
    public class InputHandler : IOpHandler
    {
        private readonly InputService _inputService;

        public InputHandler() : this(new InputService(new IInputBackend[]
        {
            new InputSystemBackend(),
            new EditorEventInputBackend()
        }))
        {
        }

        public InputHandler(InputService inputService)
        {
            _inputService = inputService ?? new InputService();
        }

        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "get_capabilities":
                    return HandleGetCapabilities();
                case "begin_session":
                    EnsureInputCapabilityOrThrow(opName);
                    return _inputService.BeginSession(parameters);
                case "end_session":
                    return _inputService.EndSession();
                case "keepalive":
                    // Internal liveness ping from the owning MCP server (not an agent tool).
                    // No capability gate: it only refreshes the idle clock for its own session.
                    return _inputService.KeepAlive(parameters);
                case "key_down":
                    EnsureInputCapabilityOrThrow(opName);
                    return _inputService.KeyDown(parameters);
                case "key_up":
                    EnsureInputCapabilityOrThrow(opName);
                    return _inputService.KeyUp(parameters);
                case "key_tap":
                    EnsureInputCapabilityOrThrow(opName);
                    return _inputService.KeyTap(parameters);
                case "click_ui":
                    EnsureInputCapabilityOrThrow(opName);
                    return _inputService.ClickUi(parameters);
                case "observe_start":
                    return HandleObserveStart(parameters);
                case "observe_stop":
                    return HandleObserveStop();
                case "pointer_tap":
                    return HandlePointerTap(parameters);
                case "pointer_tap_world":
                    return HandlePointerTapWorld(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown input op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            onError(new BridgeException(ErrorCodes.NOT_FOUND,
                $"Input op '{opName}' is not async."));
        }

        private JObject HandleGetCapabilities()
        {
            JObject capabilities = _inputService.GetCapabilities();
            capabilities["inputCapability"] = UnityBridgeCapabilities.BuildInputCapabilitySignal(capabilities);
            return capabilities;
        }

        private void EnsureInputCapabilityOrThrow(string opName)
        {
            JObject capabilities = _inputService.GetCapabilities();
            UnityBridgeCapabilities.EnsureInputCapabilityOrThrow(opName, capabilities);
        }

        // ── observe-a-human-session: record the developer's real clicks ──
        // These bypass the input-capability gate: they do not DRIVE input, they
        // OBSERVE the human's (legacy UnityEngine.Input + uGUI EventSystem), so the
        // synthetic-input backend's availability is irrelevant. Play Mode is the
        // only precondition.

        private JObject HandleObserveStart(JObject parameters)
        {
            if (!Application.isPlaying)
                throw new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "input.observe_start requires Play Mode — enter play, then start observing.");

            // Optional declared game state-signal to sample at each recorded gesture, so
            // replay can auto-gate the gesture on the signal (e.g. wait until
            // ChefGameManager.phase == "Pour"). Absent ⇒ no sampling (nulls passed through).
            string signalPath = null, signalComponent = null, signalProperty = null;
            JObject stateSignal = parameters?["stateSignal"] as JObject;
            if (stateSignal != null)
            {
                signalPath = (string)stateSignal["path"];
                signalComponent = (string)stateSignal["component"];
                signalProperty = (string)stateSignal["property"];
            }

            // Phase 2 / D1-B: when set, the observer AUTO-DETECTS each scene's signal live (so a hub→game
            // recording gates each scene on its own phase manager). Takes precedence over a declared signal.
            bool autoDetect = parameters?["autoDetectStateSignal"]?.Value<bool>() ?? false;

            InputObserverBridge.Begin(signalPath, signalComponent, signalProperty, autoDetect);
            return new JObject { ["active"] = true, ["backend"] = "InputObserver" };
        }

        // ── simulated Input System pointer tap (drives non-uGUI / world-space targets) ──
        private JObject HandlePointerTap(JObject parameters)
        {
            if (!Application.isPlaying)
                throw new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "input.pointer_tap requires Play Mode.");

            if (!IsFiniteNumber(parameters?["x"]) || !IsFiniteNumber(parameters["y"]))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "input.pointer_tap requires finite numeric x and y (Game-View screen px, origin bottom-left).");

            // The simulated pointer is delivered to the FOCUSED Game View (we deliberately
            // don't flip InputSystem.settings to focus-independent — that's a persistent
            // editor-asset leak with no end_session to restore it). So refuse honestly when
            // unfocused rather than report a tap that silently did nothing.
            if (!GameViewFocus.EnsureGameViewFocused())
                throw new BridgeException(ErrorCodes.FOCUS_REQUIRED,
                    "input.pointer_tap needs Game-View focus (the simulated pointer routes to the focused Game View).");

            float x = parameters.Value<float>("x");
            float y = parameters.Value<float>("y");
            SimulatedPointerBridge.TapAt(x, y);
            return new JObject { ["dispatched"] = true, ["x"] = x, ["y"] = y };
        }

        // ── simulated Input System pointer tap at a WORLD coordinate ──
        private JObject HandlePointerTapWorld(JObject parameters)
        {
            if (!Application.isPlaying)
                throw new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "input.pointer_tap_world requires Play Mode.");

            if (!IsFiniteNumber(parameters?["x"]) || !IsFiniteNumber(parameters["y"]))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "input.pointer_tap_world requires finite numeric world x and y.");

            float x = parameters.Value<float>("x");
            float y = parameters.Value<float>("y");
            float z = IsFiniteNumber(parameters["z"]) ? parameters.Value<float>("z") : 0f;

            Camera camera = ResolveCamera(parameters.Value<JObject>("camera"));
            Vector3 screen = camera.WorldToScreenPoint(new Vector3(x, y, z));
            if (!IsFiniteFloat(screen.x) || !IsFiniteFloat(screen.y) || !IsFiniteFloat(screen.z) || screen.z <= 0f)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"input.pointer_tap_world could not project world point ({x}, {y}, {z}) through camera '{camera.name}'.");

            Rect pixelRect = camera.pixelRect;
            if (!pixelRect.Contains(new Vector2(screen.x, screen.y)))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"input.pointer_tap_world projected point ({screen.x}, {screen.y}) is outside camera pixel rect {pixelRect}.");

            JObject tapParams = new JObject
            {
                ["x"] = screen.x,
                ["y"] = screen.y
            };
            JToken button = parameters?["button"];
            if (button != null)
                tapParams["button"] = button;

            JObject tap = HandlePointerTap(tapParams);
            tap["world"] = new JObject { ["x"] = x, ["y"] = y, ["z"] = z };
            tap["screen"] = new JObject { ["x"] = screen.x, ["y"] = screen.y, ["z"] = screen.z };
            tap["camera"] = LocatorResolver.BuildLocator(camera.gameObject);
            return tap;
        }

        private static Camera ResolveCamera(JObject cameraLocator)
        {
            if (cameraLocator != null)
            {
                GameObject go = LocatorResolver.Resolve(cameraLocator);
                Camera camera = go.GetComponent<Camera>();
                if (camera == null)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"input.pointer_tap_world camera locator does not resolve to a Camera: {cameraLocator.ToString(Newtonsoft.Json.Formatting.None)}");
                return camera;
            }

            Camera main = Camera.main;
            if (main == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    "input.pointer_tap_world could not find Camera.main; pass camera:<locator>.");
            return main;
        }

        private static bool IsFiniteNumber(JToken token)
        {
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
                return false;
            double v = token.Value<double>();
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        private static bool IsFiniteFloat(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private JObject HandleObserveStop()
        {
            // Capture liveness BEFORE collecting: `observed:false` means the recorder
            // was not live at stop (never started, or Play Mode was restarted after
            // observe_start), so an empty `clicks` is "observation died", NOT "the
            // human clicked nothing" — the caller must refuse rather than mint a trace.
            bool observed = InputObserverBridge.IsObserving();
            // Collect the gesture-time paths (resolved by the runtime observer in Record)
            // and the dropped-inert count before ending — the recorded buffers are cleared
            // when the recorder stops.
            JArray clicks = InputObserverBridge.CollectClicks();
            JArray keyEdges = InputObserverBridge.CollectKeyEdges();
            int droppedNoTarget = InputObserverBridge.CollectDroppedNoTarget();
            InputObserverBridge.End();
            return new JObject
            {
                ["clicks"] = clicks,
                ["keyEdges"] = keyEdges,
                ["observed"] = observed,
                ["droppedNoTarget"] = droppedNoTarget,
            };
        }

        /// <summary>
        /// Reflection bridge to the runtime <c>InputObserverRuntimePump</c> (it lives
        /// in a separate runtime assembly the Editor asmdef does not reference), mirroring
        /// <c>InputSystemBackend.ReflectionInputSystemAdapter</c>.
        /// </summary>
        private static class InputObserverBridge
        {
            private static Type _type;
            private static MethodInfo _begin;
            private static MethodInfo _end;
            private static MethodInfo _isObserving;
            private static MethodInfo _getPaths;
            private static MethodInfo _getScenes;
            private static MethodInfo _getToPaths;
            private static MethodInfo _getKinds;
            private static MethodInfo _getTimes;
            private static MethodInfo _getTravelPx;
            private static MethodInfo _getTravelRefHeight;
            private static MethodInfo _getReleaseNx;
            private static MethodInfo _getReleaseNy;
            private static MethodInfo _getDropped;
            private static MethodInfo _getKeyNames;
            private static MethodInfo _getKeyEdges;
            private static MethodInfo _getKeyTimes;
            private static MethodInfo _getStateSignal;
            private static MethodInfo _getSignalSpecPaths;
            private static MethodInfo _getSignalSpecComponents;
            private static MethodInfo _getSignalSpecProperties;

            public static void Begin(string signalPath, string signalComponent, string signalProperty, bool autoDetect)
            {
                Resolve();
                // BeginObserver takes the declared signal coordinates (or nulls) PLUS the auto-detect
                // flag (D1-B: detect each scene's signal live instead of using a declared one).
                Invoke(_begin, new object[] { signalPath, signalComponent, signalProperty, autoDetect });
            }

            public static void End()
            {
                Resolve();
                Invoke(_end);
            }

            public static bool IsObserving()
            {
                Resolve();
                return Invoke(_isObserving) is bool live && live;
            }

            public static JArray CollectClicks()
            {
                Resolve();
                // Paths are resolved at GESTURE time by the runtime observer (so a
                // reparented dragged object keeps its origin path) — the Editor just
                // packages them. Replay resolves a `path` without a `scene` by searching
                // all loaded scenes, which is strictly more robust than pinning a scene.
                var paths = (string[])Invoke(_getPaths);
                // Runtime scene name per gesture (parallel to paths). EVIDENCE for multi-scene inference;
                // the locator stays path-resolvable for replay (replay ignores the scene field).
                var scenes = (string[])Invoke(_getScenes);
                var toPaths = (string[])Invoke(_getToPaths);
                var times = (float[])Invoke(_getTimes);
                var kinds = (string[])Invoke(_getKinds);
                // Generic-gesture primitives (Path A), parallel to paths. Real values only for
                // the drag-only / in-place branch; 0 / −1 sentinels elsewhere (the TS consumer
                // treats those as absent). Same defensive length guards as toPaths.
                var travelPx = (float[])Invoke(_getTravelPx);
                var travelRefHeight = (float[])Invoke(_getTravelRefHeight);
                var releaseNx = (float[])Invoke(_getReleaseNx);
                var releaseNy = (float[])Invoke(_getReleaseNy);
                // The declared state-signal sampled at each gesture (parallel to paths);
                // null per click when no signal was declared or it couldn't be sampled.
                var stateSignals = (string[])Invoke(_getStateSignal);
                // The signal SPEC each gesture was sampled with (auto-detect mode; null in legacy
                // single-signal mode). Parallel to paths. Lets the trace gate each gesture on its
                // OWN scene's signal (different scenes → different phase managers).
                var specPaths = (string[])Invoke(_getSignalSpecPaths);
                var specComponents = (string[])Invoke(_getSignalSpecComponents);
                var specProperties = (string[])Invoke(_getSignalSpecProperties);

                var clicks = new JArray();
                for (int i = 0; i < paths.Length; i++)
                {
                    string path = paths[i];
                    if (string.IsNullOrEmpty(path))
                        continue; // unresolved at gesture time — skip, never invent a locator

                    // Path-only locator (replay dispatch); attach the gesture-time scene as EVIDENCE when
                    // known (omitted when empty so a single-scene trace is byte-identical to before).
                    var locator = new JObject { ["path"] = path };
                    string sceneName = scenes != null && i < scenes.Length ? scenes[i] : null;
                    if (!string.IsNullOrEmpty(sceneName))
                        locator["scene"] = sceneName;

                    var click = new JObject
                    {
                        ["tMs"] = i < times.Length ? times[i] : 0f,
                        ["locator"] = locator,
                        ["button"] = 0,
                        ["kind"] = i < kinds.Length ? kinds[i] : "ui",
                    };

                    // A DRAG carries a drop-target path (null for a tap).
                    string toPath = i < toPaths.Length ? toPaths[i] : null;
                    if (!string.IsNullOrEmpty(toPath))
                        click["to"] = new JObject { ["path"] = toPath };

                    // Generic-gesture primitives on every click (sentinels => treated as absent).
                    click["travelPx"] = i < travelPx.Length ? travelPx[i] : 0f;
                    click["travelRefHeight"] = i < travelRefHeight.Length ? travelRefHeight[i] : 0f;
                    click["releaseNx"] = i < releaseNx.Length ? releaseNx[i] : -1f;
                    click["releaseNy"] = i < releaseNy.Length ? releaseNy[i] : -1f;
                    // The precondition value at gesture time — emit explicit JSON null when
                    // absent (no signal declared / unresolved), per the protocol contract.
                    string signal = i < stateSignals.Length ? stateSignals[i] : null;
                    click["stateSignal"] = signal != null ? (JToken)signal : JValue.CreateNull();

                    // The per-gesture signal SPEC (auto-detect only) — its own scene's signal, as
                    // { locator: { path }, component, property }. Attached only when a path was sampled
                    // (legacy mode leaves these null so the trace transform falls back to the global signal).
                    string specPath = specPaths != null && i < specPaths.Length ? specPaths[i] : null;
                    if (!string.IsNullOrEmpty(specPath))
                    {
                        var spec = new JObject { ["locator"] = new JObject { ["path"] = specPath } };
                        string specComponent = specComponents != null && i < specComponents.Length ? specComponents[i] : null;
                        if (!string.IsNullOrEmpty(specComponent))
                            spec["component"] = specComponent;
                        string specProperty = specProperties != null && i < specProperties.Length ? specProperties[i] : null;
                        spec["property"] = specProperty;
                        click["stateSignalSpec"] = spec;
                    }

                    clicks.Add(click);
                }
                return clicks;
            }

            private static void Resolve()
            {
                if (_type != null)
                    return;

                _type = ResolveType("UnityBridge.Runtime.InputObserverRuntimePump");
                if (_type == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        "InputObserverRuntimePump not found — the bridge observe runtime assembly is not compiled.");

                // BeginObserver takes (string path, string component, string property, bool autoDetect)
                // — the optional declared signal plus the per-scene auto-detect flag (D1-B).
                _begin = StaticMethod("BeginObserver",
                    new[] { typeof(string), typeof(string), typeof(string), typeof(bool) });
                _end = StaticMethod("EndObserver");
                _isObserving = StaticMethod("IsObserving");
                _getPaths = StaticMethod("GetRecordedPaths");
                _getScenes = StaticMethod("GetRecordedScenes");
                _getToPaths = StaticMethod("GetRecordedToPaths");
                _getKinds = StaticMethod("GetRecordedKinds");
                _getTimes = StaticMethod("GetRecordedTimesMs");
                _getTravelPx = StaticMethod("GetRecordedTravelPx");
                _getTravelRefHeight = StaticMethod("GetRecordedTravelRefHeight");
                _getReleaseNx = StaticMethod("GetRecordedReleaseNx");
                _getReleaseNy = StaticMethod("GetRecordedReleaseNy");
                _getDropped = StaticMethod("GetDroppedNoTarget");
                _getKeyNames = StaticMethod("GetRecordedKeyNames");
                _getKeyEdges = StaticMethod("GetRecordedKeyEdges");
                _getKeyTimes = StaticMethod("GetRecordedKeyTimesMs");
                _getStateSignal = StaticMethod("GetRecordedStateSignal");
                _getSignalSpecPaths = StaticMethod("GetRecordedSignalSpecPaths");
                _getSignalSpecComponents = StaticMethod("GetRecordedSignalSpecComponents");
                _getSignalSpecProperties = StaticMethod("GetRecordedSignalSpecProperties");
            }

            /// <summary>How many uGUI taps the observer dropped this session (no interactive target).</summary>
            public static int CollectDroppedNoTarget()
            {
                Resolve();
                return Invoke(_getDropped) is int n ? n : 0;
            }

            /// <summary>Package the recorded keyboard edges as [{ key, edge, tMs }, …].</summary>
            public static JArray CollectKeyEdges()
            {
                Resolve();
                var names = (string[])Invoke(_getKeyNames);
                var edges = (string[])Invoke(_getKeyEdges);
                var times = (float[])Invoke(_getKeyTimes);

                var result = new JArray();
                for (int i = 0; i < names.Length; i++)
                {
                    result.Add(new JObject
                    {
                        ["key"] = names[i],
                        ["edge"] = i < edges.Length ? edges[i] : "down",
                        ["tMs"] = i < times.Length ? times[i] : 0f,
                    });
                }
                return result;
            }

            private static MethodInfo StaticMethod(string name)
            {
                return StaticMethod(name, Type.EmptyTypes);
            }

            private static MethodInfo StaticMethod(string name, Type[] paramTypes)
            {
                MethodInfo method =
                    _type.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, paramTypes, null);
                if (method == null)
                    throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        $"InputObserverRuntimePump.{name}() not found — observe runtime assembly is out of date.");
                return method;
            }

            // Unwrap reflection's TargetInvocationException so a BridgeException thrown
            // inside the runtime pump surfaces as itself, not an opaque wrapper.
            private static object Invoke(MethodInfo method)
            {
                return Invoke(method, null);
            }

            private static object Invoke(MethodInfo method, object[] args)
            {
                try
                {
                    return method.Invoke(null, args);
                }
                catch (TargetInvocationException ex) when (ex.InnerException != null)
                {
                    throw ex.InnerException;
                }
            }

            private static Type ResolveType(string fullName)
            {
                Type type = Type.GetType(fullName);
                if (type != null)
                    return type;

                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type loaded = assembly.GetType(fullName, false);
                    if (loaded != null)
                        return loaded;
                }
                return null;
            }
        }

    }
}
