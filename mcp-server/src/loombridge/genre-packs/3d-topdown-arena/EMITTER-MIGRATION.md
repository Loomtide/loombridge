# Dogfood emitter (TelemetryLogger) → schema-compliance migration

Ground-truthed (T3-T) against the dogfood project's real capture set
(the dogfood project's `PlaytestData/` — 259 event files, ~63k events, plus per-directory
`runs.jsonl` summary logs). This lists exactly what the real emitter must **add or
rename** to make a run pass full `loombridge tuning-report` validation against
`telemetry.json`.

The event STREAM is already representable: the seed's `eventStream` was ground-truthed
to the real 17-type closed set, real merged `player_pos` payload, `t` in **seconds**, and
a single **globally** time-sorted order. The remaining gaps are all on the run-binding /
summary surface — and each is a real HONESTY-RULE shortfall, deliberately left as a
migration item rather than a schema weakening. A real events file therefore validates
**clean once its per-event binding is stamped**, and a real run still (correctly)
refuses until the summary carries `producedAt` + `runId`.

## What already matches reality (no change needed)

- **Event types**: `player_pos`, `enemy_pos`, `shot_fired`, `shot_hit`, `damage`,
  `enemy_spawn`, `enemy_death`, `loot_start`, `loot_complete`, `loot_cancel`,
  `pressure_start`, `death`, `extract_hold_start`, `extract_hold_cancel`,
  `extract_complete`, `bot_state`, `bot_target`.
- **Merged `player_pos`** carrying `stash`/`heat`/`holdKind`/`holdProgress`/`nearestEnemyDist`.
- **`t` in seconds**, ~0.5s step, globally monotonic non-decreasing.
- **XZ-planar** (no `y`).
- **Honesty already respected upstream**: proximity is named `nearestEnemyDist`/`dist`
  (never `seen`); `banked` and `lost` are kept as **distinct** summary fields.

## MUST ADD — per-event run binding (blocks every run today)

1. **Stamp a run id on EVERY event row.** Real event rows carry no field tying them to
   their run, so the fresh-not-stale binding gate refuses (`runId` MISSING on N events).
   Add `runId` (the schema's `binding: events-file` field) to every emitted event line,
   equal to the summary's `runId`. This is the single change that flips a real events
   file from "representable" to "validates clean". Rule kept, not weakened: an unbound
   events file could be a stale file renamed onto a fresh summary's stem.

## MUST ADD / RENAME — run summary (the prescriptive contract)

The real per-run summary lives batched in `runs.jsonl` (one line per run, keyed to its
stream by the `eventsFile` filename). The schema's summary is the PRESCRIPTIVE contract;
these are the gaps:

2. **Emit one summary PER run, paired by stem to its events file.** The loader pairs
   `<stem>.summary.json` + `<stem>.events.jsonl` (or the `_summary.json` / `_events.jsonl`
   forms). The real emitter instead appends all summaries into a single `runs.jsonl` and
   names the events file inline (`eventsFile`). Either split `runs.jsonl` into one
   `<stem>_summary.json` per run, or add a batch-`runs.jsonl` adapter to the loader
   (out of scope for T3-T — left as a documented option).

3. **`runId`** — add a stable per-run id string (the schema's binding field). Today the
   only run identifier is the `eventsFile` filename; promote it (or a dedicated id) to a
   real `runId` and stamp it on every event (item 1).

4. **`producedAt`** (ISO-8601) — the real field is **`utc`** (e.g.
   `2026-07-01T10:13:01.669Z`). Rename `utc` → `producedAt` (or also emit `producedAt`).
   Freshness moat: a summary without a parseable `producedAt` is refused.

5. **`bankedValue` / `lostValue`** — the real fields are **`banked`** / **`lost`**
   (already distinct — good). Rename to the contract names (or emit both). Do NOT merge.

6. **`runDurationMs`** — the real field is **`durationSec`** in **seconds**; the summary
   contract expects **milliseconds**. Rename + convert (`durationSec * 1000`).

7. **Time-to-event summary fields** — rename to the contract's ms names and convert from
   seconds: `firstLootTimeSec` → `firstPickupMs`, `firstHighLootTimeSec` →
   `firstHighValueMs`, `firstEnemyNearTimeSec` → `firstEnemyNearMs` (all `*Sec * 1000`).
   The `-1` "never happened" sentinels should become omitted/null, not a negative ms.

8. **`map` / `route`** — the contract carries a `map` (required, segmentable) and
   `route` (segmentable) dimension. The real arena emits neither (`map` absent;
   `finalRouteType` is the closest route signal). Emit `map` and map `finalRouteType` →
   `route` so cohort segmentation works.

9. **`persona`** — the contract's segmentation field is `persona`; the real summary uses
   **`botPersona`** (and a separate empty `personaId`). Emit `persona` for bot runs so
   the persona cohort report can bind (`personas.json` bands are bound by name).

## Not blocking

- Extra real summary fields (`kills`, `shotsFired`, `containersOpened`, `peakStash`,
  `distanceTravelled`, `chosenLootTargets`, …) are ignored by the validator — declaring
  only the contract fields is fine. `chosenLootTargets` is an array and cannot be a typed
  summary field (the schema field types are scalar only); leave it undeclared.
- `enemy_pos.id` is a (sometimes negative) integer instance id — accepted as `integer`.
- `extract_hold_start.tier` can be `""` — accepted as `string`.

## Verification once migrated

```
loombridge tuning-report --genre 3d-topdown-arena --runs <dir-of-*_summary.json+*_events.jsonl>
```

Until items 1–7 land, expect the honest refusals proved by
`telemetry-groundtruth.test.ts`: event streams parse, but runs refuse for missing
per-event binding and missing summary freshness. That refusal IS the product working.
