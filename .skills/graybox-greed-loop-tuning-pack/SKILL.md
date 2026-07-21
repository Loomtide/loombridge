---
name: graybox-greed-loop-tuning-pack
description: Telemetry-driven tuning loop for greed-loop / extraction / collect-and-bank / roguelite-run games — instrument, run persona-bot cohorts, analyze, tune one lever, re-run. Carries the extraction-shooter tuning grammar (two rules dual-validated; the greed-timing rules are single-run candidates). Use when tuning whether a risk/reward run is FUN, not whether it compiles.
---

Use this skill to tune the FEEL of a greed loop — extraction shooter, collect-and-bank, roguelite run,
score chase — through a measured loop instead of vibes. The method is: **instrument → persona bot cohort
→ analyze runs → tune ONE lever → re-run the same cohort → compare**. Bots tune BALANCE and catch
regressions; HUMANS judge fun. This skill covers the loop machinery plus a specific extraction-shooter
tuning grammar (provenance labeled per rule — most of it is single-run candidate material).

The telemetry schema, persona spread, and evidence classes are genre-pack artifacts + shipped analysis:
`mcp-server/src/loomtide/genre-packs/3d-topdown-arena/telemetry.json` (per-run summary + closed event
set), `.../personas.json` (Timid/Balanced/Greedy/Reckless with intent + envelope + calibration posture),
and `mcp-server/src/verification/gates/evidence-classes.ts`. Point at those for the field lists — do not
restate them here.

Provenance tags: **VALIDATED** = the specific RULE (not just its theme) appears independently in two
sources — the Codex planning/tuning session ledger (`codex #N` tags below) AND Claude
session `3de0bf92` (GRL-B "genre-pack candidates"). Only TWO grammar rules clear that bar: minimap
informs-without-revealing and personas-as-route-proxy/calibrate-first. **CANDIDATE /
single-source** = one session only ("the same class of learning parked in two sessions" does NOT count —
each rule must itself be taught twice). **ANECDOTE** = an exact number from ONE game — never a genre
constant.

> **Numbers are anecdotes.** Every concrete value below (`3.5s`, `15-22s`, `15-20s`, `7s`, `40×40`,
> `~5 m/s`, `22-26%`, `90-150s`) is a SINGLE-GAME anecdote from one top-down mobile extraction-shooter
> gray-box dogfood project. Use the *shape* of
> the rule; re-derive the number per game from speed × target-run × camera width. Do not promote any
> number as a genre default.

## The tuning loop (the machinery)

1. **Instrument.** Emit the genre telemetry schema — a per-run summary (`runId`, `producedAt`, `map`,
   `persona`, `outcome`, `runDurationMs`, `firstPickupMs`, `firstHighValueMs`, `firstEnemyNearMs`,
   `bankedValue`, `lostValue`, …) plus a closed event stream. Follow the schema's HONESTY rules: a
   proximity field is named `…Near`/`…Distance`, NEVER `seen`; `bankedValue` (secured) and `lostValue`
   (forfeited) never collapse; event JSON is escaped; a summary carries `runId`+`producedAt` and every
   event carries a matching `runId` or the set is refused. Schema:
   `genre-packs/3d-topdown-arena/telemetry.json`. `[VALIDATED: codex #7 + GRL-B11 + seeded telemetry.json]`
2. **Run a persona cohort.** Drive the build with a deterministic, heuristic (NOT learned/RL) scripted
   bot across personas × seeds, each run emitting one schema-conformant summary+stream stamped with its
   `persona`. Spread beats one "average" bot: `personas.json` seeds Timid/Balanced/Greedy/Reckless with
   INTENT stated before any pass rate. `[VALIDATED: codex #8 + GRL-B11 + seeded personas.json]`
3. **Analyze.** Aggregate + segment by map/persona/route/loot-tier/outcome; compare BEFORE↔AFTER a single
   change. Report evidence classes, not one "all green": compile/console/scene-validation/screenshot/
   input-path/play-trace/telemetry-parsed/human-notes are SEPARATE — an agent cannot compress them into
   one success claim. `[VALIDATED: codex #6 + evidence-classes.ts]`
4. **Tune ONE lever.** Pick one target metric, change one dominant lever, re-run the SAME cohort. Keep
   map / economy / heat / combat changes separable. If pressure already exists from heat/enemies, extend
   run duration via map scale / loot placement / extraction distance / route incentives — not by making
   enemies harsher. `[method: codex #9 — single-source; cross-ref promoted as method, not a number]`
5. **Re-run + human-judge.** Bots prove the balance MOVED the way you intended; a human confirms the
   tension comes from greed choices, not confusion.

## Personas are a ROUTE/REGRESSION proxy — NEVER a difficulty proxy

This is the single most load-bearing discipline. A bot is a deterministic balance + regression proxy, not
a fun judge and not learned AI.

- **Calibrate personas BEFORE tuning the game around their failures.** A broken bot over-commits; nerfing
  the game to its failure is tuning to a bug. `personas.json` ships every persona `calibrated:false` with
  `calibrationEvidence:null` on purpose — a persona's numbers back a balance claim ONLY once
  `calibrated:true` with an evidence pointer. `[VALIDATED: codex #8 + GRL-B + personas.json calibration posture]`
- Human runs are the DIFFICULTY signal; bot cohorts are the BALANCE/regression signal.

> User (verbatim, `3de0bf92`): *"Do not tune the game downward from this bot cohort alone. First fix/
> calibrate the bot personas."* `[VALIDATED — echoed by codex #8: "Calibrate personas before tuning the game around their failures."]`

## The extraction-shooter tuning grammar (per-rule provenance)

Quote the user's lines as the authority; keep the numbers as anecdotes. **Only the minimap and
persona-calibration rules are DUAL-VALIDATED** (taught in both the Codex session and `3de0bf92`); the
greed-timing rules below appear ONLY in `3de0bf92` (GRL-B) and stay candidates — per GRL-B's own routing
table: "Do NOT promote to a shipped genre pack from this + codex alone."

- **Pressure is tied to GREED, not the clock.** First enemy spawns AFTER first loot (a short delay), with
  a grace *fallback* and a *high-rush* trigger (entering a high-loot zone before looting). The first crate
  is NOT dangerous.
  > User: *"That ties danger to greed, not just the clock… I would not make the first crate dangerous."*
  `[single-source: 3de0bf92 / GRL-B — candidate until a second extraction-shooter run]`
- **First crate safe → second crate not free → third crate is the greed decision.**
  > User: *"one 'free understanding' crate, then pressure should begin."*
  `[single-source: 3de0bf92 / GRL-B — candidate until a second extraction-shooter run]`
- **High loot sits behind a route COST, off the extract path** — a full high route must LEAVE the extract
  path, not ride the diagonal home, and must not be reachable too early (else "high" becomes the default
  route).
  > User: *"do not allow first high before ~15-20s. If first high is still at 7s, high will remain the
  > default route."* `[single-source: 3de0bf92 / GRL-B — candidate; ANECDOTE: 15-20s / 7s]`
- **Geographic danger over global buffs.** Pressure from shooter sightlines and danger pockets, not global
  stat ramps.
  > User: *"broad authored danger zones… 'this area is getting dangerous,' not 'enemy is exactly here.'"*
  `[single-source: 3de0bf92 / GRL-B — candidate until a second extraction-shooter run]`
- **Minimap INFORMS without REVEALING.** A strategy surface (player pos/facing, extraction, loot-risk
  tiers, broad danger/heat regions) — NOT a perfect always-on enemy radar, no exact loot markers. Sized
  for route CHOICE, not just orientation.
  > User: *"broad authored danger zones…, not 'enemy is exactly here.'"* `[VALIDATED — codex #4: "strategy surface, not a perfect enemy radar." ANECDOTE: minimap ~22-26% screen width]`
- **Opener-only nearest-spawn.** Use nearest-spawn selection for the OPENER / early pressure only, not
  every wave, or the map loses spatial strategy.
  > User: *"Use it only for the opener or early pressure, otherwise the map loses spatial strategy."*
  `[single-source: 3de0bf92 / GRL-B — candidate until a second extraction-shooter run]`
- **Avoid bespoke single-scenario systems.** Build pressure from EXISTING systems; do not add a mechanic
  to solve one situation.
  > User: *"avoid solving any specific scenarios. We should use existing systems."*
  `[single-source: 3de0bf92 / GRL-B — candidate; generalizable design-review principle, still one run]`

## Planning discipline (method — mostly Codex-single-source, cross-ref before promoting)

- **Product thesis + anti-drift, before build.** State what the game IS, is NOT, and what is deferred —
  agents "improve" a short-loop prototype by adding Tarkov-like depth (ammo/attachments/inventory grids)
  and make it less playable. `[method: codex #2 — single-source]`
- **Review the design doc adversarially before code.** Require an acceptance protocol, input contract,
  feedback (SFX) contract, and a measurable v0 layout up front. `[method: codex #1 — single-source]`
- **Primitive blockouts still need reference contracts** — top-down layout, primitive legend, golden-path
  trace, fixed shape/color language. "Use primitives" is underspecified without them. `[method: codex #3 — single-source]`
- **Scale from speed × target-run, not "make it bigger."** Re-derive arena size from player speed, target
  duration, first-loot time, first-high time, extraction distance, camera width, minimap readability.
  `[method: codex #5 — single-source; ANECDOTE: a 40×40 arena at ~5 m/s collapsed exploration]`

## DO-NOT

- **Never nerf the game from a bot cohort alone** (calibrate personas first).
- **Never name a proximity/distance field `seen`/`spotted`** (it overstates what telemetry knows).
- **Never merge `bankedValue` and `lostValue`** into one ambiguous `value`.
- **Never change multiple levers between two cohort runs** — you lose attribution.
- **Never let "console clean" imply "playtest verified"** — evidence classes stay separate.
- **Never promote an exact number** (`3.5s`, `15-22s`, `40×40`, `22-26%`) as a genre constant — anecdote.
- **Never let a bot verdict substitute for the human fun/tension/clarity judgment.**

## Cohort gates (a healthy greed loop)

- First-run route is understandable; the Safe (Timid) persona can bank.
- Balanced persona shows a MEANINGFUL success/failure spread.
- Greedy persona creates higher upside AND higher death/loss risk (punished by the economy, not confusion).
- Reckless persona usually fails for LEGIBLE reasons (dies deep carrying value it never banked).
- Human notes agree: tension comes from greed choices, not confusion.

## Boundaries
- Loomtide owns the telemetry SCHEMA + persona CONTRACT + the deterministic cohort/tuning analysis; it
  does not RUN the bot (that runtime is game-side C#). Use generic ops; no game-specific bridge ops.
- Missing `runId`/`producedAt`, a duplicate `runId`, an uncalibrated persona backing a balance claim, or
  a single "all green" compressing evidence classes ⇒ `blocked`/caveat, never a clean pass.
- Do NOT promote the source dogfood project's map dimensions, bot thresholds, or timing numbers as universal
  defaults; and do not add bosses/complex enemies before the base route/economy loop validates.
