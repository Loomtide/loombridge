---
name: genre-pack-authoring
description: Interview for and emit a Genre Contract — the plan-time build contract that turns a one-line game brief into a fully-specified, measurable, vertical-first, closed-set-bound plan that passes validateGenreContract.
---

# Genre Pack Authoring

Use this skill to run the plan-time **elicitation front-end**: turn a one-line game brief into a
12-field **Genre Contract** that a deterministic validator accepts. The contract is the genre-agnostic
build plan; this skill is the judgment half (the deterministic half is `validateGenreContract`).

The gate is `validateGenreContract` in
`mcp-server/src/capabilities/genre/genre-contract/validator.ts`.
A contract is done only when that function returns `valid: true`. Never invent gate ids, units, or
calculator ids outside the closed sets it binds against (listed below). A passing reference is
`mcp-server/src/capabilities/genre/genre-contract/examples/2d-shooter.contract.json`.

## Interaction model: draft first, ask only on uncertainty

1. From the one-line brief + your own genre knowledge (seeded by a genre hint-card if one exists —
   see "Hint cards" below), **draft a full candidate contract**, all 12 fields filled.
2. Then ask the human ONLY on high-uncertainty / taste dimensions:
   - **perspective** (top-down / side-scroll / fps / tps),
   - **network model** (SP / co-op / pvp),
   - **feel-band confirmation** (any band you guessed),
   - **scope** (what is core vs deferred).
   Do not interrogate dimensions you can confidently default. Confident-but-wrong bands are caught by
   the evidence-kind rule (below): every unevidenced band still gets forced to human sign-off.
3. Run the result against the validator. Fix every issue. Re-run until `valid: true`.

## The 12 fields (the universal spine)

`schemaVersion` is always `"0.1.0"`. `genreId`, `confidence` (`experimental | candidate | hardened`),
optional `subGenres`. Then:

### Group A — Context (fields 0–4)

- **0 `targetPlatform`** — `device`, `inputScheme` (authoritative here, NOT in field 2), optional
  `aspect`, `session`.
- **1 `networkModel`** — `mode: single-player | co-op | pvp`. If not single-player, `netcode` is
  REQUIRED; **default `photon-fusion`**. Fusion can run host/SP, so set `spPlayable: true` for an
  MP-capable architecture with an SP-playable vertical.
- **2 `coreLoop`** — `description`, optional `perspective`/`subGenre`, and **`genreClass`**
  (`twitch | systems | hybrid`) — the AUTHORITATIVE value the validator binds completeness against
  (the hint-card only seeds it). twitch/hybrid = fast feel (shooter, platformer); systems = mostly
  judgment (RTS, auto-battler); hybrid = both.
- **3 `artDirection`** — `style` (required), optional `palette`, `assetRoles[]` (a concrete
  core-vertical role-set, not just a theme), `theme`, `heroShotMock`. Include every role the first
  playable slice needs to read as that genre: controllable avatar/unit, threats, player/enemy
  projectiles where applicable, level/arena surfaces, HUD/readability markers, hit/impact/death VFX,
  command/selection feedback for systems games, and SFX roles when they are part of the feel loop.
  Do not list whole-game breadth just to look rich; rosters, factions, campaign art, progression
  screens, shops, bosses, and multiplayer chrome belong in `deferredMeta`.
- **4 `verticalSliceBudget`** — `coreVerticalContent` (≥1 positive-integer count, e.g.
  `{ weapon: 1, enemy: 1, arena: 1 }`) and `deferred[]` (roster/progression/economy/matchmaking…).

### Group B — Craft (fields 5–8)

- **5 `feedbackChains[]`** — one per core verb: `verb` + `input` + `response` + `feedback`.
  twitch/hybrid need ≥1.
- **6 `tunables[]`** — named runtime feel params (no magic constants). Each has `id`; optional `unit`
  MUST be in the supported-unit set if set.
- **7 `measurabilityMap[]`** — the honesty crux. See "Tag honestly" below. Non-empty.
- **8 `referenceAnchor`** — `clips[]` / `exemplars[]` / `notes` — real sources for bands instead of
  guessing. 3D video→reference is research-tier; 3D bands fall back to exemplar/hand-set + judgment.

### Group C — Build plan (fields 9–11)

- **9 `sliceDag`** — `coreVertical[]` (≈6–10 dependency-ordered slices) + `deferredMeta[]`. Each
  `SliceNode`: `id`, `title`, `dependsOn[]` (must resolve, no cycles), `confidence`, and **at least one
  of `gates[]` (closed set) / `gaps[]`** — a slice with neither is refused. Optional `kind`.
- **10 `refusalConditions[]`** — `condition` + `reason`: what is unverifiable, labeled honestly.
- **11 `humanOracleChecks[]`** — `check` + `appliesTo`: required for every `judgment-only` target.

## Vertical-first (enforced, not just encouraged)

The core vertical is the loop feeling great with MINIMAL content (one weapon, one enemy, one arena).
Push every meta-system to `deferredMeta`. The validator enforces this by **content count**, not just
bucket presence:

- `coreVerticalContent` caps how many slices of a budgeted `kind` may sit in `coreVertical`.
- A `coreVertical` slice may not carry a meta `kind` — the deny-list is
  `roster | progression | economy | matchmaking | shop | unlocks | campaign`, plus anything in your own
  `deferred[]`. Put those in `deferredMeta`.
- "Minimal content" is not "thin presentation." The core vertical still needs the full role-set that
  makes the loop readable and judgeable. For a top-down shooter, `assetRoles` should usually include
  player, weapon/muzzle, player projectile, enemy, enemy contact/projectile if applicable, arena
  floor/bounds, reticle/crosshair, hit/impact VFX, death VFX, health/ammo/wave/score HUD, and SFX
  hooks. For an RTS, include worker/combat unit, resource node, production/drop-off building, terrain
  map, selection marker, command marker/VFX, health bars, build footprint feedback, and resource/unit
  HUD. Keep variant counts low; keep readability roles explicit.
- A brief-defining meta-looking hook gets ONE minimal core representative when the brief explicitly
  names it. Example: "run-and-gun with a between-level weapon-upgrade choice" should include
  `coreVerticalContent.upgradeChoice: 1` and one `coreVertical` slice titled like "Minimal
  between-level weapon upgrade choice" with a non-meta `kind` such as `upgradeChoice`. Defer the full
  weapon tree, shop, economy, roster, and run-to-run progression. Do not mark that core slice as
  `kind: "progression"`, `kind: "unlocks"`, `kind: "economy"`, or any `deferred[]` value.

## Tag measurability HONESTLY (field 7)

Every row needs `target`, `tag`, and `bucket` (`coreVertical | deferredMeta` — required, never inferred).

- **`measurable-now`** — ONLY when an IMPLEMENTED calculator exists. `calculator` is required and MUST
  be one of (from `IMPLEMENTED_CALCULATOR_IDS` in validator.ts):
  `jumpApex, timeToApex, runSpeed, shortHopApex, runAcceleration, runDeceleration,
  fallGravityMultiplier, projectileSpeed, inputLatency, coyoteTime, jumpBuffer, inputToSfxLatency,
  dashToGhostMs, groundContactToDustMs, inputToAnimStateLatency, fireIntervalMs,
  fireInputToSpawnLatency, dashDistance`.
  Anything else (maxFallSpeed, hitStopMs, ttkMs, …) is NOT measurable-now — claiming it fails.
  Also: a target that HAS an implemented calculator may NOT dodge to `judgment-only`.
- **`needs-new-calculator`** — a TS calculator does not exist yet but the capture pattern transfers;
  `calculator` names what must be built.
- **`needs-new-bridge-capability`** — needs new C# bridge capability (vector/rotation sampling, aim
  injection), not just TS.
- **`judgment-only`** — no measurable proxy. **Every judgment-only `target` REQUIRES a matching
  `humanOracleCheck` with `appliesTo === target`.**
- **`engine-unsupported-today`** — outside Loombridge's substrate today (3D / Fusion-replicated state).

twitch/hybrid genres must commit to **at least one** non-judgment measurable feel target (any
measurable-now / needs-new-calculator / needs-new-bridge-capability). Not everything can be
judgment-only.

### Bands + evidence (field 7)

Any `band` (`{min?, max?, unit?}` or `{qualitative}`) REQUIRES an `evidenceKind`:

- `reference-anchored` — set from a clip/exemplar in field 8.
- `pack-default` — from the genre hint-card.
- `agent-guess` — your own guess. On a target, an agent-guess band is REFUSED unless paired with an
  **out-of-band operator sign-off**: `signoff: { signoffArtifact (safe root-relative path),
  signoffSha256 (64-hex), note? }`. You cannot self-attest a guess — a human signs off out of band.

Band `unit`, when set, must be in the supported set: `u, u/s, u/s^2, s, ms, px, x`.

Do not omit useful bands just because Loombridge cannot measure them today. If a hint-card provides a
`pack-default`, or a reference exemplar clearly anchors a range, include the band with the honest
measurability tag (`needs-new-calculator`, `needs-new-bridge-capability`, or `judgment-only`). Only
use no band when there is no pack default, no reference anchor, and no operator sign-off. Conversely,
never mark an unimplemented metric `measurable-now` to make the contract look stronger.

## Slice gates (field 9) — the closed gate set

`gates[]` entries must be supported gate ids. The current set:
`manifest, ui-conformance, framing, render-frame, coverage, parallax-motion, visual-artifacts,
reachability, placement, platform-tiles, tile-render, prop-purpose, playability, feel,
feel-provenance, physics-timestep, feel-rederive, console-clean, asset-source-fidelity,
frame-integrity`.
Anything you'd want but isn't here goes in `gaps[]`, never faked into `gates[]`.

## Worked mini-example (twitch)

Brief: "a fast top-down twin-stick shooter." Draft `genreClass: twitch`, `perspective: top-down`,
`networkModel: { mode: single-player, spPlayable: true }`, budget `{ weapon: 1, enemy: 1, arena: 1 }`,
`assetRoles: ["player-character", "weapon", "reticle", "player-projectile", "enemy", "arena-floor",
"arena-wall", "muzzle-vfx", "hit-vfx", "death-vfx", "health-hud", "ammo-hud", "wave-score-hud",
"combat-sfx"]`, and `deferred: ["weapon-roster", "enemy-variety", "progression"]`. Then ask the
human: perspective confirm? SP or co-op? confirm any non-pack-default band? Measurability map:

```json
{ "target": "inputToSfxLatency", "tag": "measurable-now", "calculator": "inputToSfxLatency",
  "band": { "max": 50, "unit": "ms" }, "evidenceKind": "pack-default", "bucket": "coreVertical" }
{ "target": "fireIntervalMs", "tag": "measurable-now", "calculator": "fireIntervalMs",
  "band": { "min": 90, "max": 140, "unit": "ms" }, "evidenceKind": "pack-default", "bucket": "coreVertical" }
{ "target": "fireInputToSpawnLatency", "tag": "measurable-now", "calculator": "fireInputToSpawnLatency",
  "band": { "max": 50, "unit": "ms" }, "evidenceKind": "pack-default", "bucket": "coreVertical" }
{ "target": "aiming-feel", "tag": "judgment-only", "bucket": "coreVertical" }
```

…with `humanOracleChecks: [{ "check": "does aiming feel responsive and fair?", "appliesTo": "aiming-feel" }]`.
Slices: `arena → controller → weapon → enemy → feedback / hud / end-state`, each with `gates` (e.g.
`manifest, console-clean`) and/or `gaps` (e.g. `fire-interval-calculator`). Deferred:
weapon-roster (`kind: roster`), progression (`kind: progression`).

## Hint cards (pluggable defaults)

A genre hint-card seeds defaults — `genreClass`, asset roles, exemplars, pack-default bands, and
optional `coreHooks[]` for brief-defining meta-looking mechanics that need one minimal core
representative. It is a declarative JSON read at
`mcp-server/src/capabilities/genre/genre-contract/genre-packs/<id>/hint-card.json` (forward reference — the
pack-discovery refactor is a later milestone; here the hint-card is just a file the skill reads).
Absent a pack, the spine + your genre knowledge still emit a contract — lower default quality, more
honest gaps.
The hint-card's `genreClass` is only a SEED; field 2's `genreClass` is authoritative.

## Boundaries

- Emit a contract that PASSES `validateGenreContract`; that function is the gate, not your judgment.
- Never invent gate ids, units, or calculator ids outside the closed sets above. When unsure whether a
  metric is measurable today, it is NOT — tag `needs-new-calculator` and move on.
- Do not edit any `.ts`/`.json` under `genre-contract/`; they are the frozen schema and the gate.
