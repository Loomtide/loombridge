# Robust Jump Input (per-key rising edge)

Fixes the "two-button" bug: with multiple jump keys (Space / Up / W) OR'd into one signal and a single
combined edge check, **holding one jump key masks the others** — press W then Space and nothing
happens, and you can't re-jump after landing while a jump key stays held.

The fix: detect a **rising edge per key** and jump if *any* key was newly pressed this frame. Use
`isPressed` (not `wasPressedThisFrame`) so it stays correct even when input is injected externally
(MCP double-`Update`).

## Pattern

```csharp
using UnityEngine.InputSystem;

// fields
private bool _prevSpace, _prevUp, _prevW;

private bool ReadJumpPressed()
{
    bool edge = false;
    Keyboard kb = Keyboard.current;
    if (kb != null)
    {
        edge |= RisingEdge(kb.spaceKey.isPressed, ref _prevSpace);
        edge |= RisingEdge(kb.upArrowKey.isPressed, ref _prevUp);
        edge |= RisingEdge(kb.wKey.isPressed, ref _prevW);
    }
    return edge;
}

private static bool RisingEdge(bool now, ref bool prev)
{
    bool rising = now && !prev;
    prev = now;
    return rising;
}
```

This pattern is Input-System-only. Do not add legacy `Input.GetButton` fallback code; Loomtide cannot
input-drive legacy polling.

The controller queues the jump on edge and consumes it in `FixedUpdate` gated by `IsGrounded()`:
```csharp
private void Update()    { if (ReadJumpPressed()) _jumpQueued = true; }
private void FixedUpdate(){ if (_jumpQueued && IsGrounded()) velocity.y = jumpSpeed; _jumpQueued = false; }
```

## This is the seam for buffering/coyote — now implemented
Per-key edge is the clean foundation: instead of consuming the edge immediately, stamp
`_jumpBufferedUntil = Time.time + bufferWindow` on edge and allow the jump if grounded (or within the
coyote window) any time before that stamp expires.

**Implemented in the reusable controller:** variable-height jump, coyote time, jump buffer, and air dash — with
probe-drivable `force*` test hooks and measured-to-target verification. See
[`feel-mechanics.md`](feel-mechanics.md).

## Verify
Grounded: tap W → jump. While still holding W after landing, tap Space → should jump again (the old
combined-edge code would not).
