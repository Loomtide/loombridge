# 3D enemy AI reaction — live `enemyReactionLatencyMs`

First live **enemy perception/reaction** capture, taken in the repo-owned
`unity-projects/shooter-3d-combat-dogfood` fixture. This takes the narrowest AI metric out of the
`3d-shooter` gap ledger — reaction time from a **genuine line-of-sight perception edge** to the first
reaction edge — backed by raw Unity samples. It is NOT a behavior tree or broad combat AI.

## What this proves

A clean-room `Shooter3DEnemyReaction` component on the enemy casts a `Physics.Linecast` toward the
player every frame. An `Occluder` (a `BoxCollider` at `(0,1,6)`) blocks that line, so `CanSeePlayer`
stays **false** while it is up — perception is a real LOS edge, **not a timer**. The deterministic
stimulus is removing the occluder (injected `T`), after which:

- **Perception edge** — `CanSeePlayer` flips false→true and `TargetAcquiredCount` rises **the same
  frame** the occluder is removed (`216.67ms`).
- **Reaction edge** — after a fixed reaction delay, `StartedAimingCount` rises (`416.67ms`).
- **`enemyReactionLatencyMs = 200.00 ms`** — perception edge → reaction edge, via the production
  `deriveEnemyReactionLatencyMs`. (Configured reaction delay `0.2s`.)

Because the reaction is gated on the perception edge, a reaction can never fire without first perceiving
the player; with the occluder left in place there is no perception edge and **no reaction at all** — the
derivation refuses.

## The edge chain (LOS-gated, in order)

| Signal | tMs |
|---|---|
| `OccluderActive` (line of sight blocked) | `true` until `200`, then **`false` at 216.67** (the `T` stimulus) |
| `CanSeePlayer` / `TargetAcquiredCount` (perception) | rise at **216.67** (same frame LOS clears) |
| `StartedAimingCount` (reaction) | rises at **416.67** |

`deriveEnemyReactionLatencyMs` refuses unless the perception edge exists and the reaction follows it:
no perception (no LOS), no reaction, or a pre-armed reaction (reaction before perception) all refuse,
never green.

## Files

| File | Role |
|---|---|
| `3d-ai-reaction-raw-2026-06-26.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (op, host, request, verbatim `fieldTimeline` series). Do not hand-edit. |
| `generate.mjs` | Assembles the derived artifact FROM the raw transcript: copies the series verbatim, runs `deriveEnemyReactionLatencyMs`, asserts the occluder started active (LOS blocked) and perception precedes reaction. Run: `node demo-bundles/3d-ai-reaction/generate.mjs`. |
| `3d-ai-reaction-derived-2026-06-26.json` | Canonical derived artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-ai-reaction-substrate.test.ts` (re-derives from raw,
deep-equals the generator, checks the occluder/perception/reaction ordering, and proves degraded /
no-LOS / no-reaction / pre-armed inputs refuse — never green).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/Enemy`,
  `sampleCount=63`, `durationMs=1033.33`, post-capture `error_count=0`.
- Phases: settle (occluder up, no LOS) → inject `T` (remove occluder → perception) → settle (reaction
  fires ~200ms after perception).
- Sampled fields: `CanSeePlayer`, `TargetAcquiredCount`, `StartedAimingCount`, `OccluderActive`.

## Honest gaps (still NOT measured)

This bundle proves ONE narrow perception→reaction latency, gated on a real LOS edge. It does **not**
measure behavior trees, tactical movement, squads, cover selection, pathfinding quality, accuracy / aim
fairness, target prioritization, or any broad combat intelligence — all explicit gaps. Cover and
waves/objectives remain explicit gaps. See
`mcp-server/src/capabilities/genre/genre-packs/3d-shooter/methodology-gaps.md`.
