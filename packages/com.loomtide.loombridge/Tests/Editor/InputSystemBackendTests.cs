using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class InputSystemBackendTests
    {
        [Test]
        public void IsAvailable_RequiresInstalledAndReadyAdapter()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var backend = new InputSystemBackend(adapter, new StubFallbackBackend());
            Assert.IsTrue(backend.IsAvailable);

            adapter.IsReadyValue = false;
            Assert.IsFalse(backend.IsAvailable);

            adapter.IsInstalledValue = false;
            Assert.IsFalse(backend.IsAvailable);
        }

        [Test]
        public void CanInjectGameplayKeys_TracksAvailability()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var backend = new InputSystemBackend(adapter, new StubFallbackBackend());

            // Available InputSystem backend genuinely drives gameplay key state.
            Assert.IsTrue(backend.CanInjectGameplayKeys);

            // Uninstalled / not-ready package must not advertise gameplay key injection.
            adapter.IsReadyValue = false;
            Assert.IsFalse(backend.CanInjectGameplayKeys);
            adapter.IsInstalledValue = false;
            Assert.IsFalse(backend.CanInjectGameplayKeys);
        }

        [Test]
        public void EditorEventBackend_CannotInjectGameplayKeys()
        {
            // The legacy fallback can drive IMGUI/EventSystem (ClickUi) but NOT legacy
            // Input.GetAxis/GetButton — so it must report gameplay key injection unsupported.
            Assert.IsFalse(new EditorEventInputBackend().CanInjectGameplayKeys);
        }

        [Test]
        public void BeginSession_NotInstalled_ThrowsInputSystemNotInstalled()
        {
            var backend = new InputSystemBackend(
                new StubAdapter { IsInstalledValue = false, IsReadyValue = false },
                new StubFallbackBackend());

            var ex = Assert.Throws<BridgeException>(() => backend.BeginSession("session-1"));
            Assert.AreEqual(ErrorCodes.INPUT_SYSTEM_NOT_INSTALLED, ex.Code);
        }

        [Test]
        public void BeginSession_NotReady_ThrowsInputBackendUnavailable()
        {
            var backend = new InputSystemBackend(
                new StubAdapter { IsInstalledValue = true, IsReadyValue = false },
                new StubFallbackBackend());

            var ex = Assert.Throws<BridgeException>(() => backend.BeginSession("session-1"));
            Assert.AreEqual(ErrorCodes.INPUT_BACKEND_UNAVAILABLE, ex.Code);
        }

        [Test]
        public void KeyTap_QueuesPressAndRelease()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var backend = new InputSystemBackend(adapter, new StubFallbackBackend());
            backend.BeginSession("session-1");

            backend.KeyTap(KeyCode.Space);

            Assert.AreEqual(2, adapter.Events.Count);
            Assert.AreEqual(KeyCode.Space, adapter.Events[0].KeyCode);
            Assert.AreEqual(true, adapter.Events[0].Pressed);
            Assert.AreEqual(KeyCode.Space, adapter.Events[1].KeyCode);
            Assert.AreEqual(false, adapter.Events[1].Pressed);
        }

        [Test]
        public void KeyTap_MirrorsToFallbackWhenFocusNotRequired()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var fallback = new StubFallbackBackend { RequiresFocus = false };
            var backend = new InputSystemBackend(adapter, fallback);
            backend.BeginSession("session-1");

            backend.KeyTap(KeyCode.Space);

            Assert.AreEqual(1, fallback.KeyTapCount);
        }

        [Test]
        public void KeyDownUp_MirrorsToFallbackWhenFocusNotRequired()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var fallback = new StubFallbackBackend { RequiresFocus = false };
            var backend = new InputSystemBackend(adapter, fallback);
            backend.BeginSession("session-1");

            backend.KeyDown(KeyCode.RightArrow);
            backend.KeyUp(KeyCode.RightArrow);

            Assert.AreEqual(1, fallback.KeyDownCount);
            Assert.AreEqual(1, fallback.KeyUpCount);
        }

        [Test]
        public void EndSession_ReleasesHeldKeys()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var fallback = new StubFallbackBackend();
            var backend = new InputSystemBackend(adapter, fallback);

            backend.BeginSession("session-1");
            backend.KeyDown(KeyCode.Space);
            backend.KeyDown(KeyCode.RightArrow);

            backend.EndSession();

            Assert.AreEqual(4, adapter.Events.Count);
            Assert.AreEqual(true, adapter.Events[0].Pressed);
            Assert.AreEqual(true, adapter.Events[1].Pressed);
            Assert.AreEqual(false, adapter.Events[2].Pressed);
            Assert.AreEqual(false, adapter.Events[3].Pressed);
            Assert.IsTrue(fallback.EndSessionCalled);
        }

        [Test]
        public void ClickUi_DelegatesToFallbackBackend()
        {
            var adapter = new StubAdapter { IsInstalledValue = true, IsReadyValue = true };
            var fallback = new StubFallbackBackend();
            var backend = new InputSystemBackend(adapter, fallback);
            backend.BeginSession("session-1");

            backend.ClickUi(new JObject
            {
                ["x"] = 12,
                ["y"] = 34,
                ["button"] = 0
            });

            Assert.AreEqual(1, fallback.ClickCount);
        }

        [Test]
        public void KeyDown_AdapterError_IsPropagated()
        {
            var adapter = new StubAdapter
            {
                IsInstalledValue = true,
                IsReadyValue = true,
                ThrowOnSet = new BridgeException(ErrorCodes.INVALID_KEY, "bad key")
            };

            var backend = new InputSystemBackend(adapter, new StubFallbackBackend());
            backend.BeginSession("session-1");

            var ex = Assert.Throws<BridgeException>(() => backend.KeyDown(KeyCode.None));
            Assert.AreEqual(ErrorCodes.INVALID_KEY, ex.Code);
        }

        private sealed class StubAdapter : IInputSystemAdapter
        {
            public bool IsInstalledValue { get; set; }
            public bool IsReadyValue { get; set; }
            public BridgeException ThrowOnSet { get; set; }
            public List<KeyEvent> Events { get; } = new List<KeyEvent>();

            public bool IsInstalled => IsInstalledValue;
            public bool IsReady => IsReadyValue;

            public void BeginSession()
            {
            }

            public void EndSession()
            {
            }

            public void SetKeyState(KeyCode keyCode, bool pressed)
            {
                if (ThrowOnSet != null)
                    throw ThrowOnSet;

                Events.Add(new KeyEvent
                {
                    KeyCode = keyCode,
                    Pressed = pressed
                });
            }

            public void TapKey(KeyCode keyCode)
            {
                SetKeyState(keyCode, true);
                SetKeyState(keyCode, false);
            }
        }

        private sealed class StubFallbackBackend : IInputBackend
        {
            public string Name => "FallbackStub";
            public bool IsAvailable => true;
            public bool RequiresGameViewFocus => RequiresFocus;
            // Stands in for the EditorEvent fallback, which cannot feed legacy Input polling.
            public bool CanInjectGameplayKeys => false;
            public bool RequiresFocus { get; set; } = true;
            public bool HasHeldKeys => KeyDownCount > KeyUpCount;
            public int ClickCount { get; private set; }
            public int KeyDownCount { get; private set; }
            public int KeyUpCount { get; private set; }
            public int KeyTapCount { get; private set; }
            public bool EndSessionCalled { get; private set; }

            public JArray GetLimitations()
            {
                return new JArray();
            }

            public void BeginSession(string sessionId)
            {
            }

            public void EndSession()
            {
                EndSessionCalled = true;
            }

            public void KeyDown(KeyCode keyCode)
            {
                KeyDownCount += 1;
            }

            public void KeyUp(KeyCode keyCode)
            {
                KeyUpCount += 1;
            }

            public void KeyTap(KeyCode keyCode)
            {
                KeyTapCount += 1;
            }

            public void ClickUi(JObject parameters)
            {
                ClickCount += 1;
            }
        }

        private struct KeyEvent
        {
            public KeyCode KeyCode;
            public bool Pressed;
        }
    }
}
