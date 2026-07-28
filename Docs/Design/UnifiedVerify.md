# RFC: Unified Verify (one front door for verification)

**Status:** PROPOSED for S2 to S4. **S1 has shipped** (see "S1 delivery notes" below).
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

This table is a CLOSED inventory: discovery walks exactly these kinds, and adding a kind is
an RFC-level change, never a quiet case in a switch. The reserved addition has now LANDED:
**test results** is the FIRST new asset kind, which is how the roadmap's Test Runner gate
arrives as a provider in this report instead of a sixth standalone mode. It is the one row
whose anchor column reads differently on purpose, and the delivery notes below say why.
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
4. `--only flow|feel|screens|pixels|contract` selects subsets for CI granularity.

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
- **S2:** `--only` selectors; mode flags become deprecated aliases (stderr notice, the
  `design` -> `target` precedent); `--profile` explicitly marked diagnostic and removed from
  bare-verify's plan.
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

Not in S1, and unchanged as roadmap items: `--only` selectors, mode-flag deprecation notices,
and routing the `loombridge_verify` MCP tool through the orchestrator (all S2).

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
  them to a build when one was in flight, and a manifest whose `runId` disagrees with the
  build in flight is broken (tier 2). Staleness relative to source edits remains UNPROVEN:
  nothing here notices that a `.cs` file changed after the run. That is the same limitation
  already recorded for `runId` on this report, and it is documented rather than papered over.
- **PERMANENTLY unanchored, and that costs the run its `pass`.** No human approves a test
  suite, so the section reports `anchored: false` forever and `approvedAt`/`approvedBy` are
  never set. Which forced the general rule below.
- **`pass` now requires every executed section to be anchored.** An all-green run with any
  unanchored executed section is `partial` at the same exit tier, and the summary names the
  unanchored sections. This is GENERAL, not a special case for tests: a contract graded
  without an approved design target also stops reading `pass`. The exit tiers are unchanged;
  the rule narrows what may be CALLED a pass, it does not invent a failure. A green
  deterministic result measured against nothing a human ever froze was the last place
  "agents grade their own homework" could still print as a full pass.
- **Presence is DECLARED, so deleting the evidence cannot silence the gate.** With no stamped
  pair but a project that declares tests (`Packages/manifest.json` `testables` non-empty, or
  an `Assets/**/*.asmdef` referencing `UnityEditor.TestRunner`), discovery emits a non-anchor
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
  verdict` on every path and exits 0 only for a stamped, verifying pair or under
  `GITHUB_ACTIONS`, where the trust root is the runner rather than the operator's shell. CI
  runs it over the GameCI artifacts so the CLI's mapping and CI's verdict cannot diverge.
- **The on-ramp is deliberately UNCHANGED.** It stays the trace record/replay/approve
  sequence. It is the one place that names a human actor (the play session IS the approval
  moment), and offering a self-serve, unanchored asset there would convert a human-anchor
  on-ramp into a self-serve one.

## Out of scope

- Changing any gate's semantics, tolerance, or exit tiering.
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
   non-execution reason still allowed to exit 0 (it is an operator's deliberate choice). Every
   other unmeasured anchor keeps the exit at its tier.
