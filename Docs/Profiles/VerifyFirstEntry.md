# Verify-First Entry (S5b)

**Status:** S5b — Verify-First Entry (shipped 2026-06-02)
**CLI:** `loombridge verify --profile <precision|classic|momentum> [--measurements <path>]`
**Setup:** `loombridge verify --profile <id> --setup-capture --player <path> [drive flags]`
**Capture:** `loombridge verify --profile <id> --capture-contract <path> [--project <name>]`
**Report:** `~/.loombridge/projects/<game-id>/feel/reports/feel-profile.json`
**Predecessor:** [PlatformerFeelProfiles.md](PlatformerFeelProfiles.md) (S5a profile contract)

The verify-first wedge: point Loombridge at an **existing** Unity 2D platformer and get a
feel report against a chosen profile — **without** running `plan` or `build`, and **without
mutating the project**. The deterministic CLI grades and reports. Existing-game capture is
described by a separate generic capture contract so keyboard, mobile/uGUI, pointer, replay, and
unsupported legacy paths can be represented without pretending missing evidence is green.

## What the CLI does (deterministic profile grading)

`loombridge verify --profile precision`:
- detects the engine from the project root (`ProjectSettings/ProjectVersion.txt`);
- loads the selected profile (S5a) and its measurable bands;
- reads an **optional** `--measurements` file and compares measured-vs-band per metric;
- carries optional `captureCoverage[]` from the measurements file into the report, showing which
  metrics were measured, blocked by harness/setup, unsupported, or not measured;
- writes `<workspace>/feel/reports/feel-profile.json` and prints a per-metric terminal report
  ending in a clear next action;
- never reads/requires `ACCEPTANCE.json` or `SLICES.json`, never writes `STATE.md`, never
  mutates the Unity project. Exit: `fail` → 1; `incomplete` (some metric unmeasured) → 1 only
  under `--strict`; else 0.

With `--capture-contract`, the CLI first runs the reviewed capture contract through live Unity,
then passes the resulting measurements to the same deterministic profile grader.

**Honest status:** a metric with no measurement is reported `not measured` (status
`incomplete`), never silently skipped and never folded into a green summary.

**Confidence (the report's "warn" axis, S5d):** alongside pass/fail, every metric carries a
`confidence` that says how much to trust the number — without ever changing the pass/fail
`status` (grading is band + §0 distrust only):
- `verified` — re-derived from the source's own raw trajectory samples (§0 pass);
- `reported` — a measured value with no re-derivable capture backing it (a hand-typed or
  param-read number); graded against the band like any other, but weaker than a `verified` value
  and flagged — especially on an in-band pass — so a typed number can't read as a measured one;
- `rejected` — §0 re-derivation refuted it (reported value ≠ raw samples); forced to `fail`;
- `unmeasured` — no value provided.

The report leads with a one-line `headline`, shows `why:`/`fix:` on each failing metric, rolls
up a `confidence` count, and ends in a `nextAction` that names the offending metrics. The JSON
keeps full-precision values for audit; the terminal rounds for readability.

## The agent's read-only live entry

The CLI cannot see the scene. To produce measurements (and to confirm context), the agent
inspects the live editor through the bridge using **read-only ops only**:

- `scene.get_hierarchy` — scan the active scene tree
- `scene.find_object` / `component.list` / `component.get_properties` — locate the player and read its components
- `scene.get_bounds` / `runtime.get_snapshot` — bounds + runtime transform
- `editor.screenshot` — optional visual context

Player heuristic: reuse `isPlayer(name, hint)` (`mcp-server/src/capabilities/verification/gates/framing.ts`) —
name contains `player`/`ninja`/`frog` or a caller hint.

### Mutation deny-list (never call in verify-first)

`scene.save_scene`, `scene.new_scene`, `scene.create_object`, `scene.delete_object`,
`scene.duplicate_object`, `scene.set_parent`, `scene.set_transform`, `component.add`,
`component.remove`, `component.set_property`, `code.create_script`, `code.modify_script`,
`code.attach_script`, `asset.create_*`, `asset.assign_sprite`, `ui.*`, `package.*`, and any
`input.*` op **outside** a declared measurement session.

**Measurement carve-out (S5c):** driving the controller to measure it is the one allowed
"action" — `input.begin_session` / `key_down` / `key_up` / `key_tap` / `end_session` and
`runtime.capture_input_motion` / `measure_motion` ARE permitted, but **only inside a Play-Mode
capture session that reverts on Stop**, only to observe (never to edit the game), and never as
free-standing input outside a capture. This is not project mutation: nothing persists past Stop.

The product promise is **"let Loombridge diagnose first; you stay in control."**

### Ask points (only when ambiguous, one concise question each)

1. **Which profile?** — `precision` / `classic` / `momentum`. The agent may suggest one from a
   quick read, but the CLI requires an explicit `--profile`; confirm before running.
2. **Which object is the player?** — if the heuristic finds zero or several candidates.

3. **Which keys drive the controller?** (S5c, only when measuring) — declare the input map:
   `jump` / `moveLeft` / `moveRight` / `dash` / `jumpCut` key names. There is no binding
   auto-discovery; a metric whose required key is undeclared is reported "not measured" with the
   missing key named (never silently skipped). See `planMeasurements` in `measure-recipe.ts`.

Then the agent calls `loombridge verify --profile <id> [--measurements <path>]`.

## Generic capture setup (existing games)

`loombridge verify --profile <id> --setup-capture --player <path>` previews a proposed capture
contract instead of grading. Add `--apply` to write
`<workspace>/feel/capture-contract.json`, where the standard workspace is
`~/.loombridge/projects/<game-id>` from `--id <game-id>` or explicit
`--workspace ~/.loombridge/projects/<game-id>`. The
setup surface is intentionally generic:

- `--jump-button <path>` creates uGUI tap and multi-tap recipes for mobile/pointer games.
- `--joystick <path>` creates a uGUI hold-drag recipe for run measurements.
- `--jump-key <key>` and `--move-right-key <key>` create Input-System keyboard recipes.
- `--activate <path>` adds a restorable `scene-set-active` precondition for inactive UI roots. When uGUI controls
  share a parent, setup infers that common root by default; use `--no-auto-activate` to disable inference.
- missing drive facts are persisted as `unsupported` metric recipes, not invented defaults.

The contract separates:

- **subject locators** such as `/Player`, camera, vehicle, or avatar;
- **preconditions** such as temporarily enabling inactive mobile controls, restored after capture;
- **drive primitives** such as `keyboard`, `ugui-tap`, `ugui-multitap`, `ugui-hold-drag`,
  `world-pointer`, `trace-replay`, and `unsupported`;
- **signals** such as property reads or method getters for animator/VFX sync;
- **metric recipes** mapping profile metrics to a drive primitive and derivation.

Current boundary: trajectory recipes can be re-derived and verified from raw samples. Generic
`derivation:"sync"` recipes measure only when the capture includes a trustworthy sampled series;
missing/degraded series remain `not-measured`.

Legacy `UnityEngine.Input.GetKey` with no on-screen UI, Input System binding, or developer test
hook remains unsupported by editor automation. It should appear in coverage as `unsupported` or
`not-measured`, never as a slow or zero measurement.

To run a reviewed contract against a live Unity editor:

```bash
loombridge verify --profile precision \
  --capture-contract ~/.loombridge/projects/mygame/feel/capture-contract.json \
  --project MyGame \
  --workspace ~/.loombridge/projects/mygame
```

The live capture path enters Play Mode through the routed Unity client, runs the contract, writes
the measurements file and raw capture bundle, grades the selected profile, and stops Play Mode on
exit. An incomplete live-capture verdict exits 2 because it is a capture/harness gap, not a game
pass. It records Unity routing and runtime guard metadata in measurement provenance. Add
`--capture-only` to write evidence without grading immediately.

Generated verification artifacts stay outside the Unity repo by default:

```text
~/.loombridge/projects/<game-id>/
  feel/
    capture-contract.json
    profile-measurements.json
    capture-artifacts/
    reports/
      feel-profile.json
```

Only explicit, user-chosen archival bundles belong under `Docs/Profiles/artifacts/`; routine
capture output should remain in the external workspace.

## Measurements file

Two shapes are accepted (so a hand-authored file and the S5c harness output both drop in):

```jsonc
{
  "metrics": { "runSpeed": 9.1, "jumpApex": 3.0 },
  "captureCoverage": [
    { "metric": "jumpApex", "status": "measured", "interactionId": "jump-tap" },
    { "metric": "runSpeed", "status": "attempted-blocked", "reason": "joystick drag produced no movement" }
  ],
  "provenance": { "sources": [ ... ] }
}
{ "runSpeed": 9.1, "jumpApex": 3.0 }   // flat feel.json shape
```

Keys are metric ids from the S5a vocabulary; only finite numbers are read. Unknown ids are ignored.

## S5c — measuring an existing controller (black-box)

The harness measures a controller Loombridge did NOT build by **driving the declared input keys** and
**observing the player transform** — never by reading controller params. Metrics are then DERIVED
from the raw trajectory (`feel-derive.ts`, semantics matched to C# `MotionMetrics.Compute`):

- `runSpeed` — hold `moveRight`, observe; `|Δx|/Δt`.
- `jumpApex` / `timeToApex` — tap `jump`, observe; peak-Y above start / time to that peak.
- `shortHopApex` — tap `jump` for the **canonical short hop** (jump held for exactly **6 fixed physics
  ticks**, then `jumpCut`), observe peak-Y. The tap is expressed in TICKS, not ms, because its effect is
  tick-quantized. **Why 6 (live-calibrated, not the analytic minimum):** under real in-loop injection the
  press takes ~1 tick to land, so a 2–3 tick tap realizes BELOW the jump-registration threshold and
  produces NO hop at all; the realized height saturates by ~6 ticks (live: 2t→0, 3t→0, 4t→1.27, 6t/10t→1.40).
  6 is the shortest tap that both reliably registers and is reproducible (on the saturation plateau).
  **Capture it `SHORT_HOP_CAPTURE_ATTEMPTS` (=3) times**, not once: even at 6 ticks ~8% of taps
  stochastically miss (no hop → apex 0). Pass all attempts to `assembleMeasurements` — it keeps the median
  REGISTERING attempt, discards misses, and refuses only if EVERY attempt misses (so a one-off miss never
  omits the metric and a miss is never blended into the value). **The stimulus is recorded and checked.**
  `assembleMeasurements` stamps the tap onto the source as
  `stimulus: { metric: "shortHopApex", tapTicks: 6 }` (`SHORT_HOP_CANONICAL_TAP_TICKS` in
  `measure-recipe.ts`), and `verify --profile` (and the `feel-provenance` gate) **REFUSES** a shortHopApex
  reading whose source records a non-canonical tap — or no tap at all — forcing it to `fail`/`rejected`
  (absent stimulus = refusal, never a silent pass). So an operator can no longer pick the tap that passes.
- `coyoteTime` / `jumpBuffer` — input-timing **bisection** (`interpretBisection`): jump at increasing
  delays, find the boundary between jumped/failed. Returns null + reason when the trials don't bracket
  a boundary → the metric is omitted, never invented.
- `inputLatency` (ms, **F5 responsiveness — reported but UNBANDED**) — time from pressing a movement key
  to the first detectable motion ("how motion BEGINS", not where it ends). Capture is **two phases**:
  **phase0 settles** with no keys, then **phase1 holds `moveRight`** (horizontal onset isn't confounded
  by gravity the way a vertical jump onset is). The input ONSET is the **phase0→phase1 boundary**; because
  the samples are flat re-zeroed to capture start, the boundary is recorded explicitly as
  `inputOnsetMs` (ms, **same timeline as `samples[].tMs`**) on the trajectory capture/source. Latency =
  (tMs of the first post-onset sample whose position moves beyond a small epsilon) − `inputOnsetMs`.
  **Honest-or-omit:** if `inputOnsetMs` is absent / out-of-window, or no motion is detected after onset,
  the metric is **omitted** ("not measured") — never a fabricated 0. It re-derives from `samples` +
  `inputOnsetMs`, so a tampered latency is **rejected** by §0 re-derivation. **No shipped profile bands
  `inputLatency`** (the locked controller is instant — ~1 physics tick — so on Loombridge-built games this
  is a regression guard; its load-bearing value is on games Loombridge did NOT build). Because no profile
  grades it, `verify --profile` surfaces it under an **informational "also measured (unbanded)"** section
  in the report (separate from the graded metric list) — it is **never** part of pass/fail/`status`.

`assembleMeasurements` (`assemble-measurements.ts`) turns the captures into the measurements file with
each value derived from raw evidence and trajectory sources carrying `derivation:"trajectory"` + their
raw `samples` (and, for an `inputLatency` capture, the `inputOnsetMs` onset).

### Anti-self-grade rules (non-negotiable)
- **Never param-read.** Do not read `controller.coyoteTime` and report it — that's a self-grade. Bisect
  it behaviorally, or omit it.
- **Re-derivation is enforced.** `verify --profile` re-computes every trajectory-claimed metric from its
  own `samples` (and the `feel-rederive` gate does the same in the whole-game pipeline). A reported value
  that doesn't match its samples — or claims trajectory derivation without samples — is **rejected**
  (forced to `fail`), so a tampered/param-read value can't earn a band pass.
- **Sim ticks between calls.** The sim is frozen between MCP calls when backgrounded — drive a probe/input
  op to advance game-time before reading; never poll a frozen sim.
- **60Hz quantization.** coyote/buffer windows (~±20ms) are near one physics step — bisect with finer
  `captureFps` sampling; a single-shot pass/fail is untrustworthy.

### Capture gotchas (live-validated, S5e dry run 2026-06-04)

- **`runtime.capture_input_motion` supports `captureFps > 0` (pinned, deterministic).** This op injects
  the declared keys *inside* its sampling loop (same `MotionMetrics.Compute` sampler as `measure_motion`),
  so pinning the timestep does NOT starve injection — pinning and injection coexist. Validated live
  2026-06-12 (F1 feel-swap): every capture pinned `captureFps:60` (fixedTimestep 0.016667) and injection
  worked across three profiles. Prefer a pinned rate for deterministic, reproducible samples; `captureFps:0`
  is also valid (live game-loop rate, higher sample density ~1200 Hz — keep phases short).
  *Earlier guidance to force `captureFps:0` here was a misdiagnosis: the S5e `deltaX=0` reads (2026-06-04,
  issue #37) were a FOCUS/backgrounding failure on a not-yet-fixed input path, not a timestep effect — they
  are addressed by the focus-independent input session below, not by unpinning the timestep.*
- **The "pinning desyncs injection" warning is real only for the SEPARATE input.key_down + measure_motion
  flow.** If you drive keys out-of-band with `input.key_down`/`key_up` and then sample with the observe-only
  `runtime.measure_motion` (`captureFps > 0`), pinning `Time.captureDeltaTime` decouples the editor-tick
  cadence that delivers the held key from the pinned sampling loop, so the controller can read no input.
  That is the flow to keep at `captureFps:0` (or use the in-loop `capture_input_motion` instead).
- **Run on a clear runway.** A run measurement is obstacle-sensitive: a wall mid-run silently
  under-reports speed (a rightward run that hit a wall read ~2.8 u/s; the same controller on clear
  runway read ~6.4 u/s). Pick a run direction with open space, confirm the player actually traversed,
  and treat a standstill as "not measured", not a slow speed. Note `deriveRunSpeed` averages over the
  from-rest acceleration ramp, so it under-reports steady-state top speed.
- **Input-driven capture works on InputSystem projects only.** On an **Input System** project the bridge
  temporarily sets Input System focus/background routing during an input session so
  `runtime.capture_input_motion` works with the Unity Editor app OS-backgrounded, then restores the
  developer's settings on teardown (validated live, S5e dry run #1 — unfocused run `deltaX≈−5.43`).
- **Legacy `UnityEngine.Input` projects cannot be input-driven at all — not autonomous, not focus-held.**
  On a legacy project (`activeInputHandler:0`, no `com.unity.inputsystem`), `ENABLE_INPUT_SYSTEM` is
  undefined → `InputSystemRuntimePump` (and the #39 fix) **compiles out**; the bridge falls back to the
  **EditorEvent** backend (`gameView.SendEvent`). That backend refuses an unfocused session
  (`[FOCUS_REQUIRED]`) **and**, even with focus held, `SendEvent` does **not** populate
  `Input.GetAxis/GetButton` — so the controller does not move regardless of focus (S5e legacy-input
  investigation, 2026-06-05: three independent methods all read `deltaX=0` with the app foregrounded and
  the session created). There is no runtime-only way to feed legacy `Input` without changing project
  settings. **Do not promise a "focus-held legacy mode" — it does not work.** For a legacy project, either
  (a) the developer adds the Input System package (their mutation) → then autonomous capture applies, or
  (b) measure via a clearly-labeled, lower-confidence **motor-field-drive** adapter (drives the
  controller's movement field directly, bypassing the input layer — runSpeed-only, NOT input-driven; must
  carry `drive:"component-field"` + a sub-`verified` confidence tier so it can't masquerade as a real
  input measurement), or (c) exclude it from the input-driven cohort. Check `unity_input_get_capabilities`
  first (`backend.selected`): `InputSystem` ⇒ autonomous OK; **EditorEvent-only ⇒ legacy, input-driven
  capture unsupported.** (Evidence: S5e dry run #2 + the legacy-input investigation, PC2D sample.) If an
  *InputSystem* unfocused capture reads zero motion, treat it as a tooling regression and record the exact
  op payload + phase breakdown before retrying.
- **Never assemble a `feel.json` (or grade) from a failed/zero legacy injection.** A refused or
  zero-motion legacy capture is **not a measurement** — turning it into a `feel.json` would fabricate a
  number (the exact self-grade verify-first exists to prevent). On a legacy project, report it as
  **not input-measurable** and stop; do not run `verify --profile` against invented values.

## Boundary

- **S5c-b (live, operator-driven)** — the bridge run that produces a real measurements file from a genuine
  controller. The C# additions it depends on (fixedDeltaTime provenance + `includeSamples` on
  `runtime.measure_motion`) are **landed**; the operator recipe + negatives live in
  [S5cbLiveProof.md](S5cbLiveProof.md).
- **S5d (DONE)** — confidence-aware report UX: per-metric `confidence` (`verified`/`reported`/
  `rejected`/`unmeasured`), a one-line `headline`, `why:`/`fix:` on fails, and a `nextAction` that
  names the offending metrics. Grading/capture mechanics unchanged; see `verify-profile.ts`.
- **S5e (DONE)** — the repeatable [Design Partner Protocol](DesignPartnerProtocol.md) for running
  verify-first on 3–5 real partner projects: intake checklist, privacy/non-mutation policy, run
  template + artifact checklist, developer questionnaire, and a **reviewed** profile-adjustment
  process (a one-off result never silently edits a shipped band).
