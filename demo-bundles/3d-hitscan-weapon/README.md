# 3D hitscan weapon — live `hitscanImpactLatencyMs`

First live **hitscan** capture, taken in the repo-owned `unity-projects/shooter-3d-combat-dogfood`
fixture. This takes the hitscan impact-latency metric out of the `3d-shooter` `needs-new-calculator`
gap ledger, backed by raw Unity samples that prove the full **fire → raycast-hit → damage** chain.

## What this proves

A clean-room `Shooter3DHitscanWeapon` (object `/HitscanWeapon` at `(0,1,-4)`) fires one
`Physics.Raycast` along world `+Z` on the injected `F` key. The ray strikes the reference enemy's
collider at distance `15.5u` and applies one point of damage **in the same frame** — there is no
projectile and no travel time, so the raycast hit and the damage resolve on the fire frame. Damage is
the SOLE consequence of a raycast hit: a miss (or LOS blocked by a nearer collider) raises neither
`RaycastHitCount` nor the enemy's damage.

- **`hitscanImpactLatencyMs = 16.67 ms`** — fire input onset (`0ms`) → first `RaycastHitCount` rising
  edge, via the production `deriveHitscanImpactLatencyMs`. That is **one capture frame at 60fps**: the
  measurable signature of an instantaneous hitscan, distinct from the projectile loop whose impact
  arrives only after flight time (the projectile `ttkMs` is ~hundreds of ms).

## The edge chain (causal, in order)

All three combat edges land on the **same captured frame** as each fire, proving the raycast causes the
damage (not an injected/independent damage):

| Edge | tMs (shot 1 / 2 / 3) |
|---|---|
| `FireCount` / `HitscanShotCount` (accepted fire) | `16.67` / `183.33` / `316.67` |
| `RaycastHitCount` (the ray struck the enemy) | `16.67` / `183.33` / `316.67` |
| `DamageTakenCount` / enemy `HitCount` (damage landed) | `16.67` / `183.33` / `316.67` |
| `LastHitDistance` | `15.5u` (from `z=-4` to the enemy face at `z=11.5`) |
| `IsDead` (3rd hit kills the 3-HP enemy) | `316.67` |

`deriveHitscanImpactLatencyMs` enforces `fire onset ≤ raycast-hit edge ≤ damage edge` and **refuses** on
any absent or out-of-order edge — a miss (no raycast hit edge), a hit that registered no damage, or
damage preceding the raycast hit (damage WITHOUT a hit) all refuse, never green.

## Files

| File | Role |
|---|---|
| `3d-hitscan-raw-2026-06-26.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (op, host, request, verbatim `fieldTimeline` series). Do not hand-edit. |
| `generate.mjs` | Assembles the derived artifact FROM the raw transcript: copies the series verbatim, runs the production `deriveHitscanImpactLatencyMs` (fire onset `0`), and asserts the fire→hit→damage ordering. Run: `node demo-bundles/3d-hitscan-weapon/generate.mjs`. |
| `3d-hitscan-derived-2026-06-26.json` | Canonical derived artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-hitscan-weapon-substrate.test.ts` (re-derives from raw,
deep-equals the generator, checks the fire→hit→damage ordering, and proves degraded / miss /
hit-without-damage / damage-without-hit / non-causal inputs refuse — never green).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/HitscanWeapon`,
  `sampleCount=81`, `durationMs=1333.33`, post-capture `error_count=0`.
- Phases: three short `F` (hitscan fire) phases separated by cooldown windows. The fire input onset is
  the start of the first `F` phase (`0ms`).
- Sampled fields: `FireCount`, `HitscanShotCount`, `RaycastHitCount`, `LastHitDistance` (on
  `/HitscanWeapon`) and `HitCount`, `DamageTakenCount`, `IsDead` (on `/Enemy`) — so the whole chain
  (fire → raycast hit → damage → death) is captured.

## Honest gaps (still NOT measured)

This bundle proves ONE narrow edge-chain metric — the fire-to-raycast-hit impact latency, gated on the
raycast causally driving damage. It does **not** measure bullet penetration, spread, recoil, reload,
ADS, tracer/decal rendering, body-part multipliers, or lag compensation — all explicit gaps. Projectile
metrics (`fireIntervalMs`/`projectileSpeed`/`ttkMs`) are unchanged. Enemy AI, cover, waves/objectives,
and Fusion/multiplayer remain explicit gaps. See
`mcp-server/src/loombridge/genre-packs/3d-shooter/methodology-gaps.md`.
