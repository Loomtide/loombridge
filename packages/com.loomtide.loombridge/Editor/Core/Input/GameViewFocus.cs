using System;
using UnityEditor;
using UnityEditorInternal;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Focus helper for deterministic Game View input routing.
    ///
    /// TWO DIFFERENT QUESTIONS live here, and conflating them is what let a recorder mint
    /// phantom steps:
    ///   <see cref="IsGameViewFocused"/>  "which Unity WINDOW receives an event the bridge
    ///                                     sends" (synthetic input routing, OS-activity
    ///                                     irrelevant: the bridge posts the event itself).
    ///   <see cref="IsGameViewInputFocused()"/>
    ///                                    "would a HUMAN's real click reach the game right
    ///                                     now" (needs the Game view frontmost inside Unity
    ///                                     AND Unity frontmost in the OS).
    /// </summary>
    public static class GameViewFocus
    {
        private static readonly Type GameViewType = Type.GetType("UnityEditor.GameView, UnityEditor");

        public static bool IsGameViewAvailable()
        {
            return GameViewType != null;
        }

        /// <summary>
        /// Is the Game view the frontmost window WITHIN Unity? Says nothing about whether Unity
        /// itself is the active OS application, so this alone is NOT the test for "a human's
        /// click lands in the game" (use <see cref="IsGameViewInputFocused()"/> for that).
        /// </summary>
        public static bool IsGameViewFocused()
        {
            if (GameViewType == null)
                return false;

            EditorWindow focused = EditorWindow.focusedWindow;
            return focused != null && focused.GetType() == GameViewType;
        }

        /// <summary>
        /// Is Unity the ACTIVE OS APPLICATION (frontmost, receiving the window manager's input)?
        ///
        /// <c>UnityEditorInternal.InternalEditorUtility.isApplicationActive</c> is the editor's own
        /// application-focus flag and the only direct answer available to editor code. It is
        /// referenced DIRECTLY rather than through reflection because the shipped package already
        /// depends on it compiling on every supported editor (Handlers/RuntimeHandler.cs reads the
        /// same property for the animation-freeze signal), so a reflection wrapper here would add no
        /// compile safety, only a second code path. Present in both locally verified editors
        /// (get_isApplicationActive in UnityEditor.dll on 6000.3 and 6000.5).
        /// </summary>
        public static bool IsApplicationActive()
        {
            return InternalEditorUtility.isApplicationActive;
        }

        /// <summary>
        /// THE DELIVERY PREDICATE, pure over its two live facts so the rule is testable without an
        /// editor: a human's click reaches the game only when the Game view is the frontmost window
        /// inside Unity AND Unity is the frontmost application in the OS.
        ///
        /// BOTH are required, and the second is the half that was missing. Unity-internal window
        /// focus is true whenever the Game view is Unity's frontmost window, INCLUDING while Unity
        /// sits in the background behind a terminal. A recorder started from a terminal therefore
        /// saw "focused", so the human's application-ACTIVATING click (which the editor swallows,
        /// the game never seeing it) was attributed as a real gesture: the trace recorded the same
        /// tap twice and replay died on the second one, whose target the first tap had navigated
        /// away from.
        /// </summary>
        public static bool IsGameViewInputFocused(bool gameViewFocused, bool applicationActive)
        {
            return gameViewFocused && applicationActive;
        }

        /// <summary>Live evaluation of <see cref="IsGameViewInputFocused(bool,bool)"/>.</summary>
        public static bool IsGameViewInputFocused()
        {
            return IsGameViewInputFocused(IsGameViewFocused(), IsApplicationActive());
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
