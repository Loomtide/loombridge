using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Reflection-safe seam for interacting with Unity Input System APIs.
    /// </summary>
    public interface IInputSystemAdapter
    {
        /// <summary>
        /// True when the Unity Input System package is installed.
        /// </summary>
        bool IsInstalled { get; }

        /// <summary>
        /// True when required runtime APIs are available for key injection.
        /// </summary>
        bool IsReady { get; }

        /// <summary>
        /// Start an input session for deterministic key injection.
        /// </summary>
        void BeginSession();

        /// <summary>
        /// End an input session and release backend resources.
        /// </summary>
        void EndSession();

        /// <summary>
        /// Apply key state change through Input System event APIs.
        /// </summary>
        void SetKeyState(KeyCode keyCode, bool pressed);

        /// <summary>
        /// Queue a one-frame key tap.
        /// </summary>
        void TapKey(KeyCode keyCode);
    }
}
