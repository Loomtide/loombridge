# Existing-Game Feel Verification

This flow is for games Loomtide did not build. The goal is to produce a deterministic feel
report while preserving evidence boundaries: missing capture glue is `not-measured`,
`attempted-blocked`, or `unsupported`, never a pass.

## Artifact Workspace

Use the same external verification workspace layout as mini-game verification:
`~/.loomtide/projects/<game-id>/`. Generated verification artifacts should stay outside
the Unity project by default, so a verification run does not dirty the game repo.

For feel verification, the default files under that workspace are:

```text
~/.loomtide/projects/<game-id>/
  feel/
    capture-contract.json
    profile-measurements.json
    capture-artifacts/
    reports/
      feel-profile.json
      feel-profile.html
      feel-profile.md
```

Use `--id <game-id>` when the CLI can derive the workspace, or pass
`--workspace ~/.loomtide/projects/<game-id>` explicitly. `Docs/Profiles/artifacts/`
is for explicit, user-chosen archival bundles only; it is not the default output
location for generated verification evidence.

## Flow

1. Choose the profile:

   ```bash
   loomtide verify --profile precision --id my-game
   ```

   With no measurements this should be `incomplete`, which is the honest starting point.

2. Declare the controlled subject:

   ```bash
   --player /Player
   ```

   The subject can be a player, avatar, vehicle, cursor, or other controlled object. The
   contract shape is not platformer-specific.

3. Declare the drive primitive:

   ```bash
   # Input-System keyboard
   --jump-key Space --move-right-key D

   # Mobile/uGUI
   --jump-button /Canvas/ButtonJump --joystick "/Canvas/Fixed Joystick"

   # Inactive UI root, if needed
   --activate /Canvas

   # Reviewed semantic-anchor probes for coyote-time / jump-buffer
   --coyote-probe ./coyote-probe.json
   --jump-buffer-probe ./jump-buffer-probe.json
   ```

4. Preview, then write a reviewed capture contract:

   ```bash
   loomtide verify --profile precision --setup-capture --player /Player \
     --jump-button /Canvas/ButtonJump \
     --joystick "/Canvas/Fixed Joystick" \
     --id my-game

   loomtide verify --profile precision --setup-capture --apply --player /Player \
     --jump-button /Canvas/ButtonJump \
     --joystick "/Canvas/Fixed Joystick" \
     --workspace ~/.loomtide/projects/my-game
   ```

   Without `--apply`, this is a dry run. Default output is
   `<workspace>/feel/capture-contract.json`.
   Use `--force` only when replacing a reviewed contract intentionally. For uGUI controls, setup infers a common
   UI root activation precondition by default; pass `--no-auto-activate` to disable that or repeat
   `--activate <path>` for explicit inactive roots. Activations are restored after capture.

5. Run live capture and grade the resulting measurements in one command:

   ```bash
   loomtide verify --profile precision \
     --capture-contract ~/.loomtide/projects/my-game/feel/capture-contract.json \
     --project MyUnityProject \
     --workspace ~/.loomtide/projects/my-game
   ```

   The command writes `<workspace>/feel/profile-measurements.json`,
   `<workspace>/feel/capture-artifacts/`, and
   `<workspace>/feel/reports/feel-profile.{json,html,md}`. The JSON is the machine/audit
   record; the HTML and Markdown are the developer-readable report. If the live
   capture verdict is incomplete, the command exits 2: a capture/harness gap is not a game pass.
   Add `--capture-only` when debugging capture separately; the follow-up grading command is then
   `loomtide verify --profile precision --measurements ~/.loomtide/projects/my-game/feel/profile-measurements.json --workspace ~/.loomtide/projects/my-game`.

## Contract Model

The generic contract separates four concerns:

- `subjects[]`: named locators such as player, camera, vehicle, avatar, cursor, or board piece.
- `preconditions[]`: temporary setup actions such as restorable `scene-set-active` for inactive UI roots.
- `interactions[]`: how the game is driven: `keyboard`, `ugui-tap`, `ugui-multitap`,
  `ugui-hold`, `ugui-hold-drag`, `world-pointer`, `trace-replay`, or `unsupported`.
- `signals[]`: optional observations such as property paths or method getters for animator/VFX
  sync, with explicit transient re-resolution policy. Signal sampling is evidence collection;
  generic `derivation:"sync"` metrics derive only when the sampled series is present and trustworthy.
- `metrics[]`: requested measurements mapped to an interaction and derivation.

Profiles define bands and meaning. The capture contract defines how evidence is obtained.
Generated setup currently proposes full-jump metrics (`jumpApex`, `timeToApex`,
`fallGravityMultiplier`), run metrics (`runSpeed`, `runAcceleration`, `runDeceleration`,
`inputLatency`), keyboard `shortHopApex` via a fixed-tick jump-cut phase, uGUI/mobile
`shortHopApex` via no-input grounded-settle plus pointer hold/release with fixed-tick evidence,
keyboard `dashDistance` via an explicit dash-key phase delta, mobile double-jump apex where a uGUI
jump button exists, semantic-anchor `coyoteTime`/`jumpBuffer` only when reviewed probe JSON is
provided, and optional sampled-field sync when a signal is declared or discovered.
The uGUI short-hop recipe certifies the stimulus only when the bridge reports matching requested and
actual hold ticks; games that ignore hold duration still produce measured trajectory evidence, not a
fabricated pass.

Semantic-anchor probes are intentionally explicit. A `semantic-probe` interaction must declare the
anchor kinds (`ground-lost` + `jump-input` for coyote-time; `pre-jump-buffered-input` +
`grounded-ready` for jump-buffer), runtime probe phases, bisection trial delays, and trajectory-rise
jump evidence. Setup includes these probes from `--coyote-probe <json>` /
`--jump-buffer-probe <json>`; it does not invent anchors from ordinary jump/run samples. Today those
anchors are still declared labels, not observed bridge events, so generic capture preserves the raw
trials but reports coyote/buffer as `attempted-blocked` until anchor-observation support exists.

## Coverage Semantics

- `measured`: raw evidence was captured and a metric was derived.
- `attempted-blocked`: Loomtide tried a valid recipe, but the harness/setup did not produce usable
  evidence.
- `unsupported`: Unity editor automation cannot drive this path generically.
- `not-measured`: no recipe was run or no recipe exists.
- `planned`: a reviewed recipe exists but has not run yet.

Status stays deterministic: out-of-band measured metrics fail; missing evidence keeps the profile
incomplete under strict mode. Harness blockers are not game bugs.

Trajectory-backed generic captures opt into the same §0 re-derivation trust link as older profile
captures: a metric with raw samples can report `verified`; a number without re-derivable samples
stays `reported`; a mismatch is `rejected`. Keyboard captures also require active-key phase
movement evidence before a metric is assembled, so an unsupported or misbound keyboard path does
not become a fabricated zero-motion measurement.
uGUI short-hop captures likewise require pointer-down/pointer-up actuation and matching fixed-tick
hold evidence before the canonical short-hop stimulus is attached to provenance.
Keyboard dash captures use a `phase-delta` source: the reported dash distance is re-derived from the
bridge's per-phase `deltaX`, selected by the generated dash phase index, before it can be marked
verified.

## Unsupported Boundary

Legacy `UnityEngine.Input.GetKey` without an on-screen UI, Input System binding, replay, or
developer test hook is not generally drivable from the Unity editor bridge. Do not report zero
motion as run speed. Mark it `unsupported` and ask the developer to expose a supported drive path.

## Current Implementation Boundary

The CLI can create generic capture contracts, run them against a live Unity editor, write raw
capture artifacts, and carry coverage into the profile report in the same invocation. Keyboard,
uGUI pointer, world-pointer, trace-replay, and sampled-field sync primitives all have executable
runner paths. Setup-generated contracts now cover fall-gravity, run-deceleration, input-latency,
keyboard short-hop, uGUI short-hop, and keyboard dash-distance recipes when the declared controls
can produce the necessary raw trajectory, phase-delta, fixed-tick stimulus, and onset evidence.
Generated contracts list `coyoteTime` and `jumpBuffer` as unsupported unless reviewed semantic-anchor
probe JSON is provided. With a reviewed probe, live capture attempts bisection through `runtime.probe`
and preserves the trial evidence, but it does not currently emit measured coyote/buffer values because
`ground-lost` / `grounded-ready` are not yet observed events. Remaining gaps are observable semantic
anchor support plus live dogfooding on a routed fixture, mobile/simultaneous-input dash, broader fixture
dogfooding, and deeper discovery for scene facts that still require explicit developer input.

World-pointer validation note: the bridge path is implemented and unit-tested, and generic capture now
preflights Game View focus with `editor.focus_game_view` before `runtime.capture_pointer_motion`. If
focus cannot be acquired, the interaction is `attempted-blocked` with source `editor.focus_game_view`
and the pointer is not dispatched. If focus and dispatch succeed but the subject does not move after
dispatch, the interaction is still `attempted-blocked`; projection/dispatch alone never certifies a
trajectory metric. Positive live world-pointer dogfooding remains pending until a routable
world-pointer fixture is open.

Keyboard short-hop validation note: generated contracts carry canonical 6-tick stimulus intent, but
the runner stamps that stimulus into provenance only when the raw bridge phase report includes
matching `requestedFixedTicks` and `actualFixedTicks`. The open `tiderunner-clean` session accepted
`fixedTicks` after the local package recompiled, but still reported jump and short-hop as
`attempted-blocked` because its declared jump keys did not move `/Player` under generic keyboard
capture, while the same run measured horizontal `D` motion. The currently open legacy-Input joystick-driven mobile title's
session routes correctly and reaches the new parser, but legacy input plus Game View focus prevents
headless keyboard sessions.

Update 2026-06-19 (partner-readiness re-run): `GameHub` now references the current bridge package
(`file:` ref, not an older embedded copy) and its Input System session injects autonomous keyboard motion
— the `KeyboardMove` scene's `/Mover` measured `runSpeed=1.695u/s [verified]` with real `deltaX` samples
and no Game View focus. This resolves the prior "older embedded bridge rejects `fixedTicks`" caveat for
GameHub. GameHub itself exposes no keyboard JUMP or DASH subject (KeyboardMove is
horizontal-only; the hub and mini-games are tap-uGUI), so the jump/dash recipes were proven on a
jump-bearing fixture instead (next update).

Update 2026-06-19 (input-system jump/dash dogfood, runtime `5712992+dirty`): keyboard JUMP and keyboard
DASH-distance are now LIVE-PROVEN on the `Unity-2D-Platformer-Controller` fixture (workspace
`pc2d-jump-dash`, player `/Basic Player Controller`, keys `d`/`space`/`leftShift`). Generated setup
emitted the contract from generic facts only; live capture measured `jumpApex=1.741u`,
`timeToApex=776.61ms`, `fallGravityMultiplier=2.188x`, and `dashDistance=1.835u` (phase-delta from the
D+LeftShift phase) — all `[verified]` with a §0 re-derivation PASS (`reports/feel-profile.json` →
`rederivation[]`). The precision verdict is `fail` (every measured metric is outside the precision
band — an honest game mismatch, not a harness block). So keyboard JUMP and keyboard DASH move from
"unit-covered + parser-smoked" to **live-proven**. Fixed-tick SHORT-HOP captured the requested vs
actual fixed-tick evidence (`requestedFixedTicks:6` / `actualFixedTicks:6`) but stayed **not-measured**
on the `pc2d-jump-dash` run because the player was not grounded at jump time (no apex rise to derive) —
an honest not-measured, not a false green. A generic "settle to ground before the short-hop tap"
precondition closes that gap and is now **LIVE-PROVEN** for keyboard short-hop: generated keyboard
short-hop interactions carry a `settle-until-rest` spec that observes the measured subject's own
trajectory (no game-specific grounded field), and the runner gates the fixed-tick short-hop on observed
rest for both stable sample count and stable duration — reporting `attempted-blocked`
(`timeout`/`not-observed`) rather than deriving an apex from falling or stale samples.
**2026-06-20 live validation** (`pc2d-grounded-short-hop`, runtime `af3be0c`, same PC2D fixture): the
precondition observed `status: "rested"` (310 stable samples / 200.36ms / `maxTrailingDisplacement: 0`
after 800ms), the fixed-tick jump tap then produced a real apex rise (phase-1 `deltaY = +0.8895` vs
−1.45 falling in the pre-fix run), and `shortHopApex` measured **2.313u** with a §0 re-derivation PASS
(`rederived 2.31298` from 2043 samples). It FAILS its precision band (`→1.1u ±20%`) — an honest band
mismatch (the game's jump-cut genuinely peaks at 2.313u), not a harness block. See
`Docs/Profiles/artifacts/generic-feel-verify-matrix/pc2d-grounded-short-hop/` (full settle/short-hop
run results recorded in the internal results ledger).
Update 2026-06-20 (pointer-safe uGUI settle, code/unit proof): the same `settle-until-rest`
precondition now observes through no-input `runtime.measure_motion` instead of keyboard
`runtime.capture_input_motion`. Generated uGUI `short-hop-hold` interactions therefore carry settle
before pointer hold/release without starting an Input System session. Focused compiled tests prove the
command ordering (`runtime.measure_motion` → `runtime.capture_pointer_hold_motion`), timeout blocking,
and no use of `runtime.capture_input_motion` for uGUI settle. Live uGUI/mobile validation remains pending
until a routable project such as a legacy-Input joystick-driven mobile title is open (results recorded
in the internal results ledger).
Update 2026-06-20 (world-pointer focus acquire, code/unit proof): generic world-pointer capture now
calls `editor.focus_game_view` before dispatch. Focus failure maps to `attempted-blocked` rather than a
game verdict, and dispatch without measured subject motion remains blocked. Positive live validation is
pending because no world-pointer fixture is currently routable (results recorded in the internal
results ledger).
Update 2026-06-20 (semantic coyote/jump-buffer anchors, code/unit proof): setup can now include reviewed
`semantic-probe` JSON through `--coyote-probe` / `--jump-buffer-probe`. The contract validates required
anchor kinds, executable trial phases, declared delay-vs-anchor timing, and jump-evidence shape;
malformed or ambiguous anchors fail closed. The runner executes each trial via `runtime.probe` and
preserves raw anchor/trial evidence, but returns `attempted-blocked` rather than a measured
coyote/buffer value because semantic events are not observed yet. No live Unity semantic-anchor fixture
was available in this slice, so status is **schema/setup complete + unit-proven blocking + live-pending** (results recorded in the
internal results ledger).

Two
generic glue fixes were required and shipped (tested, in the frozen runtime): (1) live capture reuses
the already-loaded scene by name via `scene.get_hierarchy` instead of guessing `Assets/Scenes/<name>.unity`
(which fails for projects that store scenes elsewhere, e.g. PC2D); (2) `phase-delta` `requiredKeys` are
matched case-insensitively (developer casing `d`/`leftShift` vs canonical bridge `D`/`LeftShift`).
See `Docs/Profiles/artifacts/generic-feel-verify-matrix/pc2d-jump-dash/` (full results recorded in
the internal results ledger).

uGUI short-hop validation note: a legacy-Input joystick-driven mobile title's live capture proved the pointer hold/release primitive
can actuate the inactive mobile jump button after a restorable `scene-set-active` precondition and
report matching `requestedFixedTicks:6` / `actualFixedTicks:6` evidence. That game still reached a
full-jump-scale apex because its controller appears to trigger jump on pointer-down rather than
scale jump height by hold duration. This is a valid measured game result, not a Loomtide setup pass.
