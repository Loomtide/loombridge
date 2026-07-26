# 3D wave/objective — live `waveObjectiveComplete`

First live **wave/objective** capture, taken in the repo-owned `unity-dev-project/shooter-3d-combat-dogfood`
fixture. This takes the wave/objective loop out of the `3d-shooter` gap ledger as a **deterministic
sequence** proof — spawn N → kill all → objective-complete — NOT pacing, a spawn director, or mission
design.

## What this proves

A clean-room `Shooter3DWaveObjective` (object `/WaveManager`) spawns N real target GameObjects on the
start key (`G`) and tracks them in a **live list**. Each kill key (`K`) destroys one and removes it from
the list, so `AliveCount` is the **actual count of live spawned objects** (not a hand-maintained number)
and `KillCount` rises per kill. `ObjectiveComplete` flips true **only** when the live list reaches 0
after a wave spawned — it is **kill-gated, never a timer**.

| Field | tMs |
|---|---|
| `WaveIndex` / `SpawnCount` (spawn N=3) | `0→1` / `0→3` at `116.67` |
| `KillCount` (K ×3) | `0→1` `266.67`, `1→2` `416.67`, `2→3` `566.67` |
| `AliveCount` | `0→3` at spawn, `3→2→1→0` (reaches **0 at `566.67`**) |
| `ObjectiveComplete` | false→**true at `566.67`** (the same frame `AliveCount` hits 0) |

**`waveObjectiveComplete = true`** — N spawned, all N killed (`KillCount == SpawnCount`, `AliveCount`
returns to 0), `ObjectiveComplete` rose **at kill-all** (`566.67ms == 566.67ms`). Proven via the
production `deriveWaveObjectiveComplete`.

## No false greens

`deriveWaveObjectiveComplete` REFUSES when:
- **the objective completed before kill-all** (`ObjectiveComplete` edge precedes the frame `AliveCount`
  returns to 0) — a **timer-driven** completion can never green;
- under-spawn (`SpawnCount` never rose);
- under-kill (`KillCount != SpawnCount`);
- enemies remain alive (`AliveCount != 0` at the end);
- no completion edge, or a degraded series.

## Files

| File | Role |
|---|---|
| `3d-wave-objective-raw-2026-06-26.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (verbatim `fieldTimeline` series). Do not hand-edit. |
| `generate.mjs` | Assembles the derived artifact FROM the raw transcript through the production `deriveWaveObjectiveComplete` (series copied verbatim). Run: `node demos/evidence-bundles/3d-wave-objective/generate.mjs`. |
| `3d-wave-objective-derived-2026-06-26.json` | Canonical derived artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-wave-objective-substrate.test.ts` (re-derives from raw,
deep-equals the generator, asserts the spawn/kill/complete ordering, and proves every refusal case
including **completion-before-kill-all** / under-spawn / under-kill / alive-remaining / no-completion).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/WaveManager`,
  post-capture `error_count=0`.
- Recipe: `G` (start wave, spawn N=3) → `K` ×3 (kill all) → `ObjectiveComplete` rises at kill-all.

## Honest gaps (still NOT measured)

This bundle proves the narrow single-wave spawn→kill-all→complete edge only. It does **not** measure
multi-wave pacing, difficulty curves, spawn directors, arenas, boss waves, loot rewards, mission design,
or wave-survival balance — all explicit gaps. See
`mcp-server/src/capabilities/genre/genre-packs/3d-shooter/methodology-gaps.md`.
