# Loombridge Roadmap

**Loombridge is the open agent layer for Unity: agents see, control, and build through a
typed MCP bridge, and a deterministic CLI proves the result against ground truth a human
approved once.** Two capabilities, one invariant: the hands (bridge + MCP), the judge
(anchors + gates + `doneness`), and the rule that a self-graded "done" is refused.
Positioning, the razor every item below passed, and the surface tiers:
[Docs/Design/Positioning.md](Docs/Design/Positioning.md).

Every item on this page serves one of two doors: **`plan`** (new game, the supervised build
loop) or **`verify`** (existing game, the record-once ratchet). An item that serves neither
does not belong here.

This roadmap states direction, not dates. Loombridge is pre-1.0: surfaces can still be
renamed (with deprecation aliases), and the sequencing below can be reshuffled by what
dogfooding on real projects teaches us. Items move to "Shipped" only after live validation
on at least one consumer project, per the working agreements in
[CONTRIBUTING.md](CONTRIBUTING.md).

Two constraints bind everything on this page:

- **Deterministic decides; advisory advises.** Model judgment (VLM review, playtest bots,
  fun metrics) never enters a deterministic exit code. Any future item that would blur this
  line gets redesigned until it does not.
- **No self-graded green.** Every verification verdict traces to a human-approved anchor and
  re-derivable evidence. Harness faults exit in their own tier (2), never as a pass, never
  as a game bug.

## Now (in progress or next up, in this order)

The order is a dependency chain, not a preference ranking. The unified front door lands
first so that every later gate arrives as a provider inside one report, never as another
top-level mode; that collapse is the simplification program for the whole verify surface.

1. **Unified verify front door.** One bare `loombridge verify` that discovers a project's
   verification assets (demonstration, pixel baseline, feel snapshot, screen contract,
   acceptance contract), prints its plan, runs everything into one report, and exits by worst
   tier. Empty projects get a two-command on-ramp (record a demonstration, approve it) instead
   of usage text. Design: [Docs/Design/UnifiedVerify.md](Docs/Design/UnifiedVerify.md).
2. **Unity Test Runner as a bound gate.** EditMode/PlayMode results consumed as a
   deterministic gate bound to the run that produced them. The single biggest table-stakes gap
   against the wider ecosystem. Sequenced after the front door on purpose: it ships as the
   first new asset kind in the unified report (a proof of the row shape), not as a sixth
   standalone mode.
3. **CI robustness for verification.** The headless story: surviving domain reloads, first
   import indexing, and unfocused editors without a human clicking a window. Includes the
   documented post-reload stall recovery and forced `runInBackground` paths. Underpins both
   items above; lands incrementally alongside them.
4. **N-capture averaging for feel snapshots.** Some metrics are single-capture-noisy
   (tail-of-trajectory derivations measured 2x spreads on real games). The manifest already
   reserves `captureRuns`; capture N times, freeze the aggregate, and surface per-metric
   stability at approve time. Independent of the chain above.

## Next

- **Player-build gate.** Verify against a built player (target platform), not only the
  editor: the editor is a simulator of the thing that ships.
- **Doneness binding for the drift report.** The feel-snapshot drift report already stamps
  `manifestSha256` as the seam; `doneness` consumes it so tuning drift can block a "done"
  claim for design-targeted builds.
- **Screen-contract generalization.** The mini-game contract machinery (safe areas, tap
  targets, required objects, flow, baselines) renamed and documented as the generic screen
  contract it already is; `minigame` verbs remain as aliases.
- **Snapshot hardening.** Refuse freezing a provenance-less baseline (all-`reported`,
  hand-typed measurements) without an explicit acknowledgement flag.
- **Spec compilation hardening.** The design-doc path: `plan --brief` and `adopt` compile a
  design document into a proposed contract the human approves as its faithful rendering;
  the implementation is then verified against that contract, deterministically. The
  machinery ships; what it needs is live validation on a real already-built game and a
  first-class guide, because `adopt` is the conversion path from the `verify` door into the
  build loop.
- **Custom feel profiles.** Load a profile from a file, not only the shipped archetypes;
  profiles stay diagnostic (placement and grading), with gating owned by the snapshot.

## Later

- **Playtest tier.** Persona bots drive the whole game; telemetry run-sets are analyzed for
  balance and pacing (`tuning-report` is the seed). Constraint inherited from day one:
  playtest output is advisory evidence for humans, never a deterministic verdict.
- **Gate-provider SDK.** Third parties contribute check providers into the unified verify
  runner (the Playwright/ESLint shape: one runner, many checks, shared verdict semantics).
  Staged after the internal providers have proven the report row shape.
- **Broader genre packs.** More genres as data + skills on the same generic op surface, per
  the genre-neutral core rule (core never imports pack vocabulary).
- **Second engine.** The CLI core is engine-agnostic by design; a second engine is
  deliberately deferred until the Unity surface is the obvious default choice.

## Recently shipped (context for the items above)

- Record-and-replay verification with perceptual baselines, live-proven end to end on a
  consumer project, including phase-gated recording (`--auto-state-signal`), honest anchor
  semantics for invisible uGUI hit-targets, and loud flow-stall reporting.
- Tuning snapshot ("a lockfile for game feel"): capture, human approve, deterministic
  kinematic drift gate (`verify --snapshot`), live-proven with both clean and drift exits.
- Feel profile grammar/taste split: universal feel-grammar metrics gate; archetype taste
  targets are descriptive placement unless explicitly enforced.
- The verification supervisor: run-bound verdicts, design-target freezing, hero-shot
  fidelity, slice roll-up, and the `doneness` freshness gate.

## Non-goals (permanent, not missing features)

- **No arbitrary code-execution op.** The typed op registry is a security boundary;
  capability gaps are closed with typed ops, never an eval escape hatch.
- **No telemetry.** No analytics, usage beacons, or phone-home.
- **No cloud requirement.** Core CLI and bridge run fully local; the hosted asset catalog is
  an optional, read-only convenience.
- **No model-judged deterministic verdicts.** See the constraints at the top; this one is
  load-bearing enough to state twice.
- **Not a game factory.** Loombridge carries no opinion about what a good game is; it is
  the machinery for stating yours once and enforcing it forever. Opinionated content lives
  at the edge as skills and pack data, never in the core
  ([Docs/Design/Positioning.md](Docs/Design/Positioning.md)).
