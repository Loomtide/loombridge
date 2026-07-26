---
description: Run the Tier-1 gates against the .loombridge/ contract and report the enforced verdict
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(loombridge:*), Bash(cat:*)
---

# loombridge verify

Run the **enforced** Tier-1 gate spine against `.loombridge/ACCEPTANCE.json` and report the
verdict. This is the moat: a build is **not done** until this is green. The guarantee is
identical on Claude Code and Codex because it lives in the deterministic CLI, not here.

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
   > writes per-state captures; every gate would degrade to `<gate>.input` WARN.

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
measurements keep the report `incomplete`; out-of-band measured metrics fail. A measurements file may include
`captureCoverage[]` so the report can distinguish measured evidence from setup blockers,
unsupported input paths, and not-yet-run recipes.

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
- A demonstration (`loombridge trace record --observe`) establishes the flow / state ordering.
- `minigame sync --scene <…>` re-scans on later scene changes and proposes structural migrations; it is
  dry-run by default and writes only with `--apply` (and `--add`/`--remove`). It refuses a removal that would
  empty a state's bindings.
- `minigame check` STOPS for review when a *bound* object moved or vanished — structural drift is never
  auto-fixed to force a green; new *unbound* controls are informational only.

The deterministic CLI owns the gates, exits, state, and report throughout; any eyeball/VLM judgment is
advisory only. Full developer guide: [`Docs/Profiles/MiniGameVerifyQuickstart.md`](../../Docs/Profiles/MiniGameVerifyQuickstart.md);
CI path: [`Docs/Profiles/MiniGameVerifyCI.md`](../../Docs/Profiles/MiniGameVerifyCI.md).
