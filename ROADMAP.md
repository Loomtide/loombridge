# Loombridge Roadmap

**Loombridge lets any agent build and verify Unity games, against ground truth a human
approved once.** Agents build through the bridge; the deterministic CLI verifies against
human-approved anchors; humans stay the arbiter of "good", exactly once per anchor.

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

## Now (in progress or next up)

- **Unified verify front door.** One bare `loombridge verify` that discovers a project's
  verification assets (demonstration, pixel baseline, feel snapshot, screen contract,
  acceptance contract), prints its plan, runs everything into one report, and exits by worst
  tier. Empty projects get a two-command on-ramp (record a demonstration, approve it) instead
  of usage text. Design: [Docs/Design/UnifiedVerify.md](Docs/Design/UnifiedVerify.md).
- **Unity Test Runner as a bound gate.** EditMode/PlayMode results consumed as a
  deterministic gate bound to the run that produced them. The single biggest table-stakes gap
  against the wider ecosystem.
- **CI robustness for verification.** The headless story: surviving domain reloads, first
  import indexing, and unfocused editors without a human clicking a window. Includes the
  documented post-reload stall recovery and forced `runInBackground` paths.
- **N-capture averaging for feel snapshots.** Some metrics are single-capture-noisy
  (tail-of-trajectory derivations measured 2x spreads on real games). The manifest already
  reserves `captureRuns`; capture N times, freeze the aggregate, and surface per-metric
  stability at approve time.

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
