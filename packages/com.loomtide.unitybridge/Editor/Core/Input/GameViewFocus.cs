using System;
using UnityEditor;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Focus helper for deterministic Game View input routing.
    /// </summary>
    public static class GameViewFocus
    {
        private static readonly Type GameViewType = Type.GetType("UnityEditor.GameView, UnityEditor");

        public static bool IsGameViewAvailable()
        {
            return GameViewType != null;
        }

        public static bool IsGameViewFocused()
        {
            if (GameViewType == null)
                return false;

            EditorWindow focused = EditorWindow.focusedWindow;
            return focused != null && focused.GetType() == GameViewType;
        }

        public static bool EnsureGameViewFocused()
        {
            EditorWindow gameView = GetGameViewWindow();
            if (gameView == null)
                return false;

            gameView.Focus();
            return IsGameViewFocused();
        }

        public static EditorWindow GetGameViewWindow()
        {
            if (GameViewType == null)
                return null;

            return EditorWindow.GetWindow(GameViewType, false, "Game", false);
        }
    }
}
