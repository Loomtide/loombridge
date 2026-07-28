# Positioning: what Loombridge is, and the razor that keeps it that way

**Status:** ACCEPTED. This is a decision record, not a proposal. Direction docs
([ROADMAP.md](../../ROADMAP.md), RFCs in this directory) inherit from it.
**Date:** 2026-07-28.

## Category

**Loombridge is the open agent layer for Unity.** Agents see, control, and build through a
typed MCP bridge; a deterministic CLI proves the result against ground truth a human
approved once.

Tagline, unchanged from the README, and the sentence every other doc serves:

> Your agent builds the Unity game. Loombridge decides whether it is actually done.

## Two capabilities, one invariant

- **Control (the hands).** The bridge: typed `unity_*` ops, real input injection,
  deterministic waits, locators instead of instance IDs. This is the front door, because it
  is what developers come looking for.
- **Prove (the judge).** Verification anchors a human approves once (a recorded trace, a
  feel snapshot, a hero shot, an acceptance contract), deterministic gates that re-measure
  the live game against them, and `doneness` as the strict certificate. This is why a
  developer picks Loombridge over any other Unity MCP server.
- **The invariant.** A self-graded "done" is refused. Deterministic decides; model judgment
  advises and never enters an exit code. This sentence is the brand, and it is load-bearing:
  every gate is built so a verdict cannot be hand-crafted, laundered, or graded by the same
  model that did the work.

Loombridge is deliberately **not** a game factory. It carries no opinion about what a good
game is, only the machinery to state such an opinion once (a human approval) and enforce it
forever (a deterministic gate). Opinionated content lives at the edge as data and skills,
never in the core.

## The razor

Every roadmap item, feature, and PR answers one question:

> Does this help an agent touch Unity, or help prove a result deterministically?

- Yes: it belongs in core (bridge, ops, anchors, gates, providers, report shapes).
- It is an opinion about what a good game is or how to produce one: it belongs at the edge
  (a skill, a genre pack's data) or outside the project.
- It would make a false "done" easier to claim: it is refused outright, whatever else it
  offers.

Corollaries the repo already enforces and this doc makes official:

- Deterministic decides; advisory advises. VLM review, playtest bots, and fun metrics never
  enter a deterministic verdict.
- Refuse on absent, never skip. A gate missing a bound field refuses; it does not skip.
- Harness fault is never a game defect; it exits in its own tier (2).

## The surface: three groups a new developer can hold in their head

The public story presents exactly three groups. Everything else still works but leaves the
headline docs.

1. **Setup:** `install-bridge`, `install-agent`, `doctor`, `update`, `mcp`. Wire in,
   health-check, connect an agent.
2. **Verify:** the anchor makers (`trace`, `feel snapshot`, `target`), the gates today
   (`trace replay`, `verify`, `verify --snapshot`), and `doneness`, the strict certificate
   for supervised builds. The end state is ONE front door, a bare `verify` that discovers a
   project's verification assets and runs them into one report; that orchestrator is IN
   PROGRESS, not shipped, and [UnifiedVerify.md](UnifiedVerify.md) is its program of
   record. Until it lands, docs name the working verbs and never present the front door in
   the present tense.
3. **Build loop:** `plan`, `build`, `status`. The opinionated workflow for new games, built
   on the same judge, presented as one workflow among possible ones rather than as the
   product.

Demoted from the headline story: `minigame` (becomes the screen-contract asset inside
`verify`), `tuning-report`, `mobile-audit`, `capture`, `assets`, `adopt`, `ask` (already
deprecated), and the `verify --profile` mode (diagnostic feel grading, never gating, per
[UnifiedVerify.md](UnifiedVerify.md)). Demotion is a docs decision, not a breaking change:
every verb keeps working, deprecations follow the alias-plus-stderr-notice precedent, and
each demoted verb documents itself via `loombridge <verb> --help`. Dedicated reference
pages for the demoted verbs are follow-up docs work, not yet written; until they exist,
`--help` is the reference.

## The two doors (how the story is told)

- **New game:** `plan` is the door. The contract and Design Target are defined before the
  first line of code; the agent builds slice by slice against a target it cannot redefine;
  `doneness` certifies with run-bound evidence. The steering wheel.
- **Existing game:** the record-once ratchet is the door. Play once, approve once, and from
  then on any agent change is checked against what was approved: `trace replay` for flow
  and pixel drift, `verify --snapshot` for feel drift, with the unified bare `verify` as
  the door's end state once [UnifiedVerify.md](UnifiedVerify.md) ships. `adopt` is the
  optional conversion path from this door into the build loop.

Showcase mapping for demos and videos: a verification-first walkthrough on an existing game
(the ratchet door), and a build-loop walkthrough on a new game (the steering-wheel door).
One video per door; never both stories in one artifact.

## What Loombridge is not (permanent non-goals)

Stated in the README and ROADMAP; repeated here because positioning is where they bind:

- No arbitrary code-execution op. The typed op registry is a security boundary.
- No telemetry, analytics, or phone-home.
- No cloud requirement. Core CLI and bridge run fully local.
- No model-judged deterministic verdicts.
- Not a game factory. Loombridge has no opinion about fun; it enforces yours.

## Deliberately deferred

- **Gate-provider SDK.** The contribution magnet (one runner, many checks, the
  Playwright/ESLint shape), staged only after the internal providers have proven the report
  row shape twice.
- **Second engine.** The core stays engine-agnostic by design; breadth waits until the
  Unity surface is the obvious default choice.

## Known risk, stated honestly

The judge is younger than the hands. The bridge and MCP surface are used daily by choice;
the verification layer has live proof on consumer projects (trace record/replay, tuning
snapshot) but not yet a sustained place in a real daily loop. The bet recorded in
[UnifiedVerify.md](UnifiedVerify.md) is that the friction, not the value, is what has kept
it out: one front door, a two-command on-ramp, and discovery instead of taxonomy. The test
of the bet is dogfooding the ratchet door on a real project and keeping it turned on. If
the bet fails, this document is where the positioning gets revisited.
