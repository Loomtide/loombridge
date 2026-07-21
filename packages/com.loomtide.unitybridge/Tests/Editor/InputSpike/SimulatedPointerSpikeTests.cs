#if ENABLE_INPUT_SYSTEM
using NUnit.Framework;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace UnityBridge.Tests.InputSpike
{
    /// <summary>
    /// Phase-0 spike for input traces (roadmap #1). THE make-or-break question:
    /// does a SIMULATED Input System `Mouse` (added + driven via QueueStateEvent +
    /// InputSystem.Update) make `Pointer.current.press.wasPressedThisFrame` true and
    /// `Pointer.current.position` read back — i.e. exactly what a game like
    /// CountTheFruits' `TapInput` reads (`Pointer.current.press.wasPressedThisFrame`
    /// + `cam.ScreenToWorldPoint(Pointer.current.position)`)?
    ///
    /// Uses `InputTestFixture` for a controlled, manual InputSystem update so the
    /// per-frame press/release EDGES are deterministic. GREEN ⇒ build the pointer
    /// pump; RED ⇒ stop and leave world-tap blocked.
    /// </summary>
    public class SimulatedPointerSpikeTests : InputTestFixture
    {
        [Test]
        public void SimulatedMousePress_DrivesPointerCurrentPressAndPosition()
        {
            var mouse = InputSystem.AddDevice<Mouse>("[Spike] VirtualMouse");
            var pos = new Vector2(123f, 456f);

            // Press the left button at a screen position.
            InputSystem.QueueStateEvent(mouse, new MouseState { position = pos }.WithButton(MouseButton.Left, true));
            InputSystem.Update();

            Assert.That(Pointer.current, Is.EqualTo(mouse), "the virtual mouse should be the current pointer");
            Assert.That(Pointer.current.press.isPressed, Is.True, "press should be down");
            Assert.That(Pointer.current.press.wasPressedThisFrame, Is.True, "press EDGE must fire this frame");
            Assert.That(Pointer.current.position.ReadValue(), Is.EqualTo(pos), "position must read back");

            // Release.
            InputSystem.QueueStateEvent(mouse, new MouseState { position = pos });
            InputSystem.Update();

            Assert.That(Pointer.current.press.isPressed, Is.False, "press should be up after release");
            Assert.That(Pointer.current.press.wasReleasedThisFrame, Is.True, "release EDGE must fire this frame");
        }
    }
}
#endif
