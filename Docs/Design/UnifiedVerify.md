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
- **Bare `verify` routes on a POSITIVE allowlist** (`--root`, `--strict`, `--live`, `--report`,
  `--id`, `--workspace`). Every other flag reaches the legacy paths exactly as before, and a
  guard test fails if a newly added flag is classified in neither direction. One declared tier
  change came with it: on BARE argv a malformed `ACCEPTANCE.json` is a broken contract ROW
  (tier 2) instead of a fatal, because the contract is one asset among several and a project
  with a good trace baseline should still get that trace checked. The engine path and the MCP
  tool keep the fatal tier.

- **The unified report is written to `.loombridge/reports/verify.json`** alongside the
  per-asset reports, and the screens section writes a verify-owned
  `.loombridge/reports/verify-screens.json` rather than the guided flow's workspace report.
  `--report <path>` overrides the first, resolved relative to `--root`, and is REFUSED when it
  would overwrite a project artifact or any file that is not a previous unified report.
- **`doneness` consumes the report** (the seam S1 originally left reserved). When
  `.loombridge/reports/verify.json` is present and its `exit` is non-zero, `doneness` adds a
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
  writes `.loombridge/reports/verify-scoped.json`; `verify.json` keeps meaning "the last time
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
  unlike `.loombridge/reports/` it is meant to be checked in: the stamped pair is evidence a
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
  than the operator's shell. That attestation is env-CLAIMED, not verified provenance, and
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
  ONE declared PNG and cross-checks `frameWidth`/`frameHeight` whenever masks are stamped, so
  every PRE-RUN surface (the plan's `anchor terms:` line, `mask --list`, discovery's typed
  `maskedFraction`) quotes a fraction measured against a denominator something verified.
  Without it the dimensions were self-asserted until grade time, and inflating them by hand
  printed a 40% mask as 4%. `mask --list` runs the verifier first and REFUSES to quote the
  terms of an anchor that fails it.
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
2. Where does the unified report live: `.loombridge/reports/verify.json` alongside the
   per-asset reports, or replacing them? Leaning alongside (per-asset reports are consumed by
   existing tooling).
3. **RESOLVED (S1): `--live` opt-in.** Bare `verify` runs the offline assets and lists the
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
