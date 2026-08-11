# RFC: Artifact storage (where Loombridge writes, and what a team commits)

**Status:** **S1 + S2 SHIPPED**; S3/S4 proposed. **Date:** 2026-08-04, S2 landed 2026-08-11.
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
   `templates/create-loombridge-game/.gitignore` hid `.loombridge/replays/`, which contained
   both the approved pixel baselines AND `traces/`, the recorded human demonstration. A trace is
   the single artifact in the system that CANNOT be regenerated without a human replaying the
   game, and the shipped default threw it away. **CLOSED by S2**: both are anchors under
   `.loombridge/anchors/`, the ignore rule covers only `run/`, and `loombridge migrate-layout`
   moves an existing project across (and `git add`s the destination, because `git clean -fd`
   skips ignored files and the old rule was accidentally protecting them).
3. **The home anchors were not portable even if copied.** The feel snapshot and the screen
   layout baseline carried an ABSOLUTE-path `projectRoot` stamp compared with `!==`, so a
   teammate whose checkout sat at a different path read `broken`, tier 2. **CLOSED by S1**
   (see "Staged delivery"): both anchors now bind through `projectBindingMatches` in
   `shared/repo-identity.ts`. Mechanism 1 is still open (S3).

Consequence as of the original finding, stated plainly: a clone plus `loombridge verify` could never exit 0. With
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

**S2 SHIPPED**, and the block below is what is on disk, not a proposal. Where it differs
from the first draft, the difference is a decision with a reason, recorded under
"Decisions taken during S2" below.

```
<unity-project>/.loombridge/
  ACCEPTANCE.json  FEEL_SPEC.json  GAME_SPEC.md  SLICES.json  STATE.md   COMMITTED
  ADOPTION.json  ASSET_MANIFEST.json  GENRE_PROMOTION.json               COMMITTED
  editor-allowlist.json  genre-contract.json   human-authored config     COMMITTED
  design/          hero-shot.png + design-target.json                    COMMITTED
  anchors/         traces/                recorded demonstrations
                   baselines/             approved pixel baselines + manifest
                   signoffs/              the human sign-off artifacts SLICES.json cites
                   feel/    (S3)          snapshots/current/ (JSON only)
                   screens/ (S3)          contract + approved layout baseline
                                                                         COMMITTED
  tests/           stamped Unity results + binding manifest              COMMITTED
  verify/          captured op output the Tier-1 gates read              COMMITTED
  registry/        imported asset packs (project INPUTS)                 COMMITTED
  run/             .gitignore  reports/  replays/{reports/,fleet.report.*}
                   captures/  art/  backups/  handoff/  op-traces/       IGNORED
```

**TWO TREES ARE NAMED `reports`, and they are NESTED, not merged.** `run/reports/` holds
the verification tier (`build-verdict.json`, `verify.json`, `slices/`); `run/replays/reports/`
holds the replay tier (`<id>.report.json`). Folding them into one directory would be a MERGE,
and a merge is not undone by renaming back: two files of the same name in the two trees, one
silently wins, and nothing on disk records which. They stay separate.

The whole `.gitignore` contribution is one rule:

```
.loombridge/run/*
```

and one rule a human can hold: **if it is not under `run/`, it is meant to be committed.**
Compare the previous template, which needed four ignore rules plus a fifteen-line comment
explaining why `tests/` was exempt, and still hid two anchors by accident.

**THE TRAILING `*` IS LOAD-BEARING; `.loombridge/run/` is a bug.** `run/` also carries its
own `.gitignore` (`*` then `!.gitignore`), so the run tier ignores itself in a fresh clone
that has never run a Loombridge verb. Git cannot re-include a file inside an *excluded
directory*, so the directory form would hide that marker too: it would never be committed,
never reach a clone, and the structural guarantee would silently do nothing. Measured with
real `git check-ignore` on a real repo, both forms, before choosing; the measurement is a
test (`write-paths.test.ts`, "M2"), not a note. The marker's own body is likewise two lines
for a measured reason: a bare `*` matches `.gitignore` itself.

This is enforceable rather than documentary. A guard test asserts every write path in the
codebase resolves under `anchors/`, `tests/`, `design/`, `verify/`, `registry/`, a named
contract file, or `run/`, and fails on anything else. That is the repo's standing defense
against a declared path nothing walks, applied to the storage layout itself. Its LITMUS
plants a writer targeting an undeclared location and requires the check to report it.

## Decisions taken during S2, and why

These six changed from the first draft. Each is here because getting it wrong was cheap to
do and expensive to discover.

1. **`.loombridge/verify/` DOES NOT MOVE.** Two independent reasons. (a)
   `packages/com.loomtide.loombridge/Editor/Handlers/CaptureHandler.cs` hard-codes
   `Path.Combine(projectRoot, ".loombridge", "verify")` as its write allowlist and throws
   `INVALID_PARAMS` outside it, so moving it in TypeScript alone makes every
   `capture.invoke_static` refuse while the whole Node suite stays green; moving it properly
   is a cross-language migration needing a bridge release AND a reinstall in every consumer
   project. (b) it is COMMITTED, and putting it under `run/` would structurally ignore it,
   which would break exactly the clone-and-verify promise this RFC exists to deliver: the
   captured op output is what lets a clone re-grade an approved slice with no editor.

2. **`.loombridge/editor-allowlist.json` DOES NOT MOVE.** `EditorInvokeAllowlist.cs` reads it
   at a fixed relative path on every invoke. It is human-authored config, and a committed
   named top-level file is what it should be.

3. **`.loombridge/genre-contract.json` DOES NOT MOVE.** Already correct; it was simply
   missing from the pinned inventory.

4. **`.loombridge/registry/` stays a COMMITTED TOP-LEVEL DIRECTORY**: not `run/`, and not
   `anchors/` either. Imported asset packs are project INPUTS: re-deriving one may need a
   hosted catalog a clone or a CI runner cannot reach, so ignoring them breaks the clone
   promise. But nobody APPROVES a pack, and `anchors/` means "a human froze this as the thing
   gates compare against". Filing an input there would dilute the word and would put
   something un-approved into the set the migration and the tombstone treat as ground truth.

5. **The human sign-off artifact moved to `anchors/signoffs/`.** `plan --go --signoff` wrote
   it under `paths.reports`, and the S2 split files `reports/` under `run/`: it would have
   become machine-local, ignored, and deletable by `git clean -fdx` while `SLICES.json` went
   on recording it as the evidence a slice is `approved`. An approval whose evidence never
   leaves one machine is not an approval. It also gained its first READER (a `status`
   warning when the artifact is missing or its sha no longer matches); it was previously
   defined and not wired.

6. **The MCP op traces moved to `run/op-traces/`, away from the demonstrations.** The server
   builds its recorder at startup, outside every CLI verb, and used to append into
   `replays/traces/`. That had two costs: an agent session re-created the directory purely by
   connecting, so "the legacy directory exists" could never be a safe migration signal; and a
   machine-generated op log was indistinguishable by location from an irreplaceable human
   demonstration. The migration refusal predicate is therefore **"a `*.trace.json` or a
   stamped baseline manifest exists at a legacy path, and is not a tombstone"**, never "the
   legacy directory exists".

**Top-level `captures/` is no longer an allowlisted screenshot root.** It predated
`.loombridge/`, sat outside the state dir, and belonged to neither tier, so no rule said
whether a team should commit it. The advertised destination is `.loombridge/run/captures/`.

## The migration, and the tombstone

`loombridge migrate-layout` performs the move. It is not a `mv`, and the reasons are all the
same reason: it touches the one artifact in the system a human cannot regenerate.

- **Copy → verify every byte at the destination → release the source.** There is no
  `fs.rename` anywhere in it, which makes a cross-device move (`EXDEV`) an ordinary case
  instead of a fallback branch that only ever runs on someone else's machine. Verification
  is sha256 per file: a size or count comparison would pass on a truncated copy.
- **A demonstration and its approved baseline move as ONE unit.** A half-migrated pair reads
  as "recorded, not approved", and that row's printed next action is `trace approve`, which
  would freeze NEW frames over the ones a human already approved. The same case now prints
  "your approved baseline is at the OLD path; run `migrate-layout`" instead.
- **The disk is the truth; the journal is a hint.** Interrupted between destination-verify
  and source-release, both copies exist. A second run re-derives every decision from what is
  actually there, so the survivor is neither re-migrated nor mistaken for finished work.
- **A lock file with a stale rule**, staleness decided by age AND process liveness, so a
  Ctrl-C does not cost an operator a fifteen-minute wait.
- **It refuses to run outside a git work tree** (unless `--no-git`), and `git add`s the
  destination itself. `git clean -fd` SKIPS ignored files, so the anchors under the old,
  ignored `replays/` were accidentally protected by the very rule this RFC removes; moving
  them somewhere untracked and un-ignored is strictly less protection. Measured on a
  template-derived project: `git clean -fd` deleted the migrated anchors with no git object
  behind them.
- **It re-stamps the four recorded paths that are not sha-bound**, and re-derives the
  sign-off sha from the relocated bytes. "No re-stamping needed" is true only of the pixel
  baseline, whose binding is a hash over bytes. The four are `SliceProof.verdictPath` (which
  three readers PREFER over the derived path), `SliceProof.signoffArtifact` +
  `signoffSha256`, the verdict evidence ledger's `inputsDir`, and `STATE.md`'s
  `lastVerdict.verdictPath`.

### The tombstone, and why it is the highest-priority part

**An OLDER CLI against a MIGRATED project must not tell a human to re-record.** Reproduced:
`discoverTraces` returns `[]` for a directory that is not there, so an old binary sees not a
`broken` anchor but NO anchor, prints the on-ramp, and says *"the cheapest universal anchor
is a recorded demonstration, so ask your human to play the game once: 1. loombridge trace
record"*. An old CLI is not hypothetical: a pinned CI runner, a second machine, and a frozen
installed runtime all keep running whatever they were installed with.

So the migration leaves each legacy anchor path OCCUPIED: a stub trace (so the id is still
discovered and the row still exists) and a PNG-less baseline manifest carrying the REAL
`traceSha256` of the migrated demonstration (so `verifyTraceBaseline` fails, `notRunClass`
becomes `broken`, and the tier is 2). The manifest's one declared-and-absent frame has a
SENTENCE for its `captureId`, because a manifest's failure text is the only channel a binary
that has never heard of this change will print.

This is proved by running the REAL discovery classifier over the LEGACY directories, which is
exactly what an old binary does, rather than by a test asserting its own model of one. The
counterfactual runs in the same test: with the legacy paths merely emptied, the same code
path reports zero rows.

A new CLI reads the same files as the migration MARKER, which is what keeps the refusal from
becoming a permanent exit-2 loop.

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
- **S2** SHIPPED. The `anchors/` + `run/` layout, the single ignore rule, the write-path guard
  with its LITMUS, the template `.gitignore` rewrite (including `.loombridge-fixtures/`, and
  top-level `captures/`, which is no longer an allowlisted screenshot root at all), and
  `loombridge migrate-layout` with its tombstone. See "Decisions taken during S2" for the six
  places the shipped layout differs from the draft above, and why.
- **S3** `migrate-workspace`, and the default flip with the five refusals inverted.
- **S4** Docs: the contradictions listed below, plus a "what to commit" section that a new team
  reads once.

## Bugs found while writing this, fileable independently

- ~~**`LOOMBRIDGE_WORKSPACE` is documented but read by nothing.**~~ **FIXED.** The variable was
  removed from `MiniGameVerifyCI.md` rather than implemented: `--workspace <dir>` is the real
  knob, it is the same flag every workspace-aware verb takes, and the unified router already
  reads it. A second spelling of one setting earns nothing. The page now states outright that
  no such variable exists, so a reader who saw the old revision is not left guessing.
- ~~**The shipped CI example is a self-graded green.**~~ **FIXED.** Confirmed from the source
  before fixing: on identical inputs (a contract with no `baseline.ref` plus the capture pack it
  was finalized from) the legacy alias printed `38 pass · 0 fail` and exited `0`, where the
  unified door exited `2` with *"a contract graded against captures of itself is not a human
  anchor"*. The example now uses the bare door with `--workspace`, splits into an honest headless
  job and a Unity-runner job, and the fictional `.loombridge/minigame/{contracts,captures}/`
  paths are gone. A guard walks it:
  `mcp-server/src/__tests__/unit/repo/profile-examples.test.ts` derives the verbs from the
  `cli.ts` dispatch, each verb's flags from its module, and decides "is this the anchored door?"
  by calling the real `classifyOrchestratorArgs` router.
  - **Still true, and still what S2 is for:** the anchor bundle has to be committed in-repo and
    copied OUT to `$RUNNER_TEMP` for the run, because `verify` refuses a `--workspace` inside the
    project. The example is structured so S2 collapses that to a single deletion (the `cp -R`
    step and the `--workspace` flag).
- **`ARCHITECTURE.md` layout drift:** it names `replays/baseline/` (code writes `baselines/`),
  cites `src/capabilities/state.ts` (the file is `src/domain/state.ts`), and lists
  `minigame-verification.json` under `.loombridge/reports/` (the unified door writes
  `verify-screens.json`).
- **`.loombridge/captures/` in the template `.gitignore` appears dead;** no writer was found.
  The real capture pack directory is `.loombridge/verify/`, which is NOT ignored today.

## Open questions

1. **Baseline PNGs: commit, or LFS by default?** Leaning commit, with LFS documented. LFS as the
   default adds a hard dependency to the on-ramp for a problem most projects will not have.
2. ~~**Does `run/` belong inside `.loombridge/` at all, or beside it as `.loombridge-run/`?**~~
   **DECIDED: inside**, on the strength of the write-path guard plus the run tier's own
   `.gitignore`, which makes the ignore rule travel to a clone rather than depending on the
   project's top-level file being right.
3. ~~**Should `migrate-workspace` be automatic on first run?**~~ **DECIDED for S2: explicit.**
   `migrate-layout` is a named top-level verb an operator asks for, never something another verb
   does on the way past; `verify` and `trace` REFUSE with the one-line command instead. Silent
   relocation of approved anchors is exactly the class of magic this repo avoids, and here the
   thing being relocated cannot be regenerated. The same answer is expected to hold for S3's
   `migrate-workspace`.
