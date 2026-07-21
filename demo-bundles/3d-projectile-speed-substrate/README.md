# 3D measurement substrate v1 — live `projectileSpeed`

First live, true-**3D** `projectileSpeed` capture, taken in the repo-owned
`unity-projects/shooter-3d-combat-dogfood` fixture. This is the first 3D-shooter metric to leave the
`needs-new-bridge-capability` gap ledger.

## What this proves

The Loomtide bridge now samples a true `{x,y,z}` trajectory (previously `z` was read from
`transform.position` but dropped at serialization), and `deriveProjectileSpeed` is
dimension-agnostic (`hypot(Δx,Δy,Δz)`, with a missing `z` treated as 0 so 2D results are unchanged).

A persistent, **non-damaging** `MeasurementProjectile` flies purely along `+Z` at 18 u/s, so the
measured trajectory is `z`-only. Re-derived speed: **`17.9964 u/s`** (configured `18`; the gap is
`tMs` reported rounded to 2 decimals). The headline substrate proof: dropping `z` from the same
samples collapses them to a stationary `x/y` track and the derivation **refuses** (`null`) — the
value is recoverable *only* because `z` is sampled.

## Files

| File | Role |
|---|---|
| `shooter-3d-projectile-speed-raw-2026-06-25.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (op, host, request, verbatim `{x,y,z}` response, fixedTick/per-phase provenance). Do not hand-edit. |
| `generate.mjs` | Assembles the derived artifact FROM the raw transcript: copies samples verbatim, runs the production `deriveProjectileSpeed`, asserts the `z`-stripped projection refuses. Run: `node demo-bundles/3d-projectile-speed-substrate/generate.mjs`. |
| `shooter-3d-projectile-speed-derived-2026-06-25.json` | Canonical derived artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-projectile-speed-substrate.test.ts` (re-derives from
raw, proves `z` is load-bearing, deep-equals the generator output, and checks degraded/flat inputs
refuse).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure
  `/MeasurementProjectile`, `sampleCount=119`, `durationMs=1966.67`, post-capture `error_count=0`.
- Phases: `R` reset → idle (stationary prefix) → one `Space` (launch) → 1.5s of constant `+Z` flight.
- Provenance: `ResetCount` 0→1 edge (reset tripwire), `MeasurementProjectileMoving` false→true at
  launch, sampled configured speed `18` as an independent cross-check.

## Honest gaps (still NOT measured)

Rotation-dependent 3D metrics — look responsiveness, recoil, ADS — remain explicit gaps; they need a
rotation/aim sampler (**substrate v2**). Hitscan, 3D hit-stop/screen-shake, AI/cover/waves, and
Fusion/multiplayer also remain gaps. See
`mcp-server/src/loomtide/genre-packs/3d-shooter/methodology-gaps.md`.
