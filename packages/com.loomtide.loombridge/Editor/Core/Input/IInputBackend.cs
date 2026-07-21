using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Backend contract for in-process input automation implementations.
    /// </summary>
    public interface IInputBackend
    {
        /// <summary>
        /// Stable backend name used in capability payloads and traces.
        /// </summary>
        string Name { get; }

        /// <summary>
        /// True when the backend can execute input operations in the current editor state.
        /// </summary>
        bool IsAvailable { get; }

        /// <summary>
        /// True when the backend requires the Game view to be focused before injecting input.
        /// </summary>
        bool RequiresGameViewFocus { get; }

        /// <summary>
        /// True when the backend can drive gameplay key state that legacy <c>UnityEngine.Input</c>
        /// polling (<c>Input.GetAxis</c>/<c>GetButton</c>) and the Input System both observe.
        /// The EditorEvent backend injects via <c>EditorWindow.SendEvent</c>, which only reaches
        /// IMGUI / the UI EventSystem — it CANNOT feed legacy <c>Input</c> polling (proven
        /// 2026-06-05, even with the Game View focused). The InputSystem backend can. The key-op
        /// layer refuses gameplay key injection with <c>LEGACY_INPUT_UNSUPPORTED</c> when this is
        /// false, rather than misleading the operator with a focus prompt that would not help.
        /// UI click dispatch (<see cref="ClickUi"/>) is NOT gated by this.
        /// </summary>
        bool CanInjectGameplayKeys { get; }

        /// <summary>
        /// True when the backend currently holds one or more injected keys down. The idle
        /// watchdog only tears a session down when there is held key state to release, so an
        /// idle session with no held keys (e.g. an agent thinking between ops) is left alone.
        /// </summary>
        bool HasHeldKeys { get; }

        /// <summary>
        /// Backend-specific limitations communicated through capability negotiation.
        /// </summary>
        JArray GetLimitations();

        /// <summary>
        /// Start a deterministic input session.
        /// </summary>
        void BeginSession(string sessionId);

        /// <summary>
        /// End the active input session and release any held key state.
        /// </summary>
        void EndSession();

        /// <summary>
        /// Press and hold a key.
        /// </summary>
        void KeyDown(KeyCode keyCode);

        /// <summary>
        /// Release a key.
        /// </summary>
        void KeyUp(KeyCode keyCode);

        /// <summary>
        /// Tap a key (down + up).
        /// </summary>
        void KeyTap(KeyCode keyCode);

        /// <summary>
        /// Execute a UI click action.
        /// </summary>
        void ClickUi(JObject parameters);
    }
}
