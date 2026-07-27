# Live Unity Input-To-Spawn Latency Capture

This records the shooter measurement-loop follow-up after `fireInputToSpawnLatency` became measurable
through the explicit sync-series calculator.

- Project: `unity-dev-project/shooter-input-spawn-dogfood`
- Fixture: `DogfoodSpawnSignal` on `/ProjectileSpawnSignal`
- Input: Input System `Space`, after a 120ms no-key settle phase
- Sampled fields: `DogfoodSpawnSignal.ProjectileSpawnCount` and `DogfoodSpawnSignal.ProjectileVisible`
- Calculator result: `fireInputToSpawnLatency = 113.33ms`

Scope: this proves the explicit spawn-signal path: input onset to a sampled counter/visibility edge.
It does not claim automatic discovery of arbitrary runtime-spawned projectile objects.

Measure-only: `fireInputToSpawnLatency` is a sync-family, measure-only metric (like `inputToSfxLatency`
and `fireIntervalMs`). The capture proves the calculator derives an honest value end-to-end — it does
NOT certify the value against the pack-default 50ms band. That band is an aspirational good-feel target
and is not gate-enforced until a shooter profile bands the metric; this synthetic dogfood (an artificial
~80ms spawn delay plus input-processing/fixed-tick quantization) lands at 113.33ms, deliberately surfaced
rather than tuned to fit the band.
