using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityBridge.Handlers;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class InputHandlerTests
    {
        private StubInputBackend _backend;
        private InputHandler _handler;
        private bool _focusAvailable;

        [SetUp]
        public void SetUp()
        {
            _backend = new StubInputBackend
            {
                IsAvailableValue = true,
                RequiresFocusValue = true
            };

            _focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { _backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => _focusAvailable,
                isGameViewFocused: () => _focusAvailable,
                isPlaying: () => true);

            _handler = new InputHandler(service);
        }

        [TearDown]
        public void TearDown()
        {
            // The keep-alive lease is process-wide static state; drain any depth a test
            // left behind so it can't suppress idle teardown in a later test.
            InputService.ResetKeepAliveForTests();
        }

        [Test]
        public void KeyDown_InvalidKey_ThrowsInvalidKey()
        {
            _handler.HandleOp("begin_session", new JObject());

            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("key_down", new JObject { ["key"] = "DefinitelyNotARealKey" }));

            Assert.AreEqual(ErrorCodes.INVALID_KEY, ex.Code);
        }

        [Test]
        public void KeyDown_FocusUnavailable_ThrowsFocusRequired()
        {
            _handler.HandleOp("begin_session", new JObject());
            _focusAvailable = false;

            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.FOCUS_REQUIRED, ex.Code);
        }

        // ── Legacy UnityEngine.Input refusal (EditorEvent-only project) ──

        private static InputHandler NewLegacyOnlyHandler(out StubInputBackend legacyBackend)
        {
            // A backend that mirrors EditorEvent: available, requires focus, but cannot feed
            // legacy Input.GetAxis/GetButton (no Input System package present).
            legacyBackend = new StubInputBackend
            {
                NameValue = "EditorEvent",
                IsAvailableValue = true,
                RequiresFocusValue = true,
                CanInjectGameplayKeysValue = false
            };

            var service = new InputService(
                new IInputBackend[] { legacyBackend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true);

            return new InputHandler(service);
        }

        [Test]
        public void KeyDown_LegacyBackendOnly_ThrowsLegacyInputUnsupported()
        {
            var handler = NewLegacyOnlyHandler(out _);
            handler.HandleOp("begin_session", new JObject());

            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.LEGACY_INPUT_UNSUPPORTED, ex.Code);
        }

        [Test]
        public void KeyUp_LegacyBackendOnly_ThrowsLegacyInputUnsupported()
        {
            var handler = NewLegacyOnlyHandler(out _);
            handler.HandleOp("begin_session", new JObject());

            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_up", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.LEGACY_INPUT_UNSUPPORTED, ex.Code);
        }

        [Test]
        public void KeyTap_LegacyBackendOnly_ThrowsLegacyInputUnsupported()
        {
            var handler = NewLegacyOnlyHandler(out _);
            handler.HandleOp("begin_session", new JObject());

            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_tap", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.LEGACY_INPUT_UNSUPPORTED, ex.Code);
        }

        [Test]
        public void KeyDown_LegacyBackendOnly_RefusalTakesPrecedenceOverFocus()
        {
            // The session begins with the Game View focused (begin_session requires it for a
            // focus-backend). If focus is then lost, the key op must still report
            // LEGACY_INPUT_UNSUPPORTED — not FOCUS_REQUIRED — because focusing won't help:
            // the legacy gate runs before the focus check inside RunBackendAction.
            var legacyBackend = new StubInputBackend
            {
                NameValue = "EditorEvent",
                IsAvailableValue = true,
                RequiresFocusValue = true,
                CanInjectGameplayKeysValue = false
            };
            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { legacyBackend },
                requirePlayMode: false,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => true);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());
            focusAvailable = false; // focus lost after the session started

            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.LEGACY_INPUT_UNSUPPORTED, ex.Code);
        }

        [Test]
        public void ClickUi_LegacyBackendOnly_DoesNotThrowLegacyInputUnsupported()
        {
            // The UI path goes through IMGUI/EventSystem, which the EditorEvent backend CAN
            // drive — so a click-only flow on a legacy project must still work.
            var handler = NewLegacyOnlyHandler(out StubInputBackend legacy);
            handler.HandleOp("begin_session", new JObject());

            JObject result = null;
            Assert.DoesNotThrow(() =>
                result = handler.HandleOp("click_ui", new JObject { ["x"] = 1, ["y"] = 2, ["button"] = 0 }));
            Assert.AreEqual(true, result.Value<bool>("clicked"));
            Assert.AreEqual(1, legacy.ClickCount);
        }

        [Test]
        public void KeyDown_GameplayKeyCapableBackend_DoesNotThrowLegacyInputUnsupported()
        {
            // Regression guard: when a gameplay-key-capable backend (InputSystem) is selected,
            // gameplay key ops must NOT be refused.
            var backend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = true,
                RequiresFocusValue = false,
                CanInjectGameplayKeysValue = true
            };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());

            Assert.DoesNotThrow(() => handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));
            Assert.AreEqual(1, backend.PressedCount);
        }

        // ── the simulated-pointer focus gate (world taps under an open session) ──

        // Both halves are required, and neither is inferred from the other: a session with no
        // applied overrides (a project with no Input System), or applied overrides with no live
        // session (a stale pump after end_session), would each relax the gate on a tap the game
        // never receives. Only the conjunction is a tap that is actually delivered unfocused.
        [Test]
        public void FocusIndependentTapAllowed_RequiresBothSessionAndAppliedSettings()
        {
            Assert.IsTrue(InputHandler.FocusIndependentTapAllowed(true, true),
                "a live focus-independent session with the overrides applied may tap unfocused");
            Assert.IsFalse(InputHandler.FocusIndependentTapAllowed(true, false),
                "a session whose backend never applied the overrides must keep the focus refusal");
            Assert.IsFalse(InputHandler.FocusIndependentTapAllowed(false, true),
                "applied overrides with no live session must keep the focus refusal");
            Assert.IsFalse(InputHandler.FocusIndependentTapAllowed(false, false),
                "no session and no overrides is the one-shot case: focus is required");
        }

        // ── the OBSERVER's delivery gate (would a HUMAN's click reach the game?) ──

        // THE REPRODUCED FAILURE: a human ran `loombridge trace record` from a terminal, clicked
        // the Unity Game view to bring Unity forward, and tapped a hub tile. The trace held that
        // tap TWICE (both tagged with the hub scene) and replay died on step-2 with
        // "Could not resolve locator" because step-1 had already navigated out of the hub. The
        // activating click was swallowed by the editor (the game never processed it) but the
        // observer recorded it, because Unity-INTERNAL Game-view focus is true even while Unity
        // sits behind the terminal. Only the conjunction with OS-level application activity is
        // "this click reaches the game": either half alone re-opens the phantom step.
        //
        // NOT executed by this agent (no Unity editor/licence available to it); this runs in
        // .github/workflows/unity-editmode.yml. LITMUS to run there: change the predicate to
        // `return gameViewFocused;` and the applicationActive:false rows must fail.
        [Test]
        public void GameViewInputFocused_RequiresBothWindowFocusAndApplicationActivity()
        {
            Assert.IsTrue(GameViewFocus.IsGameViewInputFocused(true, true),
                "Game view frontmost inside Unity AND Unity frontmost in the OS: the click reaches the game");
            Assert.IsFalse(GameViewFocus.IsGameViewInputFocused(true, false),
                "the Game view can be Unity's frontmost window while Unity itself is backgrounded, "
                + "that click is swallowed by the editor and must never be recorded");
            Assert.IsFalse(GameViewFocus.IsGameViewInputFocused(false, true),
                "an active Unity with another window frontmost does not deliver the click to the game");
            Assert.IsFalse(GameViewFocus.IsGameViewInputFocused(false, false),
                "neither half: nothing reaches the game");
        }

        // observe_start may WAIT for the human to activate the Unity window, which spans editor
        // ticks, so it has to be dispatched through the executor's ASYNC path. On the sync path
        // its `respond` would fire after the executor had already answered the request.
        //
        // NOT executed by this agent (no Unity editor/licence); runs in unity-editmode.yml.
        // LITMUS to run there: make IsAsync `return false;` and this fails.
        [Test]
        public void ObserveStart_IsDispatchedAsync()
        {
            Assert.IsTrue(_handler.IsAsync("observe_start"),
                "observe_start waits across editor ticks for the editor to become the active application");
            Assert.IsFalse(_handler.IsAsync("key_tap"), "the driving ops stay synchronous");
        }

        // The Play-Mode refusal survived the move to the async path: it must reach onError, not
        // throw past the executor's async dispatch, and must never begin observing.
        //
        // NOT executed by this agent (no Unity editor/licence); runs in unity-editmode.yml. These
        // EditMode tests run OUTSIDE Play Mode, which is exactly the state under test.
        [Test]
        public void ObserveStart_OutsidePlayMode_ReportsPlayModeRequiredThroughOnError()
        {
            JObject responded = null;
            BridgeException failed = null;
            _handler.HandleOpAsync("observe_start", new JObject(),
                r => responded = r, e => failed = e);

            Assert.IsNull(responded, "observation must not start outside Play Mode");
            Assert.IsNotNull(failed, "the refusal must arrive through the async error callback");
            Assert.AreEqual(ErrorCodes.PLAY_MODE_REQUIRED, failed.Code);
        }

        // The session half is a REAL query of live state, not a flag somebody sets: opening a
        // session on a focus-independent backend must make it true, and the query must read the
        // backend's own focus requirement rather than the backend's NAME.
        [Test]
        public void AnyFocusIndependentSessionActive_ObservesALiveFocusIndependentSession()
        {
            var backend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = true,
                RequiresFocusValue = false,
                CanInjectGameplayKeysValue = true
            };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());
            Assert.IsTrue(InputService.AnyFocusIndependentSessionActive(),
                "a live session on a backend that does not require focus must be observable");

            handler.HandleOp("end_session", new JObject());
        }

        // The pump half fails safe: with no Input System session having applied the overrides,
        // the query answers false, so the focus refusal stands. (It is the only half that can
        // relax a gate, so every failure to answer must land on false.)
        [Test]
        public void SimulatedPointerBridge_ReportsNoAppliedOverridesWithoutASession()
        {
            Assert.IsFalse(SimulatedPointerBridge.IsFocusIndependentInputApplied(),
                "no EditMode session applies the focus-independent overrides; the query must say so");
        }

        [Test]
        public void GetCapabilities_LegacyBackendOnly_ReportsGameplayKeyInjectionUnsupported()
        {
            var handler = NewLegacyOnlyHandler(out _);

            JObject result = handler.HandleOp("get_capabilities", new JObject());

            Assert.IsNotNull(result["gameplayKeyInjection"]);
            Assert.AreEqual(false, result["gameplayKeyInjection"].Value<bool>("supported"));
            StringAssert.Contains("Legacy UnityEngine.Input",
                result["gameplayKeyInjection"].Value<string>("reason"));

            bool hasLimitation = false;
            foreach (JToken limitation in (JArray)result["limitations"])
            {
                if ((limitation?.ToString() ?? string.Empty).Contains("gameplay key injection unsupported"))
                    hasLimitation = true;
            }
            Assert.IsTrue(hasLimitation, "limitations must call out unsupported gameplay key injection");
        }

        [Test]
        public void GetCapabilities_KeyCapableBackend_ReportsGameplayKeyInjectionSupported()
        {
            JObject result = _handler.HandleOp("get_capabilities", new JObject());

            Assert.IsNotNull(result["gameplayKeyInjection"]);
            Assert.AreEqual(true, result["gameplayKeyInjection"].Value<bool>("supported"));
        }

        [Test]
        public void EndSession_ClearsPressedKeys()
        {
            _handler.HandleOp("begin_session", new JObject());
            _handler.HandleOp("key_down", new JObject { ["key"] = "Space" });

            Assert.AreEqual(1, _backend.PressedCount);

            _handler.HandleOp("end_session", new JObject());

            Assert.AreEqual(0, _backend.PressedCount);
        }

        [Test]
        public void KeyUp_ReleasesPressedKey()
        {
            _handler.HandleOp("begin_session", new JObject());
            _handler.HandleOp("key_down", new JObject { ["key"] = "Space" });
            Assert.AreEqual(1, _backend.PressedCount);

            _handler.HandleOp("key_up", new JObject { ["key"] = "Space" });

            Assert.AreEqual(0, _backend.PressedCount);
            Assert.AreEqual(1, _backend.KeyUpCount);
        }

        [Test]
        public void KeyTap_DelegatesAndDoesNotLeavePressedState()
        {
            _handler.HandleOp("begin_session", new JObject());

            _handler.HandleOp("key_tap", new JObject { ["key"] = "Space" });

            Assert.AreEqual(0, _backend.PressedCount);
            Assert.AreEqual(1, _backend.KeyTapCount);
        }

        [Test]
        public void ClickUi_DelegatesToBackend()
        {
            _handler.HandleOp("begin_session", new JObject());

            JObject result = _handler.HandleOp("click_ui", new JObject
            {
                ["x"] = 12,
                ["y"] = 34,
                ["button"] = 0
            });

            Assert.AreEqual(true, result.Value<bool>("clicked"));
            Assert.AreEqual(_backend.Name, result.Value<string>("backend"));
            Assert.AreEqual(1, _backend.ClickCount);
        }

        [Test]
        public void BeginSession_UsesPreferredBackendWhenRequested()
        {
            var primary = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = true,
                RequiresFocusValue = false
            };

            var secondary = new StubInputBackend
            {
                NameValue = "EditorEvent",
                IsAvailableValue = true,
                RequiresFocusValue = false
            };

            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { primary, secondary },
                requirePlayMode: false,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => true);

            var handler = new InputHandler(service);
            JObject result = handler.HandleOp("begin_session", new JObject { ["backend"] = "EditorEvent" });

            Assert.AreEqual("EditorEvent", result.Value<string>("backend"));
            Assert.AreEqual(0, primary.BeginSessionCount);
            Assert.AreEqual(1, secondary.BeginSessionCount);
        }

        [Test]
        public void BeginSession_AllowEditMode_OverridesPlayModeRequirement()
        {
            var backend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = true,
                RequiresFocusValue = false
            };

            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: true,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => false);

            var handler = new InputHandler(service);
            handler.HandleOp("begin_session", new JObject { ["allowEditMode"] = true });

            Assert.DoesNotThrow(() =>
                handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));
        }

        [Test]
        public void BeginSession_WithoutAllowEditMode_EnforcesPlayModeRequirement()
        {
            var backend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = true,
                RequiresFocusValue = false
            };

            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: true,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => false);

            var handler = new InputHandler(service);
            handler.HandleOp("begin_session", new JObject());

            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.PLAY_MODE_REQUIRED, ex.Code);
        }

        [Test]
        public void GetCapabilities_ReturnsExpectedShape()
        {
            JObject result = _handler.HandleOp("get_capabilities", new JObject());

            Assert.IsNotNull(result["backend"]);
            Assert.IsNotNull(result["focus"]);
            Assert.IsNotNull(result["session"]);
            Assert.IsNotNull(result["limitations"]);
            Assert.IsNotNull(result["inputCapability"]);
            Assert.AreEqual("StubBackend", result["backend"].Value<string>("selected"));
            Assert.AreEqual(true, result["inputCapability"].Value<bool>("supported"));
            Assert.AreEqual(true, result["inputCapability"].Value<bool>("deterministic"));
            Assert.AreEqual(null, result["inputCapability"].Value<string>("blockerCode"));
        }

        [Test]
        public void KeyDown_WithoutSession_ThrowsInputSessionRequired()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));

            Assert.AreEqual(ErrorCodes.INPUT_SESSION_REQUIRED, ex.Code);
        }

        [Test]
        public void BeginSession_InputCapabilityBlocked_ThrowsDeterministicBlockerCode()
        {
            var unavailableBackend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = false,
                RequiresFocusValue = false
            };

            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { unavailableBackend },
                requirePlayMode: false,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => true);

            var handler = new InputHandler(service);
            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("begin_session", new JObject()));

            Assert.AreEqual(ErrorCodes.INPUT_CAPABILITY_BLOCKED, ex.Code);
            StringAssert.Contains("Input capability blocked for 'begin_session'", ex.Message);
        }

        [Test]
        public void GetCapabilities_WhenUnavailable_ReturnsBlockedCapabilitySignal()
        {
            var unavailableBackend = new StubInputBackend
            {
                NameValue = "InputSystem",
                IsAvailableValue = false,
                RequiresFocusValue = false
            };

            bool focusAvailable = true;
            var service = new InputService(
                new IInputBackend[] { unavailableBackend },
                requirePlayMode: false,
                ensureGameViewFocus: () => focusAvailable,
                isGameViewFocused: () => focusAvailable,
                isPlaying: () => true);

            var handler = new InputHandler(service);
            JObject result = handler.HandleOp("get_capabilities", new JObject());

            Assert.AreEqual(false, result["inputCapability"].Value<bool>("supported"));
            Assert.AreEqual(true, result["inputCapability"].Value<bool>("deterministic"));
            Assert.AreEqual(
                ErrorCodes.INPUT_CAPABILITY_BLOCKED,
                result["inputCapability"].Value<string>("blockerCode"));
        }

        [Test]
        public void Tick_SessionIdlePastTimeout_TearsDownAndReleasesKeys()
        {
            double now = 100.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true,
                nowSeconds: () => now,
                idleTimeoutSeconds: 30.0);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });
            Assert.AreEqual(1, backend.PressedCount);
            Assert.AreEqual(0, backend.EndSessionCount);

            // Within the timeout: no teardown.
            now += 20.0;
            service.Tick();
            Assert.AreEqual(0, backend.EndSessionCount);
            Assert.AreEqual(1, backend.PressedCount);

            // Past the timeout: session torn down, held key released.
            now += 15.0; // 35s since last activity
            service.Tick();
            Assert.AreEqual(1, backend.EndSessionCount);
            Assert.AreEqual(0, backend.PressedCount);

            // The session is gone: a further action requires a new session.
            var ex = Assert.Throws<BridgeException>(() =>
                handler.HandleOp("key_down", new JObject { ["key"] = "Space" }));
            Assert.AreEqual(ErrorCodes.INPUT_SESSION_REQUIRED, ex.Code);
        }

        [Test]
        public void Tick_ActivityRefreshesIdleTimer()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true,
                nowSeconds: () => now,
                idleTimeoutSeconds: 30.0);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());

            // Activity at t=25 refreshes the idle clock...
            now = 25.0;
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });

            // ...so at t=50 (only 25s since the last action) the session is still alive.
            now = 50.0;
            service.Tick();
            Assert.AreEqual(0, backend.EndSessionCount);

            // 31s after the last activity, it expires.
            now = 56.1;
            service.Tick();
            Assert.AreEqual(1, backend.EndSessionCount);
        }

        [Test]
        public void Tick_IdleTimeoutDisabled_NeverTearsDown()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true,
                nowSeconds: () => now,
                idleTimeoutSeconds: 0.0); // disabled
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());
            now = 100000.0;
            service.Tick();

            Assert.AreEqual(0, backend.EndSessionCount);
        }

        [Test]
        public void Tick_KeepAliveLease_SuspendsIdleTeardown_ThenRestartsCountdown()
        {
            double now = 100.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true,
                nowSeconds: () => now,
                idleTimeoutSeconds: 30.0);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });

            using (InputService.KeepActiveSessionsAlive())
            {
                // A measurement op is in flight (held key + lease). 100s elapse — far past
                // the 30s idle timeout — yet the session is NOT torn down and the key stays
                // held. This is the bug fix: measure_motion no longer starves the watchdog.
                now += 100.0;
                service.Tick();
                Assert.AreEqual(0, backend.EndSessionCount, "lease must suspend idle teardown");
                Assert.AreEqual(1, backend.PressedCount, "held key must survive the measure window");
            } // lease released here → idle countdown restarts from now (t=200)

            // 20s after release: still alive, because the countdown restarts at release
            // rather than at the original key_down activity.
            now += 20.0;
            service.Tick();
            Assert.AreEqual(0, backend.EndSessionCount, "countdown restarts at lease release, not original activity");

            // 31s after release: normal idle teardown resumes and releases the held key.
            now += 11.0;
            service.Tick();
            Assert.AreEqual(1, backend.EndSessionCount, "normal idle teardown resumes after lease");
            Assert.AreEqual(0, backend.PressedCount);
        }

        // ── Option A: keepalive + skip idle teardown when no keys are held ──

        private static InputService NewIdleService(StubInputBackend backend, System.Func<double> now)
        {
            return new InputService(
                new IInputBackend[] { backend },
                requirePlayMode: false,
                ensureGameViewFocus: () => true,
                isGameViewFocused: () => true,
                isPlaying: () => true,
                nowSeconds: now,
                idleTimeoutSeconds: 30.0);
        }

        [Test]
        public void Tick_NoHeldKeys_DoesNotTearDownIdleSession()
        {
            double now = 100.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = NewIdleService(backend, () => now);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject());

            // No key held: nothing to release, so an idle session must NOT be torn down even far
            // past the timeout (an agent thinking between ops is not an agent that walked away).
            now += 120.0;
            service.Tick();
            Assert.AreEqual(0, backend.EndSessionCount, "idle, no held keys -> no teardown");

            // The session is still usable without a re-begin.
            Assert.DoesNotThrow(() => handler.HandleOp("key_down", new JObject { ["key"] = "Space" }),
                "idle no-held-key session stays usable");
            Assert.AreEqual(1, backend.PressedCount);
        }

        [Test]
        public void Tick_HeldKey_KeepAliveRefreshes_SurvivesThinkGapBeyondTimeout()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = NewIdleService(backend, () => now);
            var handler = new InputHandler(service);

            string sid = handler.HandleOp("begin_session", new JObject()).Value<string>("sessionId");
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });

            // 100s pass with a key held, but the owning server keepalives every 20s (< timeout).
            for (int i = 0; i < 5; i++)
            {
                now += 20.0;
                JObject ka = handler.HandleOp("keepalive", new JObject { ["sessionId"] = sid });
                Assert.AreEqual(true, ka.Value<bool>("refreshed"), $"keepalive refreshes (step {i})");
                service.Tick();
                Assert.AreEqual(0, backend.EndSessionCount, $"no teardown while keepalive active (step {i})");
            }
            Assert.AreEqual(1, backend.PressedCount, "held key preserved across the think-gap");
        }

        [Test]
        public void Tick_HeldKey_KeepAliveStops_TearsDownWithinTimeout()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = NewIdleService(backend, () => now);
            var handler = new InputHandler(service);

            string sid = handler.HandleOp("begin_session", new JObject()).Value<string>("sessionId");
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });
            handler.HandleOp("keepalive", new JObject { ["sessionId"] = sid }); // last keepalive at t=0

            // Server gone: keepalive stops. Within the timeout the held key still survives...
            now += 25.0;
            service.Tick();
            Assert.AreEqual(0, backend.EndSessionCount, "within timeout after last keepalive");

            // ...past the timeout, the held-key session expires and releases the key (orphan safety).
            now += 10.0;
            service.Tick();
            Assert.AreEqual(1, backend.EndSessionCount, "held-key session expires once keepalive stops");
            Assert.AreEqual(0, backend.PressedCount, "held key released");
        }

        [Test]
        public void KeepAlive_AfterEndSession_ReportsInactiveSoServerStops()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var handler = new InputHandler(NewIdleService(backend, () => now));

            string sid = handler.HandleOp("begin_session", new JObject()).Value<string>("sessionId");
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });
            handler.HandleOp("end_session", new JObject());
            Assert.AreEqual(0, backend.PressedCount, "end_session released keys");

            JObject ka = handler.HandleOp("keepalive", new JObject { ["sessionId"] = sid });
            Assert.AreEqual(false, ka.Value<bool>("active"), "no active session after end_session");
            Assert.AreEqual(false, ka.Value<bool>("refreshed"), "server learns to stop keepalive");
        }

        [Test]
        public void BeginSession_AlreadyActive_ReturnsCreatedFalse_AndKeepsOriginalSession()
        {
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var handler = new InputHandler(NewIdleService(backend, () => 0.0));

            // Owner A creates the session.
            JObject a = handler.HandleOp("begin_session", new JObject { ["sessionId"] = "owner-A" });
            Assert.AreEqual(true, a.Value<bool>("created"), "first begin_session creates the session");
            Assert.AreEqual("owner-A", a.Value<string>("sessionId"));

            // A second caller (a different MCP server/agent) tries to begin. It must NOT create a
            // new session, must return the ORIGINAL session id, and must report created:false so
            // its server won't start a keepalive — otherwise it could keep an inherited session
            // (and its held keys) alive past the original owner's death.
            JObject b = handler.HandleOp("begin_session", new JObject { ["sessionId"] = "owner-B" });
            Assert.AreEqual(false, b.Value<bool>("created"), "second begin_session inherits, does not create");
            Assert.AreEqual("owner-A", b.Value<string>("sessionId"), "returns the original session id, not B's");
            Assert.AreEqual(1, backend.BeginSessionCount, "backend session started exactly once");
        }

        [Test]
        public void KeepAlive_WrongSessionId_DoesNotRefreshOrExtend()
        {
            double now = 0.0;
            var backend = new StubInputBackend { IsAvailableValue = true, RequiresFocusValue = false };
            var service = NewIdleService(backend, () => now);
            var handler = new InputHandler(service);

            handler.HandleOp("begin_session", new JObject { ["sessionId"] = "real" });
            handler.HandleOp("key_down", new JObject { ["key"] = "Space" });

            // A stale keepalive for a different session must not refresh the real one.
            JObject ka = handler.HandleOp("keepalive", new JObject { ["sessionId"] = "stale" });
            Assert.AreEqual(false, ka.Value<bool>("refreshed"), "mismatched session id does not refresh");

            // The real session still expires on its own schedule — no spurious extension.
            now += 35.0;
            service.Tick();
            Assert.AreEqual(1, backend.EndSessionCount, "wrong-session keepalive did not extend the session");
        }

        private sealed class StubInputBackend : IInputBackend
        {
            private readonly HashSet<KeyCode> _pressed = new HashSet<KeyCode>();

            public string NameValue { get; set; } = "StubBackend";
            public bool IsAvailableValue { get; set; }
            public bool RequiresFocusValue { get; set; }
            // Defaults true so existing tests exercise the focus/play-mode paths; a legacy
            // (EditorEvent-like) backend sets this false to exercise the LEGACY_INPUT_UNSUPPORTED gate.
            public bool CanInjectGameplayKeysValue { get; set; } = true;
            public int BeginSessionCount { get; private set; }
            public int EndSessionCount { get; private set; }
            public int KeyDownCount { get; private set; }
            public int KeyUpCount { get; private set; }
            public int KeyTapCount { get; private set; }
            public int ClickCount { get; private set; }

            public string Name => NameValue;
            public bool IsAvailable => IsAvailableValue;
            public bool RequiresGameViewFocus => RequiresFocusValue;
            public bool CanInjectGameplayKeys => CanInjectGameplayKeysValue;
            public bool HasHeldKeys => _pressed.Count > 0;
            public int PressedCount => _pressed.Count;

            public JArray GetLimitations()
            {
                return new JArray();
            }

            public void BeginSession(string sessionId)
            {
                _pressed.Clear();
                BeginSessionCount += 1;
            }

            public void EndSession()
            {
                _pressed.Clear();
                EndSessionCount += 1;
            }

            public void KeyDown(KeyCode keyCode)
            {
                _pressed.Add(keyCode);
                KeyDownCount += 1;
            }

            public void KeyUp(KeyCode keyCode)
            {
                _pressed.Remove(keyCode);
                KeyUpCount += 1;
            }

            public void KeyTap(KeyCode keyCode)
            {
                _pressed.Add(keyCode);
                _pressed.Remove(keyCode);
                KeyTapCount += 1;
            }

            public void ClickUi(JObject parameters)
            {
                ClickCount += 1;
            }
        }
    }
}
