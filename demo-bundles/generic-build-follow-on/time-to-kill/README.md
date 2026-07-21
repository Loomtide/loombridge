# Time-To-Kill (`ttkMs`) calculator

`ttkMs` is the shooter combat-pacing metric: the time from the FIRST HIT landing on the reference
enemy to its DEATH. It is measured **first-hit → death**, so it is independent of the player's aim
time (it answers "given hits land, how long does the enemy take to die?").

## Calculator

`deriveTimeToKill(damageSeries, deathSeries)` (`mcp-server/src/verification/feel-derive.ts`) — the
series→series sync form (same shape as `dashToGhostMs`):

- **damage / first-hit edge** (the reference edge): a monotonic `Enemy.HitCount` going 0→1, or an
  `Enemy.IsHit` boolean false→true.
- **death edge** (the target edge): an `Enemy.IsDead` boolean false→true, or an `Enemy.DeathCount`
  counter 0→1. Bind a RISING death SIGNAL, not a falling `Health` field (a depleting HP series would
  need a threshold-cross primitive; the explicit death signal keeps this on the honest rising-edge
  path shared by every other sync metric).

`ttkMs = deathEdge − firstHitEdge`. Honest-or-omit (refuse-don't-skip): a degraded series
(`unresolved`/`readError`) on EITHER input, no first-hit edge, no death edge, or a death edge that
precedes the first hit (non-causal) are each refused with a reason — never a fabricated/clamped 0.

## Status: measurable-now, LIVE-captured (host-project fixture)

`ttkMs` is `measurable-now` in the 2D-shooter contract + hint card (calculator exists, bound to
the validator's `IMPLEMENTED_SYNC_METRICS` closed set). It is **measure-only** (family `sync`): the
pack-default band (`150–600ms`) is an aspirational good-feel target, not gate-enforced until a shooter
profile bands it.

A live dogfood capture now exists:
`../2d-shooter-promoted-vertical/ttk-live-capture-2026-06-25.json` records a real
`runtime.capture_input_motion` Play-Mode capture of a transient `DogfoodReferenceEnemy` exposing sampled
`HitCount`/`IsDead` rising signals, driven through a kill (hits = injected fire-key edges, death causal on
`HitCount` reaching `MaxHits`). `deriveTimeToKill` derives `300.00ms` (firstHit `216.67ms` → death `516.67ms`).
The promoted vertical proof cites this live artifact; the earlier fixture-backed artifact is retained only as a
`superseded` fallback.

The calculator path is also proven synthetically by the `runFeelCaptureContract` runner test
(`feel-capture-runner.test.ts`) plus the derivation/assembler unit tests. The honest residual
(`ttk-live-shooter-combat-loop`): the live capture's host was a fixture host of convenience, **not** a shipped
2D-shooter build, and hits were injected fire-key edges rather than live projectile-collision damage. Missing
first-hit/death signals are refused (`attempted-blocked` / not-measured), never green.
