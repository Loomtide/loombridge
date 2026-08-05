# RFC: Plan and verify ANY genre

**Status:** PROPOSED. **Date:** 2026-08-05.
Inherits from [Positioning.md](Positioning.md). Related: [UnifiedVerify.md](UnifiedVerify.md)
(the verify door this feeds) and [ArtifactStorage.md](ArtifactStorage.md) (a peer correctness
wave).

## The finding

A developer ran bare `loombridge plan` in a project named `ExtractionShooter` and silently got
a 2D platformer. Confirmed against the seeded contract on disk:

```
game:       ExtractionShooter
win.rule:   "all-fruit"
feel:       runSpeed, jumpApex, timeToApex, shortHopApex, dashDistance,
            dashTime, dashCooldown, coyoteTime, jumpBuffer
platformer section present: true
verification.gates: undefined
```

That last field is the sharp end. With no `verification.gates` block, the platformer-shaped
gates (`platform-tiles`, `tile-render`, `parallax-motion`, `reachability`) stay APPLICABLE, so
the shooter is graded on whether it has parallax and platform tiers, and its hero shot is
judged against `platform-tiers` fidelity criteria.

**This is the only route in the system to a wrong `graded` claim.** Every deliberately
unsupported case is loudly scoped: an unregistered genre is `ungraded`, a promoted contract is
`partially-graded`, a genre/promotion contradiction refuses. The ACCIDENTAL case gets a full
Tier-1 `graded` stamp, and `verify` prints a coverage line only when coverage is NOT `graded`,
so nothing ever mentions the mismatch.

Two facts make it an oversight rather than a decision:

- `loombridge adopt`, in a sibling file, already refuses without `--genre`, with the comment
  "default to the registry default is WRONG (it would silently mis-genre the proposal), so
  require it" (`adopt.ts:376`). The two front doors have opposite policies.
- `commands/loombridge/plan.md:45` still tells agents: "with a single genre pack, `plan` infers
  it silently, do NOT ask. *If* more than one genre pack ever exists, ask." **Four packs
  exist.** The instruction is stale and is actively steering agents into the defect.

## What is already generic (and must not be rebuilt)

The architecture is in better shape than the symptom suggests. None of this needs work:

- **The core is genre-clean, and a LITMUS enforces it.** `genre-core-litmus.test.ts` fails the
  build if any file under `capabilities/` or `domain/` contains a registered genre id as a
  string literal or statically imports from `genre-packs/`, and it carries a self-test so the
  detector cannot silently degrade into a no-op.
- **Genre-specificity is DATA, not code.** `isGateApplicable` is one line: a gate is skipped
  when `acceptance.verification.gates[gate] === "not_applicable"`. That is the entire escape
  valve, and `promote.ts` already applies it automatically for a promoted contract.
- **A pack is mostly JSON.** `3d-topdown-arena` is two JSON files plus five registry lines with
  ZERO TypeScript, and it grades as `graded`. Only `platformer-2d` carries per-genre code, and
  it is reached through an optional lazy `loadFeelProfileModule` hook.
- **Three coverage tiers already work**, computed by the pure `deriveGenreCoverage` and
  RE-DERIVED by `doneness`, so a hand-written `genreCoverage: "graded"` certifies nothing.

So this RFC is not "make Loombridge generic". It is: close the one path that lies, and make the
already-generic path usable by someone who is not holding the source open.

## The three changes

### 1. Refuse to guess the genre (correctness)

When more than one genre is registered, bare `plan` must REFUSE rather than default, naming the
known ids and the escape hatches, exactly as `adopt` does today. A guessed genre that grades
`graded` is a false green; a refusal is a five-second fix.

`DEFAULT_GENRE_ID` stays for the single-registered-genre case and for internal callers, but it
stops being reachable as a silent answer to "what is this project?".

Also in scope, because they are the same defect wearing different hats:

- `commands/loombridge/plan.md:45` rewritten to instruct agents to ASK.
- The re-plan asymmetry: `plan --genre <other> --force` rewrites `ACCEPTANCE.json` and
  `FEEL_SPEC.json` but NOT `SLICES.json` on the non-promoted path (that file is written only in
  `mode === "design"`, which an existing roadmap suppresses). The stale platformer DAG survives
  a genre change and only surfaces later, as a `doneness` roll-up refusal about a genre
  disagreement. Either rewrite it under `--force` or refuse the flip with a message naming the
  file, but do not leave a half-changed project that looks changed.
- The shipped `2d-shooter`, `3d-shooter`, and `3d-topdown-arena` acceptance templates carry NO
  `verification` block, so on a whole-game verify the platformer-shaped gates stay applicable
  for them too. `_generic` already does this correctly; the pack templates should match.

### 2. Make a GenreContract authorable (the real bottleneck)

`--genre-contract` and `--brief` already compile an arbitrary genre into a working
`ACCEPTANCE.json` + `SLICES.json`, and already mark the platformer-shaped gates inapplicable.
The machinery is fine. The AUTHORING surface is the problem:

| authoring aid | today |
|---|---|
| TypeScript interface | yes |
| JSON Schema | **none** |
| template or generator | **none** |
| worked example | one |
| user documentation | **none** (`commands/loombridge/plan.md` never mentions the flag) |
| agent skill | one (`.skills/genre-pack-authoring/`) |

To learn the valid calculator ids today you read `validator.ts`. That is an expert path wearing
the costume of a supported one.

Deliver: a JSON Schema for `GenreContract` (so editors complete it and it can be linted outside
the CLI), a `loombridge genre init` scaffolder that writes a valid, commented starting contract
for a named genre, and the missing user documentation. The schema and the hand-rolled
`validator.ts` must be bound by a test so they cannot drift: the validator stays the gate (it
enforces cross-field rules a schema cannot), and the schema is the ergonomics layer.

### 3. Push `fidelityCriteria`, the field that buys back the moat

`partially-graded` costs two things: the registered feel oracle, which is genuinely
genre-specific work, and hero-shot fidelity. The second is RECOVERABLE without a pack, because
a `GenreContract` may declare its own `fidelityCriteria` drawn from `VLM_REVIEW_CRITERION_IDS`.
When absent, `doneness` refuses any design-targeted build.

So it is the single highest-value optional field in the schema, and the scaffolder must treat
it that way: present by default with genre-appropriate criteria, and its omission called out
rather than silently accepted.

## Invariants this must not erode

- **A guessed genre may never grade `graded`.** If the genre was not stated by a human or read
  from a contract, the run refuses; it does not pick.
- Coverage stays RE-DERIVED at `doneness` from disk, never trusted from a verdict.
- Core stays free of genre vocabulary; the LITMUS keeps deciding that, and new code must not
  need an exception.
- Adding a genre must not require TypeScript. `3d-topdown-arena` is the proof and the bar.
- The scaffolder produces a contract the REAL validator accepts. A generator whose output the
  gate rejects is worse than no generator.

## Staged delivery

- **S1 (correctness):** refuse-to-guess, the stale agent instruction, the `--force` roadmap
  asymmetry, and `verification` blocks for the three pack templates that lack one.
- **S2 (authoring):** the JSON Schema, `loombridge genre init`, schema-versus-validator binding
  test, and user docs for the whole any-genre path.
- **S3 (later, not in this wave):** a genre-neutral feel-oracle seam so `partially-graded` can
  earn feel grading from declared calculators rather than a registered pack.

## Out of scope

- Inferring the genre from project contents. Detection that is right most of the time is the
  same false-green shape as defaulting, arrived at more expensively.
- Changing what `graded` / `partially-graded` / `ungraded` mean.
- New genre packs. This wave makes authoring cheap; it does not author.

## Open questions

1. **Should bare `plan` refuse, or prompt?** Leaning refuse: `plan` runs non-interactively under
   agents, and a prompt has no answer there. The agent-facing fix is the instruction rewrite.
2. **Does `--force` across a genre change rewrite `SLICES.json`, or refuse?** Leaning rewrite
   with a loud notice, since the promoted path already rewrites and the asymmetry is the bug.
   Refusing is defensible if any slice already carries an approval proof.
3. **Where does `genre init` write?** Leaning `.loombridge/genre-contract.json`, which
   `--brief <dir>` already resolves by name, so `init` then `plan --brief .loombridge` works
   with no path juggling.
