using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Input System backend selected first when com.unity.inputsystem is installed.
    /// Uses reflection-safe probing to keep 2022.3 compatibility without hard dependency.
    /// </summary>
    // Keep this backend reflection-driven so the plugin compiles in projects without com.unity.inputsystem.
    public sealed class InputSystemBackend : IInputBackend
    {
        private readonly IInputSystemAdapter _adapter;
        private readonly IInputBackend _eventFallback;
        private readonly HashSet<KeyCode> _pressedKeys = new HashSet<KeyCode>();

        public InputSystemBackend()
            : this(new ReflectionInputSystemAdapter(), new EditorEventInputBackend())
        {
        }

        public InputSystemBackend(IInputSystemAdapter adapter, IInputBackend eventFallback)
        {
            _adapter = adapter ?? throw new ArgumentNullException(nameof(adapter));
            _eventFallback = eventFallback ?? throw new ArgumentNullException(nameof(eventFallback));
        }

        public string Name => "InputSystem";
        public bool IsAvailable => _adapter.IsInstalled && _adapter.IsReady;
        public bool RequiresGameViewFocus => false;

        // The runtime virtual-keyboard pump drives real InputSystem device state, which the
        // Input System observes directly (and legacy Input observes when Active Input Handling
        // is set to "Both"). Unlike the EditorEvent fallback, this backend genuinely injects
        // gameplay key state — gated on availability so an uninstalled package is not advertised.
        public bool CanInjectGameplayKeys => IsAvailable;

        public bool HasHeldKeys => _pressedKeys.Count > 0;

        public JArray GetLimitations()
        {
            return new JArray(
                "Requires Unity Input System package",
                "Reflection-safe backend for Unity 6000.3 / 2022.3 compatibility",
                "Uses runtime virtual keyboard injection to avoid macOS accessibility blockers",
                "UI click dispatch falls back to EditorEvent backend",
                $"Runtime status: installed={_adapter.IsInstalled}, ready={_adapter.IsReady}"
            );
        }

        public void BeginSession(string sessionId)
        {
            EnsureAvailable();
            _pressedKeys.Clear();
            _adapter.BeginSession();
            _eventFallback.BeginSession(sessionId);
        }

        public void EndSession()
        {
            foreach (KeyCode pressedKey in new List<KeyCode>(_pressedKeys))
            {
                try
                {
                    _adapter.SetKeyState(pressedKey, false);
                }
                catch
                {
                    // Cleanup is best effort; continue releasing remaining keys.
                }
            }

            _pressedKeys.Clear();

            try
            {
                _adapter.EndSession();
            }
            catch
            {
                // Adapter cleanup is best effort.
            }

            _eventFallback.EndSession();
        }

        public void KeyDown(KeyCode keyCode)
        {
            EnsureAvailable();
            _adapter.SetKeyState(keyCode, true);
            _pressedKeys.Add(keyCode);
            TryMirrorKeyAction(() => _eventFallback.KeyDown(keyCode), "key_down", keyCode);
        }

        public void KeyUp(KeyCode keyCode)
        {
            EnsureAvailable();
            _adapter.SetKeyState(keyCode, false);
            _pressedKeys.Remove(keyCode);
            TryMirrorKeyAction(() => _eventFallback.KeyUp(keyCode), "key_up", keyCode);
        }

        public void KeyTap(KeyCode keyCode)
        {
            EnsureAvailable();
            _adapter.TapKey(keyCode);
            TryMirrorKeyAction(() => _eventFallback.KeyTap(keyCode), "key_tap", keyCode);
        }

        public void ClickUi(JObject parameters)
        {
            EnsureAvailable();
            _eventFallback.ClickUi(parameters);
        }

        private void EnsureAvailable()
        {
            if (!_adapter.IsInstalled)
            {
                throw new BridgeException(ErrorCodes.INPUT_SYSTEM_NOT_INSTALLED,
                    "Unity Input System package is not installed.");
            }

            if (!_adapter.IsReady)
            {
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "Input System backend is installed but runtime key injection APIs are unavailable.");
            }
        }

        private void TryMirrorKeyAction(Action mirrorAction, string actionName, KeyCode keyCode)
        {
            if (mirrorAction == null || _eventFallback == null)
                return;

            // Best effort: keep InputSystem as primary and opportunistically mirror the key
            // event to the EditorEvent backend. NOTE: this does NOT make legacy
            // UnityEngine.Input polling (Input.GetAxis/GetButton) observe the key — SendEvent
            // only reaches IMGUI / the UI EventSystem. The mirror is retained solely so
            // IMGUI/EventSystem-driven UI in mixed projects still receives the event; gameplay
            // key injection that legacy Input can see comes from the InputSystem pump above.
            if (!_eventFallback.IsAvailable)
                return;

            if (_eventFallback.RequiresGameViewFocus)
                GameViewFocus.EnsureGameViewFocused();

            try
            {
                mirrorAction();
            }
            catch (Exception ex)
            {
                Debug.Log($"[Loombridge] InputSystem mirror fallback ignored for {actionName} '{keyCode}': {ex.Message}");
            }
        }

        private sealed class ReflectionInputSystemAdapter : IInputSystemAdapter
        {
            private static Type _inputSystemType;
            private static Type _keyType;
            private static Type _runtimePumpType;
            private static MethodInfo _beginSessionMethod;
            private static MethodInfo _endSessionMethod;
            private static MethodInfo _setKeyStateMethod;
            private static MethodInfo _tapKeyMethod;

            private static readonly Dictionary<KeyCode, string> KeyAliases = new Dictionary<KeyCode, string>
            {
                { KeyCode.Alpha0, "Digit0" },
                { KeyCode.Alpha1, "Digit1" },
                { KeyCode.Alpha2, "Digit2" },
                { KeyCode.Alpha3, "Digit3" },
                { KeyCode.Alpha4, "Digit4" },
                { KeyCode.Alpha5, "Digit5" },
                { KeyCode.Alpha6, "Digit6" },
                { KeyCode.Alpha7, "Digit7" },
                { KeyCode.Alpha8, "Digit8" },
                { KeyCode.Alpha9, "Digit9" },
                { KeyCode.Keypad0, "Numpad0" },
                { KeyCode.Keypad1, "Numpad1" },
                { KeyCode.Keypad2, "Numpad2" },
                { KeyCode.Keypad3, "Numpad3" },
                { KeyCode.Keypad4, "Numpad4" },
                { KeyCode.Keypad5, "Numpad5" },
                { KeyCode.Keypad6, "Numpad6" },
                { KeyCode.Keypad7, "Numpad7" },
                { KeyCode.Keypad8, "Numpad8" },
                { KeyCode.Keypad9, "Numpad9" },
                { KeyCode.Return, "Enter" },
                { KeyCode.KeypadEnter, "NumpadEnter" },
                { KeyCode.LeftControl, "LeftCtrl" },
                { KeyCode.RightControl, "RightCtrl" },
                { KeyCode.LeftCommand, "LeftMeta" },
                { KeyCode.RightCommand, "RightMeta" },
                { KeyCode.BackQuote, "Backquote" },
                { KeyCode.Escape, "Escape" }
            };

            public bool IsInstalled
            {
                get
                {
                    ResolveHandles();
                    return _inputSystemType != null && _keyType != null;
                }
            }

            public bool IsReady
            {
                get
                {
                    ResolveHandles();
                    return IsInstalled
                           && _runtimePumpType != null
                           && _beginSessionMethod != null
                           && _endSessionMethod != null
                           && _setKeyStateMethod != null
                           && _tapKeyMethod != null;
                }
            }

            public void BeginSession()
            {
                ResolveHandles();
                EnsureReady();
                InvokePumpVoid(_beginSessionMethod, null);
            }

            public void EndSession()
            {
                ResolveHandles();
                if (!IsReady)
                    return;

                InvokePumpVoid(_endSessionMethod, null);
            }

            public void SetKeyState(KeyCode keyCode, bool pressed)
            {
                ResolveHandles();

                if (keyCode == KeyCode.None)
                {
                    throw new BridgeException(ErrorCodes.INVALID_KEY,
                        "Input System backend cannot queue KeyCode.None.");
                }

                EnsureReady();
                string keyName = ResolveKeyName(keyCode);
                ResolveKeyEnum(keyCode);
                InvokePumpVoid(_setKeyStateMethod, new object[] { keyName, pressed });
            }

            public void TapKey(KeyCode keyCode)
            {
                ResolveHandles();

                if (keyCode == KeyCode.None)
                {
                    throw new BridgeException(ErrorCodes.INVALID_KEY,
                        "Input System backend cannot queue KeyCode.None.");
                }

                EnsureReady();
                string keyName = ResolveKeyName(keyCode);
                ResolveKeyEnum(keyCode);
                InvokePumpVoid(_tapKeyMethod, new object[] { keyName });
            }

            private static void EnsureReady()
            {
                if (!IsStaticInstalled())
                {
                    throw new BridgeException(ErrorCodes.INPUT_SYSTEM_NOT_INSTALLED,
                        "Unity Input System package is not installed.");
                }

                if (!IsStaticReady())
                {
                    throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        "Input System runtime pump APIs are unavailable.");
                }
            }

            private static bool IsStaticInstalled()
            {
                return _inputSystemType != null && _keyType != null;
            }

            private static bool IsStaticReady()
            {
                return IsStaticInstalled()
                       && _runtimePumpType != null
                       && _beginSessionMethod != null
                       && _endSessionMethod != null
                       && _setKeyStateMethod != null
                       && _tapKeyMethod != null;
            }

            private static void ResolveHandles()
            {
                _inputSystemType = ResolveType("UnityEngine.InputSystem.InputSystem", "Unity.InputSystem");
                _keyType = ResolveType("UnityEngine.InputSystem.Key", "Unity.InputSystem");
                _runtimePumpType = ResolveType("UnityBridge.Runtime.InputSystemRuntimePump", null);

                _beginSessionMethod = _runtimePumpType?.GetMethod(
                    "BeginSession",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    Type.EmptyTypes,
                    null);

                _endSessionMethod = _runtimePumpType?.GetMethod(
                    "EndSession",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    Type.EmptyTypes,
                    null);

                _setKeyStateMethod = _runtimePumpType?.GetMethod(
                    "SetKeyState",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(string), typeof(bool) },
                    null);

                _tapKeyMethod = _runtimePumpType?.GetMethod(
                    "TapKey",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(string) },
                    null);
            }

            private static Type ResolveType(string fullTypeName, string assemblyName)
            {
                Type type = Type.GetType(fullTypeName);
                if (type != null)
                    return type;

                if (!string.IsNullOrEmpty(assemblyName))
                {
                    type = Type.GetType($"{fullTypeName}, {assemblyName}");
                    if (type != null)
                        return type;
                }

                foreach (Assembly loadedAssembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type loadedType = loadedAssembly.GetType(fullTypeName, false);
                    if (loadedType != null)
                        return loadedType;
                }

                if (!string.IsNullOrEmpty(assemblyName))
                {
                    try
                    {
                        Assembly assembly = Assembly.Load(assemblyName);
                        if (assembly != null)
                            return assembly.GetType(fullTypeName, false);
                    }
                    catch
                    {
                        // Ignore load errors and fall back to path probing.
                    }

                    try
                    {
                        string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
                        string packageCachePath = Path.Combine(projectRoot, "Library", "PackageCache");
                        if (Directory.Exists(packageCachePath))
                        {
                            string[] matches = Directory.GetFiles(
                                packageCachePath,
                                $"{assemblyName}.dll",
                                SearchOption.AllDirectories);
                            if (matches.Length > 0)
                            {
                                Assembly fromPath = Assembly.LoadFrom(matches[0]);
                                if (fromPath != null)
                                {
                                    Type fromPathType = fromPath.GetType(fullTypeName, false);
                                    if (fromPathType != null)
                                        return fromPathType;
                                }
                            }
                        }
                    }
                    catch
                    {
                        // Ignore load-by-path errors and fall through to null.
                    }
                }

                return null;
            }

            private static object ResolveKeyEnum(KeyCode keyCode)
            {
                string keyName = ResolveKeyName(keyCode);
                try
                {
                    if (_keyType == null)
                    {
                        throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                            "Input System Key enum type is unavailable.");
                    }

                    return Enum.Parse(_keyType, keyName, ignoreCase: false);
                }
                catch (Exception ex)
                {
                    throw new BridgeException(ErrorCodes.INVALID_KEY,
                        $"Input System backend cannot map key '{keyCode}' to InputSystem.Key enum value '{keyName}'.", ex);
                }
            }

            private static string ResolveKeyName(KeyCode keyCode)
            {
                if (KeyAliases.TryGetValue(keyCode, out string alias))
                    return alias;

                return keyCode.ToString();
            }

            private static void InvokePumpVoid(MethodInfo method, object[] parameters)
            {
                try
                {
                    method.Invoke(null, parameters);
                }
                catch (TargetInvocationException ex)
                {
                    Exception inner = ex.InnerException ?? ex;
                    if (inner is BridgeException bridgeException)
                        throw bridgeException;

                    throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        $"Input System runtime pump invocation failed: {inner.Message}", inner);
                }
                catch (Exception ex)
                {
                    throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        $"Input System runtime pump invocation failed: {ex.Message}", ex);
                }
            }
        }
    }
}
