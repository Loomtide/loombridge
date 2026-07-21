using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;

namespace UnityBridge.Runtime
{
    /// <summary>
    /// Observes a developer's real left-clicks during manual Play — the
    /// observe-a-human-session recorder. It lives in its OWN runtime assembly with
    /// NO Input System constraint (unlike <c>InputSystemRuntimePump</c>), so it
    /// records regardless of the project's input backend: it reads legacy
    /// <see cref="Input"/> plus the uGUI <see cref="EventSystem"/>, which work for
    /// the legacy <c>StandaloneInputModule</c> games this targets.
    ///
    /// Click capture MUST happen here, in the game's Update loop: the bridge runs on
    /// the editor tick (<c>EditorApplication.update</c>), which misses per-frame
    /// input edges. Each gesture records its target's hierarchy path resolved AT
    /// GESTURE TIME (so a dragged object that later reparents into the drop zone keeps
    /// its origin path) plus a millisecond offset from the start of the session.
    ///
    /// New-Input-System pointer capture, world-space drags, and right/middle clicks
    /// are deliberate follow-ons.
    /// </summary>
    [DefaultExecutionOrder(-32000)]
    public sealed class InputObserverRuntimePump : MonoBehaviour
    {
        private static InputObserverRuntimePump _instance;
        private static bool _recording;
        private static float _startTime;
        // Hierarchy paths resolved at GESTURE time (not at stop): a dragged object that
        // REPARENTS into the drop zone has moved by stop, so resolving then would capture
        // its post-drop path. The observer ticks at order −32000, BEFORE the EventSystem
        // processes the drop, so the object is still at its origin path in Record().
        private static readonly List<string> _paths = new List<string>();
        // The runtime scene NAME the gesture's target lived in, resolved at gesture time (parallel to
        // _paths). EVIDENCE for multi-scene verification only — paths stay scene-less for replay (replay
        // searches all loaded scenes, strictly more robust). null when the target's scene is invalid.
        private static readonly List<string> _scenes = new List<string>();
        private static readonly List<string> _toPaths = new List<string>();
        private static readonly List<string> _kinds = new List<string>();
        private static readonly List<float> _timesMs = new List<float>();
        // Generic-gesture primitives (Path A), parallel to the buffers above. Populated with
        // REAL values ONLY for the drag-only-control / in-place branch — the scrub/stir that
        // needs accumulated TRAVEL, and the position-drop whose target is the RELEASE POINT
        // (not a raycast element). Every OTHER gesture (tap, distinct-drop drag) pushes the
        // SENTINELS (travelPx 0, releaseN −1) so the consumer treats them as absent and replay
        // is unchanged. _travelPx is accumulated screen-px pointer travel over the gesture;
        // _releaseNx/_releaseNy are the release point normalized by Screen.width/height.
        private static readonly List<float> _travelPx = new List<float>();
        private static readonly List<float> _releaseNx = new List<float>();
        private static readonly List<float> _releaseNy = new List<float>();
        // Screen.height at RECORD time, per gesture (0 sentinel when no travel). `travelPx` is
        // ABSOLUTE screen px, but the game converts screen-travel→progress by dividing by the
        // canvas scale factor (∝ screen height). So the SAME px under-shoots on a higher-res
        // device. Carrying the record-time height lets replay rescale travel per device
        // (travelPx × deviceHeight / recordHeight) to reproduce the same on-canvas travel.
        private static readonly List<float> _travelRefHeight = new List<float>();
        // A declared game state-signal sampled AT GESTURE TIME — the precondition the
        // replay anchor gates on (e.g. ChefGameManager.phase == "Pour"). Parallel to
        // _paths: one entry per Record(), null when no signal is declared or it could not
        // be resolved/sampled. Sampling is ADVISORY: it never throws and never affects
        // whether a gesture is recorded.
        private static readonly List<string> _stateSignal = new List<string>();
        // The declared signal coordinates, set by BeginObserver and cleared by EndObserver.
        // A null _signalPath ⇒ sampling is OFF (behaviour identical to before this feature).
        private static string _signalPath;
        private static string _signalComponent;
        private static string _signalProperty;
        // Cache of the GameObject resolved from _signalPath so we don't re-walk the
        // hierarchy every gesture; reset whenever a session begins/ends.
        private static GameObject _signalResolved;
        // Count of uGUI taps DROPPED because they hit no interactive element (a
        // transparent backdrop / decoration) — surfaced at stop so the loss is honest,
        // never silent. These taps do nothing in the game, so recording them would emit
        // an unreplayable step.
        private static int _droppedNoTarget;

        // Keyboard EDGES (down/up) captured via legacy Input, parallel buffers. Raw edges
        // (not paired holds) so the transform can reproduce CONCURRENT keys on a timeline.
        // Legacy Input → works for legacy/Both projects; an Input-System-ONLY project sees
        // nothing here (the new-IS observation follow-on). `_heldKeys` tracks pressed keys
        // so the up scan stays cheap (only currently-held keys).
        private static readonly List<string> _keyNames = new List<string>();
        private static readonly List<string> _keyEdges = new List<string>();
        private static readonly List<float> _keyTimesMs = new List<float>();
        private static readonly HashSet<KeyCode> _heldKeys = new HashSet<KeyCode>();

        /// <summary>The keyboard KeyCodes to scan — every KeyCode except mouse/joystick buttons
        /// (which the simulated-keyboard replay can't drive anyway).</summary>
        private static readonly KeyCode[] _keyboardKeys = BuildKeyboardKeys();

        private static KeyCode[] BuildKeyboardKeys()
        {
            var keys = new List<KeyCode>();
            foreach (KeyCode kc in System.Enum.GetValues(typeof(KeyCode)))
            {
                if (kc == KeyCode.None)
                    continue;
                string n = kc.ToString();
                if (n.StartsWith("Mouse") || n.StartsWith("Joystick"))
                    continue;
                keys.Add(kc);
            }
            return keys.ToArray();
        }

        // Pending press, deferred to release so a gesture can be classified tap vs drag.
        private static bool _downPending;
        private static GameObject _downTarget;
        private static string _downKind;
        private static Vector2 _downScreen;
        private static float _downTimeMs;
        // Accumulated screen-px pointer travel of the in-flight gesture and the last sampled
        // pointer position. Reset on each left-mouse-DOWN, integrated every Update frame while
        // a press is pending (the human's REAL screen motion — naturally scale-correct).
        private static float _travel;
        private static Vector2 _lastMouse;
        // The state signal sampled at the PRESS (down) edge = the gesture's true PRECONDITION.
        // Sampling at release is wrong for a gesture whose effect transitions the phase
        // MID-gesture (a stir that completes before the pointer is lifted records the
        // POST-gesture phase). Captured at down, emitted at Record (release).
        private static string _downStateSignal;
        // Phase 2 / D1-B: per-scene AUTO-DETECT. When true the signal isn't declared up front; it's
        // detected live from the ACTIVE scene the first time a gesture occurs in it (cached by scene
        // name) and the _signalPath/_signalComponent/_signalProperty fields are switched to that scene's
        // signal before sampling — so a hub→game recording gates each scene's gestures on its OWN phase
        // manager (HomeManager, then ChefGameManager) without any --state-signal.
        private static bool _autoDetect;
        // Detected signal per scene name; a cached Result with Found==false means "nothing for this
        // scene" so we never re-walk it. Cleared per session.
        private static readonly Dictionary<string, StateSignalAutoDetector.Result> _autoSignalByScene =
            new Dictionary<string, StateSignalAutoDetector.Result>();
        // The signal SPEC each gesture was sampled with (parallel to _stateSignal). Populated ONLY in
        // auto-detect mode (where it varies scene to scene); null in legacy single-signal mode so the
        // trace is byte-identical. The PRESS-edge spec is held in _downSpec* and committed by Record().
        private static readonly List<string> _signalSpecPath = new List<string>();
        private static readonly List<string> _signalSpecComponent = new List<string>();
        private static readonly List<string> _signalSpecProperty = new List<string>();
        private static string _downSpecPath;
        private static string _downSpecComponent;
        private static string _downSpecProperty;

        /// <summary>Pointer travel (px) above which a uGUI press→release counts as a drag, not a tap.</summary>
        private const float DragMinPixels = 20f;

        public static void BeginObserver(string signalPath, string signalComponent, string signalProperty, bool autoDetect)
        {
            EnsureInstance();
            _paths.Clear();
            _scenes.Clear();
            _toPaths.Clear();
            _kinds.Clear();
            _timesMs.Clear();
            _travelPx.Clear();
            _releaseNx.Clear();
            _releaseNy.Clear();
            _travelRefHeight.Clear();
            _stateSignal.Clear();
            _signalSpecPath.Clear();
            _signalSpecComponent.Clear();
            _signalSpecProperty.Clear();
            _autoSignalByScene.Clear();
            _droppedNoTarget = 0;
            _keyNames.Clear();
            _keyEdges.Clear();
            _keyTimesMs.Clear();
            _heldKeys.Clear();
            _downPending = false;
            // Auto-detect (D1-B) takes precedence over a declared signal: the per-scene walk supplies the
            // signal, so the explicit coordinates are ignored and the fields start empty (set per scene).
            _autoDetect = autoDetect;
            if (autoDetect)
            {
                _signalPath = null;
                _signalComponent = null;
                _signalProperty = null;
            }
            else
            {
                // The declared signal to sample at each gesture (all null ⇒ sampling off).
                // Treat a blank path as absent so an empty-string round-trip can't enable it.
                _signalPath = string.IsNullOrEmpty(signalPath) ? null : signalPath;
                _signalComponent = signalComponent;
                _signalProperty = signalProperty;
            }
            _signalResolved = null;
            _downStateSignal = null;
            _downSpecPath = null;
            _downSpecComponent = null;
            _downSpecProperty = null;
            _startTime = Time.unscaledTime;
            _recording = true;
        }

        public static void EndObserver()
        {
            _recording = false;
            _paths.Clear();
            _scenes.Clear();
            _toPaths.Clear();
            _kinds.Clear();
            _timesMs.Clear();
            _travelPx.Clear();
            _releaseNx.Clear();
            _releaseNy.Clear();
            _travelRefHeight.Clear();
            _stateSignal.Clear();
            _signalSpecPath.Clear();
            _signalSpecComponent.Clear();
            _signalSpecProperty.Clear();
            _autoSignalByScene.Clear();
            _droppedNoTarget = 0;
            _keyNames.Clear();
            _keyEdges.Clear();
            _keyTimesMs.Clear();
            _heldKeys.Clear();
            _downPending = false;
            _autoDetect = false;
            _signalPath = null;
            _signalComponent = null;
            _signalProperty = null;
            _signalResolved = null;
            _downStateSignal = null;
            _downSpecPath = null;
            _downSpecComponent = null;
            _downSpecProperty = null;
            DestroyInstance();
        }

        /// <summary>
        /// True only while a live recorder is actually capturing. Distinguishes "the
        /// human clicked nothing" (observing, empty buffer) from "observation died"
        /// (e.g. Play Mode was stopped+restarted after BeginObserver, destroying the
        /// instance) — so observe_stop never returns an empty list that silently looks
        /// like a clean no-click session.
        /// </summary>
        public static bool IsObserving()
        {
            return _recording && _instance != null;
        }

        /// <summary>Hierarchy path of each clicked / drag-start object, resolved at gesture time.</summary>
        public static string[] GetRecordedPaths()
        {
            return _paths.ToArray();
        }

        /// <summary>Runtime scene NAME of each gesture target, resolved at gesture time (parallel to
        /// GetRecordedPaths); null when invalid. Multi-scene EVIDENCE only — never used for replay dispatch.</summary>
        public static string[] GetRecordedScenes()
        {
            return _scenes.ToArray();
        }

        /// <summary>Per gesture (auto-detect mode): the path/component/property of the signal SPEC the
        /// gesture's value was sampled with (parallel to GetRecordedPaths). Null entries in legacy
        /// single-signal mode. Lets the trace gate each gesture on its own scene's signal.</summary>
        public static string[] GetRecordedSignalSpecPaths()
        {
            return _signalSpecPath.ToArray();
        }

        public static string[] GetRecordedSignalSpecComponents()
        {
            return _signalSpecComponent.ToArray();
        }

        public static string[] GetRecordedSignalSpecProperties()
        {
            return _signalSpecProperty.ToArray();
        }

        /// <summary>Per gesture: the drop target's path for a DRAG, or null for a tap (parallel to GetRecordedPaths).</summary>
        public static string[] GetRecordedToPaths()
        {
            return _toPaths.ToArray();
        }

        /// <summary>"ui" (uGUI element) or "world" (sprite/collider) per recorded click.</summary>
        public static string[] GetRecordedKinds()
        {
            return _kinds.ToArray();
        }

        /// <summary>Millisecond offset of each click from the start of the session.</summary>
        public static float[] GetRecordedTimesMs()
        {
            return _timesMs.ToArray();
        }

        /// <summary>Accumulated screen-px pointer travel per gesture; 0 sentinel for taps / distinct-drop drags (parallel to GetRecordedPaths).</summary>
        public static float[] GetRecordedTravelPx()
        {
            return _travelPx.ToArray();
        }

        /// <summary>Release point X ÷ Screen.width per gesture; −1 sentinel for taps / distinct-drop drags (parallel to GetRecordedPaths).</summary>
        public static float[] GetRecordedReleaseNx()
        {
            return _releaseNx.ToArray();
        }

        /// <summary>Release point Y ÷ Screen.height per gesture; −1 sentinel for taps / distinct-drop drags (parallel to GetRecordedPaths).</summary>
        public static float[] GetRecordedReleaseNy()
        {
            return _releaseNy.ToArray();
        }

        /// <summary>Screen.height at record time per gesture (0 sentinel when no travel); lets replay rescale travelPx per device.</summary>
        public static float[] GetRecordedTravelRefHeight()
        {
            return _travelRefHeight.ToArray();
        }

        /// <summary>
        /// The declared game state-signal sampled AT GESTURE TIME for each recorded click
        /// (parallel to GetRecordedPaths). The precondition value — an enum is its NAME —
        /// or null when no signal was declared or it couldn't be resolved/sampled.
        /// </summary>
        public static string[] GetRecordedStateSignal()
        {
            return _stateSignal.ToArray();
        }

        /// <summary>How many uGUI taps were dropped this session for hitting no interactive element.</summary>
        public static int GetDroppedNoTarget()
        {
            return _droppedNoTarget;
        }

        /// <summary>KeyCode name of each recorded keyboard edge (parallel to GetRecordedKeyEdges/TimesMs).</summary>
        public static string[] GetRecordedKeyNames()
        {
            return _keyNames.ToArray();
        }

        /// <summary>"down" or "up" per recorded keyboard edge.</summary>
        public static string[] GetRecordedKeyEdges()
        {
            return _keyEdges.ToArray();
        }

        /// <summary>Millisecond offset of each keyboard edge from the start of the session.</summary>
        public static float[] GetRecordedKeyTimesMs()
        {
            return _keyTimesMs.ToArray();
        }

        private static void EnsureInstance()
        {
            if (_instance != null)
                return;

            var go = new GameObject("[Loombridge] InputObserverRuntimePump");
            go.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<InputObserverRuntimePump>();
        }

        private static void DestroyInstance()
        {
            if (_instance == null)
                return;

            if (Application.isPlaying)
                Destroy(_instance.gameObject);
            else
                DestroyImmediate(_instance.gameObject);

            _instance = null;
        }

        private void Update()
        {
            if (!_recording)
                return;

            // Keyboard edges FIRST — the mouse-release block below has early returns, so
            // capturing keys here guarantees a frame's key edges aren't skipped on a
            // mouse-up frame. Independent of the click path (separate buffers).
            CaptureKeyEdges();

            // Press: resolve the target but DEFER recording to release, so a press→move→
            // release gesture can be classified as a tap or a drag.
            if (TryGetLeftMouseDown(out Vector2 downPoint))
            {
                // uGUI first (EventSystem) — replayable via the bridge's dispatch.
                GameObject hit = RaycastUI(downPoint);
                string kind = "ui";
                if (hit == null)
                {
                    // Fall back to a world-space (sprite/collider) hit — the game handles
                    // these via its own raycast + Input System pointer, so they're recorded
                    // faithfully but replay marks them blocked (no EventSystem actuation).
                    hit = RaycastWorld(downPoint);
                    kind = "world";
                }
                _downTarget = hit; // may be null (empty space) — resolved at release
                _downKind = kind;
                _downScreen = downPoint;
                _downTimeMs = (Time.unscaledTime - _startTime) * 1000f;
                _downPending = true;
                // Start a fresh travel accumulation for this gesture (real screen-px motion).
                _travel = 0f;
                _lastMouse = _downScreen;
                // Auto-detect (D1-B): switch _signal* to the ACTIVE scene's signal (detected+cached
                // once per scene) before sampling, so this gesture gates on its OWN scene's phase.
                if (_autoDetect)
                    ApplyAutoDetectedSignalForActiveScene();
                // Sample the state signal NOW, at the press — the true precondition. A gesture
                // that flips the phase mid-gesture (a completing stir) would otherwise record
                // the post-gesture phase if sampled at release.
                _downStateSignal = SampleStateSignal();
                // Hold the spec in force at this press (auto-detect only) so Record() can commit it
                // parallel to the sampled value; legacy single-signal mode leaves it null (no per-gesture
                // spec ⇒ the trace transform uses the global meta.stateSignal, byte-identical to before).
                if (_autoDetect)
                {
                    _downSpecPath = _signalPath;
                    _downSpecComponent = _signalComponent;
                    _downSpecProperty = _signalProperty;
                }
                // Do NOT return — fall through so a SAME-FRAME press+release (a sub-frame
                // click, possible at low frame rates) is classified this tick instead of
                // stranding the pending press (its up edge is gone next frame).
            }

            // Integrate pointer travel each frame the press is held — the human's real screen
            // motion (px), so it's naturally scale-correct. Reuses the legacy-Input read pattern
            // (guarding the InvalidOperationException when legacy Input is disabled).
            if (_downPending && TryGetMousePosition(out Vector2 curMouse))
            {
                _travel += (curMouse - _lastMouse).magnitude;
                _lastMouse = curMouse;
            }

            // Release: classify the pending gesture.
            if (_downPending && TryGetLeftMouseUp(out Vector2 upPoint))
            {
                _downPending = false;
                if (_downTarget == null)
                    return; // press began on empty space — nothing actionable to record

                float dist = (upPoint - _downScreen).magnitude;
                if (_downKind == "ui" && dist >= DragMinPixels)
                {
                    // A uGUI drag: the drop target is the topmost element under the release
                    // point that ISN'T the dragged element (which follows the pointer).
                    GameObject drop = RaycastUIExcluding(upPoint, _downTarget);
                    if (drop != null && drop != _downTarget)
                    {
                        // A normal DISTINCT-drop drag — the drop target is identified by the
                        // raycast element, not the release point. Emit sentinels (unchanged).
                        Record(_downTarget, drop, "ui", _downTimeMs, 0f, -1f, -1f, 0f);
                        return;
                    }
                }

                if (_downKind == "ui"
                    && !RoutesToPointerHandler(_downTarget)
                    && RoutesToDragHandler(_downTarget))
                {
                    // Drag-only controls (no click/down/up handler) respond to drags — including
                    // an IN-PLACE gesture whose release lands back on the source (a stir scrub, a
                    // nudge), which the distinct-drop-target drag path above skips. Capture it as a
                    // replayable drag (to a distinct drop if there is one, else to itself) at ANY
                    // distance, instead of dropping it as an inert tap. A bare handler-less backdrop
                    // still routes to neither and is dropped below.
                    GameObject drop = RaycastUIExcluding(upPoint, _downTarget);
                    if (drop == null || drop == _downTarget)
                        drop = _downTarget;
                    // The scrub/stir + position-drop branch — the ONLY one carrying real
                    // primitives: accumulated TRAVEL (for a stir that needs total path length)
                    // and the normalized RELEASE POINT (for a drop whose target is the release
                    // position, not a raycast element). Guard divide-by-zero with −1 sentinels.
                    float relNx = Screen.width > 0 ? upPoint.x / Screen.width : -1f;
                    float relNy = Screen.height > 0 ? upPoint.y / Screen.height : -1f;
                    // Carry Screen.height so replay can rescale this travel per device.
                    Record(_downTarget, drop, "ui", _downTimeMs, _travel, relNx, relNy, Screen.height);
                    return;
                }

                // No movement, a world press, or no distinct drop target → a plain tap.
                // Drop an INERT uGUI tap — one whose target routes to no pointer handler
                // (a transparent backdrop / decoration). Such a click does nothing in the
                // game (the EventSystem has no handler to invoke), so recording it would
                // emit a step that can't replay (`wait-for-visible` rightly refuses an
                // inert/invisible target). Count it so the drop is honest, never silent.
                // World taps (handled via the simulated pointer) and drags are unaffected.
                if (_downKind == "ui" && !RoutesToPointerHandler(_downTarget))
                {
                    _droppedNoTarget++;
                    return;
                }
                // A plain tap (uGUI or world) — no travel/release primitives. Emit sentinels.
                Record(_downTarget, null, _downKind, _downTimeMs, 0f, -1f, -1f, 0f);
            }
        }

        /// <summary>
        /// True if a click on <paramref name="go"/> would reach a uGUI pointer handler
        /// (click/down/up) on it or an ancestor — i.e. the game actually responds to a tap
        /// there. Mirrors how the EventSystem routes a click (<see cref="ExecuteEvents"/>),
        /// so a `false` is exactly a tap that would do nothing in the running game.
        /// </summary>
        private static bool RoutesToPointerHandler(GameObject go)
        {
            if (go == null)
                return false;
            return ExecuteEvents.GetEventHandler<IPointerClickHandler>(go) != null
                || ExecuteEvents.GetEventHandler<IPointerDownHandler>(go) != null
                || ExecuteEvents.GetEventHandler<IPointerUpHandler>(go) != null;
        }

        /// <summary>
        /// True if a gesture on <paramref name="go"/> would reach a uGUI drag handler on
        /// it or an ancestor. Kept separate from click routing so inert-tap filtering
        /// still only treats click/down/up handlers as tap-interactive.
        /// </summary>
        private static bool RoutesToDragHandler(GameObject go)
        {
            if (go == null)
                return false;
            return ExecuteEvents.GetEventHandler<IBeginDragHandler>(go) != null
                || ExecuteEvents.GetEventHandler<IDragHandler>(go) != null
                || ExecuteEvents.GetEventHandler<IInitializePotentialDragHandler>(go) != null;
        }

        /// <summary>
        /// Record this frame's keyboard down/up edges (legacy <see cref="Input"/>). Down edges
        /// are scanned only on an `anyKeyDown` frame; up edges only over currently-held keys —
        /// so the per-frame cost is near-zero when nothing is pressed. A key still held at stop
        /// has no up edge; the transform balances it with a trailing release.
        /// </summary>
        private static void CaptureKeyEdges()
        {
            float tMs = (Time.unscaledTime - _startTime) * 1000f;

            if (Input.anyKeyDown)
            {
                foreach (KeyCode kc in _keyboardKeys)
                {
                    if (Input.GetKeyDown(kc))
                    {
                        _keyNames.Add(kc.ToString());
                        _keyEdges.Add("down");
                        _keyTimesMs.Add(tMs);
                        _heldKeys.Add(kc);
                    }
                }
            }

            if (_heldKeys.Count > 0)
            {
                // Copy: we mutate _heldKeys while iterating.
                foreach (KeyCode kc in new List<KeyCode>(_heldKeys))
                {
                    if (Input.GetKeyUp(kc))
                    {
                        _keyNames.Add(kc.ToString());
                        _keyEdges.Add("up");
                        _keyTimesMs.Add(tMs);
                        _heldKeys.Remove(kc);
                    }
                }
            }
        }

        private static void Record(GameObject from, GameObject to, string kind, float tMs,
            float travelPx, float relNx, float relNy, float travelRefHeight)
        {
            // Resolve paths NOW (gesture time), before the EventSystem can reparent a
            // dropped object — see the note on `_paths`.
            _paths.Add(BuildRuntimePath(from));
            // Scene evidence for the gesture target, captured NOW (parallel to _paths). Replay ignores it.
            _scenes.Add(from != null && from.scene.IsValid() ? from.scene.name : null);
            _toPaths.Add(to != null ? BuildRuntimePath(to) : null); // null for a tap
            _kinds.Add(kind);
            _timesMs.Add(tMs);
            // KEEP PARALLEL: every recorded gesture pushes to ALL buffers, same length.
            _travelPx.Add(travelPx);
            _releaseNx.Add(relNx);
            _releaseNy.Add(relNy);
            _travelRefHeight.Add(travelRefHeight);
            // The precondition signal was sampled at the PRESS (_downStateSignal), not here at
            // release — correct even for a gesture that flips the phase mid-gesture.
            _stateSignal.Add(_downStateSignal);
            // The signal SPEC in force at that press (auto-detect only; null in legacy mode). KEEP
            // PARALLEL with _stateSignal so each gesture's gate carries its own scene's signal.
            _signalSpecPath.Add(_downSpecPath);
            _signalSpecComponent.Add(_downSpecComponent);
            _signalSpecProperty.Add(_downSpecProperty);
        }

        /// <summary>
        /// Auto-detect (D1-B): point _signal* at the ACTIVE scene's phase signal, detecting it once
        /// per scene (cached). A scene with no detectable signal caches Found==false and leaves
        /// _signalPath null (sampling returns null ⇒ that scene's gestures get no gate, reported
        /// honestly by invariant #4). Switching scenes invalidates the resolved-object cache.
        /// </summary>
        private static void ApplyAutoDetectedSignalForActiveScene()
        {
            UnityEngine.SceneManagement.Scene scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            string key = scene.name ?? string.Empty;
            StateSignalAutoDetector.Result result;
            if (!_autoSignalByScene.TryGetValue(key, out result))
            {
                result = StateSignalAutoDetector.Detect(scene, BuildRuntimePath);
                _autoSignalByScene[key] = result;
            }
            string path = result.Found ? result.Path : null;
            if (path != _signalPath)
                _signalResolved = null; // a different scene's object — re-resolve on next sample
            _signalPath = path;
            _signalComponent = result.Found ? result.Component : null;
            _signalProperty = result.Found ? result.Property : null;
        }

        /// <summary>
        /// The current value of the declared game state-signal (path/component/property set
        /// by BeginObserver), or null when no signal is declared or any step fails to
        /// resolve. ADVISORY: this NEVER throws — a sampling failure is simply a null
        /// precondition, never a dropped or mis-recorded gesture. An enum's
        /// <see cref="object.ToString"/> is its member NAME, which is what replay anchors on.
        /// </summary>
        private static string SampleStateSignal()
        {
            if (string.IsNullOrEmpty(_signalPath))
                return null; // sampling off — behaviour identical to before the feature

            try
            {
                GameObject go = ResolveSignalObject();
                if (go == null)
                    return null;

                // GameObject.GetComponent(string) accepts a component TYPE NAME (the
                // declared `component`, e.g. "ChefGameManager").
                Component component = string.IsNullOrEmpty(_signalComponent)
                    ? null
                    : go.GetComponent(_signalComponent);
                if (component == null)
                    return null;

                if (string.IsNullOrEmpty(_signalProperty))
                    return null;

                System.Type type = component.GetType();
                const System.Reflection.BindingFlags flags =
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;

                // Property first, then field — public instance members only.
                System.Reflection.PropertyInfo prop = type.GetProperty(_signalProperty, flags);
                if (prop != null && prop.CanRead)
                {
                    object value = prop.GetValue(component);
                    return value?.ToString(); // enum.ToString() IS the member name
                }

                System.Reflection.FieldInfo field = type.GetField(_signalProperty, flags);
                if (field != null)
                {
                    object value = field.GetValue(component);
                    return value?.ToString();
                }

                return null; // no such public member
            }
            catch
            {
                // Never let advisory sampling break recording.
                return null;
            }
        }

        /// <summary>
        /// Resolve (and cache) the GameObject holding the declared signal, addressed by the
        /// same "/A/B[index]/C" path format <see cref="BuildRuntimePath"/> emits: split on
        /// '/', match a scene-root by name, then descend child-by-name honouring an optional
        /// "[index]" suffix (the n-th same-named sibling). Returns null if any segment is
        /// unresolved. Cached because the signal object doesn't move during a session.
        /// </summary>
        private static GameObject ResolveSignalObject()
        {
            if (_signalResolved != null)
                return _signalResolved;

            string path = _signalPath;
            if (string.IsNullOrEmpty(path))
                return null;

            // Leading '/' produces an empty first segment — drop empties.
            string[] rawSegments = path.Split('/');
            var segments = new List<string>();
            foreach (string seg in rawSegments)
            {
                if (!string.IsNullOrEmpty(seg))
                    segments.Add(seg);
            }
            if (segments.Count == 0)
                return null;

            // Root segment: search all loaded scenes' root objects (no scene pin — mirrors
            // how replay resolves a path without a scene).
            ParseSegment(segments[0], out string rootName, out int rootIndex);
            GameObject current = FindSceneRoot(rootName, rootIndex);
            if (current == null)
                return null;

            // Descend child-by-name.
            for (int i = 1; i < segments.Count; i++)
            {
                ParseSegment(segments[i], out string childName, out int childIndex);
                GameObject next = FindChild(current.transform, childName, childIndex);
                if (next == null)
                    return null;
                current = next;
            }

            _signalResolved = current;
            return current;
        }

        /// <summary>Split a path segment "Name[2]" into its name and index (index 0 when no suffix).</summary>
        private static void ParseSegment(string segment, out string name, out int index)
        {
            name = segment;
            index = 0;
            int open = segment.LastIndexOf('[');
            if (open > 0 && segment.EndsWith("]"))
            {
                string inner = segment.Substring(open + 1, segment.Length - open - 2);
                if (int.TryParse(inner, out int parsed) && parsed >= 0)
                {
                    name = segment.Substring(0, open);
                    index = parsed;
                }
            }
        }

        /// <summary>The <paramref name="index"/>-th root GameObject named <paramref name="name"/> across all loaded scenes, or null.</summary>
        private static GameObject FindSceneRoot(string name, int index)
        {
            int seen = 0;
            for (int s = 0; s < UnityEngine.SceneManagement.SceneManager.sceneCount; s++)
            {
                UnityEngine.SceneManagement.Scene scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(s);
                if (!scene.IsValid() || !scene.isLoaded)
                    continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    if (root.name == name)
                    {
                        if (seen == index)
                            return root;
                        seen++;
                    }
                }
            }
            return null;
        }

        /// <summary>The <paramref name="index"/>-th direct child named <paramref name="name"/> under <paramref name="parent"/>, or null.</summary>
        private static GameObject FindChild(Transform parent, string name, int index)
        {
            int seen = 0;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform child = parent.GetChild(i);
                if (child.gameObject.name == name)
                {
                    if (seen == index)
                        return child.gameObject;
                    seen++;
                }
            }
            return null;
        }

        /// <summary>
        /// The runtime hierarchy path of <paramref name="go"/> as "/A/B[index]/C" — a
        /// faithful mirror of the Editor <c>LocatorResolver.GetHierarchyPathWithIndex</c>
        /// (a sibling index is appended only when a name is duplicated under its parent),
        /// so the path the resolver parses back at replay matches. Computed in the runtime
        /// assembly so it can run at gesture time (the Editor resolver runs only at stop).
        /// KEEP IN SYNC with that Editor builder; both are guarded by
        /// <c>InputObserverPathTests</c> (the observer path must resolve back to its object).
        /// </summary>
        private static string BuildRuntimePath(GameObject go)
        {
            if (go == null)
                return null;

            var segments = new List<string>();
            Transform current = go.transform;
            while (current != null)
            {
                string name = current.gameObject.name;
                Transform parent = current.parent;
                int duplicateCount = 0;
                int myIndex = 0;

                if (parent != null)
                {
                    for (int i = 0; i < parent.childCount; i++)
                    {
                        Transform sibling = parent.GetChild(i);
                        if (sibling.gameObject.name == name)
                        {
                            if (sibling == current)
                                myIndex = duplicateCount;
                            duplicateCount++;
                        }
                    }
                }
                else if (current.gameObject.scene.IsValid())
                {
                    foreach (GameObject root in current.gameObject.scene.GetRootGameObjects())
                    {
                        if (root.name == name)
                        {
                            if (root == current.gameObject)
                                myIndex = duplicateCount;
                            duplicateCount++;
                        }
                    }
                }

                segments.Add(duplicateCount > 1 ? $"{name}[{myIndex}]" : name);
                current = parent;
            }

            segments.Reverse();
            return "/" + string.Join("/", segments);
        }

        /// <summary>The topmost uGUI element under the point, or null (mirrors EventSystemPointerDispatch).</summary>
        private static GameObject RaycastUI(Vector2 screenPoint)
        {
            EventSystem es = EventSystem.current;
            if (es == null)
                es = Object.FindFirstObjectByType<EventSystem>();
            if (es == null)
                return null;

            var pointer = new PointerEventData(es) { position = screenPoint };
            var results = new List<RaycastResult>();
            es.RaycastAll(pointer, results);
            return results.Count > 0 ? results[0].gameObject : null;
        }

        /// <summary>
        /// The topmost uGUI element under the point that is NOT <paramref name="exclude"/>
        /// or a descendant of it — the drop target beneath a dragged element (which
        /// follows the pointer and would otherwise be the topmost hit). Null if none.
        /// </summary>
        private static GameObject RaycastUIExcluding(Vector2 screenPoint, GameObject exclude)
        {
            EventSystem es = EventSystem.current;
            if (es == null)
                es = Object.FindFirstObjectByType<EventSystem>();
            if (es == null)
                return null;

            var pointer = new PointerEventData(es) { position = screenPoint };
            var results = new List<RaycastResult>();
            es.RaycastAll(pointer, results);
            foreach (RaycastResult result in results)
            {
                GameObject go = result.gameObject;
                if (go == null)
                    continue;
                // IsChildOf is true for the transform itself or any descendant.
                if (exclude != null && go.transform.IsChildOf(exclude.transform))
                    continue;
                return go;
            }
            return null;
        }

        /// <summary>
        /// A non-uGUI collider under the point — 2D overlap first, then a 3D ray. Each
        /// branch is gated on the corresponding physics module being present (the asmdef
        /// versionDefines), so the package compiles on projects without 2D/3D physics
        /// (world capture is simply unavailable there).
        /// </summary>
        private static GameObject RaycastWorld(Vector2 screenPoint)
        {
            Camera cam = Camera.main;
            if (cam == null)
                cam = Object.FindFirstObjectByType<Camera>();
            if (cam == null)
                return null;

#if LOOMBRIDGE_PHYSICS2D
            // 2D: a physics overlap at the world point (matches the common sprite-tap
            // pattern, e.g. CountTheFruits' TapInput: ScreenToWorldPoint → OverlapPoint).
            Vector3 world = cam.ScreenToWorldPoint(screenPoint);
            Collider2D collider2d = Physics2D.OverlapPoint(world);
            if (collider2d != null)
                return collider2d.gameObject;
#endif
#if LOOMBRIDGE_PHYSICS3D
            // 3D: a ray from the camera through the point.
            if (Physics.Raycast(cam.ScreenPointToRay(screenPoint), out RaycastHit raycastHit))
                return raycastHit.collider.gameObject;
#endif
            return null;
        }

        private static bool TryGetLeftMouseDown(out Vector2 screenPoint)
        {
            screenPoint = default;
            try
            {
                if (!Input.GetMouseButtonDown(0))
                    return false;

                Vector3 mouse = Input.mousePosition;
                screenPoint = new Vector2(mouse.x, mouse.y);
                return true;
            }
            catch (System.InvalidOperationException)
            {
                // Legacy Input is disabled (Active Input Handling = "Input System").
                // New-Input-System pointer observation is a follow-on.
                return false;
            }
        }

        /// <summary>
        /// The current legacy-Input mouse position, guarding the InvalidOperationException
        /// thrown when legacy Input is disabled (Active Input Handling = "Input System") —
        /// same pattern as TryGetLeftMouseDown/Up. Used to integrate per-frame pointer travel.
        /// </summary>
        private static bool TryGetMousePosition(out Vector2 screenPoint)
        {
            screenPoint = default;
            try
            {
                Vector3 mouse = Input.mousePosition;
                screenPoint = new Vector2(mouse.x, mouse.y);
                return true;
            }
            catch (System.InvalidOperationException)
            {
                return false; // legacy Input disabled — travel stays at its initialized value
            }
        }

        private static bool TryGetLeftMouseUp(out Vector2 screenPoint)
        {
            screenPoint = default;
            try
            {
                if (!Input.GetMouseButtonUp(0))
                    return false;

                Vector3 mouse = Input.mousePosition;
                screenPoint = new Vector2(mouse.x, mouse.y);
                return true;
            }
            catch (System.InvalidOperationException)
            {
                return false; // legacy Input disabled — same follow-on as the down path
            }
        }

        private void OnDisable()
        {
            if (_instance == this)
                _instance = null;
        }
    }
}
