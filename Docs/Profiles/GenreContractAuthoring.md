# Authoring a Genre Contract

**Status:** shipped (GenreGenericity S2)
**CLI:** `loombridge genre init --genre <id> [--class twitch|systems|hybrid]`
**Then:** `loombridge plan --brief <dir>` or `loombridge plan --genre-contract <file>`
**Schema:** [`mcp-server/src/capabilities/genre/genre-contract/genre-contract.schema.json`](../../mcp-server/src/capabilities/genre/genre-contract/genre-contract.schema.json)
**Worked example:** [`mcp-server/src/capabilities/genre/genre-contract/examples/2d-shooter.contract.json`](../../mcp-server/src/capabilities/genre/genre-contract/examples/2d-shooter.contract.json)
**Interview skill:** `.skills/genre-pack-authoring/SKILL.md`

Loombridge ships a genre pack for a handful of genres. Your game is probably not one of them.
A **Genre Contract** is how you plan and verify a genre that has no pack: one JSON file that
`plan` compiles into `.loombridge/ACCEPTANCE.json` and `.loombridge/SLICES.json`, with the
platformer-shaped gates marked inapplicable so your build is never graded on whether it has
parallax.

This guide is about the decisions the contract asks you to make. It does not restate the fields;
the schema above documents every one of them, and the example is a complete contract you can read
end to end.

## The 60-second path

```bash
loombridge genre init --genre extraction-shooter --class hybrid
# edit .loombridge/genre-contract.json  (it prints the fields that still say REPLACE ME)
loombridge plan --brief .loombridge
```

`genre init` writes `.loombridge/genre-contract.json`, which is the exact name `--brief <dir>`
resolves, so the two commands compose with no path juggling. Use `--out <path>` if you keep briefs
somewhere else, and `--force` to replace one (it refuses to overwrite by default).

The scaffold **passes the validator on the first run**. That is deliberate: a generator whose
output the gate rejects is worse than no generator, so `genre init` validates its own output before
writing and refuses rather than hand you something to debug. What it cannot know, it marks
`REPLACE ME:` and lists back to you.

If your genre has a hint-card pack (`genre init --help` lists them), the scaffold seeds that pack's
tunables, default bands, asset roles, and exemplars. Otherwise you get the skeleton for your genre
class.

## What you are trading: `partially-graded`

A build planned from a contract verifies as `partially-graded`, not `graded`. That is an honest
label, not a penalty, and it costs exactly two things:

- **the registered feel oracle.** A pack ships per-genre feel-profile code; a contract cannot.
  Your measurable targets are still measured, but the genre-level feel grading a pack brings does
  not exist for you.
- **hero-shot fidelity, unless you declare `fidelityCriteria`.** This one you get back. See below.

Everything else works: the slice DAG, the deterministic gates, the build loop, `doneness`. The
ungraded gaps are enumerated on the verdict rather than quietly assumed away, which is the whole
point: a contract genre never borrows another genre's gates in order to look green.

## The five decisions

### 1. The genre class

`coreLoop.genreClass` is `twitch`, `systems`, or `hybrid`, and it is authoritative: it selects the
completeness rules the validator applies.

- **twitch** and **hybrid** must commit to at least one measurable feel target and at least one
  feedback chain. If the game lives or dies on how a verb feels, this is you.
- **systems** may be mostly judgment, and carries its weight in `humanOracleChecks` instead. An
  RTS, a builder, a management game.

It is never guessed. A genre with no hint card must pass `--class`, and a `--class` that
contradicts a pack refuses rather than silently override it.

### 2. The measurability map: the honesty crux

One row per feel target, and the row's `tag` is a claim about **what Loombridge can actually
measure today**, not about what matters:

- `measurable-now` binds to an implemented calculator, and the validator refuses an id that is not
  one. The current list is in the schema under `$defs.implementedCalculatorId`, so your editor can
  complete it.
- `needs-new-calculator` / `needs-new-bridge-capability` are the honest backlog. Name what has to
  be built; the scaffolder turns these into a `refusalCondition` for you.
- `judgment-only` requires a matching `humanOracleCheck`. A target that HAS an implemented
  calculator may not dodge into this tag.
- `engine-unsupported-today` is for things outside the substrate entirely.

**Bands and provenance.** A `band` is aspirational: it is recorded and surfaced, and an
out-of-band measurement is reported, never failed. A `gateBand` is enforced: a passing metric must
land inside it. Start with bands; promote to a gateBand once you have measured the game and know
the window is real.

Any band needs an `evidenceKind` saying where the number came from, and `agent-guess` needs an
out-of-band operator sign-off (a durable artifact plus its sha256), not a self-authored flag. If
you have not anchored a band to anything, leave the band off rather than invent one. That is why
the scaffold's own rows ship band-free.

### 3. Vertical-first: the budget and the slice DAG

`verticalSliceBudget.coreVerticalContent` is content **counts** (one weapon, one enemy, one
arena), and `deferred` is what is explicitly pushed to later. The validator enforces that a
`coreVertical` slice cannot carry a meta kind and cannot exceed its budget, because the failure
mode this catches is real: a roster of eight enemies before one of them is fun to fight.

Every slice declares `gates`, `gaps`, or both. `gates` come from a closed set (the schema
enumerates it): a gate that does not exist cannot prove anything. `gaps` are the honest remainder,
kept out of `gates` so they are never silently satisfied.

### 4. `fidelityCriteria`: the field that buys back the hero shot

This is optional and it is the single highest-value optional field in the contract.

`doneness` grades an approved Design Target against the genre's hero-shot fidelity criteria. A
registered pack declares them; a contract genre has none, so **without `fidelityCriteria` doneness
REFUSES any design-targeted build** (the alternative is declaring `art: { "mode": "deferred" }` in
`ACCEPTANCE.json`, which is a different, louder trade).

`genre init` therefore seeds a class-appropriate set by default. **Review it before you build.**
Every id must be one the review can actually carry (the schema enumerates them), and a criterion
your hero shot cannot satisfy makes your own doneness unreachable-green. Drop what does not apply
to your game; add what does.

### 4b. `artDirection.assetRoles` + slice `assets`: the fields that buy the asset manifest

A contract genre has no compiled-in asset-genre profile (those exist only for registered packs), so
without these fields `loombridge plan --asset-mode` REFUSES to draft an `ASSET_MANIFEST.json` and
`build` stays blocked at the asset gate.

Declare the asset roles your game actually reads by, then bind each slice to the roles it consumes:

```json
"artDirection": { "style": "…", "assetRoles": ["player-pen", "rival-pen", "desk"] },
"sliceDag": { "coreVertical": [
  { "id": "scene", "assets": ["desk"], … },
  { "id": "core-mechanic", "assets": ["player-pen", "rival-pen"], … }
] }
```

Promotion derives an `assetProfile` onto `GENRE_PROMOTION.json` (sanitized roles + per-slice
bindings), and `loombridge plan --asset-mode generated` drafts the manifest from it. The manifest
carries the roles as `contractRoles`, and `readAssetManifest` refuses a manifest whose roles drift
from the promotion on disk. Two limits, both deliberate:

- **`generated` mode only.** A contract declares roles but no registry primitives, so registry and
  hybrid drafts are refused by name; there is nothing a registry selection rule could match.
- **Every slice `assets` entry must be a declared role.** The validator refuses an unknown one
  (`SLICE_ASSET_UNKNOWN`) rather than letting a binding silently vanish from the profile.

An absent `assetRoles` stays absent: promotion writes no `assetProfile`, and the asset layer
refuses with a named reason instead of borrowing another genre's roles.

### 5. What the scaffold deliberately leaves out

`genre init` omits `productThesis`, `scaleModel`, and `requiredEvidenceClasses`, and it does not
invent a `gateBand`. All four would have to be fabricated, and a fabricated value that passes a
check is worse than an absent one that gets flagged.

- **`productThesis`** is the anti-drift boundary: what this game IS in one line, and what it is
  NOT. In dogfooding, this was the single most useful guardrail, because agents "improve" a
  prototype by adding familiar genre features that make a short-loop build less playable.
- **`scaleModel`** ties geometry to speed and target run length. Without it the scale sanity check
  cannot run at all.
- **`requiredEvidenceClasses`** declares which distinct evidence signals the build must gather, so
  "console clean" can never stand in for "playtest verified". Declare only classes your build can
  actually produce: `doneness` enforces them.

**Which of these `plan` actually warns about.** Only the first two. On a scaffolded contract `plan`
prints three advisory `WARN`s and one of them is not on the list above:

| code | fires when |
|---|---|
| `COVERAGE_PRODUCT_THESIS_ABSENT` | no `productThesis` |
| `SCALE_MODEL_ABSENT` | no `scaleModel` |
| `COVERAGE_ACCEPTANCE_PROTOCOL_PARTIAL` | only ONE of `measurabilityMap[].gateBand` / `humanOracleChecks` is present |
| `COVERAGE_FEEDBACK_SOUND_PARTIAL` | feedback chains are declared but none names sound/SFX |

An absent `requiredEvidenceClasses` is reported `[OK] proxied`, not warned: the coverage item falls
back to the per-slice `gates`, and a scaffolded slice DAG binds them, so it scores `present`.
Declaring the field is an OPT-IN that nothing prompts you to take, which is exactly why it is worth
taking. Adding it flips the item to "first-class" and `doneness` starts enforcing each class.

Add them all once you can state them honestly. They are cheap, and each one is a real check that
switches on.

## Editor completion

The schema has no hosted URL; the `$id` is an identifier, not a fetch target. Point your editor at
the file:

```json
{
  "$schema": "../mcp-server/src/capabilities/genre/genre-contract/genre-contract.schema.json",
  "schemaVersion": "0.1.0"
}
```

or map it once in your editor's JSON schema settings. The contract's `$schema` key is documented
in the schema and ignored by the validator.

**The schema is not the gate.** It gives you completion, required-field errors, and the closed sets
inline. It cannot express the cross-field rules, and it does not pretend to: dependency cycles,
calculator binding, band provenance, budget counts, and genre-class completeness are all enforced
by `validateGenreContract`, which is what `plan` runs. A file that satisfies the schema can still
be refused, and the CLI's refusal is the authoritative one. Every refusal names the rule, the path,
and a code.

## Where this fits

- [`commands/loombridge/plan.md`](../../commands/loombridge/plan.md) is the agent-facing procedure,
  including when to author a contract instead of forcing a pack.
- The `genre-pack-authoring` skill runs the contract as an **interview** rather than a scaffold,
  which is the better path when a human is in the loop and the genre is unfamiliar.
- [`Docs/Design/GenreGenericity.md`](../Design/GenreGenericity.md) is the design record for why the
  any-genre path exists and what it may never erode.
