# 3D shooter — minimal vertical run (the productization roll-up)

The final phase of the `3d-shooter` productization package. It assembles every PROVEN capability —
each backed by its own live Unity capture and re-derived through production calculators — into one
minimal **vertical builder** roll-up, and lists every remaining gap **explicitly**. It makes **no
production-ready claim**: `experimental-green`, supported capabilities only.

## What this is (and is not)

- **Is:** a minimal vertical builder for one scoped 3D-shooter loop, composed from raw-proven
  capabilities, with an honest evidence manifest + report.
- **Is NOT:** a production-ready 3D shooter pack. No unsupported feature is wired into a runnable gate
  or a green row; every gap below stays `not_measured` / `unsupported`.

## The vertical core loop (re-captured live)

`vertical-run-raw-2026-06-26.json` is a fresh live capture of the playable core combat loop, taken
**after every phase's components were added** (a regression that the fixture still plays end-to-end):
three injected `Space` fires drive `FireCount`/`ProjectileSpawnCount`, the projectiles collide so
`HitCount` rises, and the enemy `IsDead` flips as the causal consequence. Re-derived through the
production calculators:

| Metric | Value | Calculator |
|---|---|---|
| `fireIntervalMs` | 150 ms | fireIntervalMs |
| `fireInputToSpawnLatency` | 16.67 ms | fireInputToSpawnLatency |
| `ttkMs` (first hit → death) | 300 ms | ttkMs |

## The roll-up (11 measured capabilities)

`evidence-manifest.json` and `reports/3d-shooter-vertical-report.json` (both generated) roll up the
3 core-loop metrics above plus the 8 advanced capabilities, each citing its merged raw bundle:

| Capability | Metric | Value | Evidence (PR) |
|---|---|---|---|
| true-3D projectile speed | `projectileSpeed` | 17.9964 u/s | #320 |
| true-3D aim turn rate | `aimTurnRateDegPerSec` | 119.976 deg/s | #325 |
| impact hit-stop window | `hitstopMs` | 116.67 ms | #328 |
| true-3D screen-shake magnitude | `screenShakeMag` | 0.2885 u | #328 |
| hitscan impact latency | `hitscanImpactLatencyMs` | 16.67 ms | #331 |
| enemy AI reaction | `enemyReactionLatencyMs` | 200.00 ms | #333 |
| cover blocks LOS + damage | `coverBlocksDamage` | true | #338 |
| wave/objective | `waveObjectiveComplete` | true | #342 |

Each value is pulled from that bundle's committed derived artifact (itself re-derivable from its own raw
by its own generator + regression test). The roll-up generator REFUSES to mint if the core loop does not
re-derive, or if any source bundle is not `status: pass` — and the regression test asserts the roll-up
never drifts from the committed source evidence.

## Explicit gaps (NOT measured / NOT supported — never hidden)

`look responsiveness/latency`, `recoil`, `ADS / aim spread`, `hit-stop / screen-shake FEEL QUALITY`,
broader hitscan weapon features, `enemy AI behavior beyond reaction`, `advanced cover beyond LOS/damage`,
`wave pacing / mission design beyond one wave`, `aiming-feel`, and `Fusion / multiplayer / netcode` — see
`evidence-manifest.json#gaps` and `mcp-server/src/loombridge/genre-packs/3d-shooter/methodology-gaps.md`.

## Files

| File | Role |
|---|---|
| `vertical-run-raw-2026-06-26.json` | IMMUTABLE raw live core-loop capture (verbatim `fieldTimeline`). |
| `generate.mjs` | Re-derives the core loop from the raw + rolls up the 8 phase bundles → manifest + report + derived. Run: `node demo-bundles/3d-shooter-minimal-vertical/generate.mjs`. |
| `vertical-run-derived-2026-06-26.json` | Core-loop derived artifact (generated). |
| `evidence-manifest.json` | Capability manifest + explicit gaps (generated). |
| `reports/3d-shooter-vertical-report.json` | Partner-facing roll-up report — experimental-green, not production-ready (generated). |

Regression test: `mcp-server/src/__tests__/3d-shooter-minimal-vertical.test.ts` (re-derives the core loop,
deep-equals the manifest/report/derived, asserts `productionReady:false` + explicit gaps + no capability
green without a raw source, and that every rolled-up value matches its source bundle — no drift).
