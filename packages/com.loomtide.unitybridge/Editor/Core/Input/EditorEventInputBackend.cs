using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Legacy-safe input backend that injects Editor events into the Game View.
    /// </summary>
    public sealed class EditorEventInputBackend : IInputBackend
    {
        private readonly HashSet<KeyCode> _pressedKeys = new HashSet<KeyCode>();
        private readonly HashSet<KeyCode> _pendingReleaseKeys = new HashSet<KeyCode>();

        public string Name => "EditorEvent";
        public bool IsAvailable => GameViewFocus.IsGameViewAvailable();
        public bool RequiresGameViewFocus => true;

        // SendEvent only reaches IMGUI / the UI EventSystem (used by ClickUi); it does NOT
        // feed legacy UnityEngine.Input polling (Input.GetAxis/GetButton) — proven 2026-06-05,
        // focus held. So gameplay key injection through this backend is unsupported.
        public bool CanInjectGameplayKeys => false;

        public bool HasHeldKeys => _pressedKeys.Count > 0 || _pendingReleaseKeys.Count > 0;

        public JArray GetLimitations()
        {
            return new JArray(
                "Uses Editor event injection fallback",
                "Requires focused Game View",
                "Event fidelity depends on Unity Editor window event routing"
            );
        }

        public void BeginSession(string sessionId)
        {
            _pressedKeys.Clear();
            _pendingReleaseKeys.Clear();
        }

        public void EndSession()
        {
            var pressedSnapshot = new List<KeyCode>(_pressedKeys);
            foreach (KeyCode keyCode in pressedSnapshot)
            {
                try
                {
                    SendKeyEvent(EventType.KeyUp, keyCode);
                }
                catch
                {
                    // Cleanup should continue for other keys even if one release fails.
                }
            }

            _pressedKeys.Clear();
            _pendingReleaseKeys.Clear();
        }

        public void KeyDown(KeyCode keyCode)
        {
            SendKeyEvent(EventType.KeyDown, keyCode);
            _pressedKeys.Add(keyCode);
        }

        public void KeyUp(KeyCode keyCode)
        {
            SendKeyEvent(EventType.KeyUp, keyCode);
            _pressedKeys.Remove(keyCode);
            _pendingReleaseKeys.Remove(keyCode);
        }

        public void KeyTap(KeyCode keyCode)
        {
            SendKeyEvent(EventType.KeyDown, keyCode);
            _pressedKeys.Add(keyCode);

            if (!_pendingReleaseKeys.Add(keyCode))
                return;

            // Delay key release by one editor tick so gameplay polling can
            // observe a pressed frame (critical for Jump-style actions).
            EditorApplication.delayCall += () =>
            {
                if (!_pendingReleaseKeys.Remove(keyCode))
                    return;

                try
                {
                    SendKeyEvent(EventType.KeyUp, keyCode);
                }
                catch
                {
                    // Best effort: session cleanup will still release held keys.
                }

                _pressedKeys.Remove(keyCode);
            };
        }

        public void ClickUi(JObject parameters)
        {
            int button = parameters?.Value<int?>("button") ?? 0;
            float x = parameters?.Value<float?>("x") ?? 0f;
            float y = parameters?.Value<float?>("y") ?? 0f;

            SendMouseEvent(EventType.MouseDown, button, x, y);
            SendMouseEvent(EventType.MouseUp, button, x, y);
        }

        private void SendKeyEvent(EventType eventType, KeyCode keyCode)
        {
            EditorWindow gameView = RequireGameViewWindow();
            var evt = new Event
            {
                type = eventType,
                keyCode = keyCode,
                character = KeyCodeToCharacter(keyCode)
            };

            bool accepted = gameView.SendEvent(evt);
            if (!accepted)
            {
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    $"EditorEvent backend rejected {eventType} for key '{keyCode}'.");
            }
        }

        private void SendMouseEvent(EventType eventType, int button, float x, float y)
        {
            EditorWindow gameView = RequireGameViewWindow();
            var evt = new Event
            {
                type = eventType,
                button = button,
                mousePosition = new Vector2(x, y)
            };

            bool accepted = gameView.SendEvent(evt);
            if (!accepted)
            {
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    $"EditorEvent backend rejected {eventType} for mouse button '{button}'.");
            }
        }

        private static EditorWindow RequireGameViewWindow()
        {
            EditorWindow gameView = GameViewFocus.GetGameViewWindow();
            if (gameView == null)
            {
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "Game View is unavailable for EditorEvent input backend.");
            }

            return gameView;
        }

        private static char KeyCodeToCharacter(KeyCode keyCode)
        {
            string name = keyCode.ToString();
            if (name.Length == 1)
                return char.ToLowerInvariant(name[0]);

            if (keyCode >= KeyCode.Alpha0 && keyCode <= KeyCode.Alpha9)
            {
                int value = keyCode - KeyCode.Alpha0;
                return (char)('0' + value);
            }

            if (keyCode == KeyCode.Space)
                return ' ';

            return '\0';
        }
    }
}
