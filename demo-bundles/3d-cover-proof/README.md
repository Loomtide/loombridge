# 3D cover proof — live `coverBlocksDamage`

First live **cover** capture pair, taken in the repo-owned `unity-projects/shooter-3d-combat-dogfood`
fixture. This takes cover out of the `3d-shooter` gap ledger as a **geometric, causal** proof — an
obstacle blocks line of sight AND prevents damage for an otherwise-valid shot, and removing it restores
both — NOT as a tactical planner, cover-point generator, or AI cover selection.

## What this proves

A clean-room `Shooter3DCoverProbe` on an **isolated lane** (x=-4, clear of the main combat lane and the
AI occluder) fires straight `Physics.Raycast` shots at a down-range `CoverEnemy`. A `CoverProp` collider
sits between them. Each shot is on the line that **would** hit the target — the only variable is whether
the cover is in the way:
- the ray's first hit is the **cover** → `BlockedShotCount` rises (a real BLOCK, the crucial distinction
  from a miss — the shot was on-line);
- the ray's first hit is the **target** → the shot connects and deals damage.

Two captures under the **same** weapon conditions:

| Field | Covered (cover up) | Exposed (`V` removed it) |
|---|---|---|
| `IncomingShotCount` | 3 | 3 |
| `BlockedShotCount` | **3** (every shot blocked) | **0** |
| `HasLineOfSight` | false throughout | false → **true** at removal |
| `CoverActive` | true | true → false at `116.67ms` |
| `CoverEnemy.DamageTakenCount` | **0** (no damage through cover) | **3** (shots connect) |

**`coverBlocksDamage = true`** — the covered case blocks LOS + every valid shot + all damage; the exposed
case restores LOS + lets the same shots damage. Proven via the production `deriveCoverBlocksDamage`.

## No false greens

`deriveCoverBlocksDamage` REFUSES (never mints) when:
- a covered shot was **not** blocked by the cover (`BlockedShotCount != IncomingShotCount`) — a **miss is
  not a cover block**;
- damage was dealt **through** cover (covered `DamageTakenCount` rose);
- the covered case ever had line of sight;
- the exposed case dealt **no** damage (**false cover** — the block wasn't really cover), was still
  blocked, or never regained LOS;
- no shot was fired, or a series is degraded.

## Files

| File | Role |
|---|---|
| `3d-cover-covered-raw-2026-06-26.json` | IMMUTABLE raw covered-case transcript (cover up; shots blocked, no damage). |
| `3d-cover-exposed-raw-2026-06-26.json` | IMMUTABLE raw exposed-case transcript (cover removed; shots damage). |
| `generate.mjs` | Assembles the derived artifact FROM both raw transcripts through the production `deriveCoverBlocksDamage` (series copied verbatim). Run: `node demo-bundles/3d-cover-proof/generate.mjs`. |
| `3d-cover-derived-2026-06-26.json` | Canonical derived artifact (generated; reproducible from the two raw transcripts). |

Regression test: `mcp-server/src/__tests__/3d-cover-proof-substrate.test.ts` (re-derives from the raw
pair, deep-equals the generator, asserts covered-blocks/exposed-damages, and proves every refusal case:
degraded / no-shot / had-LOS / miss-as-block / damage-through-cover / false-cover / still-blocked).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/CoverProbe`,
  post-capture `error_count=0` on both.
- Covered recipe: fire `C` ×3 with the cover up → every shot blocked, no damage.
- Exposed recipe: `V` (remove cover) → fire `C` ×3 → LOS restored, shots connect for damage.

## Honest gaps (still NOT measured)

This bundle proves the narrow LOS/damage-prevention property only. It does **not** measure tactical
planning, cover-point generation, navmesh safe areas, peeking, suppression, flanking, AI cover selection,
or production cover-map quality — all explicit gaps. Waves/objectives remain a later phase. See
`mcp-server/src/capabilities/genre/genre-packs/3d-shooter/methodology-gaps.md`.
