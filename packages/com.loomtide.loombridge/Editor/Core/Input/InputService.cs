using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Capability surface and backend selection root for input automation.
    /// Execution methods are added by subsequent milestones.
    /// </summary>
    public sealed class InputService
    {
        private static readonly List<InputService> ActiveServices = new List<InputService>();
        private static readonly object ActiveServicesLock = new object();
        private static bool _updateHooked;

        // Process-wide keep-alive lease. While held (depth > 0), the idle watchdog in
        // Tick() does not tear down sessions: a long-running, non-input op (e.g.
        // runtime.measure_motion) is in flight, so the session owner is demonstrably
        // present and a held key must not be released mid-measurement. Static because the
        // runtime op handlers do not hold the registered InputService instance.
        private static int _keepAliveDepth;
        private static readonly object KeepAliveLock = new object();

        /// <summary>
        /// Idle window after which an active session is auto-torn-down. Generous enough
        /// to outlast any single automation step (a held-key measure window is ~1-2s),
        /// but bounded so a session whose owner went away (server-side expiry, dropped
        /// client) cannot leave injected key state driving the game — or, with the old
        /// pump, suppressing the developer's keyboard — indefinitely.
        /// </summary>
        public const double DefaultIdleTimeoutSeconds = 30.0;

        private static readonly string[] DefaultLimitations =
        {
            "Requires Play Mode for gameplay input",
            "Session lifecycle is required for key-state cleanup"
        };

        private readonly List<IInputBackend> _backends = new List<IInputBackend>();
        private readonly bool _requirePlayMode;
        private readonly Func<bool> _ensureGameViewFocus;
        private readonly Func<bool> _isGameViewFocused;
        private readonly Func<bool> _isPlaying;
        private readonly Func<double> _nowSeconds;
        private readonly double _idleTimeoutSeconds;

        private IInputBackend _activeBackend;
        private string _sessionId = string.Empty;
        private bool _allowEditModeSession;
        private double _lastActivitySeconds;

        public InputService()
            : this(new IInputBackend[0], true, null, null, null)
        {
        }

        public InputService(IEnumerable<IInputBackend> backends)
            : this(backends, true, null, null, null)
        {
        }

        public InputService(
            IEnumerable<IInputBackend> backends,
            bool requirePlayMode,
            Func<bool> ensureGameViewFocus,
            Func<bool> isGameViewFocused,
            Func<bool> isPlaying,
            Func<double> nowSeconds = null,
            double idleTimeoutSeconds = DefaultIdleTimeoutSeconds)
        {
            _requirePlayMode = requirePlayMode;
            _ensureGameViewFocus = ensureGameViewFocus ?? GameViewFocus.EnsureGameViewFocused;
            _isGameViewFocused = isGameViewFocused ?? GameViewFocus.IsGameViewFocused;
            _isPlaying = isPlaying ?? (() => EditorApplication.isPlaying);
            _nowSeconds = nowSeconds ?? (() => EditorApplication.timeSinceStartup);
            _idleTimeoutSeconds = idleTimeoutSeconds;

            if (backends == null)
            {
                RegisterService();
                return;
            }

            foreach (IInputBackend backend in backends)
            {
                if (backend != null)
                    _backends.Add(backend);
            }

            RegisterService();
        }

        public void RegisterBackend(IInputBackend backend)
        {
            if (backend == null)
                return;

            _backends.Add(backend);
        }

        public JObject BeginSession(JObject parameters)
        {
            if (IsSessionActive)
            {
                // A session is already active — return it but mark created:false so the
                // caller knows it did NOT create (and therefore does not own) this session.
                // The owning server keepalives only sessions it created; a second
                // server/agent must not inherit an existing session and keep it alive past
                // the original owner's death.
                return new JObject
                {
                    ["sessionId"] = _sessionId,
                    ["backend"] = _activeBackend?.Name ?? "none",
                    ["active"] = true,
                    ["created"] = false
                };
            }

            string preferredBackend = parameters?.Value<string>("backend");
            string requestedSessionId = parameters?.Value<string>("sessionId");
            _allowEditModeSession = parameters?.Value<bool?>("allowEditMode") ?? false;

            _activeBackend = SelectBackend(preferredBackend);
            _sessionId = string.IsNullOrEmpty(requestedSessionId)
                ? Guid.NewGuid().ToString("N")
                : requestedSessionId;

            if (_activeBackend.RequiresGameViewFocus && !_ensureGameViewFocus())
            {
                _activeBackend = null;
                _sessionId = string.Empty;
                throw new BridgeException(ErrorCodes.FOCUS_REQUIRED,
                    "Game View focus is required before starting an input session.");
            }

            _activeBackend.BeginSession(_sessionId);
            _lastActivitySeconds = _nowSeconds();
            TraceCollector.LogInputAction("begin_session", _activeBackend.Name, _sessionId);

            return new JObject
            {
                ["sessionId"] = _sessionId,
                ["backend"] = _activeBackend.Name,
                ["active"] = true,
                ["created"] = true
            };
        }

        public JObject EndSession()
        {
            bool wasActive = IsSessionActive;
            string endedSessionId = _sessionId;
            string backendName = _activeBackend?.Name ?? "none";
            if (wasActive)
            {
                TraceCollector.LogInputAction("end_session", backendName, endedSessionId);
            }
            SafeEndSession();

            return new JObject
            {
                ["ended"] = wasActive,
                ["sessionId"] = endedSessionId,
                ["backend"] = backendName
            };
        }

        public JObject KeyDown(JObject parameters)
        {
            string keyName = RequireKeyName(parameters);
            KeyCode keyCode = InputKeyMap.ResolveOrThrow(keyName);

            RunBackendAction("key_down", keyCode.ToString(), () => _activeBackend.KeyDown(keyCode),
                requiresGameplayKeyInjection: true);

            return new JObject
            {
                ["key"] = keyCode.ToString(),
                ["backend"] = _activeBackend.Name,
                ["pressed"] = true
            };
        }

        public JObject KeyUp(JObject parameters)
        {
            string keyName = RequireKeyName(parameters);
            KeyCode keyCode = InputKeyMap.ResolveOrThrow(keyName);

            RunBackendAction("key_up", keyCode.ToString(), () => _activeBackend.KeyUp(keyCode),
                requiresGameplayKeyInjection: true);

            return new JObject
            {
                ["key"] = keyCode.ToString(),
                ["backend"] = _activeBackend.Name,
                ["pressed"] = false
            };
        }

        public JObject KeyTap(JObject parameters)
        {
            string keyName = RequireKeyName(parameters);
            KeyCode keyCode = InputKeyMap.ResolveOrThrow(keyName);

            RunBackendAction("key_tap", keyCode.ToString(), () => _activeBackend.KeyTap(keyCode),
                requiresGameplayKeyInjection: true);

            return new JObject
            {
                ["key"] = keyCode.ToString(),
                ["backend"] = _activeBackend.Name,
                ["tapped"] = true
            };
        }

        public JObject ClickUi(JObject parameters)
        {
            RunBackendAction("click_ui", null, () => _activeBackend.ClickUi(parameters ?? new JObject()));

            return new JObject
            {
                ["clicked"] = true,
                ["backend"] = _activeBackend.Name
            };
        }

        public JObject GetCapabilities()
        {
            IInputBackend selected = IsSessionActive ? _activeBackend : FirstAvailableBackend();
            bool focusRequired = selected?.RequiresGameViewFocus ?? true;
            bool gameplayKeysSupported = selected?.CanInjectGameplayKeys ?? false;
            var backendSummaries = new JArray();
            var fallbackOrder = new JArray();
            var limitations = new JArray();

            foreach (string limitation in DefaultLimitations)
                limitations.Add(limitation);

            limitations.Add(focusRequired
                ? "Game View focus is required before key injection"
                : "Game View focus is not required for InputSystem key injection");

            if (!gameplayKeysSupported)
                limitations.Add("Legacy UnityEngine.Input: gameplay key injection unsupported (no Input System package).");

            foreach (IInputBackend backend in _backends)
            {
                if (backend == null)
                    continue;

                fallbackOrder.Add(backend.Name);
                backendSummaries.Add(new JObject
                {
                    ["name"] = backend.Name,
                    ["available"] = backend.IsAvailable,
                    ["requiresGameViewFocus"] = backend.RequiresGameViewFocus
                });

                JArray backendLimitations = backend.GetLimitations();
                if (backendLimitations == null)
                    continue;

                foreach (JToken limitation in backendLimitations)
                {
                    string text = limitation?.ToString();
                    if (!string.IsNullOrEmpty(text))
                        limitations.Add(text);
                }
            }

            return new JObject
            {
                ["backend"] = new JObject
                {
                    ["available"] = selected != null,
                    ["selected"] = selected?.Name ?? "none",
                    ["fallbackOrder"] = fallbackOrder,
                    ["backends"] = backendSummaries
                },
                ["focus"] = new JObject
                {
                    ["gameViewFocused"] = _isGameViewFocused(),
                    ["required"] = focusRequired
                },
                ["gameplayKeyInjection"] = new JObject
                {
                    ["supported"] = gameplayKeysSupported,
                    ["reason"] = gameplayKeysSupported
                        ? $"Gameplay key injection supported via backend '{selected?.Name ?? "none"}'."
                        : LegacyInputUnsupportedMessage
                },
                ["requiresPlayMode"] = _requirePlayMode,
                ["session"] = new JObject
                {
                    ["required"] = true,
                    ["active"] = IsSessionActive
                },
                ["limitations"] = limitations
            };
        }

        private bool IsSessionActive => !string.IsNullOrEmpty(_sessionId) && _activeBackend != null;

        /// <summary>
        /// TRUE when ANY registered service currently holds a live session on a backend that
        /// does NOT require Game View focus (the InputSystem backend, whose BeginSession
        /// applies the focus-independent overrides).
        ///
        /// A REAL QUERY OF LIVE STATE, deliberately: the simulated-pointer focus gate reads it
        /// together with the pump's applied-settings flag, and both must be true before an
        /// unfocused tap is allowed. Static because the op handlers do not hold the registered
        /// InputService instance (same reason as the keep-alive lease). Answering from the
        /// service list rather than from a cached boolean means a session torn down by the idle
        /// watchdog, by a play-mode stop, or by a failed action stops relaxing the gate the
        /// moment it ends.
        ///
        /// FAIL-CLOSED AND UNGUARDABLE HEADLESS, RECORDED AS SUCH (AX7/V8). An empty service
        /// list, a session on a focus-REQUIRING backend, and a project with no Input System all
        /// answer FALSE, which leaves the focus refusal exactly where it was. Driving a TRUE
        /// here needs a live InputSystem session, so no EditMode test reaches it without an
        /// injection seam built solely to be tested; the decision it feeds is pinned instead as
        /// a pure predicate (InputHandler.FocusIndependentTapAllowed).
        /// </summary>
        public static bool AnyFocusIndependentSessionActive()
        {
            lock (ActiveServicesLock)
            {
                foreach (InputService service in ActiveServices)
                {
                    if (service.IsSessionActive && !service._activeBackend.RequiresGameViewFocus)
                        return true;
                }
            }

            return false;
        }

        /// <summary>True when the active backend currently holds injected keys down.</summary>
        public bool HasHeldKeys => _activeBackend?.HasHeldKeys ?? false;

        /// <summary>
        /// Refresh the idle clock for the named active session. The owning MCP server calls
        /// this periodically while it holds the session, so the session survives agent
        /// think-time gaps between ops (which routinely exceed the idle timeout). A mismatched
        /// or inactive session is a no-op (`refreshed:false`) so a stale keepalive can never
        /// revive a torn-down session; the server uses `refreshed` to know when to stop.
        /// </summary>
        public JObject KeepAlive(JObject parameters)
        {
            string sessionId = parameters?.Value<string>("sessionId");
            bool refreshed = IsSessionActive
                && !string.IsNullOrEmpty(sessionId)
                && sessionId == _sessionId;
            if (refreshed)
                _lastActivitySeconds = _nowSeconds();

            return new JObject
            {
                ["active"] = IsSessionActive,
                ["sessionId"] = _sessionId,
                ["refreshed"] = refreshed,
                ["hasHeldKeys"] = HasHeldKeys
            };
        }

        private void RunBackendAction(string actionName, string keyName, Action action,
            bool requiresGameplayKeyInjection = false)
        {
            EnsureSession();
            // Refuse gameplay key injection on a backend that cannot drive legacy/InputSystem
            // key state BEFORE the play-mode/focus checks, so a legacy (EditorEvent) project is
            // not told to focus the Game View when focusing will never make Input.GetAxis work.
            // ClickUi passes requiresGameplayKeyInjection:false, so the UI path is preserved.
            if (requiresGameplayKeyInjection)
                EnsureGameplayKeyInjectionSupported();
            EnsurePlayModeIfRequired();
            EnsureFocusIfRequired();
            TraceCollector.LogInputAction(actionName, _activeBackend?.Name, _sessionId, keyName);
            _lastActivitySeconds = _nowSeconds();

            try
            {
                action();
            }
            catch (BridgeException ex)
            {
                TraceCollector.LogInputFailure(
                    actionName,
                    _activeBackend?.Name,
                    _sessionId,
                    ex.Code,
                    ex.Message);
                SafeEndSession();
                throw;
            }
            catch (Exception ex)
            {
                TraceCollector.LogInputFailure(
                    actionName,
                    _activeBackend?.Name,
                    _sessionId,
                    ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    ex.Message);
                SafeEndSession();
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    $"Input backend '{_activeBackend?.Name ?? "unknown"}' failed: {ex.Message}", ex);
            }
        }

        private void EnsureSession()
        {
            if (!IsSessionActive)
            {
                throw new BridgeException(ErrorCodes.INPUT_SESSION_REQUIRED,
                    "Input session is required. Call input.begin_session first.");
            }
        }

        private void EnsurePlayModeIfRequired()
        {
            if (!_requirePlayMode || _allowEditModeSession)
                return;

            if (!_isPlaying())
            {
                throw new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "Play Mode is required for input automation.");
            }
        }

        /// <summary>
        /// Message surfaced when a gameplay key op targets a backend that cannot drive key
        /// state legacy <c>UnityEngine.Input</c> / the Input System can observe. Shared with
        /// the capability surface so the refusal and the advertised reason stay in sync.
        /// </summary>
        internal const string LegacyInputUnsupportedMessage =
            "Legacy UnityEngine.Input cannot be driven by the bridge (EditorEvent backend can't feed Input.GetAxis/GetButton). " +
            "Add the Input System package for autonomous capture, or measure via a clearly-labeled motor-field-drive adapter.";

        private void EnsureGameplayKeyInjectionSupported()
        {
            if (_activeBackend == null || _activeBackend.CanInjectGameplayKeys)
                return;

            throw new BridgeException(ErrorCodes.LEGACY_INPUT_UNSUPPORTED, LegacyInputUnsupportedMessage);
        }

        private void EnsureFocusIfRequired()
        {
            if (_activeBackend == null || !_activeBackend.RequiresGameViewFocus)
                return;

            if (!_ensureGameViewFocus())
            {
                throw new BridgeException(ErrorCodes.FOCUS_REQUIRED,
                    "Game View focus is required for input automation.");
            }
        }

        private string RequireKeyName(JObject parameters)
        {
            string keyName = parameters?.Value<string>("key");
            if (string.IsNullOrEmpty(keyName))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'key'.");
            }

            return keyName;
        }

        private IInputBackend FirstAvailableBackend()
        {
            foreach (IInputBackend backend in _backends)
            {
                if (backend != null && backend.IsAvailable)
                    return backend;
            }

            return null;
        }

        private IInputBackend SelectBackend(string preferredBackend)
        {
            if (string.IsNullOrEmpty(preferredBackend))
            {
                IInputBackend selected = FirstAvailableBackend();
                if (selected != null)
                    return selected;

                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "No input backend is currently available.");
            }

            foreach (IInputBackend backend in _backends)
            {
                if (backend == null)
                    continue;

                if (!string.Equals(backend.Name, preferredBackend, StringComparison.OrdinalIgnoreCase))
                    continue;

                if (backend.IsAvailable)
                    return backend;

                if (string.Equals(backend.Name, "InputSystem", StringComparison.OrdinalIgnoreCase))
                {
                    throw new BridgeException(ErrorCodes.INPUT_SYSTEM_NOT_INSTALLED,
                        "Input System backend requested but Unity Input System is not installed.");
                }

                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    $"Input backend '{backend.Name}' is unavailable.");
            }

            throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                $"Unknown input backend '{preferredBackend}'.");
        }

        private void SafeEndSession()
        {
            if (_activeBackend != null)
            {
                try
                {
                    _activeBackend.EndSession();
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[Loombridge] Input session cleanup warning: {ex.Message}");
                }
            }

            _activeBackend = null;
            _sessionId = string.Empty;
            _allowEditModeSession = false;
        }

        private void RegisterService()
        {
            lock (ActiveServicesLock)
            {
                ActiveServices.Add(this);
                if (!_updateHooked)
                {
                    EditorApplication.update += PollActiveServices;
                    _updateHooked = true;
                }
            }
        }

        private static void PollActiveServices()
        {
            lock (ActiveServicesLock)
            {
                foreach (InputService service in ActiveServices)
                {
                    service.Tick();
                }
            }
        }

        /// <summary>
        /// Suspends idle-expiry teardown for all active sessions while a long-running,
        /// non-input op (e.g. runtime.measure_motion) is in flight. Acquire just before
        /// the op begins and dispose when it completes (in every exit path). The idle
        /// countdown restarts fresh from the moment the lease is released, so a session
        /// abandoned after a measurement is still cleaned up. Reentrant: nested leases
        /// stack via a depth counter. Process-wide because op handlers do not hold the
        /// registered InputService instance.
        /// </summary>
        public static IDisposable KeepActiveSessionsAlive()
        {
            lock (KeepAliveLock)
            {
                _keepAliveDepth++;
            }

            // The owner is active right now — refresh so a session that was near expiry
            // when the op started is not torn down the instant the lease releases.
            RefreshAllActiveSessions();
            return new KeepAliveLease();
        }

        /// <summary>Test-only: drain any leaked lease depth between tests (static state).</summary>
        public static void ResetKeepAliveForTests()
        {
            lock (KeepAliveLock)
            {
                _keepAliveDepth = 0;
            }
        }

        private static bool KeepAliveHeld
        {
            get
            {
                lock (KeepAliveLock)
                {
                    return _keepAliveDepth > 0;
                }
            }
        }

        private static void ReleaseKeepAlive()
        {
            lock (KeepAliveLock)
            {
                if (_keepAliveDepth > 0)
                    _keepAliveDepth--;
                if (_keepAliveDepth > 0)
                    return;
            }

            // Last lease released: restart the idle countdown from now for every session.
            RefreshAllActiveSessions();
        }

        private static void RefreshAllActiveSessions()
        {
            lock (ActiveServicesLock)
            {
                foreach (InputService service in ActiveServices)
                {
                    service.RefreshActivity();
                }
            }
        }

        private void RefreshActivity()
        {
            if (IsSessionActive)
                _lastActivitySeconds = _nowSeconds();
        }

        private sealed class KeepAliveLease : IDisposable
        {
            private bool _disposed;

            public void Dispose()
            {
                if (_disposed)
                    return;
                _disposed = true;
                ReleaseKeepAlive();
            }
        }

        /// <summary>
        /// Per-frame session lifecycle poll (driven by EditorApplication.update, which
        /// fires even when the editor is unfocused). Tears down an active session — and
        /// therefore the injected key state behind it — when Play Mode stops or when the
        /// session has been idle past the timeout (server-side expiry, a dropped client,
        /// or an agent that simply walked away). Public so tests can drive it with an
        /// injected clock instead of waiting on wall-clock time.
        /// </summary>
        public void Tick()
        {
            if (!IsSessionActive)
                return;

            if (_requirePlayMode && !_allowEditModeSession && !_isPlaying())
            {
                TraceCollector.LogInputFailure(
                    "session_teardown",
                    _activeBackend?.Name,
                    _sessionId,
                    ErrorCodes.PLAY_MODE_REQUIRED,
                    "Play Mode stopped while input session was active.");
                SafeEndSession();
                return;
            }

            // Only idle-tear-down when there is held key state to release. An idle session
            // with no held keys (an agent thinking between ops) is harmless to leave open —
            // tearing it down would only break the agent's sequence with INPUT_SESSION_EXPIRED.
            // The owning server's keepalive refreshes _lastActivitySeconds while it is alive,
            // so a held key survives think-gaps; when the server exits, keepalive stops and a
            // held-key session still expires within the timeout (orphan safety).
            if (_idleTimeoutSeconds > 0 && !KeepAliveHeld && HasHeldKeys
                && (_nowSeconds() - _lastActivitySeconds) > _idleTimeoutSeconds)
            {
                TraceCollector.LogInputFailure(
                    "session_teardown",
                    _activeBackend?.Name,
                    _sessionId,
                    ErrorCodes.INPUT_SESSION_EXPIRED,
                    $"Input session idle for more than {_idleTimeoutSeconds:0.#}s with keys held; tearing down to release injected key state.");
                SafeEndSession();
            }
        }
    }
}
