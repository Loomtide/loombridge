# RFC: Hero-shot authoring, and closing the `--kind` default trap

**Status:** PROPOSED. **Date:** 2026-08-11.
Inherits the design-target split from [Positioning.md](Positioning.md) and the doneness
invariants in `CLAUDE.md`. Ships with the `hero-shot-authoring` skill in the same change; the
code change described in §2 is deliberately NOT in that change, and wants an adversarial pass
first.

## The problem

`plan` blocks until an approved, frozen hero shot exists, so the Design Target is the first
hard wall a new user hits. Every other part of that pipeline is built: `target set/approve`
owns the artifact and the kind split, `plan.md` step 3 walks the three modes, and
`verify-2d-game/references/vlm-review.md` is the densest hero-shot content in the repo.

**Nothing teaches an agent how to produce one.** `plan.md` routes to Claude's built-in
`frontend-design` skill, which is a general HTML/CSS skill that knows nothing about Unity, 3D,
or the kind split. `codex exec` appears in zero skills, so the one path a maintainer has
actually shipped a game with is unwritten.

### The sharp edge: an absent `--kind` is a silent, wrong answer

`resolveDesignTargetKind` (`capabilities/verification/design.ts:84`) reads:

```ts
return kind === "composition-reference" ? "composition-reference" : DEFAULT_DESIGN_TARGET_KIND;
```

Anything that is not the explicit string resolves to `rendered-unity-frame`. That default is
correct and deliberate for backward compatibility, and `CLAUDE.md` states it: *only an explicit
`composition-reference` is refused.*

The trap is what that means at the keyboard. The natural command after generating an image is:

```bash
loombridge target set --image hero.png --mode generated --approve
```

For a 3D build that has just frozen a flat 2D mock as the artifact `doneness` grades final
fidelity against: an image with no materials, no real proportions, no lighting, no silhouettes.
This is precisely the "certify against an idealized fiction" failure the kind split exists to
prevent, and nothing refuses it, because an absent `kind` is a legitimate answer for a 2D game.

The gate is sound. The DEFAULT is what is unsafe, and only on one path.

### A dimensionality-derived fix is not available

The obvious fix, "derive the kind from whether the project is 3D", cannot be built today:

- The genre contract declares **no** dimensionality field (no `dimension` / `2d` / `3d` /
  `projection` key in `genre-contract/types.ts`).
- `design.ts` never consults the genre at all.
- The genre id encodes it by naming convention only (`3d-shooter`, `platformer-2d`), and the
  genre-core LITMUS forbids core from containing registered genre id literals, so core may not
  pattern-match them. A `3d-` prefix heuristic would also be wrong for any contract genre, which
  is the population this feature most needs to serve.

So dimensionality is a thing this repo does not know. Inventing a heuristic for it inside core
would trade a visible trap for an invisible one.

## The changes

### 1. Ship the `hero-shot-authoring` skill (this change)

The runbook nobody has: choosing a mode with the user, the two generation backends, the 2D/3D
fork, capturing the real Unity frame for stage two, and what makes a hero shot *annotated*
(the callouts are what `fidelityCriteria` later grades against).

It carries the ordering that the verb help states and no runbook teaches:

```
generate concept  → target set --kind composition-reference --approve   (unlocks assembly ONLY)
assemble scene    → capture a real Unity frame
                  → target set --kind rendered-unity-frame --approve     (only NOW fidelity/doneness)
```

### 2. Require an explicit `--kind` when `--mode generated` (the code change)

**`target set --mode generated` with no `--kind` REFUSES**, naming both options and what each
unlocks. Refuse-on-absent, applied to the one path where the default is dangerous.

This needs no dimensionality signal, which is the point: the user answering "is this a mock, or
a real frame of the assembled scene?" is a question they can always answer, whereas the tool
guessing it is a question the tool cannot.

Scope is deliberately narrow, to preserve the documented compat rule:

- `--mode provided` and `--mode reference-game` keep the absent-kind default unchanged. A
  provided file is a deliberate human choice of artifact.
- Every existing `--kind`-bearing invocation is unaffected.
- Only the generated path, where the artifact was made by a model minutes earlier and the
  operator is least likely to have considered which kind it is, changes.

An `--assume-kind` style escape hatch is deliberately NOT proposed: the whole value is the
half-second of thought at the moment the artifact is minted.

### 3. Backend detection: suggest, never default

`codex` on PATH makes a second generation backend available. Detection is the CLI's job
(deterministic, local, cheap); **generation is not**.

- A `doctor` row reports availability: `codex: available (codex-cli <version>)` / `not found`.
- `plan`'s step 3 offers the detected backends and lets the user pick, or paste an existing
  reference, or decline generation entirely.
- Detection MUST NOT select. Claude and codex produce visibly different art, and the hero shot
  is the one artifact the entire build is graded against; a silent backend choice is a surprise
  on the worst possible artifact.
- **Non-interactive refuses rather than guesses.** `plan` runs headless in CI and inside other
  agents; with `process.stdin.isTTY !== true` there is nobody to ask, so an explicit mode flag
  is required and its absence is a refusal. Precedent: `minigame-setup.ts:376`.

The CLI never invokes an image generator. The agent does, via its own tooling, exactly as the
Ghost Relay build did. That keeps `child_process` egress, retries, cost and provider failure
modes out of a tool whose job is deterministic grading, and it is supported by evidence: a real
3D game shipped this way with no CLI involvement at all.

### 4. Record which backend produced it

The design-target record stamps the generator (tool + model) when the mode is `generated`, so a
hero shot carries the same provenance discipline as a generated asset. Secrets are redacted on
the existing `generated-assets.ts` path (`SECRET_KEY_RE`), and that refusal already prescribes
env-var-only keys; nothing new is introduced here.

## Invariants

- **A generated image is never silently a frozen hero shot.** The operator states the kind, or
  the command refuses.
- **Only a `rendered-unity-frame` certifies doneness.** Unchanged; this RFC only stops an
  operator from mislabelling one by omission.
- **Detection never chooses.** An available backend is an offer, never a default.
- **The CLI does not generate.** It detects, records, and grades.
- The absent-kind compat rule survives on every path except `--mode generated`.

## Out of scope

- Adding a dimensionality field to the genre contract. It would be useful for preselecting the
  answer in the chooser, but the refusal in §2 is correct without it, and a new contract field
  is a bigger change than the trap warrants.
- Any in-process image or 3D generation provider. See the asset-registry boundary: adding one
  means re-scoping the package-wide write-verb ban, which is a separate RFC with its own
  adversarial pass.
- Gate-declaration-based skill routing (skills declaring which gates they build toward). Related
  and worth doing, deliberately separate.

## Open questions

1. **Does `--mode generated` + refusal break any shipped flow?** `plan.md` step 3's generated
   example passes no `--kind`, so that documentation changes with the code. No test fixture
   should depend on the default via the generated path; confirm before implementing.
2. **Should `doctor`'s backend row be a warning when nothing is available?** Leaning no: zero
   backends is a legitimate configuration (paste a reference, or let the agent draw one), so it
   is informational. A warning would imply a missing dependency that is not missing.
3. **What exactly did the Ghost Relay build run for `codex exec`?** The skill records the
   verified CLI surface (`codex exec [PROMPT]`, `-i/--image`, `-m/--model`, `codex-cli 0.145.0`)
   but the image-production recipe is the maintainer's and is marked UNVERIFIED in the skill
   until confirmed. It must not be invented: a plausible-looking wrong command is worse than an
   admitted gap.

## LITMUS obligations for the implementation

Each guard needs a self-test proving it fails on the broken input:

- `--mode generated` with no `--kind` refuses (exit non-zero), and the refusal names both kinds.
- `--mode generated --kind rendered-unity-frame` still succeeds: the refusal is about ABSENCE,
  never about the generated mode being second-class.
- `--mode provided` with no `--kind` still resolves to `rendered-unity-frame`: the compat rule
  is untouched off the generated path, and a test asserts that explicitly.
- Non-interactive (`isTTY` false) with no mode refuses before writing anything.
- Detection reports `not found` without throwing when `codex` is absent from PATH.
