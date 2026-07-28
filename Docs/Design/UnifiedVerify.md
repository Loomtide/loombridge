# RFC: Unified Verify (one front door for verification)

**Status:** PROPOSED.
**Date:** 2026-07-28. Written after the first full live dogfood of every verification mode on
consumer projects (KidsAdventure: trace record/replay + screen contract; KnightsQuest: tuning
snapshot), which is where the fragmentation cost was measured first-hand.

## Thesis

The pitch is one sentence: **Loombridge lets any agent build and verify Unity games, against
ground truth a human approved once.** Two workflows hang from it:

- **Build**: bridge + MCP tools + commands/skills. Agents construct in-engine.
- **Verify**: deterministic gates agents run locally and in CI, anchored to human-approved
  baselines. Verification is not a terminal CI stage; it is the steering signal that makes
  agent building CONVERGE (build, verify, fix, re-verify, approve, next slice).

The named third element is the **human approval surface**: a human approves ground truth once
(a design target, a trace baseline, a feel snapshot, a screen contract), and every later
verdict is a deterministic comparison against that anchor. Without this anchor, "agents build
and verify" reads as agents grading their own homework, which is the exact failure mode the
product exists to kill.

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
the two-command path to the cheapest universal asset: `trace record --observe` (play it once),
then approve. A recorded demonstration + baseline works for ANY game with input, needs no
contract authoring, and gives an agent real regression protection minutes after install. This
is the default entry for "agents verifying whatever they build."

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
3. Does bare `verify` run LIVE assets (feel snapshot, screen capture) by default in a local
   run, or require `--live` the way doctor does? Leaning run-by-default locally with the plan
   printed, and a `--offline` escape for CI stages that only grade existing artifacts.
