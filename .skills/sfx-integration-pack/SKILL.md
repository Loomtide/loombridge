---
name: sfx-integration-pack
description: Integrate SFX into an AI-built game as a semantic, cue-map-driven system — physical-action-first sound grammar, layer roles, anti-fatigue variants, top-down player-anchored audio rig, and the presence/runtime/latency/fatigue verification gates. Use when a built game needs readable, non-fatiguing, verifiable sound.
---

Use this skill to give a built game sound that reads as the ACTION, not a file drop — and to prove the
required cues actually fire. SFX is a semantic system: each cue is a declared contract (event binding,
grammar, layer roles, frequency, variant policy, priority, bus, spatial policy), not something invented
per run. This is a distinct pipeline from UI (`ui-polish-pack`) and environment/character art
(`generated-3d-art-integration`).

Workflow in brief: generate or source each cue against a declared cue map, keep provider API keys out of
the committed tree (env-only), and record provenance (source, license, author, cache key/sha) for every
imported clip. Import with game-appropriate Unity defaults (compressed-in-memory for one-shots, streaming
for loops/music) and, for a top-down game, anchor the listener to the player rather than the camera so
distance attenuation reads correctly. The per-genre cue map lives as a genre-pack artifact
(`mcp-server/src/capabilities/genre/genre-packs/<genre>/cue-map.json`), and the verification gates read it. This
skill is the actionable runbook + the DO/DO-NOT framing. Loombridge gates technical audio health and cue
FIRING deterministically; "does it sound like the intended action?" stays a HUMAN gate.

Provenance tags: **VALIDATED** = seen across ≥2 sources (SFX planning doc + the seeded cue-map/gates, or
a workflow doc + a ledger). **CANDIDATE** = one run only.

## The cue map is the source of truth — point at it, don't restate it

Do not re-enumerate the cue taxonomy in prose. Read the genre-pack cue map
(`genre-packs/<genre>/cue-map.json`) — e.g. `3d-topdown-arena/cue-map.json` declares the extraction /
top-down required set (`fire`, `hit`, `hurt`, `loot_open`, `loot_reward`, `extract_start`,
`extract_complete`, `enemy_death`, `player_death`) plus optional cues, each with its `event`,
`layerRoles`, `frequency`, `variantPolicy`, `priority`, `mixerBus`, `spatial`, and `meaning`. The schema
type + self-validating parser live in `mcp-server/src/capabilities/sfx/cue-map.ts`. A malformed/hand-edited
cue map is refused, so it can never silently degrade the gates. If your genre has no cue map, author one
following that shape; do not scatter ad-hoc cue names through the build. `[VALIDATED: sfx doc backlog #5 + seeded cue-map.json + cue-map.ts]`

## DO-NOT rules (each burned a real session)

- **Never prompt a cue for MOOD.** Name the PHYSICAL ACTION first: "metal footlocker clasp flips open,
  then a small reward bell" — not "loot pickup chime". The first loot cue read as a swing/woosh because
  it was prompted for mood; changing the sound grammar fixed it. `[VALIDATED: sfx doc #1 + cue-map honestyRule physical-action-first]`
- **Never leave a frequent cue single-clip.** A cue with `frequency:"frequent"` (fire/hit/hurt/
  enemy-death) MUST carry ≥2 variants, `noImmediateRepeat:true`, and pitch/volume jitter — single-clip
  frequent cues fatigue fast. Less-frequent cues can stay single. `[VALIDATED: sfx doc #2 + cue-map honestyRule frequent-needs-variants]`
- **Never stack layers as "make it bigger".** Layers are functional ROLES: transient (timing/
  readability), body (identity/weight), sweetener (genre flavor), tail (space/state), reward (emotional
  confirm), context (mix state). Weapon fire worked because it layered distinct roles; a musical reward
  cue may stay single-layer to avoid key clashes. `[VALIDATED: sfx doc #3 + cue-map layerRoles]`
- **Never route a tiered cue through a global `PlayLoot()`.** Map the event PAYLOAD to the variant/tier
  (loot reward reads `tier`/`value`); a global call hides the game state that makes better feedback
  possible. Tiered loot worked because `LootContainer` already emitted the looted value. `[VALIDATED: sfx doc #4 + cue-map honestyRule payload-not-global]`
- **Never make audio the ONLY channel for critical info.** low-health / zone-warning / player-death must
  ALSO be visual or captioned (accessibility). `[VALIDATED: sfx doc research synthesis + cue-map honestyRule audio-not-sole-channel]`
- **Never trust silence as success.** Prove required cues FIRED via probe counters/timestamps, not by
  assuming the drive worked (see Verification). `[VALIDATED: sfx doc backlog #7 + probe-contract.ts]`
- **Never green a cue whose signal is missing/stale.** Missing clip, no runtime edge, stale capture, or
  an unsupported object ref ⇒ `blocked`/`incomplete`, never green (harness-fault ≠ game-defect). `[VALIDATED: sfx doc Failure Semantics + gates]`

## Layering grammar (transient / body / sweetener + tail / reward / context)

Author every cue's prompt and integration metadata by role, not by "bigger":
- **transient** — the attack that gives timing readability (fire onset, clasp click).
- **body** — the identity/weight (weapon caliber, metal impact).
- **sweetener** — genre flavor (mechanical servo, energy whine).
- **tail** — space/state decay (room verb, reward shimmer).
- **reward** — emotional confirm (the bell after the clasp; escalates by tier but keeps a shared identity).
- **context** — mix-state layer (danger stinger, low-health filter).
`[VALIDATED: sfx doc #3 + cue-map CueLayerRole enum]`

## Top-down player-anchored audio rig

For a top-down camera, do NOT put the `AudioListener` on the camera — it makes every 3D source sound
distant and flattens panning. Use an audio rig that follows the PLAYER position while holding an
orientation aligned to the camera/screen, so left-on-screen maps to left-in-ear and distances stay
gameplay-true. Own each cue by class:
- **self-feedback** (fire, reload, own hit-confirm, UI) can stay **2D** for immediacy;
- **world threat + navigation** (enemy shots, enemy death, beacon hums, spawn telegraphs) should be
  **3D/positional** — a beacon hum doubles as spatial guidance;
- **enemy locomotion loops** should be **speed-gated** so footstep/servo loops belong to actual motion,
  not idle objects.

Recipe canonical in `GeneratedSfxWorkflow.md` → "Top-Down Audio Rig". `[CANDIDATE: late-polish #1 + GeneratedSfxWorkflow — a single top-down dogfood run; a starting recipe, not yet validated across genres]`

## How the T2 SFX gates consume the declaration

The gates (`mcp-server/src/capabilities/sfx/`) read the parsed cue map to know WHICH cues matter, then grade
runtime evidence — they do not invent requirements:
- **presence** — every `required` cue asset is imported as an `AudioClip` and bound on the SfxPlayer /
  event router; declared mixer buses exist.
- **runtime** — a drive scenario increments the expected per-cue counters (via the `SfxPlayer` probe
  snapshot — `playCount` / `perCue` / `lastCueId` / `lastCueTimeMs`, shape in
  `sfx/probe-contract.ts`); silence is not success.
- **latency** — `inputToSfxLatency` from input/gameplay onset to the SfxPlayer edge for the primary
  input-confirm cue; unsupported ⇒ reported `blocked`, not skipped.
- **fatigue** — configured `noImmediateRepeat` groups do not immediately repeat under a short stress
  drive.
The SfxPlayer MonoBehaviour (pooled sources, no-repeat variants, jitter, voice limits, priority, mixer
routing, 2D/3D, graceful no-op on missing optional clips) exposes the probe fields the gates read; the
component/template is authored per build, the READ CONTRACT is fixed in `probe-contract.ts`. `[VALIDATED: sfx doc backlog #6/#7 + probe-contract.ts + cue-map.ts]`

## Stages and gates

### Stage 0 — Cue inventory
- Extract player/enemy/world/UI/reward/failure/objective/ambience events from the core loop; mark each
  `required`, `optional`, or `silent-by-design`. Crude graybox tones are a valid EARLY deliverable — the
  early hooks make later polish tractable. `[VALIDATED: sfx doc #7 + GeneratedSfxWorkflow "Graybox Audio"]`
- **Gate:** every core-loop action has a cue or an explicit `silent-by-design` reason.

### Stage 1 — Cue grammar (or adopt the genre cue map)
- For each cue define physical action, emotional role, layer roles, frequency, priority, bus, spatial
  policy, payload mapping. Prefer the genre-pack `cue-map.json` if one exists.
- **Gate:** frequent cues have a variant policy; critical cues have latency + priority policy.

### Stage 2 — Asset selection / generation
- Prefer coherent curated packs; generate only game-specific-semantics cues. Record provenance + output
  hashes; no secrets in logs/manifests (per `GeneratedSfxWorkflow.md`).
- **Gate:** provenance + hashes present; reject technically weak takes before import.

### Stage 3 — Technical QC
- Analyze duration, leading silence, clipping, peak/RMS, attack, tail, format suitability.
- **Gate:** reject clips outside cue-specific technical bands (metrics reject defects, never approve taste).

### Stage 4 — Unity import + mix
- Role-specific import (short critical = low-latency/decompress-on-load; music/ambience = stream/
  compressed-in-memory); route through mixer buses; wire the SfxPlayer with variants/jitter/voice-limits/
  priority/spatial/payload mapping.
- **Gate:** all required cue refs bind, buses exist, scene compiles.

### Stage 5 — Runtime verification
- Drive gameplay; sample SfxPlayer counters/timestamps; measure `inputToSfxLatency` for the primary
  input-confirm cue.
- **Gate:** required cues fired; no immediate-repeat violation; no false-green on missing signals.

### Stage 6 — Human / advisory review
- Short targeted checklist: does loot sound like a crate opening? does fire read as THIS weapon? does
  high-tier loot feel better than low? does the cue fatigue after ~30s? Record corrections with
  provenance.

## Boundaries
- Use generic `unity_*` / `runtime_*` ops + the CLI; do not add game-specific bridge ops. `AudioClip`
  object-reference round-trip has a known gap (`GeneratedSfxWorkflow.md`) — bind carefully and verify.
- Do NOT promote the source dogfood project's exact clip names, prompt text, ElevenLabs provider choice, or specific
  loudness/centroid thresholds as canonical — gate on more genres.
