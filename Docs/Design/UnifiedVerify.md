# RFC: Unified Verify (one front door for verification)

**Status:** **S1 and S2 have shipped** (see the delivery notes below); S3 to S4 remain
PROPOSED.
**Date:** 2026-07-28. Written after the first full live dogfood of every verification mode on
consumer projects (KidsAdventure: trace record/replay + screen contract; KnightsQuest: tuning
snapshot), which is where the fragmentation cost was measured first-hand.

## Thesis

Positioning ([Positioning.md](Positioning.md)) fixes the frame this RFC works inside:
provable doneness is the product, and the story has exactly **two doors**. `plan` is the
door for a new game (the supervised build loop, with `doneness` as its strict certificate).
`verify` is the door for an existing game: **you play once and approve once; your agent
gets `verify` forever after.** This RFC is the program of record for making that second
door one door, and in doing so it is the simplification program for the whole verify
surface.

Two workflows hang from the doors:

- **Build**: bridge + MCP tools + commands/skills. Agents construct in-engine.
- **Verify**: deterministic gates agents run locally and in CI, anchored to human-approved
  baselines. Verification is not a terminal CI stage; it is the steering signal that makes
  agent building CONVERGE (build, verify, fix, re-verify, approve, next slice).

The named third element is the **human approval surface**: a human approves ground truth once
(a design target, a trace baseline, a feel snapshot, a screen contract), and every later
verdict is a deterministic comparison against that anchor. Without this anchor, "agents build
and verify" reads as agents grading their own homework, which is the exact failure mode the
product exists to kill. The actors are deliberate and split: the approval steps (play,
look, approve) are HUMAN steps and cannot be delegated to an agent; everything downstream
of an approval is deterministic and belongs to agents and CI.

Today the verify workflow does not look like one workflow. It looks like four:

| Entry | What it checks | Anchor |
|---|---|---|
| `verify` (contract mode) | Tier-1 gates for a Loombridge-built project | acceptance contract + design target |
| `verify --minigame --contract --captures` | screen/UI/flow release check | screen contract + approved baseline |
| `verify --snapshot` | kinematic drift | approved feel snapshot |
| `trace replay` | flow + pixel drift | approved trace baselines |

Plus `verify --profile` (archetype feel grading) standing off to the side. A user, or an
agent, must know Loombridge's internal capability taxonomy before they can ask the only
question they have: **"does this build still do what a human approved?"**

Two facts make unification cheaper than it looks:

1. **Verdict semantics are already unified.** Every mode shares the exit contract (0 pass,
   1 game-fail/drift, 2 harness-fault/capture-gap) and the invariants (refuse-on-absent,
   harness fault is never a game defect, no self-grading). The modes differ in INPUTS only.
2. **The anchors are already one grammar.** Approve-once / freeze / refuse-drift,
   instantiated per anchor kind: trace baselines (pixels), feel snapshot (kinematics),
   screen-contract baseline (layout), design target (composition). Four instances of one
   grammar wanting one front door.

## The model: verification assets

A project accumulates **verification assets**. Each asset is a frozen, human-approved anchor
plus the recipe to re-measure the live game against it:

| Asset | Anchor (frozen) | Re-measured live | Today's owner |
|---|---|---|---|
| demonstration | recorded action trace | replay actuation + flow | `replay/` |
| pixel baseline | approved frames per trace | perceptual diff | `replay/` |
| feel snapshot | approved kinematics + capture contract | live capture + drift | `feel/` |
| screen contract | declared screens/objects/flow + approved layout baseline | capture pack + gates | `minigame/` |
| acceptance contract | contract + design target | Tier-1 gate suite | `verification/` |
| test results | a stamped Unity EditMode run (bound, never approved) | nothing: graded OFFLINE from the stored bytes | `tests/` |
| slice roadmap | the APPROVED slices of `SLICES.json` + their per-slice verdicts | nothing: the gates are RE-RUN OFFLINE over each slice's own evidence dir | `verification/` |

This table is a CLOSED inventory: discovery walks exactly these kinds, and adding a kind is
an RFC-level change, never a quiet case in a switch. The reserved addition has now LANDED:
**test results** is the FIRST new asset kind, which is how the roadmap's Test Runner gate
arrives as a provider in this report instead of a sixth standalone mode. It is the one row
whose anchor column reads differently on purpose, and the delivery notes below say why.
The SECOND addition, **slice roadmap**, landed with the evidence arc's roll-up door (L109): a
slice-planned project keeps its evidence in `.loombridge/verify/<slice>/`, so the flat contract
row could only ever refuse "nothing was graded", leaving a 9/9 project with a permanently red
front door and no legal route to green. The two rows are MUTUALLY EXCLUSIVE by construction: when
`SLICES.json` exists, the acceptance contract is graded PER SLICE and rolled up by the `slices`
section, and the flat contract row is the non-sliced flow's door. Its human anchor is the
approval checkpoint (`proof.approvedAt`); its re-measurement is a RE-GRADE (each slice's gate list
re-run over its own evidence dir, refused on any divergence from the stored verdict), plus a
per-file sha binding minted into the verdict at verify time and a contract-coverage check that
refuses when a contract section declaring required content is walked by no gate in the plan.
Deliberately NOT assets:
`sfx/` (its probe contract and latency checks are gate inputs inside other assets, not an
anchor a human approves) and `scenario/` (a step runner, machinery rather than a frozen
anchor); if either ever grows a human-approved baseline, it enters through this table.

`loombridge verify`, bare, becomes an orchestrator:

1. **Discover** the project's assets DETERMINISTICALLY, from the workspace and `.loombridge/`
   manifests. Never by sniffing or guessing: an asset exists because an approve/init step
   wrote it.
2. **Print the plan first**: `will check: flow (trace kq-happy-path), feel (snapshot
   approved 2026-07-28), screens (contract kids-adventure)`. CI never runs a surprise live
   capture; an operator can see exactly what a green means.
3. **Run every asset** into ONE report (per-asset sections, shared row shape), exit by worst
   tier. A discovered-but-broken asset (tampered manifest, missing baseline file) is exit 2,
   never skipped.
4. `--only contract|flow|feel|screens|tests|slices` selects subsets for CI granularity. (The
   vocabulary is the REPORT's own section names, spelled once in `UNIFIED_SECTION_NAMES`.
   `pixels` folded into `flow` when the trace section landed in S1 (actuation and pixel
   drift are one replay, not two selectable checks), `tests` joined with the fifth asset
   kind, and `slices` with the sixth. A selector naming a section the report cannot express would be a selector nothing
   could grade.)

**The empty-project behavior is the on-ramp, not usage soup.** `verify` with no assets prints
the path to the cheapest universal asset. As shipped in S1 that path is three commands, not two:
`trace record --observe` (a human plays it once), `trace replay` (re-drive it and capture
frames), `trace approve` (freeze those frames as the baseline), then `verify --live`. A
recorded demonstration + baseline works for ANY game with input, needs no
contract authoring, and gives real regression protection minutes after install. The on-ramp
names its actors honestly: the recording session is a HUMAN playing the game (that play
session IS the approval moment, the single human anchor everything hangs from), and the
agent's entry point is the step after it, running `verify` against what was approved. The
on-ramp text an agent sees must therefore say "ask your human to record a demonstration",
never instruct the agent to perform a step it structurally cannot.

## What existing surfaces become

- **`verify --minigame`** stays as an alias; the concept is renamed **screen contract** (the
  mechanism is generic: safe areas, tap targets, required objects, flow; nothing kids-specific).
  The `minigame` verb family keeps working; new docs and the unified report say "screens".
- **`verify --snapshot`** becomes the `feel` asset section. The flag stays as an alias for
  `--only feel`.
- **`trace replay`** stays as the low-level verb (it is also a dev tool); bare `verify` runs
  the same engine through the flow/pixels sections.
- **`verify --profile`** LEAVES the gating path. Since the grammar/taste split, archetype
  profiles are a diagnostic wedge (placement, advisory grading), and the snapshot owns the
  gating role for feel. Profile grading remains available (either the flag marked diagnostic,
  or a future `feel grade`), but it never contributes to bare `verify`'s verdict.
- **`doneness` stays separate and stricter.** It is the supervisor gate for builds Loombridge
  orchestrated, with runId binding, freshness, and hero-shot fidelity. Unification is about
  the ENTRY, not the verdict. `doneness` may later consume the unified report as one of its
  inputs (the drift report's `manifestSha256` is the reserved seam).

## Invariants (what "simple" must not erode)

Simplicity comes from auto-discovery and one report, NEVER from weakening gates:

- Refuse-on-absent everywhere: a broken or partial asset refuses (2); nothing silently skips.
- **A verify that checked nothing must never exit 0.** The motivating defect, observed live
  on a fresh project during the positioning review: today a planned-but-empty project gets
  a bare `verify` that exits 0 with every gate at `warn` and flips STATE to
  `verified-warn`, which an agent can quote as "verify passed" (only `doneness` refuses).
  S1's orchestrator replaces that with the on-ramp text and a non-zero exit when the plan
  resolves to zero runnable assets.
- The plan is printed before any live interaction; discovery is deterministic and auditable.
- Deterministic decides; model judgment (VLM, playtest bots, fun metrics) stays advisory and
  never enters the exit code. This constraint is stated at the pitch level so the future
  playtest tier inherits it.
- The human anchor is explicit: every asset row names WHEN and by WHAT it was approved.

## Extension seam (how this scales as a default OSS system)

A **gate provider** is the unit of extension: it takes (asset, live bridge) and returns tiered
report rows in the shared shape. Genre packs become providers instead of modes; third parties
can contribute providers without touching the front door. This is the Playwright/ESLint shape:
one runner, many checks, shared verdict semantics. The provider SDK is deliberately staged
LAST, once the internal providers have proven the row shape twice.

## Staged delivery

- **S1 (additive, no breaking changes):** unified report type + bare-`verify` orchestrator
  that discovers assets and delegates to the existing mode implementations. Empty-project
  on-ramp text. Plan-first output.
- **S2 (SHIPPED):** `--only` selectors; mode flags become deprecated aliases (stderr notice,
  the `design` -> `target` precedent); `--profile` explicitly marked diagnostic and CONFIRMED
  ABSENT from bare-verify's discovery (it was never a discovered asset, so there was nothing to
  remove: the audit is the deliverable); the `loombridge_verify` MCP tool routes through the
  orchestrator.
- **S3:** screen-contract rename in docs/report vocabulary (verbs stay aliased); README
  repositions around the one-command story.
- **S4 (later):** provider SDK, once a second external consumer exists.

Each stage lands with the standard bars: LITMUS-backed guards for the new discovery paths (a
planted broken asset must fail the plan), `npm run ci` green, live validation on at least one
consumer project.

### S1 delivery notes

S1 shipped as described, plus four things this RFC did not originally specify:

- **The checked-nothing refusal lives in the ENGINE, not the orchestrator.** `runVerify` derives
  "nothing graded" from the assembled report's own gates, never from directory emptiness, which
  closes the defect for the bare run, every `--inputs` form, and the `loombridge_verify` MCP tool
  at once. Directory emptiness is never used as a proxy anywhere.
- **A trace baseline manifest** (`baseline-manifest.json`, written by `trace approve`) binds
  `traceId`, `traceSha256`, `approvedAt`, `sourceReportSha256`, and per-frame shas. It is what
  lets the plan answer WHEN a pixel baseline was approved and FROM WHAT. Feel snapshots and
  screen-contract baselines gained an owning-`projectRoot` stamp for the same reason. An
  unstamped legacy anchor is a non-anchor row (never executed, never a pass), not tampering.
- **Two sanctioned replay tiering corrections**, recorded here as harness-fault enforcement
  rather than a change to gate semantics: replay `blocked` maps to exit 2 in both doors, and an
  unreadable actual or baseline PNG is `visualStatus: "unreadable"` plus a harness marker (exit
  2), never reported as pixel drift. A corrupt file is a capture gap, not a game defect.
- **A replay states its pixel-gate coverage, and a shortfall is exit 2.** The approved
  baseline manifest declares its own denominator (`pngs[]`), so a run records
  `comparisonsExpected` / `comparisonsPerformed` and `replayExitCode` refuses a run that
  graded fewer approved frames than the anchor declares. A capture the run left ungraded is
  written down as `visualStatus: "not-compared"` with a run-level `visualHarnessFaultReason`,
  never as an absent field: the observed false green was a report whose captures carried only
  `id, artifact, sha256, framesElapsed` beside `"status": "pass"`, under a rendered page that
  led with a green PASS badge. The rendered page states the tier the run earned, and the
  grade-time anchor check binds the baseline to the trace file being replayed, which the
  `trace replay` door previously left to the unified door alone.
- **Bare `verify` routes on a POSITIVE allowlist** (`--root`, `--strict`, `--live`, `--report`,
  `--id`, `--workspace`). Every other flag reaches the legacy paths exactly as before, and a
  guard test fails if a newly added flag is classified in neither direction. One declared tier
  change came with it: on BARE argv a malformed `ACCEPTANCE.json` is a broken contract ROW
  (tier 2) instead of a fatal, because the contract is one asset among several and a project
  with a good trace baseline should still get that trace checked. The engine path and the MCP
  tool keep the fatal tier.

- **The unified report is written to `.loombridge/run/reports/verify.json`** alongside the
  per-asset reports, and the screens section writes a verify-owned
  `.loombridge/run/reports/verify-screens.json` rather than the guided flow's workspace report.
  `--report <path>` overrides the first, resolved relative to `--root`, and is REFUSED when it
  would overwrite a project artifact or any file that is not a previous unified report.
- **`doneness` consumes the report** (the seam S1 originally left reserved). When
  `.loombridge/run/reports/verify.json` is present and its `exit` is non-zero, `doneness` adds a
  refusal on both its paths (whole-game and slice roll-up); an absent report changes nothing,
  and a malformed one refuses rather than being skipped. It is a REFUSE-ONLY input: a green
  report never adds certification, so it is not a laundering path.
- **A found game defect stays at exit 1**, however many anchors went unmeasured. The earlier
  cut raised a `fail` to 2 whenever a row could not be measured, which broke the promise that
  "2 is never a game verdict". Unmeasured anchors are reported as `notRun` rows and named in
  the summary; they do not change the tier of a defect that was actually found.
- **A screen contract runs only against an APPROVED layout baseline.** A contract and its
  capture pack are both producible in one agent session, so with no frozen third artifact the
  section would grade a document against captures of that same document and report `pass`. No
  stamped baseline manifest, no execution.
- **Sections declare `anchored`**, and the report carries `anchoredSections` /
  `unanchoredSections`, so "green" and "green against nothing a human froze" are
  distinguishable without reading prose. Report paths and shas are stamped ONLY when the run
  actually (re)wrote the per-asset report, so a refused section cannot inherit the previous
  run's evidence.

Documented limitations of the S1 shape, recorded rather than papered over:

- `runId` on the unified report is CONTEXTUAL, not an enforcement. It records which build was
  in flight; freshness enforcement (runId match plus the `producedAt` ordering) remains
  `doneness`'s job, and the stamp exists so the two documents can be cross-checked.
- The bare-run flag guard scans the `arg === "--x"` parser idiom that `verify.ts` uses today. A
  parser rewritten to a different idiom (a map, a `startsWith`, a library) would need the scan
  rewritten with it; the guard carries a LITMUS so a defused scan fails loudly rather than
  passing over an empty set.
- `verify.json` carries no self-integrity stamp and cannot: anyone who can edit the project can
  write one. That is precisely why `doneness` treats it as refuse-only input and never as a
  source of green.

Not in S1: `--only` selectors, mode-flag deprecation notices, and routing the
`loombridge_verify` MCP tool through the orchestrator. All three shipped in S2; the notes
below record how each landed.

### S2 delivery notes

S2 shipped the three items above, and the shape of each was decided by one question: what
would this let a run CLAIM that it did not measure?

- **`--only <sections>` is a SCOPED run, and scoping is a property of the report.** The
  vocabulary is the report's own section names (`contract`, `flow`, `feel`, `screens`,
  `tests`); the report carries `only: string[] | null` (REQUIRED, so "full run" is written
  down rather than inferred from an absent field) plus a `deselected` array of the healthy
  rows the selection excluded.
- **A BROKEN or unapproved asset refuses regardless of the selection.** Deselection may only
  ever remove a row whose `runnable` is not `no`; every broken / non-anchor / draft row stays
  in `notRun` with its tier. Otherwise `--only tests` would be a one-flag way to make a
  tampered feel snapshot stop counting, which is the precise opposite of what this product
  sells.
- **A scoped run's status ceiling is `partial`, and it never writes the full report.** It
  writes `.loombridge/run/reports/verify-scoped.json`; `verify.json` keeps meaning "the last time
  this project answered the whole question". `--report` pointing one at the other's path is
  refused in both directions, because both files carry `kind: "unified-verify"` and would
  otherwise pass the previous-report allowance.
- **Selector validation happens at the pre-discovery, pre-write position**, next to
  `--report`'s: an unknown name, an empty selection, and a value-less `--only` each refuse
  (exit 2) with the valid names, leaving any previous report untouched. A selection that
  matches no discovered asset is a `nothing-checked` run (exit 2) with the row-less reason
  named, never a green.
- **Two scoped exits are correct and deliberate**, and they differ only in what was found: a
  RED `--only tests` exits **1** (the executed tier short-circuits: a real assertion failure
  is a game defect whatever else was scoped out), while a GREEN `--only tests` exits **2**
  (FXH: the tests section is permanently unanchored, so nothing human-approved was compared).
  A green subset is not a smaller pass; it is a run that certified nothing.
- **`doneness` now requires a FULL green, not merely `exit: 0`** (the root fix, and it applies
  to both doors). `status !== "pass"` refuses with the reason naming what was partial: anchors
  skipped for lack of `--live`, sections that compared no frozen approval, or a scoping. This
  closes the whole overwrite family in one rule instead of special-casing each door: an
  offline run after a live drift, a scoped run after a full refusal, and the MCP tool's own
  offline write are all non-certificates by construction. Belt and braces: a `verify.json`
  whose `only` is non-null is refused outright, though a scoped run cannot write there.
- **…and the report has to be BOUND to what it certifies** (the S2 fix pass). A green roll-up
  said nothing about WHICH project, WHICH build, or WHEN, so five further refuse-only bindings
  joined the status rule: the report's `root` must be the root being certified (an absent
  `root` refuses with a re-run message, since the orchestrator has stamped it since S1); a
  `pass` must be internally consistent (nothing in `notRun`, nothing unanchored, nothing
  deselected, no scoping, every section at tier 0); a `verify-scoped.json` that POSTDATES
  `verify.json`, or that exists while no `verify.json` does, refuses; a `verify.json` that
  PREDATES `build-verdict.json` refuses; and with a build in flight the report must carry THAT
  `runId` (the FXC precedent: a `null` scope is an absent binding, not a free pass). Ordering
  prefers each document's own `producedAt` and falls back to mtime; an ordering that cannot be
  established at all is a refusal, never a skipped check.
- **The deprecated aliases print a short stderr notice each.** `--snapshot` and `--minigame` keep
  byte-identical behavior (stdout is unchanged with and without the notice) and point at
  `--only feel` / `--only screens`. `--profile` gets NO notice: it is a permanent diagnostic,
  not an alias. The notices are SUPPRESSED under `--quiet-next`, the guided flow's existing
  marker, so the guided mini-game run does not tell a human to abandon the flow they are
  standing in.
- **The `loombridge_verify` MCP tool routes through the orchestrator** (the S1 divergence,
  closed). It runs OFFLINE always and unscoped with default paths, so the agent-facing door
  and the human-facing door answer the same question and write the same document. The payload
  keeps every existing field and adds `unifiedStatus`, `unifiedExit`, `unanchoredSections`,
  and `reportPath`. Three rules make those fields honest: `refused` derives from the REPORT's
  exit rather than a stderr regex (a summary field that could be flipped by rewording a log
  line was never a summary); `verdictStatus`/`verdictExists` come from the contract section
  having a report binding stamped THIS run, so a skipped or refused section cannot quote a
  verdict an earlier run left behind; and a throw out of the orchestrator maps to tier 2,
  matching the CLI router. One declared tier change came with it: on the MCP path a malformed
  `ACCEPTANCE.json` is now a broken ROW (2) rather than a fatal (1), the same change the bare
  CLI argv took in S1.
- **The zero-asset on-ramp names the OTHER door.** When there is no `ACCEPTANCE.json`, the
  refusal adds a `loombridge plan` pointer: an agent that reaches "nothing to verify" while
  BUILDING a new game has arrived at door two by mistake, and telling it to record a
  demonstration of a game that does not exist yet is the wrong instruction.

RECORDED AS S3 SURFACE WORK (deliberately not in S2): the printed next-step sites across the
guided flows still name the mode flags rather than the unified door. The S2 note first put the
count at nine, which was a guess; the audited truth (every non-test occurrence of
`verify --minigame` / `verify --snapshot` that is PRINTED, rather than a code comment) is
**16 source sites**:

- `capabilities/minigame/minigame.ts` x4 (baseline refusal, baseline-enforced notice, the
  scaffold next-step, the init next-step)
- `capabilities/minigame/verify-minigame.ts` x2 (both remediation sentences)
- `capabilities/minigame/minigame-report-render.ts` x2 (the HTML command chip and the footer)
- `capabilities/minigame/minigame-declare-background.ts` x2 (the `--from-report` refusal and
  the printed re-run command)
- `capabilities/minigame/minigame-next.ts` (the resolved `verify` step of the guided flow)
- `capabilities/minigame/minigame-setup.ts` (the proven-verbs sentence)
- `capabilities/minigame/minigame-sync.ts` (the re-capture next step)
- `capabilities/feel/snapshot.ts` x2 (the approve-then-grade sentence and the printed drift
  gate)
- `surfaces/cli.ts` (the top-level verb summary)

plus **11 user-facing Markdown documents outside this RFC** (`README.md`, `ROADMAP.md`,
`ARCHITECTURE.md`, `commands/loombridge/verify.md`, `Docs/Design/Positioning.md`, and the six
`Docs/Profiles/` guides: `ExistingGameFeelVerification.md`, `MiniGameVerificationContract.md`,
`MiniGameVerifyCI.md`, `MiniGameVerifyQuickstart.md`, `TuningSnapshotVerification.md`,
`VerifyFirstEntry.md`), and one CI example workflow
(`Docs/Profiles/examples/minigame-verify.github-actions.yml`).

Rewriting them is a vocabulary change that belongs with the S3 screen-contract rename, and
doing it here would have meant editing 27 strings with no verdict-level guard behind them. The
count is recorded so the S3 estimate is a measurement rather than an impression; it is a scope
note, so no guard enforces it.

### Test-results delivery notes (the fifth asset kind)

- **Producer / consumer split. `verify` never spawns Unity.** `loombridge tests run` is the
  PRODUCER: it resolves the editor the project declares, spawns batchmode
  (`-runTests -testPlatform EditMode`), and stamps a binding manifest beside the NUnit3 XML.
  The unified door is the CONSUMER and grades those stored bytes offline. Bare `verify`
  therefore never launches a multi-minute editor, never takes the license seat, and never
  fights a domain reload. Running tests over the bridge is an explicit non-goal for this
  wave.
- **The slot is COMMITTED.** The stamped run lives at `.loombridge/tests/test-results.xml`,
  `.loombridge/tests/test-results-manifest.json`, and `.loombridge/tests/test-run.log`, and
  unlike `.loombridge/run/reports/` it is meant to be checked in: the stamped pair is evidence a
  reviewer can read without re-running an editor. The project template's `.gitignore` is
  guarded against ignoring it.
- **What the binding proves, exactly.** The provenance of THESE BYTES: produced by this tool,
  at this time, against this root, from this editor, under this command line. `runId` scopes
  them to a build when one was in flight, and when a build IS in flight the manifest must
  carry that build's id: a different id, or no id at all, is broken (tier 2), because an
  absent scope is a comparison that cannot be made rather than one that passed. With no build
  in flight either is accepted, and the section reports the `runId` it read (`null` included)
  so a reader can tell scoped evidence from unscoped. Staleness relative to source edits remains UNPROVEN:
  nothing here notices that a `.cs` file changed after the run. That is the same limitation
  already recorded for `runId` on this report, and it is documented rather than papered over.
- **PERMANENTLY unanchored, and that costs the run its `pass`.** No human approves a test
  suite, so the section reports `anchored: false` forever and `approvedAt`/`approvedBy` are
  never set. Which forced the general rule below.
- **`pass` now requires every executed section to be anchored.** An all-green run with any
  unanchored executed section is `partial`, and the summary names the unanchored sections.
  This is GENERAL, not a special case for tests: a contract graded without an approved design
  target also stops reading `pass`. A green deterministic result measured against nothing a
  human ever froze was the last place "agents grade their own homework" could still print as
  a full pass.
- **Exit 0 requires AT LEAST ONE anchored executed section.** Narrowing only the status word
  left the exit, which is the part an agent actually reads, unchanged: a project whose single
  asset was self-produced could still exit 0 having compared nothing frozen. So an all-green
  run with ZERO anchored sections is `partial` at exit **2**, with the summary line *nothing
  human-approved was compared; a self-produced green cannot exit 0*. It is the harness tier
  because "there was nothing here that could certify anything" is a statement about the
  evidence, not a defect in the game. A MIXED run is unaffected: one anchored green section
  still exits 0, with the unanchored extras named. The moat ceiling for a forged stamped test
  pair is therefore exit 2, not exit 0.
- **Presence is DECLARED, so deleting the evidence cannot silence the gate.** With no stamped
  pair but a project that declares tests (`Packages/manifest.json` `testables` non-empty, or
  an `Assets/**/*.asmdef` referencing the Test Runner by NAME or by Unity's well-known GUID),
  discovery emits a non-anchor
  row. A manifest with no XML is broken, not absent. Neither file and no declaration is no
  row at all: tests are opt-in.
- **The grader re-derives everything it is handed.** The XML must still hash to the stamped
  `resultsSha256` at grade time; the summary is re-derived from the test-case walk with the
  same function the producer stamped with, and a disagreement is tier 2; the manifest's
  assembly set must match the XML's; `compileErrors > 0`, `mutatedProject`, and an exit code
  the walk cannot account for each refuse. Failure detection is the UNION of the test-case
  walk and the suite/run roll-ups, and any disagreement between them is itself a refusal.
- **The exit-code rule is "unexplained by the walk", not "non-zero".** Unity exits 2 on
  genuine test failures. A blanket non-zero rule would reclassify every real red as a harness
  fault, which would mean this gate could never report an assertion defect at all. Exit 2
  with real walked failures is an honest tier 1; an unexplained 1/3/134, or a 2 from a file
  containing no failing case, is tier 2.
- **`tests grade` is DIAGNOSTIC and non-quotable.** It prints `DIAGNOSTIC: not a verification
  verdict` on every path and exits 0 only for a stamped, verifying pair that sits at the
  project its own manifest names (every sha survives a copy, so location is the last thing
  left to check: a moved pair exits 2 with *results are not at the project they claim*), or
  under `GITHUB_ACTIONS=true` (that exact value), where the trust root is the runner rather
  than the operator's shell. A manifest that is PRESENT and FAILS its own integrity is a third
  refusal in that same ordered group (*a stamped pair that does not verify*), checked before
  the attestation: see the test-results wave below for why leaving it to degrade into the
  unstamped path was a path to exit 0. That attestation is env-CLAIMED, not verified provenance, and
  the output says so. CI runs the verb over the GameCI artifacts so the CLI's mapping and
  CI's verdict cannot diverge, keeping the WORST tier across the graded files.
- **The on-ramp is deliberately UNCHANGED.** It stays the trace record/replay/approve
  sequence. It is the one place that names a human actor (the play session IS the approval
  moment), and offering a self-serve, unanchored asset there would convert a human-anchor
  on-ramp into a self-serve one.

### Drift-tolerance delivery notes (the ratchet wave)

Shipped after a live session in which a real, animating game replayed at ~1.3% pixel drift on
every capture: the gate was permanently red, so it was on its way to being ignored, which
protects nothing.

- **The allowance lives in the human-approved anchor, never in a runtime flag.**
  `baseline-manifest.json` gained an OPTIONAL `driftTolerance`. Absent resolves to the 0.5%
  default, which is why `schemaVersion` stays `"1"`: the omission fails safe, because a reader
  that never heard of the field grades STRICTLY. A field that could only tighten a comparison
  is the only kind that may be added without a version bump.
- **`trace approve` never takes a tolerance. `trace tolerance --id <id> --set <fraction>` is a
  separate verb.** This split is the load-bearing part. The natural design (`approve
  --drift-tolerance`) hands an operator staring at a drift failure ONE command that both widens
  the gate and re-freezes the drifted frames as the new truth: the anchor destroyed by the act
  of trying to keep it. The new verb touches no PNG and no sha, re-stamps `approvedAt`, and
  appends an approval ledger (`approvalCount`, `previousApprovedAt`, `previousDriftTolerance`)
  so a tolerance that ratchets upward one re-stamp at a time is visible on disk. `approve`
  preserves a stamped tolerance and prints it; it also refuses to promote a run carrying an
  unreadable capture, because a capture gap is a harness fault and never an anchor.
- **The cap is 0.02, enforced on BOTH sides by one constant, inside the one reader.**
  `loadTraceBaselineManifest` rejects an over-cap, negative, non-numeric or non-finite value as
  a typed error, so a hand-edited `0.9` makes the row BROKEN in the unified door rather than
  making the gate wider. 1% was rejected as the cap because it kills the measured real-world
  case, and a permanently red gate protects nothing. Exact `0` is valid (it demands pixel
  exactness); the comparison stays `fraction > tolerance`, so a value exactly equal to the
  tolerance passes.
- **MASKS ARE THE LOCALIZED FIX, and they shipped (the pixel-masks wave, below).** A tolerance
  is a hole of a stated size anywhere in the frame; a mask is a named region that is never
  graded again. Both are disclosed together, and every surface that prints a tolerance still
  prints its consent sentence: *at N%, anything covering up to ~sqrt(N)% of frame width by
  ~sqrt(N)% of height can change undetected*.
- **The baseline is re-verified AT GRADE TIME.** `applyVisualDiff` runs `verifyTraceBaseline`
  itself rather than trusting discovery's earlier plan (and the `trace` verb has no discovery
  step at all). A manifest that is malformed, over-cap, or no longer matches its frames is a
  harness fault for every capture, never a fall back to the default tolerance.
- **A drift names itself, and the suggestion names the right verb.** The flow line leads with
  `pixel-drift regression (exit 1): actuation passed, N capture(s) over tolerance, max X.X%`,
  carried in typed report fields rather than in the M5 `note`. A drift-ONLY failure prints the
  observed max and the exact `trace tolerance` command (never `trace approve`), with
  `min(cap, ceil3(max) + 0.002)` as the suggested value. It never fires for a harness fault.
- **A workspace that stamps this root but was not used is a plan NOTE, never an adoption.**
  The one carve-out to "an asset exists because an approve step wrote it": the scan reads at
  most two ownership stamps per workspace, at most 50 workspaces, emits routing text listing
  every match, and produces no `DiscoveredAsset`. Which `--id` an operator passes changes what
  is measured, so only the operator may choose it.

### Pixel-mask delivery notes (the phase-alignment wave)

Shipped after a live session twice-quantified the failure a tolerance structurally cannot
absorb: 1x pixel drift growing MONOTONICALLY from 2% to 8% from step 17 on (a cumulative
wall-clock phase desync of an ambient animation layer), and 17% at 2x pacing. The 2%
tolerance cap deliberately cannot absorb unbounded growth, so the region has to leave the
comparison or the gate stays permanently red.

- **A RESIZED GAME VIEW IS A HARNESS FAULT, NOT DRIFT.** `frameWidth`/`frameHeight` began as
  the masks' denominator and were stamped only when masks existed, which reads backwards:
  masks NEED the size, every baseline HAS one. So an unmasked anchor recorded no resolution,
  and resizing the Game view between `approve` and `replay` surfaced as `diffFraction: 1`,
  `visualStatus: "drift"` at the GAME tier (exit 1 under the unified door's `strictVisual`,
  exit 0 on the bare `trace replay`), with nothing anywhere naming the window. Observed live
  on a consumer project. `comparePerceptual` had ALWAYS returned `dimensionsMatch: false` for
  this; nothing on the replay path read it, so the one fact separating "the game changed"
  from "the window changed" was discarded a line after it was derived. Two changes: every
  `approve` stamps the decoded resolution, and `applyVisualDiff` reads `dimensionsMatch` and
  tiers it as a HARNESS fault naming both resolutions. It was never a false green (a
  cross-resolution comparison cannot be laundered into a pass); it was the wrong tier and an
  unactionable message. The refusal is deliberate and there is no opt-out: two frames of
  different sizes share no pixels, so there is no honest verdict between refusing and lying.
  The way forward for a free-aspect project is the newly stamped number: RESTORE the Game
  view's ASPECT to the approved frames' (the anchor is untouched, no new consent is minted,
  the next run is green), with re-approving named second because it mints an anchor from
  frames nothing compared. The capture-level `harnessFault` is deliberately NOT set, so
  `approve` stays available: it is the escape hatch the refusal itself points at. An anchor
  with no stamped size keeps working unchanged, because the grade-time check measures DECODED
  frames and needs no field to be present.
- **AND A TRACE DELIBERATELY RECORDS NO RESOLUTION, which the first pass got wrong.** That
  pass also had `trace record` stamp the live Game view size onto the trace as `viewport` and
  compare it, pre-drive, against the anchor's stamped frame size. On a healthy consumer
  project the note fired on EVERY run: *"recorded at 1280x720 but its approved frames are
  1024x576 … set the Game view to 1024x576 first"*, with nothing resized. THE TWO NUMBERS ARE
  NOT THE SAME MEASUREMENT. `ui.get_screen_rects` reports the Game view WINDOW
  (`Handles.GetMainGameViewSize()`); a capture is the game camera rendered into an offscreen
  RenderTexture at the screenshot op's capture width and that window's ASPECT
  (`ScreenshotCapture`: `width = maxWidth; height = round(width / aspect)`), so the frames
  were 1024x576 in every run and every baseline. The stamp, its parser branch and its one
  reader are gone: with the comparison removed the field had no reader at all, and a
  machine-written field that reads as wired is this repo's most expensive recurring shape.
  The real gate was never involved and never wrong (it compares decoded bytes on both sides
  and stayed silent), so this was a false WARNING, never a false verdict. Nine
  LITMUS-verified tests shipped with the note and none caught it, for one reason: every
  fixture used the SAME NUMBER for the window size and the frame size. The guard that
  replaces the note holds them apart (`replay-capture-resolution.test.ts` §6), and the
  operator-facing resize prose now names the approved size as a FRAME size to restore the
  ASPECT to, never as a window size to type in. There is no proxy for the frame size
  available before the first capture is decoded: a replay learns its own resolution by taking
  a frame.
- **The mask is part of the ANCHOR.** `baseline-manifest.json` gained `maskRects`
  (`{ captureId?, x, y, w, h, reason }`) plus the `frameWidth`/`frameHeight` the rects were
  measured against, stamped by a new verb, `trace mask`, that mirrors `trace tolerance`
  exactly: it refuses without an approved baseline, touches no PNG and no sha, re-stamps
  `approvedAt`, and appends to the same approval ledger. An absent `maskRects` means no
  masks, which is the strictest value the field can hold, so `schemaVersion` stays `"1"`.
- **BLANKING, not exclusion from the denominator.** `comparePerceptual` paints the rects
  opaque black in BOTH images before the diff (the operation lifted out of
  `minigame-baseline.ts`, now shared), so a masked region cannot differ, while
  `diffFraction` keeps dividing by the FULL frame. Re-scaling the denominator instead would
  silently widen every tolerance a human already consented to: 1.5% of what was left is a
  bigger hole than the 1.5% of the frame they approved. `maskedFraction` is recorded per
  capture and per run so the blindness is stated rather than inferred.
- **The cap is 0.10 PER FRAME, enforced on both sides by one predicate.** `maskRefusal` is
  called by the stamp verb and by `loadTraceBaselineManifest`, so a hand-edited full-frame
  mask makes the row BROKEN in the unified door rather than making the gate vacuous. It is
  per frame, not per list: a trace-wide rect and a capture-scoped one are measured together
  for the capture they both cover. Overlaps count once (exact union area), so a duplicate is
  not charged twice. It REFUSES when `frameWidth`/`frameHeight` are absent: with no
  denominator the cap cannot be computed, and an unmeasurable mask is not an approved one.
- **Every rect carries a mandatory `@reason`, and `--set` restates the WHOLE list.** A
  `--add` that appended would make each stamp a local edit to a set nobody was re-reading,
  which is how a mask grows to cover the frame one reasonable-looking rect at a time. The
  ledger records `previousMaskRects` and an append-only `maskedFractionHistory`, and the
  stamp prints the transition (*masked 0% to 4%*).
- **`approve` preserves masks and REFUSES the re-freeze at a CHANGED RESOLUTION.** Dropping
  the masks would un-blind a region a human excused (and the next replay would suggest
  masking it again); keeping them would re-interpret a human decision against frames they
  never saw, and the re-interpretation is silent even when the rects still LAND on the new
  frame: the same 20x20 rect hides 4% of a 100x100 frame and 1% of a 200x200 one, so a
  re-freeze at a new resolution would move both the blindness and every number printed about
  it with no event anywhere saying so. Any difference from the stamped
  `frameWidth`/`frameHeight` therefore refuses and names `trace mask`. At UNCHANGED
  dimensions the approve appends the (unchanged) fraction to `maskedFractionHistory`, so the
  history is one entry per approval EVENT rather than only per mask stamp. A dims mismatch at
  GRADE time is the same shape: a manifest-level `baselineFault` on the pacing precedent,
  captures left ungraded, never a per-capture `unreadable`.
- **The stamped denominator is checked against a real frame.** `verifyTraceBaseline` decodes
  ONE declared PNG and cross-checks `frameWidth`/`frameHeight` whenever they are stamped, so
  every PRE-RUN surface (the plan's `anchor terms:` line, `mask --list`, discovery's typed
  `maskedFraction`) quotes a fraction measured against a denominator something verified.
  Without it the dimensions were self-asserted until grade time, and inflating them by hand
  printed a 40% mask as 4%. `mask --list` runs the verifier first and REFUSES to quote the
  terms of an anchor that fails it. The check was originally gated on masks being present,
  because masks were the only reason a size was stamped; it now fires on any stamped size,
  because that size is quoted to operators as the resolution to restore the Game view to.
- **A mask is never suggested from ONE run, and reproduction is STRUCTURAL.** Each drifted
  capture records `driftDiffSha` (sha256 of the drift bitmap), `driftBounds` and `driftGrid`
  (a 16x16 grid of drifted-pixel counts). Sha equality alone was the wrong bar: flipping ONE
  extra pixel between two runs defeats it, so a real regression could be re-run until the
  shas differed and the tool would start recommending a mask for the bug. The bar is now
  `sum(min(a,b)) / max(sum a, sum b) >= 0.95` on the two runs' grids, which one pixel of
  jitter cannot move, and it fails SAFE (over-refusing withholds a suggestion; the operator
  can still stamp a mask by hand). The suggestion fires only when a previous report exists,
  both runs drifted in SHARED GRID CELLS (not merely overlapping bounding boxes, which one
  distant speck could stretch across the frame), and the drift does not reproduce. A
  reproduced drift prints *the drift is IDENTICAL across two runs: that is a deterministic
  change, not ambient noise; investigate before masking* (or, for the sub-exact case, *at
  least 95% of the drifted pixels reproduce across two runs:* + the same warning) -- the line
  that stops the feature from erasing the regressions it was built next to. A first run asks
  for a second. Rects come from connected components clustered to at most 3 boxes, refused
  unless the AGGREGATE UNION of the surviving boxes is tight (drifted pixels / union area
  >= 0.6, measured on the SET rather than per rect: three individually-dense rects say
  nothing about the empty space a merge swallowed, and the union is what a mask actually
  spends) and under the cap. The refusal NAMES which bound broke, in three distinct
  sentences: *one region of X%, above the 10% cap*, *more than 64 separate components*, or
  *only X% drifted pixels, under the 60% tightness bar*. The suggested command RESTATES the
  currently stamped rects first, because `--set` replaces the whole list and a command naming
  only the new rect would delete every mask already approved. Nothing is ever auto-applied,
  and the suggested reason is a placeholder the human must replace.
- **One combined consent sentence, with the arithmetic done.** `anchorTermsSentence` prints
  masks and tolerance together (*N mask(s) hide X% of every frame outright; the rest grades at
  Z%, ...; together, up to (X+Z)% of the frame can change while the gate stays green*) at both
  stamp verbs, on the plan's own `anchor terms:` line, in the replay summary and in the HTML
  report header, which also draws the rects on the thumbnails. Two allowances described in
  two places are two allowances nobody adds up, and stating both halves without the sum is
  the truth twice and the answer zero times. The per-asset detail in the unified summary
  carries the qualifier on the GREEN branch too (*demo=pass (8% masked)*): a pass measured
  with 8% of every frame blanked is a weaker claim than a pass, and that is the branch a
  reader acts on. The HTML header's tolerance falls back to the ANCHOR's stamped value
  exactly as the masks do, so an ungraded run (a pacing refusal) states the real terms rather
  than the stricter default.
- **The ledger has a reader.** `mask --list` prints the rect list, the combined consent
  sentence, `previousMaskRects` (*previously: `<rects>` at `<ts>`*) and the fraction history.
  `maskedFractionHistory` is validated against `[0, 1]` and deliberately NOT against the live
  cap: it is history, never enforcement, and binding it to `MAX_MASKED_FRACTION` would mean
  that lowering the cap later retroactively bricked every anchor whose past stamps were legal
  when they were made. A cap change must refuse the next stamp, never un-read the previous
  ones. A `--set` that DROPS a rect names it (*2 mask(s) REMOVED: ...*) and the count line
  reads *2 to 2 mask(s) (2 removed, 2 added)* rather than as no-change.
- **The honest limit is recorded.** Masks fix LOCALIZED nondeterminism only. Full-frame or
  diffuse nondeterminism (particle storms, full-screen shaders) stays red, and clock
  alignment (the wave below) is the path for the PHASE half of it.

### Capture-aligned settle delivery notes (the clock wave)

Shipped against the measurement the mask wave left behind: drift that GROWS monotonically
across a run is a phase desync, not a regression, and no tolerance or mask can honestly
absorb an unbounded one. This wave removes the largest source of that phase noise, and
deliberately removes only that one.

- **THE DRIFT TAXONOMY, which is what decides the lever.** *Phase* drift (the same content,
  captured at a different animation time) is what clock alignment fixes. *Localized* drift (a
  region that is genuinely nondeterministic) is what masks fix. *Diffuse seed- or
  realtime-driven* drift (unseeded `Random`, `realtimeSinceStartup`, `DateTime`) is fixed by
  neither: the levers there are a tolerance, or seeding the game. Naming the three is the
  point of the taxonomy: each previous wave shipped one lever, and an operator reaching for
  the wrong one either blinds a gate or leaves it permanently red.
- **The settle is the aligned window, and ONLY the settle.** A new bridge op,
  `replay.settle_and_capture`, advances exactly N player-loop frames with
  `Time.captureDeltaTime` pinned to `1/fps` and takes the screenshot IN-LOOP on the frame the
  settle completes (the `runtime.capture_sequence` precedent), with the `editor.tick` pin
  idiom for restore and eager interrupts. The wall-clock pair it replaces (sleep here, then
  `editor.screenshot`) let the game free-run for an unknown number of frames between the two
  calls, which is exactly how a monotonic phase desync accumulates.
- **A missed settle is an ERROR, never a degraded frame.** The op's wall budget
  (`settleFrames/fps + 8s`, checked every tick) returns no image at all: a frame at an unknown
  game time is not comparable evidence, and returning one would let a starved editor read as
  pixel drift. The driver records it as a capture-tier harness fault (exit 2), and the run
  never grades it. The driver also states its own wire timeout (`+15s`) so the BRIDGE's
  deadline is the one that decides, not an anonymous transport timeout.
- **The clock discipline is part of the ANCHOR**, the pacing precedent exactly:
  `baseline-manifest.json` gained an OPTIONAL `alignedCaptureFps` (integer, [10, 120]),
  carried by `tolerance`/`mask`, re-derived by `approve` from the report it freezes, and
  range-checked by the one reader. Absent means the legacy wall-clock settle, so every
  existing manifest keeps meaning what it meant, and a MISMATCH between the anchor's
  discipline and the run's refuses the pixel comparison as a harness fault rather than
  grading frames that sit at different phases.
- **`baselineFault` accumulates.** It was a single slot, so the last check to run overwrote
  the earlier ones and an operator fixed one fault, re-ran, and met the next. Every reason an
  anchor cannot be trusted is now collected and printed together.
- **The physics cadence is an ADVISORY, never a refusal.** When `1/fps` does not sit on a
  whole number of physics steps, the run prints *physics steps N times every M frames at this
  fps; feel-sensitive traces may differ from the recording*, computed from the project's real
  `Time.fixedDeltaTime` (the op returns it), never from an assumed 0.02. Refusing would block
  a trade-off the operator is entitled to make; silence would let a changed cadence read as
  drift.
- **THE HONEST RESIDUAL is printed with every aligned drift.** Alignment covers the settle;
  the action round trips and the 150ms anchor polling are still wall-clock windows. So drift
  that survives an aligned run is *consistent with* those windows or with seed/realtime
  binding, and is never proof of either. The line says so, because "we pinned the clock and it
  still moved" is the strongest available over-reading of this feature.
- **Every side-effecting input op the replay driver sends is now non-idempotent.**
  `input.pointer_tap`, `input.pointer_tap_world`, `key_tap`, `key_down`, `key_up` and
  `replay.settle_and_capture` joined `ui.dispatch_pointer` in the set the resilient send
  refuses to retry: a retried tap is a phantom second press, and a retried settle advances
  game time twice while the report claims one settle. The scope is deliberate. It is not
  "every input op" (a read-only `input.observe_start` is safely retryable and belongs
  nowhere near this list), and it is not only the ops enumerated on the day: the world-space
  tap is `pointer_tap` one camera projection earlier, so listing one and not the other left
  the identical phantom press reachable through the other door.
- **A focus loss is BLOCKED, not a game defect.** `FOCUS_REQUIRED` maps to a new blocked
  reason, `focus-lost`, and the replay driver now opens the input SESSION before a world tap
  (the session's backend applies, and owns restoring, the focus-independent InputSystem
  settings that let an unfocused tap land at all). A blocked segment also captures nothing:
  its state was never reached, so its screen is not the evidence its capture id names.

### Absent-family delivery notes (the coverage wave)

Shipped against a live confusion. A human ran `verify --live` on a real project, got a verdict
covering exactly one asset (a replay trace), and asked why the safe-area checks they used to
see were missing. Verify was right: those checks belong to the screen-contract family, that
project has no screen contract, so none of them ran. But the output never said so, and
"those passed", "those do not exist here" and "those silently did not run" printed
identically. A door whose whole claim is that a verdict states what it established cannot
be silent about what it did not.

- **Every known family is named, every run, by default.** One line per family with no asset:
  what it would have covered, and the command that creates one. No flag: an opt-in coverage
  report is a coverage report nobody reads at the moment they are being misled.
- **DERIVED, NEVER HAND-LISTED.** `ASSET_KIND_CATALOG` is now the single declaration of a
  kind, carrying its prose, and `ASSET_KINDS` is derived from it. A second list of kinds
  inside the reporting code is exactly the drift that would leave a seventh kind absent from
  the report about absences, which is the failure mode this repo keeps paying for.
- **INFORMATIONAL, and structurally so.** `absentFamilies` is a distinct type from both
  `DiscoveredAsset` and `UnifiedNotRun` (the two that carry tiers), it is not an input to
  `resolveUnifiedOutcome`, and no status word or exit code is derived from it. Naming a gap
  is the opposite of covering it, and the zero-asset refusal (`nothing-checked`, exit 2,
  no report written) is untouched. A test re-derives the recorded outcome from executed +
  notRun alone, so folding gaps into the calculus in either direction fails.
- **The workspace-scoped families name the DIRECTORY they were searched in.** The workspace
  id is derived from the project's folder name, so "no screen contract" and "no screen
  contract under the id this folder name derives" are different sentences. This is the cheap
  half of the keying problem; the A5 routing note remains the half that names the other id
  when some workspace on the machine stamps this root.
- **The same gaps ride in `verify.json` and the `loombridge_verify` MCP payload**, so a CI
  consumer and an agent see what the human saw rather than having to regex stderr.

### And it moved once more: THE EVIDENCE ITSELF (the test-results wave)

The audit's last cluster, and the first one where the attack was not on a gate's predicate but
on the **document the predicate reads**. The waves below all made a gate compare more; this one
is about a document that lies about what it contains, and a manifest whose own failure was the
thing that silenced it. All three were demonstrated end to end against the real verb and all
three are closed here.

- **H1: a manifest that FAILS integrity degraded to "unstamped", and CI attestation then passed
  it.** `gradeStoredResults` set a note on `!integrity.ok` and left `stamped = false`,
  `integrityManifest = undefined`, so control reached the `GITHUB_ACTIONS` branch and returned 0.
  Because the five producer bindings were optional fields read off that same `undefined`, ONE
  failed sha silenced all five at once. Demonstrated with a manifest declaring `exitCode: 3`,
  `compileErrors: 42`, `mutatedProject: true`, `summary: 999 passed` and a wrong assembly list,
  beside a green two-case XML: **all five refusals present on disk, none reached the grader, exit
  0.** The ordering precedent was already in the file and pointed the right way: the misplaced-pair
  check runs BEFORE the attestation because a moved pair is "a positive signal of tampering, not
  merely an absence of provenance". A sha mismatch is the same class of signal, and is now ordered
  there too. CI is untouched: the workflow grades bare GameCI XMLs, which have no manifest at all.
  **CORRECTED BY H5 BELOW, and the sentence above claimed more than it bought:** locally both
  shapes already exited 2, so H1's ONLY behavioural change is inside the `GITHUB_ACTIONS` branch,
  and that is precisely where the cheaper bypass landed. H1 refuses a manifest that is present
  and failing; it said nothing about an ABSENT one, and `rm test-results-manifest.json` reached
  exit 0 over the identical green bytes. H1's real value is against accidental tampering plus a
  much better message. The bypass is closed by H5.
- **H2: omitting one XML attribute disabled the roll-up cross-check.** `runAttrSummary` was `null`
  whenever `<test-run total>` was absent, and the only comparison drawn from it was `failed > 0`.
  So `<test-run result="Passed" passed="1" failed="3">` with one passing case graded tier 0, and
  so did `total="500" passed="499"` with one passing case, because `failed="0"` was honest and
  nothing else was read. The module's own docstring promised "the verdict is the UNION of the two
  readings, and any DISAGREEMENT between them is itself a refusal". That is now true: every count a
  roll-up DECLARES is held against the cases walked beneath it, on `<test-run>` **and on every
  `<test-suite>`**, so hiding a case means scrubbing the roll-up of every ancestor rather than
  deleting one attribute. Only declared counts are compared, because an older writer that omits
  `total` is stating no fact rather than claiming zero. `total` is the one asymmetric count
  (over-claiming refuses, under-claiming is a note) and the asymmetry is calibrated to the writer
  convention this file already documents: a Warning case lands in `total` and in no other bucket.
- **H3: the grader skipped all five producer bindings on absence, with the refusal delegated to
  the call sites.** Judged intentional by the audit (a bare CI XML is a supported input) but
  argued against by the file's own comment two screens above the guards: *a rule enforced by one
  door is a rule the other doors do not have.* It is also what made H1 reachable at all. **Decided
  the other way**: the bindings are MANDATORY at the grader as a required discriminated
  `attribution` (`producer` | `stamped` | `unattributed`), the `stamped` shape owes all five facts
  by type, and the bare-XML case is an explicit NAMED opt-in carrying the reason it is
  unattributed. The compiler now refuses a call site that omits what its shape owes, `tests grade`
  prints the attribution on every path, and a source guard walks `src/` for callers so a FOURTH
  door cannot appear silently.

**Whether each new bound is recomputable, or one more value the attacker can write:**

- **H1: RECOMPUTABLE.** The refusal reads `verifyTestResults`, which re-hashes the XML on disk
  and compares against the stamped `resultsSha256`. The attacker cannot both edit the results and
  keep the pair verifying without also rewriting the manifest, which is the point: it makes the
  two files have to lie in agreement instead of one failure hiding the other.
- **H2: RECOMPUTABLE, and the strongest of the three.** The denominator is the walk of the
  document being graded, by the same reader that produced the roll-up, so the two numbers come
  from one pass over one byte stream. ~~There is no field to delete that buys silence at one level
  without contradicting the level above it.~~ **WRONG, and F4 below disproves it**: `testcasecount`
  is written by real Unity on `<test-run>` and on every `<test-suite>`, was in no closed set, and
  was read by nothing, so a document declaring `testcasecount="500"` over one walked case graded
  tier 0 with the report silent about the other 499. It is read now, as a NOTE. The deeper point
  the sentence missed is that all of H2 is a document held against ITSELF: one byte stream, one
  reader, one author. That is what H4 addresses.
- **H3: NOT a bound, and stated as such.** Attribution is a discipline on CALLERS, not a fact
  about bytes: it makes omission impossible and the bare-XML case explicit. What it buys is that
  H1's shape (a manifest present, its facts silently `undefined`) is no longer expressible.

#### Known-open after this wave

- **Nothing binds the stamped pair to a real Unity run.** `resultsSha256` binds the XML to the
  manifest and H1 makes that binding load-bearing, but both files are written by the thing being
  graded: a self-consistent forged pair still grades as `stamped`. **DEMONSTRATED AND PARTLY
  CLOSED by H4 below**, which ships exactly the candidate this bullet named.
- **Deleting a roll-up entirely is still cheaper than lying in it.** H2 compares what is declared;
  a document with every count attribute stripped from `<test-run>` and every `<test-suite>` has
  nothing left to disagree with. For a STAMPED pair the manifest's `summary` and `assemblies`
  cross-checks still bind it. For a bare CI XML nothing does, which is the same gap as the bullet
  above and narrows with it (H4 refuses a document that declares no assembly suite at all).
- **The suite cross-check is capped at five named refusals.** A single deleted case disagrees with
  every ancestor, so the cap is about readability; the tier is unaffected.

### And it moved once more, INSIDE the pair: SELF-CONSISTENT FORGERY

The wave above strengthened the internal consistency of two files, and an adversarial review
found the flaw that leaves: **none of H1, H2 or H3 adds a fact from outside the pair.** H2's two
readings both come from the graded byte stream. H3 is a discipline on callers. H1's re-hash is
computed by whoever wrote the bytes. So one self-consistent forgery satisfies all three at once,
and the reviewer flipped the test-results section from `fail`/exit 1 to `pass (unanchored)`/exit 0
with a thirty-line script, no Unity, and `createHash` for the sha. Three more findings came with
it. All four are demonstrated end to end and closed here.

- **H4: the one fact from OUTSIDE the pair.** `projectTestSurface` reads the assemblies the
  PROJECT declares (`Packages/manifest.json` `testables`, resolved the three ways Unity resolves
  them, plus every Test-Runner `.asmdef` under `Assets/`) and the XML's assembly set is held
  against it at every door, as a REQUIRED discriminated input for the same reason H3's attribution
  is: an optional field is the field the next door forgets. The previous wave named this candidate
  and deferred it over false-failure surface; the surface is real and the split is made
  deliberately rather than by taking the strictest reading. **REFUSALS**: the walk names no
  assembly suite at all (the cheapest evasion of everything else, and the "delete the denominator"
  shape the screens and feel waves already closed twice); and no assembly the walk names is one
  the project declares, on a COMPLETE surface only. **NOTES**: a declared assembly the walk does
  not contain (the direction that would catch a whole failing assembly being hidden, and the
  direction where a platform-excluded or test-free asmdef is a legitimate absence); an assembly
  the walk names that the project does not declare (predefined assemblies land here honestly); and
  a `none` or `unknown` surface, because a project with no declared test surface and a bare CI XML
  with no project at all are both supported inputs. The false-failure bar is met on REAL bytes:
  the committed real Unity document's assembly set equals, exactly and both ways, what this
  repository's own `unity-dev-project` declares through its `file:` testable.
- **H5: DELETING the manifest was cheaper than failing it.** H1 refuses a manifest that is present
  and failing and says nothing about an absent one. With an honest failing manifest on disk
  (`exitCode: 3`, `compileErrors: 42`, `mutatedProject: true`) `tests grade` exits 2 under
  `GITHUB_ACTIONS=true`; `rm test-results-manifest.json` and the IDENTICAL green bytes exited 0
  through the CI attestation. Since locally both already exited 2, that branch is the ONLY place
  H1 changed behaviour, which is exactly where deletion landed. The attestation now distinguishes
  "nobody stamped this" from "the stamp was taken away", by POSITION rather than provenance:
  results sitting in a project's own `.loombridge/tests/` slot, in a project that DECLARES tests,
  with no manifest beside them. CI is unaffected for a checkable reason rather than an asserted
  one: the workflow grades `unity-test-results/<label>/*.xml`, which inverts to no project root at
  all.
- **H6: `TAMPERED_REFUSAL` was ordered behind a tier gate.** `if (grade.tier !== 0) return
  grade.tier` ran before the tampered and misplaced checks, so a tampered manifest over an XML
  that ALSO graded red returned tier 1: a game-defect verdict for evidence nobody can trust,
  firing only when the mapping happened to come out green. Never a false pass, but a positive
  signal of tampering conditional on the attacker's luck, and the same shape H1 fixed one level
  up. Both are ordered before the tier gate now. H5 is deliberately ordered AFTER it, because
  unlike tampering an ABSENCE cannot tell "the manifest was removed" from "`tests run` never ran
  here", and an honest red in that slot is still an honest red.
- **The fourth-door guard was one `as` keyword wide.** H3's whole "a fourth door cannot appear"
  claim rested on a scan for `/\bgradeTestResults\(/`, which is blind to
  `import { gradeTestResults as gradeIt }`, to `const g = gradeTestResults; g(…)`, and to a
  namespace import. A real aliased fourth door was planted on disk, grading an unattributed walk,
  and the guard file reported `tests 4 / pass 4 / fail 0`. The scan resolves the IMPORT now, which
  aliasing cannot hide (`import { X as y }` still contains `X`), and refuses outright the three
  shapes that would launder the name out of an import clause: a namespace import, a re-export, and
  a dynamic import. The old LITMUS did not cover the bug it claimed to, because it drove
  `deepEqual` over a hand-made list rather than the scanner; the scanner now takes its source root
  as a parameter so the LITMUS points the SHIPPING function at planted trees.

**Whether each new bound is recomputable, or one more value the attacker can write:**

- **H4: RECOMPUTABLE, and the first bound in this area that is not written by the run.** The
  denominator is `.asmdef` and `Packages/manifest.json` files authored by the GAME, walked by the
  same code path that reads them. **What it does not buy, stated plainly:** the declared surface
  is READABLE, so a forger who opens one asmdef can name a real assembly and pass. It raises the
  cost from "invent two files" to "invent two files that agree with a third the run did not
  write", and it makes a project with no test surface impossible to forge INTO having tests
  without also editing the game. A forger who additionally edits `Packages/manifest.json` to add
  an unresolvable testable can downgrade the disjointness refusal to a note, which is an edit to
  the build input rather than to the evidence.
- **H5: NOT a bound, and stated as such.** It is a POSITION rule: `.loombridge/tests/` is the one
  directory `tests run` writes and `projectRootForTestResultsDir` inverts that path exactly. What
  it buys is that deleting the stamp is no longer cheaper than failing it.
- **H6: an ORDERING, not a bound.** It buys that a harness fault is never reported as a game
  defect, whatever the mapping happens to say.
- **The door scan: a source guard, and it can only see module bindings.** A door that obtains the
  function without one (via `globalThis`, `eval`, or a compiled artifact) is invisible to it. The
  honest close remains the TYPE, which no door can satisfy without stating both an attribution and
  a surface.

#### Known-open after this wave

- **The assembly set is not the CASE set.** A forger who names a real declared assembly can still
  invent its contents, and H4 says nothing about them. The next honest denominator is the
  project's own test SOURCES: the `[Test]`/`[UnityTest]` methods under each test asmdef are
  authored by the game and are what a real run must have executed. It is not shipped here because
  reading them means parsing C# well enough to survive parameterized cases, `[TestCase]`, nested
  classes and source-generated names, and a mapping that guesses wrong reds out an honest project.
  That is a wave of its own, not a line in this one.
- **`none` and `unknown` surfaces are notes, and a project can be edited into `none`.** Deleting a
  game's test asmdefs would take a project from `declared` to `none` and drop H4 to a note. That
  is a visible edit to the game rather than to the evidence, and refusing it would red out every
  project that keeps its EditMode tests in the predefined assemblies, which is a legal Unity
  shape. Named here rather than closed.
- **H5 cannot fire on a bare XML outside a declared slot**, by construction, which is what keeps
  CI working and is also the shape a forger would choose if they controlled the path. `verify`
  never reads such a file (discovery only looks at the slot), so this is scoped to `tests grade`,
  which prints "not a verification verdict" on every path.

### Comparison-counting delivery notes (the denominator wave)

An audit found eight confirmed paths to exit 0 with nothing actually compared. They were one
bug with one shape: **a gate that reports its per-item verdicts and never counts them against
what the anchor declared.** "No verdict about item X" then prints identically to "no problem
with item X". The replay pixel gate was fixed first and in isolation; this wave promotes that
fix to a rule every gate reads.

- **The contract is shared vocabulary** (`domain/comparison-coverage.ts`): `expected`,
  `performed`, `ungraded`, plus `comparisonShortfall` / `anchoredByComparison`. It lives in
  `domain/` because four capabilities (replay, minigame, feel, verification) each need it and
  none of them may import another. That predicate is now the whole of the "compared nothing"
  guarantee, in one place rather than four.
- **Every anchor already declares its own denominator**, so none had to be invented: a trace
  baseline's `manifest.pngs`, a screen contract's `states[]`, a feel snapshot's
  `manifest.metrics`, a slice verdict's `sliceEvidenceFiles(acceptance.gates)`.
- **The refusal reads the NUMBERS, never a boolean beside them.** A gate writes its harness
  flag and its counts in the same statement, so they agree in any report this tool produced;
  the counts are what matter for a report it did NOT produce. Deleting a flag from a
  hand-edited verdict cannot launder a shortfall. An absent numerator reads as ZERO; an absent
  DENOMINATOR is "no anchor", which is a different statement and is never a pass either.
- **A shortfall refuses at the harness tier (2), naming the shortfall PER ITEM.** A gate that
  could not run is not evidence the game is broken.
- **Two counting holes closed.** (1) The screen contract: a state whose rects loaded and whose
  PNG did not fell between the two absence predicates (`captureAbsent` watches the rects, the
  baseline loader refuses on either file) and reached exit 0 over a ~50% pixel diff against
  the approved anchor. (2) The evidence ledger: `readEvidenceLedger` refused an ABSENT
  `evidence` block but accepted `files: []`, and the re-hash loop iterates `files`, so trimming
  a ledger from 4 entries to 0 took a mutated slice from `exit 2 / refused` to
  `exit 0 / pass / anchored: true`. The rule that module documents was implemented for the
  block and not for its contents. Moving the names into `missing` instead of deleting them
  refuses too, or `missing` would simply become the next hiding place.
- **`anchored` now means "this run compared something a human froze", derived from the run.**
  `resolveUnifiedOutcome` was always sound; its INPUTS lied. Five of six sections derived
  `anchored` from DISCOVERY (`traces.length > 0`, `asset.approvedAt !== undefined`) or from
  parsing (`baseline.present`, set the moment a manifest parses). Discovery's opinion is a
  PLAN, not evidence: it says an anchor existed when the row was classified, never that a
  comparison happened against it. Flow, screens and feel now read their own run's counts; the
  contract section additionally requires that THIS run wrote the verdict and that the verdict
  names at least one graded gate. `tests` stays permanently unanchored, and `slices` already
  derived from the run.

### And then it moved again: PRESENT BUT VACUOUS

An adversarial review of the refuse-on-absent wave found the same shape one step to the right.
Every predicate that wave added asks whether the bound input is THERE and is the RIGHT TYPE.
None of them asks whether the value it holds still CONSTRAINS anything. So the identical false
green was reachable by supplying a legal value that means nothing: a tolerance of `1e6`, a
design target downgraded rather than deleted, a gate list shrunk rather than a manifest emptied,
a list entry dropped rather than a field blanked. Four were demonstrated end to end against the
real engines and all four are closed here.

**The rule this wave applies everywhere:** a bound value needs a RECOMPUTABLE BOUND, not just a
type. That is the counting wave's rule (an `expected` must be recomputable from artifacts on
disk) turned on the values themselves.

- **A2: the tolerance was bounded for type and never for magnitude.** `tolerancePolicyRefusals`
  accepted any finite `>= 0`, and there was no upper bound at all. The same +99996 drift that
  exits 1 under the intact policy exited 0 under `defaultRelPct: 1e6`, with `integrity.ok: TRUE`:
  the tampered anchor positively certified itself, which is worse than the silence A1 removed.
  Also reachable with `1e308`, with `defaultAbsFloorByDerivation.trajectory = 1e9`, with
  `perMetric.<id>.abs = MAX_VALUE`, and through the APPROVE door with no hand-edit at all. The
  precedent was already in the repo pointing the other way: the trace baseline caps
  `driftTolerance` at `MAX_DRIFT_TOLERANCE` inside `loadTraceBaselineManifest`, the one reader
  every grader goes through. Mirrored here in TWO halves, because one constant cannot bound both
  terms of `max(abs, relPct * |baseline|)`: `relPct` is dimensionless and is capped by the
  constant `MAX_SNAPSHOT_REL_PCT` (0.5); `abs` is in the metric's native unit and is bounded
  against the FROZEN BASELINE instead, `applied <= max(MAX_SNAPSHOT_REL_PCT * |baseline|, the
  shipped floor for the derivation)`. The shipped floor keeps the ceiling non-zero for a metric
  that legitimately measures near zero, and makes the DEFAULT policy provably inside the cap for
  every baseline value. Both doors run the same predicates (approve and read), and every surface
  that grades against a widened band prints the consent sentence naming how wide it is.
- **B2: a DOWNGRADED design target certified, and the first cut enshrined it in a test.** B
  refused a target that was ABSENT and read the status field to decide, so a target that is
  PRESENT but `draft` tripped none of the three signals: `orphanedDesignArtifacts` is scoped to a
  MISSING meta, the whole-game verdict does not exist on a slice-planned project that never ran
  one, and STATE is one hand-edit away. Two edits, nothing deleted, took a fixture from `exit 1 /
  hero-shot-fidelity: REFUSE` to `exit 0 / hero-shot faithful`, and the wave's own false-failure
  test asserted `draft.code === 0`, so the escape hatch shipped as an assertion. Refusing a LIST
  of bad statuses would only move the hole to the word not on the list, so the rule is about the
  TRANSITION: any evidence that this target was EVER approved refuses a target that is not
  approved NOW, whatever it currently calls itself. Three signals join the union, through ONE
  predicate (`designTargetApprovalClaims`) now shared by the whole-game and slice paths, which
  had the same hole and different partial answers: the meta's own `approvedAt`, a STATE that
  carries no `designTarget` record while a meta sits on disk, and any PER-SLICE verdict's own
  `designTarget` claim. The last is the one that costs something: the verdict is the slice's
  proof, and deleting it refuses the slice outright.
- **C2: shrinking the gate list cost nothing on the door that prints the certificate.** C's own
  known-open said the cost of shrinking `slice.acceptance.gates` was "the gate coverage the
  roll-up separately grades". On the doneness path that price was zero: `contractCoverageRefusals`
  lives in `slice-rollup.ts` under `verify --rollup`, and `evaluateSliceDoneness` never called it.
  So gates and `captureManifest` could be shrunk TOGETHER, stayed self-consistent under C's
  re-derivation, and the certificate printed with four capture files deleted. `doneness` now binds
  the union of the APPROVED slices' gate lists to the on-disk `ACCEPTANCE.json` through the same
  predicate the verify door uses. This is F3's territory entered from the doneness side.
- **D2: D converted "delete a field" into "delete a list entry".** The drift row became
  unconditional on the observation EXISTING, and stayed conditional on the observation existing at
  all, so dropping the whole entry (or the whole array) was cheaper and still passed, AND the
  wrapped input still counted as GRADED evidence that the run measured the game. Closed with PR
  #88's denominator rule: the expected observations are recomputable as `manifest.assets`, walked
  by the same reader, with the reverse walk beside it (an observation of an asset the approved
  manifest never declared is a refusal). The staged-document carve-out survives, NARROWED to what
  its own argument covers: a BARE `ASSET_MANIFEST.json` carries no observations by construction and
  owes none. Which shape the gate read is decided in `run-gates.ts` from the bytes on disk and
  injected AFTER the input is spread, so a staged input can never declare its own exemption.

**Whether each new bound is recomputable, or one more value the attacker can write**, asked per
fix because the previous two waves each MOVED the false green by not asking:

- **A2 (relPct cap): a code constant.** Not attacker-writable, not recomputable either; it is a
  product decision about what a gate is.
- **A2 (effective-tolerance ceiling): RECOMPUTABLE.** It is arithmetic over the frozen baseline,
  which the same reader has already bound to the measurements file's sha256 and to its own §0
  re-derivation, and over a shipped floor that lives in code. Raising the ceiling means moving the
  value the snapshot was approved AS.
- **B2: NOT recomputable, and stated as such.** "Was this target ever approved" leaves no artifact
  that can be re-derived from bytes, so the union is writable values all the way down. What it
  buys is that the lie must be told consistently in four files, one of which (the slice verdict)
  cannot be deleted without refusing the slice.
- **C2: RECOMPUTABLE.** The expected gate coverage comes from `ACCEPTANCE.json`, which is not a
  claim about the run but the specification the run is measured against, and doneness already
  refuses a contract whose genre disagrees with the roadmap.
- **D2: RECOMPUTABLE.** `manifest.assets` in the approved manifest is the denominator, walked by
  the same code path that reads the observations.

#### Known-open after this wave

- **The B2 union is still a union of writable values.** Four coordinated edits across four files
  buy the certificate. The honest close needs an artifact that records approval and cannot be
  rewritten with the approval it records, which none of today's files is.
- **The magnitude cap does not bind `derivation`.** A hand-edited manifest can relabel a metric's
  derivation to borrow a larger shipped floor. The contract's own recipe re-derives it and the
  contract is sha-pinned, so the check is available; it is not written here because every route
  to it is bounded by the relative half of the ceiling anyway (the shipped floors are all small).
- **C2 grades the APPROVED slices' union only.** A project with no approved slice is refused for
  other reasons first, so the coverage question is not asked there, which is right for noise and
  is a gap if that ever stops being true.

### Then the attack moved: SHRINKING the denominator

An adversarial review of the wave above attacked the new mechanism rather than the gates, and
found that counting comparisons had **moved** the false green rather than removed it. You can
no longer skip a check. You could still delete the thing you owed, and the shrunken number
then became the positive evidence for `anchored: true`. Both were demonstrated end to end
against real `approve` + real `verify`, and both are closed here.

- **Screens (F1).** The denominator is `manifest.states`, and `loadBaselineManifest` parsed the
  file, checked `kind`, checked the repoIdentity/projectPath pair, and stopped. Nothing walked
  the `<id>.png` files beside it, and `pngSha256` was **write-only**: stamped at approve and
  read nowhere in the capability. Deleting one line from `states[]` took the run from
  `exit 2 / comparisons {expected: 2, performed: 1, ungraded: ["start"]}` to
  `exit 0 / pass / comparisons {expected: 1, performed: 1}`, with the trimmed state's frame
  still present in both directories. `verifyScreensBundle` now does what `verifyTraceBaseline`
  has always done for the trace baseline: re-hash every declared frame against its stamped sha,
  and refuse any `<id>.png` / `<id>.ui-rects.json` in the bundle the manifest does not declare.
  It runs INSIDE the loader, so the denominator cannot be obtained without the check having
  run, and `writeBaselineBundle` prunes stale files on every approve so an undeclared file is
  never something an honest approve left behind.
- **Feel (F2).** `verifySnapshotIntegrity` walked `manifest.metrics` to the frozen measurements
  and never walked back, so a metric DELETED from the manifest had nothing left to disagree
  with. A `runSpeed` drift of +1.0 against a 0.14 tolerance exits 1 with `total: 3`; delete
  `runSpeed` from `manifest.metrics` and the SAME capture exits 0, `clean`, `total: 2`,
  `anchored: true`. The reverse walk is now a named refusal. It is exact rather than heuristic
  because `snapshot approve` freezes every measured metric, so the two sets are equal at
  approve time by construction; a metric that was never measured (a coverage gap) is in neither
  set and is untouched.

**The general rule this wave leaves behind:** a denominator that nothing walks is a number the
anchor asserts about itself. Every `expected` must be recomputable from artifacts on disk, by
the same code path that reads it.

#### Known-open, deliberately not widened here

- **F3: the `contract` section has no denominator at all.** `anchored` is
  `countGradedGates(verdict) > 0`, so one graded gate out of twelve satisfies it, and "graded"
  means an evaluator ran against `ACCEPTANCE.json`, never "compared bytes a human froze". The
  adversary could not reach exit 0 through it. The honest denominator is the contract's own
  selected gate list; that is the follow-up.
- **F4: `doneness` reads the evidence ledger for reporting only** and never counts it, so it
  could summarize a ledger the slice roll-up refuses. Reachable only with a stale green
  `verify.json`, which `unifiedVerifyRefusals` already narrows.
- **F5: SFX gate ids are in `SUPPORTED_GATE_IDS` but not `GATE_SPECS`**, so an SFX-only slice
  yields `expected: 0` and a vacuous coverage check. The re-grade divergence check appears to
  cover it; confirm before adding a second mechanism.

### And the wave before that one: SKIPPING ON ABSENT

The counting wave above closed "the gate ran on a subset". This wave closes the older and
plainer class beside it: **an absent or malformed input made a check SKIP rather than refuse.**
Four were demonstrated end to end and all four are closed here. The house rule they all violate
is stated in `CLAUDE.md`: a gate predicate must REFUSE when a bound field is absent.

- **A. A non-numeric tolerance made every feel metric match forever.**
  `resolveTolerance` computes `max(abs, relPct * |baseline|)`; `Math.max` returns NaN if any
  argument is NaN, and every comparison against NaN is false, so `|delta| > applied` was false
  for every delta. Two ORDINARY routes reached it: an operator typo at approve
  (`--tolerances '{"perMetric":{"runSpeed":{"relPct":"5%"}}}'`, whose KEYS were validated and
  whose VALUES were not), and deleting the single key `tolerancePolicy.defaultRelPct` from a
  frozen `manifest.json` (which nothing covered, because the manifest carries no self-hash).
  Both produced `runSpeed: 2.816 -> 99999 (delta +99996.1839, tolerance NaN) ok`, `clean`,
  exit 0. Now refused at BOTH doors a tolerance can enter through, by one predicate: at approve
  in `readTolerances`, and at read in `verifySnapshotIntegrity`, beside the reverse walk, so one
  place owns manifest trust. `compareSnapshot`'s drift test is additionally written fail-closed
  (`!(|delta| <= applied + 1e-9)`), identical for every finite tolerance, DRIFT for a NaN one.
- **B. The slice path had no disk-truth Design Target guard, and the polarity was backwards.**
  Both slice-path fidelity checks opened with `if (design.status !== "approved") return []`, and
  a DELETED `design-target.json` resolves to `status: "missing"`. So a CORRUPT target refused
  (`readMeta` rethrows anything that is not ENOENT) while a DELETED one certified: same fixture,
  target present `exit 1 / hero-shot-fidelity: REFUSE`, target deleted
  `exit 0 / hero-shot-fidelity: PASS / OK — … + hero-shot faithful`, with STATE still recording
  `designTarget: approved`. Deleting is strictly easier than corrupting, so the cheaper attack
  was the one that worked. `sliceDiskTruthDesignTargetRefusals` now refuses on the UNION of three
  independently-written signals (STATE's sticky record, the whole-game verdict's own claim, and
  hero-shot artifacts left in `.loombridge/design/` with no approval record beside them), so no
  single deletion silences it, and the same union feeds `runtimeClaimsApprovedDesignTarget` so
  scrubbing STATE cannot flip the project to `art:deferred` to skip the roll-up entirely.
- **C. Omitting `captureManifest` certified where declaring it refused.** `isSliceDone` read
  `proof.captureManifest ?? []`, and `assertValidSlicePlan` accepts the omission (optional field;
  the closed-key check only rejects UNKNOWN keys). Declared-and-absent exited 1
  (`missing slice captureManifest entries: s1/verify-manifest.json`); the field removed exited 0.
  Refusing only the ABSENT field would have moved the hole one character (`captureManifest: []`
  certified too), so the expected set is RE-DERIVED from the slice's own declared gates through
  the same `sliceCaptureManifestEntries` that `build` mints from. That is the counting wave's
  rule applied here: the denominator is recomputable from disk by the code path that reads it.
- **D. An observation that omitted the bound id skipped the drift check.** The literal
  anti-pattern, `if (observed?.registryAssetId && manifest !== observed.registryAssetId)`, on both
  the registry and generated branches. Demonstrated on the real `runGates` path: an honest
  observation passes, a wrong `registryAssetId` FAILS the gate, and the same record with the field
  deleted PASSES. The drift row is now emitted whenever an observation exists, pass or fail, so
  the comparison is counted rather than conditionally present.

**What each new refusal now depends on** is the question this wave had to answer for itself,
because the previous one moved the false green instead of removing it. A (both routes) depends
only on arithmetic over the frozen manifest's own bytes. C depends on the slice's declared gates,
which an attacker CAN shrink, but only by deleting the gates the slice claims to have passed,
which the roll-up's coverage checks already read. B depends on a union of three artifacts rather
than one. D depends on the observed record still being agent-authored, so it makes lying
EXPLICIT rather than free: an absent field is now a refusal, and a matching-but-false id is a
stated claim the capture path can later bind.

#### Known-open after this wave

- **A declared `captureManifest` can still be shrunk by shrinking the slice's gate list.** The
  re-derivation binds the manifest to `slice.acceptance.gates`, so editing both together stays
  self-consistent. What that costs the attacker is the gate coverage the roll-up separately
  grades; closing it fully means binding the gate list to the contract, which is F3's territory.
  **CLOSED by C2 above, and the sentence above was wrong about the price:** on the doneness path
  the roll-up's coverage check was never called, so shrinking the gate list cost nothing at all on
  the door that prints the certificate.
- **`checkSliceRollupAssetSourceFidelity` still returns `[]` on a non-approved target.** It is no
  longer reachable as a false green (the hero-shot refusal fires first on the same facts), so it
  is left with one answer per question rather than two.
- **"No observation at all" is still a PASS on the asset-source gate.** Deliberate: `verify`
  stages the bare `ASSET_MANIFEST.json` into the inputs dir itself, so failing it would
  manufacture a tier-1 game defect out of a harness gap on every ordinary project. The
  staged-document marker already keeps that copy out of `gradedGates`, which is the honest answer
  to "did this run measure the game". **NARROWED by D2 above:** the carve-out was wider than its
  own argument. It now applies to the BARE staged declaration only, which is the only shape the
  argument is about; a CAPTURE owes one observation per declared manifest asset.

## Out of scope

- Aligning the windows OUTSIDE the settle (action dispatch round trips, anchor polling), the
  conditional next slice: built only if a measurement says those windows dominate what the
  clock wave left behind.
- Pausing the editor between segments, in-tick input dispatch, and a whole-segment
  `run_segment` op (the same conditional slice).
- Mask EDITING UI, and per-capture mask *authoring* beyond the `captureId:` prefix on a
  `--set` rect.
- Changing any gate's semantics or exit tiering. (The ratchet wave added ONE tolerance, and
  the delivery note above states why: it is per-trace, human-approved on the anchor, capped,
  and it can only ever be as strict as the old fixed default when nobody stamps one.)
- Folding `doneness` into `verify`.
- Engine breadth (the CLI core stays engine-agnostic by design; Unity remains the only
  shipped engine).
- The playtest tier itself (persona bots, telemetry): its constraint is recorded here (advisory,
  never gating), its design is its own RFC.

## Open questions

1. Discovery manifest: derive purely from existing files (workspace layout is already the
   truth) or add an explicit `VERIFY.json` index? Leaning derive-from-files: one less thing
   to drift, and the layout is already guarded by tests.
2. Where does the unified report live: `.loombridge/run/reports/verify.json` alongside the
   per-asset reports, or replacing them? Leaning alongside (per-asset reports are consumed by
   existing tooling).
3. **SUPERSEDED (LiveByDefault): the `--live` opt-in was reversed.** Live is now the DEFAULT
   and `--offline` is the opt-out; `--live` is still accepted and is a no-op, so everything
   already typing it keeps working. What the S1 reasoning below did not weigh is what the
   opt-in cost on the COMMON path: on a normal project bare `verify` printed "every discovered
   asset needs a running editor" and exited 2, so the answer to this product's central question
   always took two invocations, and an operator who forgot the flag got a `partial` that read
   like a run. CI is still served, and served more honestly, by spelling `--offline`: a
   headless runner genuinely cannot drive an editor, and saying so is better than relying on a
   default. The post-reload-stall concern is answered directly rather than by avoidance: a live
   run PROBES for a reachable editor after the plan prints and before the first write, and
   REFUSES (tier 2) with `loombridge verify --offline` named as the way to grade stored
   evidence. The plan-prints-first rule now carries a second job, consent: it names every row
   about to be driven into Play Mode, before anything is driven. The coverage-honesty half
   below is unchanged, with `--offline` in place of the omitted `--live`.

   The S1 reasoning, kept verbatim as the record of what was traded away:
   Bare `verify` runs the offline assets and lists the
   live-only ones as `not run: needs --live`; `--live` executes them. The reasoning that
   decided it, unchanged: the ratchet door's dominant runtime is CI, and live-by-default would
   make the least specific, most-typed command the one most likely to hit the post-reload stall
   family (the least recoverable failure mode we have). Printing the plan first does not
   mitigate that, because the plan prints and then runs anyway. The fresh-project
   "verify looks useless" concern is already answered by the on-ramp text. The cost of the
   opt-in is honesty about coverage, and S1 pays it explicitly: a run whose only unmeasured
   assets were live-only reports `partial`, names every unmeasured anchor, and is the ONE
   non-execution reason still allowed to exit 0 (it is an operator's deliberate choice), given
   that the run compared at least one anchored green section. Every other unmeasured anchor
   keeps the exit at its tier.
