#if ENABLE_INPUT_SYSTEM
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace UnityBridge.Runtime
{
    [DefaultExecutionOrder(-32000)]
    public sealed class InputSystemRuntimePump : MonoBehaviour
    {
        // Keep synthetic taps active for multiple runtime frames so both
        // InputSystem and legacy GetButtonDown polling observe the press.
        private const int TapHoldFrames = 2;

        private static readonly HashSet<Key> HeldKeys = new HashSet<Key>();
        private static readonly Dictionary<Key, int> TapFrames = new Dictionary<Key, int>();

        private static InputSystemRuntimePump _instance;
        private static Keyboard _virtualKeyboard;
        private static Mouse _virtualMouse;
        // Pointer tap state: hold the left button down for `_pointerDownFrames` runtime
        // frames at `_pointerPosition`, then emit one release frame, so both the
        // Input-System press EDGE (`Pointer.current.press.wasPressedThisFrame`, which a
        // game like CountTheFruits' TapInput reads) and the release EDGE actually fire.
        private static Vector2 _pointerPosition;
        private static int _pointerDownFrames;
        private static bool _pointerWasDown;
        private static bool _sessionActive;
        private static bool _capturedRunInBackground;
        private static bool _previousRunInBackground;

#if UNITY_EDITOR
        // Saved InputSystem focus/background settings, captured when a session applies the
        // focus-independent overrides and restored on teardown (see ApplyFocusIndependentInput).
        private static bool _focusSettingsApplied;
        private static InputSettings.BackgroundBehavior _savedBackgroundBehavior;
        private static InputSettings.EditorInputBehaviorInPlayMode _savedEditorBehavior;
#endif

        public static void BeginSession()
        {
            EnsureInstance();
            // Start every session from a clean slate so a prior session that was
            // never torn down cleanly (e.g. expired) can't leak held keys into this
            // one and drive the controller with a phantom press.
            HeldKeys.Clear();
            TapFrames.Clear();
            _sessionActive = true;
            EnableRunInBackground();
            ApplyFocusIndependentInput();
        }

        /// <summary>
        /// TRUE only while a session's focus-independent InputSystem overrides are actually
        /// APPLIED (see ApplyFocusIndependentInput). This is the live state of the setting,
        /// not a claim that a session exists: the editor-side focus gate for a simulated
        /// pointer tap reads it to decide whether an unfocused tap can really be delivered,
        /// so it must never report true after RestoreFocusIndependentInput has run.
        ///
        /// Always false outside the editor: the overrides are editor-only, and a player build
        /// has no Game View focus concept to be independent of.
        /// </summary>
        public static bool IsFocusIndependentInputApplied()
        {
#if UNITY_EDITOR
            return _focusSettingsApplied;
#else
            return false;
#endif
        }

        public static void EndSession()
        {
            _sessionActive = false;
            HeldKeys.Clear();
            TapFrames.Clear();
            RestoreRunInBackground();

            // Flush the empty-state release while the focus-independent settings are still
            // active, so the key-release actually reaches any bound InputAction (under the
            // restored default settings a backgrounded action would ignore it); then restore
            // the developer's settings and remove the device.
            QueueStateAndUpdate();
            RestoreFocusIndependentInput();
            RemoveVirtualKeyboard();
            RemoveVirtualMouse();
            DestroyInstance();
        }

        public static void SetKeyState(string keyName, bool pressed)
        {
            EnsureInstance();
            _sessionActive = true;

            if (!TryResolveKey(keyName, out Key key))
                return;

            if (pressed)
            {
                HeldKeys.Add(key);
                TapFrames.Remove(key);
            }
            else
            {
                HeldKeys.Remove(key);
                TapFrames.Remove(key);
            }
        }

        public static void TapKey(string keyName)
        {
            EnsureInstance();
            _sessionActive = true;

            if (!TryResolveKey(keyName, out Key key))
                return;

            HeldKeys.Add(key);
            TapFrames[key] = TapHoldFrames;
        }

        /// <summary>
        /// Queue a SIMULATED Input System pointer tap (left button) at a Game-View
        /// screen point — origin bottom-left, matching `Camera.WorldToScreenPoint` /
        /// the bridge's screen rects. The press is held for a couple of runtime frames
        /// then released by the per-frame pump, so a game reading `Pointer.current`
        /// observes both edges. Drives any non-uGUI target the game resolves from the
        /// pointer (e.g. a `Physics2D.OverlapPoint` sprite hit).
        /// </summary>
        public static void TapPointerAt(float screenX, float screenY)
        {
            EnsureInstance();
            _sessionActive = true;
            // runInBackground (so the game loop ticks) is reset on play-stop; the
            // virtual mouse is removed on play-stop's domain reload. We deliberately do
            // NOT touch InputSystem.settings here (ApplyFocusIndependentInput), since a
            // one-shot pointer tap has no end_session to RESTORE them — so it would leak
            // the developer's editor settings. v1 trade-off: the editor should be focused.
            EnableRunInBackground();
            EnsureVirtualMouse();

            _pointerPosition = new Vector2(screenX, screenY);
            _pointerDownFrames = TapHoldFrames;
            _pointerWasDown = false;
            // NOTE: a one-shot tap has no end_session owner, so the virtual mouse +
            // runInBackground + the pump's idle Update are reclaimed only by play-stop's
            // domain reload (bounded to the play session, no editor-asset mutation). A
            // proper lifecycle owner (a playModeStateChanged → EndSession hook) is a
            // follow-on; it matters more if DisableDomainReload is ever enabled.
        }

        private static void EnsureInstance()
        {
            if (_instance != null)
                return;

            var go = new GameObject("[Loombridge] InputSystemRuntimePump");
            go.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<InputSystemRuntimePump>();
            EnsureVirtualKeyboard();
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

        private static void EnsureVirtualKeyboard()
        {
            if (_virtualKeyboard != null)
                return;

            _virtualKeyboard = InputSystem.AddDevice<Keyboard>("[Loombridge] VirtualKeyboard");
        }

        private static void RemoveVirtualKeyboard()
        {
            if (_virtualKeyboard == null)
                return;

            InputSystem.RemoveDevice(_virtualKeyboard);
            _virtualKeyboard = null;
        }

        private static void EnsureVirtualMouse()
        {
            if (_virtualMouse != null)
                return;

            _virtualMouse = InputSystem.AddDevice<Mouse>("[Loombridge] VirtualMouse");
        }

        private static void RemoveVirtualMouse()
        {
            if (_virtualMouse == null)
                return;

            InputSystem.RemoveDevice(_virtualMouse);
            _virtualMouse = null;
            _pointerDownFrames = 0;
            _pointerWasDown = false;
        }

        /// <summary>
        /// Queue this frame's pointer state (called from QueueStateAndUpdate, before the
        /// shared InputSystem.Update). Emits a press frame while held, then exactly one
        /// release frame, so both the press and release EDGES fire for game code.
        /// </summary>
        private static bool QueuePointerState()
        {
            if (_virtualMouse == null)
                return false;
            if (_pointerDownFrames <= 0 && !_pointerWasDown)
                return false;

            if (!_virtualMouse.enabled)
                InputSystem.EnableDevice(_virtualMouse);

            bool down = _pointerDownFrames > 0;
            var mouseState = new MouseState { position = _pointerPosition }.WithButton(MouseButton.Left, down);
            InputSystem.QueueStateEvent(_virtualMouse, mouseState);
            if (down)
                _pointerDownFrames--;
            _pointerWasDown = down;
            return true;
        }

        private static void QueueStateAndUpdate()
        {
            // The pointer is independent of the keyboard device — queue it first so a tap
            // pumps even on a (hypothetical) keyboard-less session.
            bool queued = QueuePointerState();

            if (_virtualKeyboard == null)
            {
                if (queued)
                    InputSystem.Update();
                return;
            }

            // A focus-independent settings reassign (ApplyFocusIndependentInput) or a focus
            // transition can leave the device disabled; re-enable it so the queued state is
            // not silently dropped (issue #37: a disabled device swallows QueueStateEvent).
            if (!_virtualKeyboard.enabled)
                InputSystem.EnableDevice(_virtualKeyboard);

            var state = new KeyboardState();
            foreach (Key key in HeldKeys)
                state.Set(key, true);

            // Inject ONLY into our own virtual keyboard. We deliberately do NOT mirror
            // this state onto the developer's real keyboard device: a full KeyboardState
            // event REPLACES a device's state, so writing our (often empty) held-key set
            // onto the real keyboard every frame would zero the human's own presses —
            // wedging all input, bridge and human, for the life of the session. The
            // virtual keyboard is a real InputSystem Keyboard device, so InputActions
            // bound to <Keyboard>/… (and InputSystem-backed UnityEngine.Input) read it
            // directly; legacy Input is mirrored separately via the EditorEvent backend
            // (InputSystemBackend.TryMirrorKeyAction), which does not clobber real devices.
            InputSystem.QueueStateEvent(_virtualKeyboard, state);
            InputSystem.Update();
        }

        private static void EnableRunInBackground()
        {
            if (!Application.isPlaying)
                return;

            if (!_capturedRunInBackground)
            {
                _previousRunInBackground = Application.runInBackground;
                _capturedRunInBackground = true;
            }

            Application.runInBackground = true;
        }

        private static void RestoreRunInBackground()
        {
            if (!_capturedRunInBackground)
                return;

            if (Application.isPlaying)
                Application.runInBackground = _previousRunInBackground;

            _capturedRunInBackground = false;
        }

        /// <summary>
        /// Make InputSystem input delivery focus-independent for the life of a bridge session.
        /// Editor-only: when the Editor application is OS-backgrounded, the default
        /// editorInputBehaviorInPlayMode (PointersAndKeyboardsRespectGameViewFocus) parks
        /// InputActions in Waiting even though the synthetic keyboard's control state is live —
        /// so input-driven capture reads deltaX=0 (issue #37). IgnoreFocus keeps the device
        /// enabled while unfocused; AllDeviceInputAlwaysGoesToGameView routes its input into
        /// actions while unfocused. Proven against the OnlineSamples 2D platformer with the app
        /// backgrounded throughout: action Waiting->Started, /Player deltaX 0->2.25. Idempotent;
        /// the prior values are saved and restored in RestoreFocusIndependentInput. No-op in a
        /// player build (the bridge only drives the Editor, and the setting is editor-only).
        /// </summary>
        private static void ApplyFocusIndependentInput()
        {
#if UNITY_EDITOR
            if (_focusSettingsApplied)
                return;

            InputSettings settings = InputSystem.settings;
            if (settings == null)
                return;

            _savedBackgroundBehavior = settings.backgroundBehavior;
            _savedEditorBehavior = settings.editorInputBehaviorInPlayMode;

            settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            settings.editorInputBehaviorInPlayMode =
                InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            // Reassign so InputSystem re-reads the changed settings this frame.
            InputSystem.settings = settings;
            _focusSettingsApplied = true;
#endif
        }

        /// <summary>
        /// Restore the InputSystem focus/background settings captured in
        /// ApplyFocusIndependentInput. Best-effort and idempotent so a session torn down on any
        /// path (clean EndSession, idle expiry, Play Mode stop) leaves the developer's editor
        /// settings exactly as they were.
        /// </summary>
        private static void RestoreFocusIndependentInput()
        {
#if UNITY_EDITOR
            if (!_focusSettingsApplied)
                return;

            InputSettings settings = InputSystem.settings;
            if (settings != null)
            {
                settings.backgroundBehavior = _savedBackgroundBehavior;
                settings.editorInputBehaviorInPlayMode = _savedEditorBehavior;
                InputSystem.settings = settings;
            }

            _focusSettingsApplied = false;
#endif
        }

        private static bool TryResolveKey(string keyName, out Key key)
        {
            if (string.IsNullOrEmpty(keyName))
            {
                key = Key.None;
                return false;
            }

            return System.Enum.TryParse(keyName, false, out key);
        }

        private void Update()
        {
            if (!_sessionActive)
                return;

            EnsureVirtualKeyboard();

            foreach (Key key in new List<Key>(TapFrames.Keys))
            {
                int framesRemaining = TapFrames[key];
                if (framesRemaining <= 0)
                {
                    HeldKeys.Remove(key);
                    TapFrames.Remove(key);
                    continue;
                }

                TapFrames[key] = framesRemaining - 1;
            }

            QueueStateAndUpdate();
        }

        private void OnDisable()
        {
            if (_instance == this)
                _instance = null;
        }
    }
}
#endif
