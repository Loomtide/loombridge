# RFC: Artifact storage (where Loombridge writes, and what a team commits)

**Status:** PROPOSED; **S1 SHIPPED**. **Date:** 2026-08-04.
Inherits from [Positioning.md](Positioning.md) and is a peer of
[UnifiedVerify.md](UnifiedVerify.md): the front door cannot be a team gate until the anchors
it reads can leave one machine.

## The finding

**A teammate or a CI runner cannot `git clone` a project and verify it. Not in any
configuration.** This is not a hygiene preference; it is a correctness defect in the product's
central promise, which the README states as "play once, approve once; deterministic gates
forever after". Today that promise is scoped to the laptop that did the approving.

Three mechanisms produce it, each verified in code:

1. **The workspace path is unreachable from the repo.** It is computed as `os.homedir()` plus
   the project folder's BASENAME (`unified/discovery.ts:235`). Nothing on disk in the project
   can point at it. On a fresh clone `~/.loombridge/projects/<id>/` does not exist, so the feel
   snapshot and screen-contract anchors return zero rows, silently.
2. **The one project-local anchor is gitignored by our own template.**
   `templates/create-loombridge-game/.gitignore` hides `.loombridge/replays/`, which contains
   both the approved pixel baselines AND `traces/`, the recorded human demonstration. A trace is
   the single artifact in the system that CANNOT be regenerated without a human replaying the
   game, and the shipped default throws it away.
3. **The home anchors were not portable even if copied.** The feel snapshot and the screen
   layout baseline carried an ABSOLUTE-path `projectRoot` stamp compared with `!==`, so a
   teammate whose checkout sat at a different path read `broken`, tier 2. **CLOSED by S1**
   (see "Staged delivery"): both anchors now bind through `projectBindingMatches` in
   `shared/repo-identity.ts`. Mechanisms 1 and 2 are still open.

Consequence, stated plainly: a clone plus `loombridge verify` can never exit 0 today. With
nothing committed it prints the on-ramp and exits 2. With the contract committed it refuses
"nothing was graded" and exits 2. With only `.loombridge/tests/` committed it is `partial` at
exit 2, because a run with zero anchored sections cannot exit 0 by the rule
[UnifiedVerify.md](UnifiedVerify.md) established. Every path is a refusal, and every refusal is
correct given the inputs. The inputs are what is wrong.

"Keep the project clean" was the right instinct applied to the wrong set of files. It should
govern heavy regenerable output. It must never govern ground truth.

## The rule

> **Generic goes to the root. Project-specific goes to the project. Temporary is gitignored.**

- **Root (`~/.loombridge/`)** holds only what is not about any one project: the frozen CLI
  runtime, the cross-project asset download cache. `~/.loombridge/projects/` stops existing.
- **Project (`<unity-project>/.loombridge/`)** holds everything about that project, anchors and
  run output alike, so there is exactly ONE place Loombridge writes per project.
- **Committed vs ignored is structural**, not a list: one directory holds the regenerable half,
  and it is the only ignore rule.

Collapsing to one project root also kills a live defect for free: the basename-derived
workspace id means two checkouts of the same repo in different directories silently share one
workspace, which is why `discovery.ts` already carries a `workspaceRoutingNotes` scan to detect
it. That is the root cause of ledger backlog item 16 ("explicit `--id` workspaces invisible under the
derived id") in
[TideRunnerDoorOneLedger.md](TideRunnerDoorOneLedger.md); this RFC subsumes it, because a
project-local root has no derived id to disagree with.

## The layout

```
<unity-project>/.loombridge/
  ACCEPTANCE.json  FEEL_SPEC.json  GAME_SPEC.md  SLICES.json     COMMITTED
  design/          hero-shot.png + design-target.json            COMMITTED
  anchors/         traces/                recorded demonstrations
                   baselines/             approved pixel baselines + manifest
                   feel/                  snapshots/current/ (JSON only)
                   screens/               contract + approved layout baseline
                   overrides.json                                COMMITTED
  tests/           stamped Unity results + binding manifest       COMMITTED
  run/             reports/  verify/  captures/  candidates/
                   raw/  capture-artifacts/  backups/             IGNORED
```

The whole `.gitignore` contribution becomes one line:

```
.loombridge/run/
```

and one rule a human can hold: **if it is not under `run/`, it is meant to be committed.**
Compare the current template, which needs four ignore rules plus a fifteen-line comment
explaining why `tests/` is exempt, and still hides two anchors by accident.

This is enforceable rather than documentary. A guard test asserts every write path in the
codebase resolves under `anchors/`, `tests/`, `design/`, a named contract file, or `run/`, and
fails on anything else. That is the repo's standing defense against a declared path nothing
walks, applied to the storage layout itself. Its LITMUS plants a writer targeting a fifth
location and requires the check to report it.

### Why the split falls where it does

| Artifact | Tier | Why |
|---|---|---|
| recorded traces | anchor | irreplaceable without a human replaying the game |
| approved pixel baselines | anchor | the frozen comparison; heaviest anchor, see below |
| feel `snapshots/current/` | anchor | JSON only, tiny, and the thing drift is measured against |
| screen contract + layout baseline | anchor | the declared screens and the layout a human approved |
| design target | anchor | already project-local and correct today |
| stamped test results | committed evidence | not an anchor (nobody approves a suite), but a reviewer must read it without an editor |
| every report | run | re-derived from anchors plus a run |
| capture packs, candidates, raw scans | run | inputs to a grade, regenerable |
| replay report HTML | run | base64-embeds actual AND baseline frames, roughly 2.7x the raw bytes |

**The one genuine judgment call is the approved baseline PNGs.** They are anchors by role and
the heaviest thing in the system. Recommendation: commit them by default, document Git LFS for
teams that care about repo weight. They change only when a human re-approves, and an anchor
that cannot be shared is not an anchor. This is the single place an opt-out is defensible.

## What must happen first, and in this order

The move is not a file relocation. Two of the anchors would read `broken` on every teammate's
machine the moment they are committed, so the ordering is a constraint, not a preference:

1. **Make the binding portable.** SHIPPED (S1). The rule that already solved this for test
   results was extracted to `shared/repo-identity.ts`, where `projectBindingMatches` accepts an
   absolute-path match OR a `repoIdentity` + `projectPath` pair, and all three stamped artifacts
   (test results, feel snapshot, screen layout baseline) now gate on that one implementation. An
   identity that is not a real `host/path` never matches portably: the `basename:` fallback, a
   `../template.git` relative remote, and an `insteadOf` shorthand are all coincidences two
   unrelated repos share.
2. **Ship a migration.** `loombridge migrate-workspace` relocates an existing
   `~/.loombridge/projects/<id>/` into the project, sorts each artifact into `anchors/` or
   `run/`, and RE-STAMPS the bindings. Without this step the move silently invalidates anchors
   that are already in use, including the two validated live on consumer projects in July 2026.
3. **Only then flip the default**, and invert the refusals below.

### The refusals being inverted

Five sites currently REFUSE a workspace inside the project root, each with prose stating why:
`verification/verify.ts:1085`, `:1207`, `:1577`; `minigame/minigame-setup.ts:263`;
`feel/snapshot.ts:150`. They encoded the "never dirty the game repo" rule and were correct under
it. They are inverted deliberately here, and the prose is replaced rather than deleted, so the
next reader learns the rule changed and why instead of finding a guard that quietly vanished.

`--workspace` survives with its meaning flipped: it stops being "put the workspace outside the
project, which is mandatory" and becomes "put the REGENERABLE half somewhere else, which is
optional". That is the one preference with no correctness consequence, so it is the one that
stays configurable. Anchor location is not configurable: if it were, a meaningful fraction of
users would end up with unshareable ground truth, and the failure is silent, because verify
reports "no assets found" rather than "your anchors are on another machine".

## Invariants this must not erode

- **Anchors are shareable by construction.** An anchor whose evidence never leaves one machine
  is not a gate, which is the same sentence the template already uses to justify committing
  `tests/`. This RFC applies it to every anchor rather than one.
- Refuse on absent, never skip: a missing or foreign-bound anchor is `broken` (tier 2), never a
  silent zero-row skip. The current silent-skip on a missing home workspace is precisely how the
  defect stayed invisible.
- A run that compared nothing human-approved still cannot exit 0
  ([UnifiedVerify.md](UnifiedVerify.md)). Making anchors shareable makes that rule reachable
  rather than permanent.
- Portable binding must never widen into no binding: an identity that is not a real `host/path`
  stays a refusal.
- **Portable binding CHANGES THE FORGERY COST, and the docs must not pretend otherwise.** The
  stamp is anti-accident provenance, not anti-forgery, and it always was: the manifest is plain
  text either way. But the old absolute-path stamp was accidentally hard to forge for the case
  that matters here, because a forger had to guess the victim's checkout path, which is
  unguessable for an artifact committed to a repo that reaches an unknown clone. The clone URL
  is a public fact, so that accidental difficulty is gone. This is the price of an anchor that
  can be committed at all, and it is the reason integrity (sha256 over the frozen bytes, and
  re-derivation from the evidence) carries the weight rather than the binding.

## Staged delivery

- **S1** SHIPPED. Portable binding for the feel snapshot and screen layout baseline. No layout
  change; additive, and independently useful. Delivered: `shared/repo-identity.ts` (the
  derivation plus the one matching predicate); both approve paths derive the pair inside the
  writer, so no caller can stamp half of it; a half pair is a REFUSAL at every reader, not a
  field to ignore; the workspace routing note binds by the same rule, so a teammate whose
  anchor binds portably is told which `--id` to pass; and a portable match is stated on the
  plan row, naming the absolute path the anchor was approved at, because two checkouts of one
  repo still share a home workspace until S2 lands.
- **S2** The `anchors/` + `run/` layout, the single ignore rule, the write-path guard with its
  LITMUS, and the template `.gitignore` rewrite (including the two directories it misses today,
  `.loombridge-fixtures/` and top-level `captures/`).
- **S3** `migrate-workspace`, and the default flip with the five refusals inverted.
- **S4** Docs: the contradictions listed below, plus a "what to commit" section that a new team
  reads once.

## Bugs found while writing this, fileable independently

- **`LOOMBRIDGE_WORKSPACE` is documented but read by nothing.**
  `Docs/Profiles/MiniGameVerifyCI.md:86` shows `WORKSPACE="${LOOMBRIDGE_WORKSPACE:-...}"`. No
  source file reads that variable. A reader sets it and nothing happens.
- **The shipped CI example is a self-graded green.**
  `Docs/Profiles/examples/minigame-verify.github-actions.yml:22` points at in-project contract
  and capture paths that no code writes, and uses the legacy
  `verify --minigame --contract --captures` mode, which does NOT enforce the approved-baseline
  rule the unified door enforces. It grades a document against captures of that same document.
  It is also accidental proof that repo-local anchors work: the recipe just skips the anchor.
- **`ARCHITECTURE.md` layout drift:** it names `replays/baseline/` (code writes `baselines/`),
  cites `src/capabilities/state.ts` (the file is `src/domain/state.ts`), and lists
  `minigame-verification.json` under `.loombridge/reports/` (the unified door writes
  `verify-screens.json`).
- **`.loombridge/captures/` in the template `.gitignore` appears dead;** no writer was found.
  The real capture pack directory is `.loombridge/verify/`, which is NOT ignored today.

## Open questions

1. **Baseline PNGs: commit, or LFS by default?** Leaning commit, with LFS documented. LFS as the
   default adds a hard dependency to the on-ramp for a problem most projects will not have.
2. **Does `run/` belong inside `.loombridge/` at all, or beside it as `.loombridge-run/`?**
   Inside keeps one directory; beside makes the ignore rule impossible to get wrong even if
   someone commits `.loombridge/` wholesale with `git add -f`. Leaning inside, on the strength of
   the write-path guard.
3. **Should `migrate-workspace` be automatic on first run?** Silent relocation of approved
   anchors is exactly the class of magic this repo avoids, so leaning explicit, with `verify`
   printing the one-line command when it detects a legacy home workspace for this project.
