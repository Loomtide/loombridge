# Generic Build Follow-On: 2D Shooter Experimental Slice

This bundle is the first concrete follow-on after the genre elicitation front-end certified against
vanilla. It proves a narrow claim:

- non-platformer genre: `2d-shooter`
- one core vertical slice: `weapon`
- status: `experimental-green`
- production claim: explicitly false

The proof is intentionally not a full Loombridge production build mode. Bootstrap build plumbing,
automatic spawned-object discovery, and per-genre fidelity criteria are still methodology gaps. The
bundle records a minimal 2D-shooter slice that passes supported gates, includes live Unity shot-counter
evidence for `fireIntervalMs`, live Unity spawn-signal evidence for `fireInputToSpawnLatency`, live Unity
trajectory evidence for `projectileSpeed`, and keeps the remaining gaps visible. `inputToSfxLatency` is
measurable today but is explicitly gapped in this bundle because the live weapon fixture did not include
a fire-SFX edge.

## Files

- `2d-shooter-experimental-run.json` — self-contained proof bundle with the validated Genre Contract,
  build/capture evidence, supported gates, and methodology gaps.
- `evidence/fire-interval-capture.json` — fixture-backed sampled `Weapon.FireCount` fieldTimeline
  evidence that originally proved the generic runner path.
- `live-unity-fire-dogfood/` — the successful live Unity fire-cadence capture plus the runbook/history.
- `live-unity-input-spawn-latency/` — the successful live Unity input-to-explicit-spawn-signal capture.
- `live-unity-projectile-speed/` — the successful live Unity projectile-trajectory capture.

## Verification

The bundle is validated by `validateExperimentalBuildProof` in
`mcp-server/src/loombridge/genre-contract/experimental-build-proof.ts`.

Run from `mcp-server/`:

```bash
npm run build
node --test dist/__tests__/generic-build-follow-on.test.js
```

The validator refuses:

- platformer genre ids
- invalid Genre Contracts
- unsupported or undeclared gates
- non-passing supported gates
- missing methodology gaps for unimplemented shooter-feel targets
- any `productionReady: true` claim

## Honest Scope

This is a milestone proof that the generic contract can drive a non-platformer slice to a bounded,
reviewable, experimental green. It closes three measurable shooter-feel targets end-to-end through the
bridge: a live Unity sampled shot counter derives `fireIntervalMs`, a sampled explicit spawn signal
derives `fireInputToSpawnLatency`, and a live Unity sampled projectile trajectory derives
`projectileSpeed`. It does **not** close automatic runtime-spawned object discovery or TTK; those remain
explicit methodology gaps.
