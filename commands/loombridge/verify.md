---
description: Run the Tier-1 gates against the .loombridge/ contract and report the enforced verdict
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(loombridge:*), Bash(cat:*)
---

# loombridge verify

Run the **enforced** Tier-1 gate spine against `.loombridge/ACCEPTANCE.json` and report the
verdict. This is the moat: a build is **not done** until this is green. The guarantee is
identical on Claude Code and Codex because it lives in the deterministic CLI, not here.

## Bare `verify`: the unified front door

`loombridge verify` with **no mode flags** answers the only question a user has: *does this
build still do what a human approved?* It discovers the project's verification assets
(acceptance contract, approved trace baselines, feel snapshot, screen contract), **prints the
plan first**, then runs them into one report at `.loombridge/reports/verify.json` alongside
the per-asset reports.

```bash
loombridge verify --root .              # offline assets only
loombridge verify --root . --live       # also replay traces + grade feel drift
loombridge verify --root . --only screens # ONE section (CI granularity); never a certificate
```

- **The plan prints before anything is written.** One row per asset: what it is, when and by
  what its anchor was approved, and whether it will run. Read it before trusting the exit code.
- **A check family with NO asset is named too, every run.** One line per absent family: what it
  would have covered and the command that creates one, plus the workspace directory that was
  searched for the two families that live outside the project (feel snapshot, screen contract).
  The summary repeats the names in one `NOT CHECKED` line and the report carries them as
  `absentFamilies`. This is why a project with only a trace no longer reads as if the
  safe-area / tap-target / required-object checks passed: they live in the screen-contract
  family, and their absence is now stated rather than implied. It is **informational only** and
  changes no status, tier, or exit code: naming a gap is the opposite of covering it.
- **Offline by default.** Trace replay and feel-snapshot capture need a running editor, so
  they are listed as `not run: needs --live` and are **never folded into a pass**.
- **A row that cannot execute is named, never skipped.** An unapproved trace, an unstamped
  legacy baseline, a draft screen contract, a screen contract with **no approved layout
  baseline** (a contract graded against captures of itself is not a human anchor: run
  `loombridge minigame baseline approve`), a baseline approved for a *different* project: each
  is a visible row that cannot contribute a pass.
- **No assets at all** prints the on-ramp (`trace record` → `trace replay` →
  `trace approve`, then `verify --live`) and exits `2`. Recording is a **human** step: the play
  session *is* the approval moment. Do not claim it as an agent action.
- **Pixel drift can be TOLERATED, only by a human, only up to 2%.** A game that animates
  under its own clock cannot hold a frozen frame to the 0.5% default, so `loombridge trace
  tolerance --id <id> --set <fraction>` stamps a per-trace allowance onto the approved
  baseline manifest. It is a **separate verb from `trace approve` on purpose**: approve
  re-freezes frames, so one command that both widened the gate and re-approved would destroy
  the anchor it was meant to keep. `approve` never takes a tolerance and preserves a stamped
  one; `tolerance` never touches a frame or a sha. The cap is `0.02`, enforced at stamp time
  *and* at read time, so a hand-edited manifest is a **broken** row, not a wider gate. Any
  non-default tolerance prints on the plan line with its consent sentence (*at 2%, anything
  covering up to ~14% of frame width by ~14% of height can change undetected*).
- **Localized nondeterminism is MASKED, only by a human, only up to 10% of a frame.** When
  one region animates under its own clock (an ambient layer whose phase drifts against
  wall-clock), `loombridge trace mask --id <id> --set <captureId?>:<x>,<y>,<w>x<h>@<reason>`
  stamps the excluded rects onto the approved baseline; the rest of the frame keeps grading
  at full strictness. The rects are **blanked in both images**, so a masked region cannot
  differ while the diff fraction still divides by the whole frame: a stamped tolerance means
  exactly what it meant. Every rect needs a `@reason`, `--set` restates the **whole list**
  each stamp (so a mask set cannot grow one unnoticed rect at a time), `--clear` empties it,
  `--list` touches nothing. The `0.10` cap is enforced at stamp time *and* at read time by
  one predicate, so a hand-edited full-frame mask is a **broken** row, not a green gate.
  `approve` preserves masks and **refuses** the re-freeze whenever the frame RESOLUTION
  changed, even when the rects still land on the new frame: the same rect hides a different
  share of a different frame, and re-interpreting a human's decision is never silent. Masks
  and tolerance are disclosed together on the plan's `anchor terms:` line, which states the
  **sum** (*together, up to N% of the frame can change while the gate stays green*), and a
  green trace graded with masks reads `id=pass (8% masked)` in the summary detail.
- **Phase skew is ALIGNED, not tolerated: `trace replay --aligned`.** A wall-clock settle
  (sleep here, screenshot there) lets the game free-run for however many frames the editor
  happens to tick, so every run captures a different animation phase and the pixel gate reads
  that skew as drift. `--aligned` (or `--aligned-fps <n>`, integer 10 to 120, default 60)
  replaces the pair with ONE bridge op that advances a fixed frame count at a pinned game-time
  step and captures on the exact frame the settle completes. Reach for it BEFORE a tolerance
  or a mask: it removes the drift instead of consenting to it. The clock is **part of the
  anchor**: `approve` stamps the run's clock into the baseline, later replays inherit it with
  no flag, and a run under a *different* clock (including an unaligned one against an aligned
  anchor, since absence is a value and not a gap) **refuses** the pixel comparison as a harness
  fault rather than grading two animation phases against each other. Re-anchor by approving
  from a report captured under the new clock; the change prints its own consent line. A settle
  the editor cannot deliver inside its wall budget returns **no frame at all** and is a
  capture-tier harness fault (exit `2`), never a degraded frame and never drift. When `1/fps`
  does not sit on a whole number of physics steps the run prints an **advisory** cadence note
  and continues: an uneven cadence is a trade-off the operator is entitled to make. And the
  residual is stated every time drift survives an aligned run: alignment covers the **settle
  only**, so the action round trips and the 150ms anchor polling are still wall-clock windows,
  and surviving drift is *consistent with* those windows or with seed/realtime binding
  (unseeded `Random`, `realtimeSinceStartup`) without being proof of either.
- **A mask is never suggested from one run, and one pixel cannot buy you one.** A drift-only
  failure prints a mask suggestion only when a PREVIOUS report exists, both runs drifted in
  the same **grid cells**, and the drift does NOT reproduce between them. Reproduction is
  structural, not byte equality: at or above **95%** of the drifted pixels landing in the same
  cells of a 16x16 grid, the drift is deterministic and the tool says so instead of naming a
  rect, so re-running until the bitmaps differ buys nothing. It reads *the drift is IDENTICAL
  across two runs: that is a deterministic change, not ambient noise; investigate before
  masking*; a drift masks cannot honestly cover names which bound it broke (over the 10% cap,
  more than 64 components, or under the 60% aggregate tightness bar); a first run asks for a
  second. The suggested command restates the rects you already stamped, so following it never
  un-masks one. Nothing is ever applied for you, and the suggested `@reason` is a placeholder
  you must replace. Full-frame or diffuse nondeterminism stays red: game-time (`timeScale`)
  alignment is the recorded future path for it.
- **A drift names itself.** A trace whose actuation passed but whose pixels moved reads
  `flow: pixel-drift regression (exit 1): actuation passed, N capture(s) over tolerance, max
  X.X%`, never `pass (exit 1)`, and a drift-only failure prints the exact `trace tolerance`
  command to consent to it. That suggestion **never** appears for an unreadable capture: a
  capture gap is a harness fault (exit `2`), not drift.
- **A workspace that stamps this root but was not used is a NOTE, never an adoption.** When
  the derived workspace holds nothing, the plan names any workspace under
  `~/.loombridge/projects/` whose stamped `projectRoot` is this project, and tells you to pass
  `--id <id>`. Nothing is adopted automatically: which id you pass changes what is measured,
  and therefore the verdict.
- **Each section says whether it compared a frozen anchor.** The report carries
  `anchored` per section plus `anchoredSections`/`unanchoredSections`, so "green" and "green
  against nothing a human froze" never print identically. **`pass` requires every executed
  section to be anchored**; an all-green run with any unanchored section reads `partial`, and
  the summary names the unanchored sections. **Exit `0` additionally requires at least one
  anchored green section**: a run in which nothing anchored was compared exits `2`, because a
  self-produced green cannot certify itself.
- **Unity EditMode tests are graded OFFLINE from a stamped run.** The producer is a separate
  verb, `loombridge tests run`: it resolves the editor, runs batchmode headless, and writes
  `.loombridge/tests/test-results.xml` plus `.loombridge/tests/test-results-manifest.json`
  (and the run log). `verify` only ever reads those bytes, so it never launches an editor,
  never takes the license seat, and never fights a domain reload. Details below.
- **`--report <path>`** resolves relative to `--root`, must stay inside the project root, and
  is **refused** (exit `2`, nothing written, nothing run) when it escapes the root, would
  overwrite a project artifact, or targets any file that is not a previous unified report. The screens section writes to a verify-owned
  `.loombridge/reports/verify-screens.json`, never the guided flow's workspace report.
- **`--only <sections>`** runs a SUBSET: a comma-separated selection of
  `contract`, `flow`, `feel`, `screens`, `tests`. Read the four rules before using it in CI:
  - **A broken or unapproved asset still refuses, whatever you selected.** Only a *healthy*
    asset outside the selection is deselected; tampering is never scoped away.
  - **Deselected rows are listed and excluded from the verdict.** You scoped the run, so the
    rows you scoped out cost nothing, and they are printed, so nobody has to guess.
  - **A scoped run is never a `pass`.** Its status ceiling is `partial`, it writes
    `.loombridge/reports/verify-scoped.json` (never the full `verify.json`), and
    `loombridge doneness` refuses to certify from it.
  - **Unknown or empty selections refuse (exit `2`) before anything is written**, and a
    selection matching no discovered asset is a nothing-checked run (exit `2`), named as such.
  - **`--only tests` never exits `0`.** A red suite exits `1`; a *green* one exits `2`, because
    the tests section is permanently unanchored (nothing human-approved was compared). For a
    tests-only CI step use `loombridge tests grade --results <xml>`, or put an anchored section
    in the selection (`--only screens,tests`).
- **`doneness` reads the full report when it exists.** A unified run that exited non-zero, OR
  whose status is anything but `pass` (a `--live` gap, an unanchored section, a scoping), adds
  a refusal to `loombridge doneness`. Only a FULL green certifies: an exit-0 `partial` is a run
  that measured less than this project can prove. An absent report changes nothing.
- **`--snapshot` and `--minigame` are DEPRECATED ALIASES.** Behavior is byte-identical and
  each now prints a short stderr notice pointing at the unified door (`--only feel` and
  `--only screens`); removal comes in a future major. The notice is suppressed under
  `--quiet-next` (the guided flows pass it), for both aliases. `--profile` is NOT deprecated:
  it is a permanent diagnostic that never gates.
- **Exit codes:** `0` a full pass, or a partial that compared **at least one anchored green
  section** and whose only gaps were assets skipped for lack of `--live` or extra unanchored
  sections · `1` a game defect (gate fail, pixel-drift regression, baseline regression) · `2` a harness
  fault (including a baseline manifest that cannot be trusted at grade time, or one carrying
  an over-cap drift tolerance), a broken asset, nothing graded, **or an all-unanchored partial** (every executed section was
  green but none of them compared anything a human froze: *nothing human-approved was
  compared; a self-produced green cannot exit 0*). A run that checked nothing is never a pass,
  and a `2` is never a game verdict (a found defect stays at `1` however much else went
  unmeasured).

Seven flags stay on the unified run and combine only with each other: `--root`, `--strict`,
`--live`, `--report`, `--only`, `--id`, `--workspace`. Every other flag below is a mode or
engine flag, and passing any one of them selects that legacy mode instead, unchanged.

## The Unity EditMode test gate (producer / consumer)

```bash
loombridge tests run --root .        # PRODUCER: launches Unity headless, stamps the results
loombridge verify --root .           # CONSUMER: grades the stored bytes offline
```

`tests run` writes three files into a **committed** directory (this is what lets a CI
runner with NO Unity license grade the run offline; the full licensing story, including
the Unity Personal CI activation path, is [`Docs/Licensing-and-CI.md`](../../Docs/Licensing-and-CI.md)):
`.loombridge/tests/test-results.xml` (the NUnit3 document Unity produced),
`.loombridge/tests/test-results-manifest.json` (the binding manifest), and
`.loombridge/tests/test-run.log`. Commit them: they are the evidence a reviewer or a CI job
reads without re-running a multi-minute editor.

- **A hand-dropped XML never grades.** With no manifest beside it the row is a visible
  non-anchor (`unstamped results: run loombridge tests run`) and never executes.
- **The manifest is re-verified at grade time**, from disk: the XML must still hash to the
  stamped `resultsSha256`, the stamped `projectRoot` must be *this* root, the assembly set
  must match the XML, and the summary is re-derived with the same function that stamped it.
  Any disagreement is `2`, never a re-graded run.
- **Deleting the evidence does not silence the gate.** If the project declares tests
  (`Packages/manifest.json` `testables`, or an asmdef referencing `UnityEditor.TestRunner`)
  but has no stamped pair, the plan carries a non-anchor row saying so.
- **Results not scoped to the build in flight are broken** (`2`): when a build is in flight,
  the manifest's `runId` must be *that* build's. A different id is evidence about some other
  build; an absent id (`null`) is evidence scoped to no build at all, and both are refused
  rather than compared against nothing. With no build in flight there is nothing to scope
  against, so either is accepted and the section reports the `runId` it read.
- **It is PERMANENTLY unanchored.** Nobody approves a test suite, so the section always
  reports `anchored: false`, and a run whose only green is the test section reads `partial`
  and exits `2`: nothing human-approved was compared. Binding proves the *provenance of these
  bytes*, `runId` scopes them to a build when one exists, and staleness relative to source
  edits stays unproven.
- **`loombridge tests grade --results <xml>` is DIAGNOSTIC**, not a verdict: it prints
  `DIAGNOSTIC: not a verification verdict` on every path and exits `0` only for a stamped,
  verifying pair or under CI attestation. Do not quote its output as a verification result.
- **Exit mapping** (both the producer and the section): `0` everything executed and passed ·
  `1` a real assertion failure · `2` a run that could not be trusted (compile errors, a
  mutated project, a cancelled run, an ignored fixture or assembly that executed nothing,
  zero cases, an all-skipped run, an unreadable XML, or an exit code the test-case walk
  cannot account for). A fixture that ran cases but carries a propagated `Ignored` label
  from `[Ignore]`d children is not an opt-out; its skipped cases are the named subset. A
  harness fault is never reported as a game defect, and a real failure is never reported
  as a harness fault.
- **`tests run` is not read-only against the project.** Unity generates files during a
  batchmode run (`.meta` files for folders the tests create, `Library/` on a cold import).
  Run it against your working checkout knowingly, or against a copy in CI-like contexts.

## Process

1. **Run the gates against the primary state's captures.**

   ```bash
   # Per-state captures live under .loombridge/verify/<state>/ (see build.md §6).
   # For platformer-2d the primary state is `spawn`; pick the contract's first state for other genres.
   node mcp-server/dist/surfaces/cli.js verify --root . --inputs .loombridge/verify/spawn
   # require all-green (no warnings tolerated): add --strict
   # (published installs: `loombridge verify --root . --inputs .loombridge/verify/spawn`)
   ```

   This reads captured op-output from the named state subdir, writes
   `.loombridge/reports/build-verdict.json` (with the build's `runId` + `producedAt`), updates
   `STATE.md`, and exits non-zero on a Tier-1 `fail` (or on `warn` under `--strict`).

   > **Known limitation (M2 follow-up).** Today `loombridge verify` grades a **single** state
   > per invocation. `doneness` enforces capture *presence* for every state in the
   > capturePack, but multi-state quality *aggregation* is deferred. Omitting `--inputs`
   > defaults to the bare `.loombridge/verify/` root, which is **not** where the canonical flow
   > writes per-state captures.
   >
   > **That case is now a REFUSAL, not a green.** If no gate consumed a captured input (every
   > gate `warn`-on-missing-capture, `not_applicable`, or graded only from a **staged project
   > document** rather than a capture: `verify` copies `.loombridge/ASSET_MANIFEST.json` into
   > the inputs dir itself, and that declaration is not evidence that this run measured the
   > game), the engine prints `REFUSED: nothing
   > was graded`, writes the verdict for audit, leaves `STATE.md` **untouched**, and exits `2`.
   > It applies to the bare run, every `--inputs` form, and the `loombridge_verify` MCP tool.
   > A run that measured nothing is never a pass. A **partially** graded run is unchanged: at
   > least one real capture makes a `warn` verdict a real result over a real subset (exit `0`,
   > `1` under `--strict`, `STATE.md` flipped).

   > **Slice-scoped verify has its OWN three-way exit contract** (the bare tiers above are
   > unchanged). `loombridge verify --slice <id>` exits:
   >
   > - `0` the slice PASSED, and the per-slice verdict records `"approvable": true`. It is the
   >   only outcome that can advance the slice.
   > - `1` a game defect: a `fail`, **or a `warn` over evidence that was actually graded**. A
   >   warn does not advance the slice, so reporting it as success was false advertising.
   >   Slice verify is therefore **strict by default**; `--strict` is accepted for compatibility
   >   and is a NO-OP for `--slice` (the run announces this).
   > - `2` a harness/capture gap: the only failing checks are gates whose input file was absent,
   >   so nothing was graded and the verdict says nothing about the game. The message names the
   >   missing evidence files. Harness fault is never a game defect.
   >
   > Read `approvable` rather than re-deriving approvability from `status`: a pipeline that
   > loses the exit code (`| tail` drops `$?`) still has one machine-readable answer, and a
   > *diagnostic* verdict is `approvable: false` however green it is, because it is not bound
   > to the slice's proof.

2. **Report honestly from the verdict.** `cat .loombridge/reports/build-verdict.json`.
   - `status: "pass"` → green; state it plainly.
   - `status: "fail"` → enumerate `failures[]` (gate + expected vs actual). **Do NOT claim
     the build is done.** The next step is `loombridge build` after fixing the reported failures.
   - `status: "warn"` → list `warnings[]`; many warns mean captures are missing from
     `.loombridge/verify/` — note which gates were not measured.
   - **Distinguish a HARD failure from an UNEVALUATED gate.** A gate is only a true failure when
     its `status` is `fail`; a `warn` / `not_applicable` gate was *not evaluated* (missing capture
     input), not passed. When summarizing coverage, **never say "only X failed" without also stating
     how many gates were `warn`/unevaluated** — "one hard fail, the rest unevaluated" is the honest
     phrasing, not "everything else passed". This is the PR #349 dogfood lesson: an unapproved asset
     manifest can be the only `fail` while most other gates simply never ran.

3. **Never assert success without a fresh green verdict.** If the exit code was non-zero,
   the build stays in a "not done" phase. Say so.

4. **A green Tier-1 verdict is NOT "done" for a design-targeted build.** If the project has
   an approved Design Target, `loombridge doneness` additionally requires the verdict to carry
   an **independent hero-shot review** (`verify --vlm <unioned vlm-review.json>`): it must
   reference the frozen hero shot (`reference.heroShotSha256 === designTarget.pngSha256`), be
   independent (`independent` + `reviewerCount ≥ 2`), and pass every Group-C fidelity
   criterion (`composition-match`, `parallax-present`, `platform-tiers`,
   `element-placement-arc`). See `build.md` §6.5 + `verify-2d-game/references/vlm-review.md`.
   Tier-1 green + missing/divergent fidelity review → `doneness` exits 1 (plan §P0).

## Verify-First Profile Mode

For an existing Unity platformer, use profile mode instead of the build contract gate:

```bash
loombridge verify --root . --profile precision \
  --measurements ~/.loombridge/projects/my-game/feel/profile-measurements.json \
  --workspace ~/.loombridge/projects/my-game
```

This writes `<workspace>/feel/reports/feel-profile.{json,html,md}`. The JSON is the
machine/audit record; the HTML and Markdown are the developer-readable report. Missing
measurements keep the report `incomplete`. Out-of-band GRAMMAR metrics (coyote time,
jump buffer, gravity asymmetry, jump-cut) fail; out-of-band TASTE metrics (archetype
targets like runSpeed/jumpApex) read `out_of_band` with an archetype-placement block
(nearest shipped profile per metric and overall) and never fail unless you pass
`--enforce-taste`. A tampered (§0-rejected) value fails in both modes. A measurements file may include
`captureCoverage[]` so the report can distinguish measured evidence from setup blockers,
unsupported input paths, and not-yet-run recipes.

Interpreting a taste mismatch: it is an archetype disagreement, not a defect. The
honest next steps are either re-run against the nearer archetype the placement block
names, or pass `--enforce-taste` when the build explicitly targets this archetype.

## Tuning-Snapshot Drift Mode

Once a human has approved how the game actually plays
(`loombridge feel snapshot capture` then `feel snapshot approve`), grade drift against
the game's own frozen baseline instead of an archetype:

```bash
loombridge verify --snapshot --id my-game            # live capture, frozen contract
loombridge verify --snapshot --id my-game --measurements <feel.json>   # offline
```

Exit `0` clean, `1` drift (or a §0-rejected current value), `2` for a missing/tampered
snapshot, a capture-contract mismatch, or a capture gap. Full lifecycle, tolerance
defaults, and the exit table:
[`Docs/Profiles/TuningSnapshotVerification.md`](../../Docs/Profiles/TuningSnapshotVerification.md).

To create an existing-game capture contract from explicit drive facts:

```bash
loombridge verify --root . --profile precision --setup-capture \
  --player /Player \
  --jump-button /Canvas/ButtonJump \
  --joystick "/Canvas/Fixed Joystick" \
  --activate /Canvas \
  --id my-game
```

The setup command previews by default. Add `--apply` to write
`<workspace>/feel/capture-contract.json` unless `--output` is provided. The standard workspace is
`~/.loombridge/projects/<id>` from `--id <id>`, or an explicit `--workspace ~/.loombridge/projects/<id>`.
It does not grade the
game. It records generic drive primitives and preconditions:

- `keyboard` for Input-System key capture.
- `ugui-tap`, `ugui-multitap`, `ugui-hold`, and `ugui-hold-drag` for mobile/pointer UI games.
- `scene-set-active` preconditions for inactive UI roots; setup infers a common uGUI root from
  declared button/joystick paths unless `--no-auto-activate` is passed. The live runner restores
  the original active state after capture.
- `world-pointer` for launch-aligned world-coordinate Input-System pointer taps; because dispatch is not game
  actuation, the runner requires post-dispatch subject motion before grading trajectory metrics.
- `trace-replay` for replay/condition anchors.
- `unsupported` for paths Unity editor automation cannot drive, such as legacy `Input.GetKey`
  with no UI, Input System binding, or developer test hook.

Do not convert a blocked or unsupported capture into a zero measurement. The correct report is
`not measured`, `attempted-blocked`, or `unsupported`, with the reason attached.
Generated setup proposes only recipes whose drive facts can provide raw evidence: full-jump
trajectory metrics (`jumpApex`, `timeToApex`, `fallGravityMultiplier`), run trajectory/onset
metrics (`runSpeed`, `runAcceleration`, `runDeceleration`, `inputLatency`), keyboard
`shortHopApex` with a fixed-tick jump-cut stimulus, uGUI `shortHopApex` through pointer
hold/release, keyboard `dashDistance` from an explicit dash phase (`--move-right-key` +
`--dash-key`), uGUI double-jump apex, and optional sampled-field sync. The short-hop stimulus is
trusted only when raw capture evidence reports matching requested and actual fixed ticks. Dash
distance is trusted only when the bridge phase breakdown re-derives the reported phase delta. If a
game ignores hold duration and always performs a full jump, that becomes the measured result and can
fail the profile; Loombridge must not relabel it as a missing or successful short-hop.

Forgiveness-window metrics (`coyoteTime`, `jumpBuffer`) are currently emitted as unsupported by
generated setup with the missing anchor called out. They require input-timing bisection around a
semantic ledge-leave or landing approach; absent those anchors, the report must stay
not-measured/unsupported.

To go beyond explicit facts, add `--discover`: setup inspects a live editor (routed by
`--project`) and PROPOSES likely controls/signals before writing anything.

```bash
loombridge verify --root . --profile precision --setup-capture \
  --player /Player --discover --project MyGame \
  --animator-controller Assets/Player/Player.controller \
  --workspace ~/.loombridge/projects/my-game
```

- It dumps `ui.get_screen_rects` and proposes a jump button and joystick from generic uGUI naming.
  An **unambiguous** match is adopted (and printed for confirmation); **multiple** matches are
  reported as choices and left UNBOUND — never silently picked — so you pass `--jump-button` /
  `--joystick` to choose. **No** match leaves the metric unsupported.
- Explicit drive facts always override discovery for that role: `--jump-button` / `--jump-key`
  for jump, and `--joystick` / `--move-right-key` for run.
- With `--animator-controller <Assets/...controller>`, it enumerates the controller's bool
  parameters and proposes an `Animator.GetBool("…")` sync signal (`inputToAnimStateLatency`) when
  unambiguous; `--animator-bool <name>` chooses one explicitly; `--animator-host` sets the host
  (default `--player`). No Animator → nothing proposed (never invented).
- Discovery only sees VISIBLE controls: a control under an inactive root won't be discovered —
  declare it with `--jump-button`/`--joystick` and enable it with `--activate`.
- Discovery still previews by default; add `--apply` to write. An unreachable editor exits `2`
  (incomplete capture setup), never a fabricated proposal.

To run a reviewed contract against a live Unity editor and grade it:

```bash
loombridge verify --root . --profile precision \
  --capture-contract ~/.loombridge/projects/mygame/feel/capture-contract.json \
  --project MyGame \
  --workspace ~/.loombridge/projects/mygame
```

This capture path owns Play Mode entry/exit and routes through the same project-aware Unity client
resolver used by other CLI runners. It writes `<workspace>/feel/profile-measurements.json`, a raw
bundle under `<workspace>/feel/capture-artifacts/`, and the profile report under
`<workspace>/feel/reports/feel-profile.{json,html,md}`. Generated verification artifacts should stay outside
the Unity project by default; only explicit user-chosen artifact archives belong in docs/artifacts.
An incomplete live-capture verdict exits 2 because that is
a capture/harness gap, not a game pass. Add `--capture-only` to stop after measurements/artifacts
and print the follow-up `--measurements` grading command.

## Mini-Game Release Verify Mode

For a 2D kids mini-game, `verify --minigame` grades a capture pack against a `MinigameContract`:

```bash
loombridge verify --minigame --contract <c>.minigame.json --captures <captures-dir> [--strict]
```

It runs the deterministic gates — including required-in-frame, safe-area, tap-target-size, text-clipping,
control-overlap, console-clean, background coverage, and interaction-flow — plus baseline drift, and writes
the human report (HTML/MD) + `minigame-verification.json`. **Exit codes are the moat and never blur:** `0` READY · `1` NOT READY
(a real game/asset defect **or** baseline drift) · `2` CAN'T VERIFY (a capture/harness gap — a screen
wasn't captured or a tap didn't fire). A `2` is never a game verdict and a missing capture is never a
silent pass.

### Developer-owned setup (`scan` / `sync` / `check`)

A developer setting up their *own* game does **not** hand-author the contract. The recommended front door
derives and maintains it through the live scene (Unity editor open + bridge connected):

```bash
# Drift-aware one command: bootstrap a draft from a scene scan, guide a demonstration,
# guard structural drift, then run capture → finalize → verify --minigame → one report.
loombridge minigame check --scene Assets/Scenes/MyGame.unity --id my-game
```

- `minigame scan --scene <Assets/...unity>` proposes a DRAFT contract from the scene's visible controls /
  text / backgrounds. It is a proposal the developer reviews — derived data feeds the contract, never the
  verdict.
- A demonstration (`loombridge trace record`) establishes the flow / state ordering.
- `minigame sync --scene <…>` re-scans on later scene changes and proposes structural migrations; it is
  dry-run by default and writes only with `--apply` (and `--add`/`--remove`). It refuses a removal that would
  empty a state's bindings.
- `minigame check` STOPS for review when a *bound* object moved or vanished — structural drift is never
  auto-fixed to force a green; new *unbound* controls are informational only.

The deterministic CLI owns the gates, exits, state, and report throughout; any eyeball/VLM judgment is
advisory only. Full developer guide: [`Docs/Profiles/MiniGameVerifyQuickstart.md`](../../Docs/Profiles/MiniGameVerifyQuickstart.md);
CI path: [`Docs/Profiles/MiniGameVerifyCI.md`](../../Docs/Profiles/MiniGameVerifyCI.md).
