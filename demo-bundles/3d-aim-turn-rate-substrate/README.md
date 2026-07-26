# 3D measurement substrate v2 — live `aimTurnRateDegPerSec`

First live **rotation/aim** capture, taken in the repo-owned
`unity-projects/shooter-3d-combat-dogfood` fixture. This is the first ROTATION-dependent 3D-shooter
metric to leave the `needs-new-bridge-capability` gap ledger.

## What this proves

The Loombridge bridge now samples a true rotation trajectory (`transform.eulerAngles`, degrees)
alongside position — every trajectory sample carries `rx` (pitch), `ry` (yaw), `rz` (roll) in
addition to `{x,y,z}`. `deriveAimTurnRateDegPerSec` reads the yaw axis (`ry`) and reports the median
moving per-interval angular speed, wrap-aware (the shortest signed angle delta, so a sweep across the
0/360° seam never fabricates a ~360°/s spike).

A clean-room `AimRig` — fixed in position — yaws about `+Y` at a constant configured rate for a
bounded sweep (`<360°`, so `eulerAngles.y` never wraps). The measured trajectory is yaw-only.
Re-derived turn rate: **`119.976 deg/s`** (configured `120 deg/s`; the ~0.024 gap is `tMs` reported
rounded to 2 decimals plus the first/last partial moving intervals at the capture-clock boundaries).
The headline substrate proof: dropping the rotation fields from the same samples collapses them to a
stationary position-only track and the derivation **refuses** (`null`) — the value is recoverable
*only* because rotation is sampled.

## Files

| File | Role |
|---|---|
| `shooter-3d-aim-turn-rate-raw-2026-06-26.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (op, host, request, verbatim `{x,y,z,rx,ry,rz}` response, per-phase + fieldTimeline provenance). Do not hand-edit. |
| `generate.mjs` | Assembles the derived artifact FROM the raw transcript: copies samples verbatim, runs the production `deriveAimTurnRateDegPerSec`, asserts the rotation-stripped projection refuses. Run: `node demo-bundles/3d-aim-turn-rate-substrate/generate.mjs`. |
| `shooter-3d-aim-turn-rate-derived-2026-06-26.json` | Canonical derived artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-aim-turn-rate-substrate.test.ts` (re-derives from raw,
proves rotation is load-bearing, deep-equals the generator output, and checks flat/insufficient/
position-only inputs refuse).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/AimRig`,
  `sampleCount=113`, `durationMs=1866.67`, post-capture `error_count=0`.
- Phases: `R` reset → idle (stationary prefix) → one `Q` (begin yaw sweep) → constant-rate yaw until
  the bounded sweep completes. The yaw rises `0 → 150°` (`ry`) at a constant `~120°/s`, then plateaus.
- Provenance: `AimRig.IsTurning` false→true at the turn start (`383.33ms`); the sampled configured
  `TurnRateDegPerSec` (constant `120`) as an independent cross-check; `x`/`y`/`z` constant throughout
  (the rig only rotates).

## Honest gaps (still NOT measured)

This bundle proves ONE conservative rotation metric — a constant yaw turn RATE. It does **not** prove
look responsiveness/latency (no input-onset binding here), recoil kick/recovery, ADS transition, aim
assist/fairness, or mouse-look acceleration. Hitscan, 3D hit-stop/screen-shake, AI/cover/waves, and
Fusion/multiplayer also remain explicit gaps. See
`mcp-server/src/capabilities/genre/genre-packs/3d-shooter/methodology-gaps.md`.
