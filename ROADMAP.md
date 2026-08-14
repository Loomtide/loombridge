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

## The findings ledger

Two live campaigns (the KidsAdventure ratchet dogfood and the TideRunner door-one walk)
produced a 156-finding engineering ledger:
[Docs/Design/TideRunnerDoorOneLedger.md](Docs/Design/TideRunnerDoorOneLedger.md). Every
finding is marked fixed (with its PR), documented, or open, and its **THE OPEN BACKLOG**
section is the single authoritative list of pending items. The roadmap items below
reference it; when they disagree, the ledger is the fresher truth.

## Now (in progress or next up, in this order)

1. **Finish the evidence-trust wave** (ledger backlog items 1, 2, 5). The op journal's
   bridge half, the reopen verb, and the three-way warn exit shipped (PRs 49 and 50);
   what remains is the journal's CONSUMPTION half (the observer embeds the window and
   the gate cross-binds it against the CLI's own op log over a closed allowlist), the
   framing per-field checks with producer-pinned game view, and eventually the
   mutation-based per-field coverage guard the wave review scoped out.
2. **Shareable anchors (artifact storage).** A teammate or a CI runner cannot `git clone` a
   project and verify it, in any configuration: the approved anchors live under
   `~/.loombridge/projects/<id>/`, which no clone can reach, and the one project-local anchor
   is gitignored by our own template. Move every project-specific artifact into the project,
   split into a committed `anchors/` half and an ignored `run/` half, with portable bindings so
   an anchor survives a different checkout path. This is a PREREQUISITE for the next item, not
   a hygiene change: a gate whose evidence never leaves one machine is not a gate. Design:
   [Docs/Design/ArtifactStorage.md](Docs/Design/ArtifactStorage.md).
3. **CI robustness for verification.** The headless story: surviving domain reloads,
   first-import indexing, and unfocused editors without a human clicking a window
   (background throttling trips settle budgets today, measured live at ~10Hz). Includes
   the `UNITY_LICENSE` CI path for the EditMode gate.
4. **Paused-stepped replay.** The measured next step for pixel baselines on animated
   games: capture-aligned settles shipped in 0.1.0 and the idle-probe discriminator
   proved the residual drift is game-clock phase desync accumulating in the unaligned
   inter-segment windows, which only whole-run stepped execution closes. The
   preconditions are recorded in the aligned-wave review; either it ships, or a game
   stays honestly flow-green with a red pixel gate.
5. **N-capture averaging for feel snapshots.** Some metrics are single-capture-noisy
   (tail-of-trajectory derivations measured 2x spreads on real games). The manifest
   already reserves `captureRuns`; capture N times, freeze the aggregate, and surface
   per-metric stability at approve time. Independent of the chain above.

## Next

- **Bridge op-surface batch** (ledger backlog items 7 to 13, each with live repro data):
  `scene.get_transform` (the read half of an asymmetric verb pair), material tiling
  read/write, `wrapMode`/`filterMode` import args, the `ui.get_screen_rects` empty-result
  root cause, `sampledFields` on `runtime.probe`, a bridge-wide unknown-parameter guard
  (the ui-scoped one shipped), and an installed-bridge-versus-TOOLS.md skew guard.
- **Hero-shot pipeline rules from the live campaigns.** Packs must derive the mock from
  the contract's framing numbers (or vice versa): the two frozen artifacts disagreeing
  about the player anchor made pixel-faithful composition provably unreachable once
  (ledger E27). And taste-class review criteria need a termination rule (majority
  voting across three or more reviewers, or the re-freeze ceremony), because
  worst-status union across rounds is monotonically stricter and oscillates (E28).
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

## Recently shipped (context for the items above; 0.1.0 is the evidence release)

- **Post-0.1.0, pre-announcement**: the bridge op journal (every executed op leaves a
  sequenced, target-resolved record through BOTH executor doors, batch children
  included, with an instance id so a reset cannot impersonate a clean window);
  `loombridge reopen` (approvals withdraw through the state machine, cascaded, with
  artifacts cleared and the re-verify chain printed in dependency order); and the
  three-way slice warn exit (capture gaps to the harness tier, graded warns strict by
  default, a machine-readable `approvable` on the verdict).

- **The evidence architecture** (0.1.0, the four-stage arc): evidence is produced,
  observed, or honestly second-class. The CLI produces feel evidence itself through a
  declared harness seam (op echoes, never typed numbers; known-truth calibrated tick
  conventions; a behaviorally proven input-reader disable); playability is observed by a
  bridge-side recorder with `completionMethod` derived from motion continuity against
  the contract's own kinematics (a teleported win cannot say "played"); verdicts carry
  a sha per graded evidence file; the front door re-grades slices instead of trusting
  stored verdicts; required contract content no gate walks refuses by name; evidence
  binds to the run and editor session that produced it.
- **Unified verify front door** with the slices roll-up section, live-proven: a 9/9
  project re-graded green through bare `verify`, and `doneness` still refusing on
  hero-shot fidelity is the moat demonstrated end to end
  ([Docs/Design/UnifiedVerify.md](Docs/Design/UnifiedVerify.md)).
- **Unity Test Runner as a bound gate**: `tests run` executes headless, stamps run-bound
  results, and `verify` grades them offline as the fifth asset kind.
- **Ratchet-door extensions, all live-proven on a consumer project**: human-consented
  pixel tolerances, drift masks with a structural (16x16 grid) reproduced-drift
  discriminator, replay pacing, capture-aligned settles inside a pinned tick loop, and
  focus-independent world taps through an InputSystem session.
- **Delivery integrity**: the bundled bridge is digest-bound to its packaged sources;
  stale bundles refuse at install, update and doctor, and same-version byte drift
  between a project and the CLI turns doctor red naming the fix.
- Record-and-replay verification with perceptual baselines, live-proven end to end on a
  consumer project, including phase-gated recording (`--auto-state-signal`), honest anchor
  semantics for invisible uGUI hit-targets, and loud flow-stall reporting.
- Tuning snapshot ("a lockfile for game feel"): capture, human approve, deterministic
  kinematic drift gate, live-proven with both clean and drift exits.
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
