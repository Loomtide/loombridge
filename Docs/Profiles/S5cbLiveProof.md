# S5c-b — Live, Operator-Driven Measurement Proof

**Status:** code half landed (this branch `feature/S5cLiveMeasurement`); live bridge run pending operator.
**Predecessor:** [VerifyFirstEntry.md](VerifyFirstEntry.md) (S5b/S5c-a). This note is the *live* proof recipe.
**Objective:** prove the bridge can measure an **existing** Unity 2D platformer controller by driving
**declared inputs** and **observing the player transform** — feeding the S5c-a re-derivation verifier —
**without mutating the developer project**.

The whole point of verify-first is low-trust diagnosis: we **observe**, we never edit the project, and
every reported number must **re-derive from its own raw samples** so a hand-authored / param-read value
cannot pass. This run is the first end-to-end demonstration of that on a project Loombridge did not build.

---

## Sample under test

`~/loombridge-runs/OnlineSamples/2d-platformer-controller`

- Unity **2019.4.17f1** project (closer to the 2022.3 compatibility target than the 5.3 sample).
- Full game: scenes (`DemoScene`, `TestingRoom`, …), prefabs, player + camera.
- Controller: `Assets/Scripts/CharacterController2D.cs`, `Assets/Scripts/PlayerController.cs`.
- Input: **new Input System** asset `Assets/Input/InputMaster.inputactions` (relevant — see the
  injection caveat below).

Editor decision (recorded): **try a 2022.3 upgrade-open first** (the product compatibility target);
abort back to native 2019.4.17f1 if the upgrade churns (API renames / package upgrades). The upgrade
copy is a throwaway working copy — **no commits come out of the sample project regardless**.

---

## Code this proof depends on (landed in this slice)

`runtime.measure_motion` now optionally emits the raw evidence the offline verifier needs:

- `includeSamples: true` → `samples[]` of `{tMs, x, y}` (tMs relative to capture start — the
  `FeelTrajectorySample` shape `feel-derive.ts` consumes).
- `projectFixedTimestepBeforeMeasurement` + `measurementFixedTimestep` provenance. `measure_motion`
  pins only `Time.captureDeltaTime` (render cadence), **never** `Time.fixedDeltaTime` (physics), so it
  **observes the project's real physics rate** — both fields are equal, by construction. That is the
  honest verify-first behavior: we read the project's 50/60Hz, we never impose one.

Implementation: `MotionMetrics.Compute(samples, includeSamples, projectFixedTimestep,
measurementFixedTimestep)` (`Editor/Core/MotionMetrics.cs`), wired in `HandleMeasureMotion`
(`Editor/Handlers/RuntimeHandler.cs`), advertised in `op-registry.ts`. EditMode coverage in
`MotionMetricsTests.cs`.

> **Before the live run:** `loombridge` execs the **frozen** runtime at `~/.loombridge/runtime`, NOT the
> repo `dist`. After this code lands, re-run `scripts/loombridge-install-locally.sh` so the bridge the
> editor loads (and the `loombridge` CLI) include these C# + server changes. See
> [[loombridge-frozen-runtime-reinstall]].

---

## Read-only recipe (no project mutation)

All scene-shape reads use the verify-first **read-only** ops; the **mutation deny-list** in
`VerifyFirstEntry.md` applies unchanged. The only "writes" here are Play-Mode entry and transient input
injection — both revert on exit Play Mode; nothing is saved to the scene or assets.

1. **Connect + confirm context.** Open the sample (2022.3 upgrade copy), confirm `loombridge_editor_list`
   shows it bound. `scene.open_scene DemoScene` (or `TestingRoom`); confirm it compiles + the player
   object resolves (`scene.find_object`, `component.list`). Read-only.

2. **Declare the input map** (no binding auto-discovery). For this sample's `InputMaster`:
   - `moveRight` / `moveLeft` — the horizontal action keys,
   - `jump` — the jump key,
   - `jumpCut` — the key whose release cuts the jump short (often == `jump`),
   plus a `dash` key only if the controller has one. A metric whose required key is undeclared is
   reported **"not measured" with the missing key named** — never silently skipped (`planMeasurements`).

3. **Drive + observe, one window per metric family.** A single window cannot honestly measure both run
   and jump (run = hold direction on flat ground; jump = tap jump). Use one window per family, each with
   `includeSamples: true`:

   > **Preferred method (since §B2 pass 3): `runtime.capture_input_motion` with `captureFps: 0`.** It
   > injects the declared keys *in-loop* (no `key_down→measure` latency gap) and is what the live S5e
   > dry run used. **`captureFps` MUST be `0`** for input-driven capture — pinning the timestep
   > (`captureFps:120`) breaks injection (motion reads zero). The `captureFps:120` examples below are the
   > older two-call `measure_motion` path (observe-only `measure_motion` *does* take `captureFps:120`);
   > also run on a **clear runway** (a wall mid-run silently under-reports speed). See
   > VerifyFirstEntry.md "Capture gotchas".

   - **runSpeed** — `input.begin_session` → `input.key_down moveRight` → `runtime.measure_motion
     { locator: <player>, durationMs: ~900, captureFps: 120, includeSamples: true }` → `input.key_up
     moveRight`. Read `avgRunSpeed` + `samples`.
   - **jumpApex / timeToApex** — from rest on ground, `input.key_tap jump`, then `runtime.measure_motion
     { durationMs: ~1100, includeSamples: true }` capturing the arc. Read `deltaY` (apex height),
     `timeToApexMs`, + `samples`.
   - **shortHopApex** (optional) — tap `jump` and release `jumpCut` early (a brief hold), observe peak-Y.
   - **coyoteTime / jumpBuffer** (optional) — input-timing **bisection** via `interpretBisection`: jump
     at increasing delays, find the jumped→failed boundary. Returns null+reason when unbracketed → the
     metric is **omitted, never invented**.

   New-Input-System caveat: this sample reads `InputMaster.inputactions`. The bridge injects at the
   `InputSystem.devices` layer (see [[mcp-keyboard-injection-and-sim-throttle]]) — scan devices, not
   `Keyboard.current`; the sim freezes when backgrounded, so advance game-time **inside** the
   `measure_motion`/probe loop (it forces `runInBackground`), never by polling between calls. Confirm
   input is actually landing with a quick `runtime.get_snapshot` delta before trusting a window.

4. **Assemble `feel.json`.** Each window becomes one **trajectory source** carrying its `samples`,
   `derivation:"trajectory"`, the metrics it covers, and the timestep provenance copied verbatim from
   the `measure_motion` response. Canonical assembler: `assembleMeasurements` in
   `genre-packs/platformer-2d/assemble-measurements.ts` (it re-derives each value from the raw samples — never
   copies a controller param). The equivalent hand-authored shape the verifier consumes:

   ```jsonc
   {
     "metrics": { "runSpeed": 9.10, "jumpApex": 3.02, "timeToApex": 312 },
     "provenance": {
       "sources": [
         {
           "source": "runtime.measure_motion",
           "derivation": "trajectory",
           "measuredMetrics": ["runSpeed"],
           "samples": [ { "tMs": 0, "x": 0.0, "y": 0.0 }, /* … from the run window … */ ],
           "sampleCount": 108,
           "captureFps": 120,
           "measuredAt": "<iso>",
           "projectFixedTimestepBeforeMeasurement": 0.02,
           "measurementFixedTimestep": 0.02
         },
         {
           "source": "runtime.measure_motion",
           "derivation": "trajectory",
           "measuredMetrics": ["jumpApex", "timeToApex"],
           "samples": [ /* … from the jump window … */ ],
           "sampleCount": 132,
           "captureFps": 120,
           "measuredAt": "<iso>",
           "projectFixedTimestepBeforeMeasurement": 0.02,
           "measurementFixedTimestep": 0.02
         }
       ]
     }
   }
   ```

   Each metric value must equal the re-derivation of **its own source's** samples
   (`deriveRunSpeed` / `deriveJumpApex` / `deriveTimeToApex`) — which it will, because
   `MotionMetrics.Compute` and `feel-derive.ts` share the formulas by design.

5. **Verify.** `loombridge verify --profile precision --measurements <feel.json>`. Expect run / jump apex /
   time-to-apex graded against the precision bands, re-derivation **green**, and any undeclared metric
   reported "not measured" (status `incomplete` if so — honest, never a green-over-unmeasured).

---

## Negative proofs (the part that makes the green trustworthy)

### N1 — tampered value rejected by re-derivation
Edit **one** reported metric in `feel.json` to a value that is *inside* the profile band but **no longer
matches its samples** (leave `samples` untouched). Re-run `verify --profile`. Expect that metric
**REJECTED** by §0 re-derivation and forced to `fail` (`reported … does NOT match re-derivation …
tampered or param-read`). This is the keystone: a plausible, in-band, hand-edited number cannot pass.
Restore the value, re-run → green.

### N2 — 50Hz project surfaced by physics-timestep
`physics-timestep` is a **build-mode** gate (it needs `acceptance.physics.fixedTimestep`), so this is a
gate-level demonstration on the same assembled `feel.json`, not part of `verify --profile`:

- Confirm the sample's real physics rate (`ProjectSettings` Fixed Timestep; Unity default 0.02 = 50Hz)
  and that the `measure_motion` provenance reports it (`projectFixedTimestepBeforeMeasurement: 0.02`).
- Run `physics-timestep` against an acceptance asserting **60Hz** (`fixedTimestep: 0.016667`) → **fail**
  (`does not match acceptance.physics.fixedTimestep`). Against a matching 50Hz acceptance → **pass**.

The new capability my C# change unlocks is that the gate now has **honest, observed** timestep data to
judge — before this slice `measure_motion` emitted no timestep at all.

---

## Non-mutation guarantee + sign-off

- **Never** call any op on the `VerifyFirstEntry.md` deny-list. Play-Mode + input injection revert on
  Stop; no `scene.save_scene`, no asset writes.
- After the run, prove the sample project is unchanged: `git -C <sample-or-upgrade-copy> status` clean
  (or, if the copy isn't a repo, diff against a pre-run snapshot). The upgrade-open copy is throwaway —
  **no commits leave the sample project**.
- This branch commits **only** the EditMode-testable C# + server changes + this note. The live run's
  artifacts (the real `feel.json`, the verdict, the negatives) are recorded **here as evidence**, not as
  repo code (mirrors the S3b/S4b/S4-parallax-b operator-driven proofs).

## What to record as proof (paste back after the run)

1. Editor version actually used (2022.3 upgrade vs native 2019.4) + whether the upgrade was clean.
2. The declared input map.
3. Per-window `measure_motion` output (the aggregates + a few `samples` + the timestep fields).
4. The assembled `feel.json` and the `verify --profile precision` verdict (status + per-metric).
5. N1: the tampered metric, the rejection line, and the restored-green re-run.
6. N2: the project's real fixedDeltaTime, the 60Hz-acceptance **fail**, the 50Hz-acceptance **pass**.
7. `git status` (clean) of the sample/upgrade copy.

---

## Methodology findings (live run, Unity 6000.3.9f1, TestingRoom)

### What the C# data-path proved live ✅
`runtime.measure_motion` with `includeSamples:true` worked exactly as designed on this real,
Loombridge-did-not-build project:
- it **advanced the simulation and emitted the raw trajectory correctly** — e.g. 97 samples over a full
  800 ms game-time window under forced `Application.runInBackground = true`;
- the new provenance came back **`projectFixedTimestepBeforeMeasurement: 0.02` /
  `measurementFixedTimestep: 0.02`** — the project's real 50 Hz physics rate, **observed, not imposed**.

So the S5c-b data-path (samples + timestep provenance for offline re-derivation) is proven on a live
existing controller. The re-derivation enforcement and the N1/N2 negatives are proven offline against a
valid assembled `feel.json` (see the dry-run note in the project log).

### B1 — an ACTIVE bridge input session suppresses ALL keyboard input, incl. the human's (the live blocker)
The live *input-driven* capture (drive declared keys → observe the controller's response) was blocked.

- **Symptom (operator-confirmed): once a bridge input session is open, no key — bridge OR the developer's
  own keyboard — reaches the controller, until the session is torn down (or Play restarts / a domain
  reload occurs).** The Game View was focused throughout, so this is **not** a focus problem.

- **Confirmed by a controlled reproduction (Unity 6000.3.9f1, TestingRoom, Game View focused), using the
  developer's keyboard as the oracle and `CharacterController2D.speed`/position to corroborate:**

  | Step | Bridge session | Operator holds Right | Player moved? | Position |
  |---|---|---|---|---|
  | **T0** baseline | none | yes | **YES** | x 0.16 → 9.70 |
  | **T1** during | `begin_session`, **no key injected** | yes | **NO** | stayed 0.16 |
  | **T2** recovery | cleanly `end_session` | yes | **YES** | x 0.16 → 9.70 |

  T1 is decisive: the bridge injected *nothing*, yet merely having a session open killed the human's
  keyboard. T2 shows a clean `end_session` releases it. So the suppression is bound to an **active
  session**, not to any injected key.

- **Root cause (code-level): `InputSystemRuntimePump.MirrorStateToOtherKeyboards`** queues the bridge's
  `HeldKeys` state onto the **real keyboard device every pump `Update()`** while `_sessionActive`. Every
  frame in which the bridge holds no key writes an **empty** `KeyboardState` to the real keyboard,
  continuously overwriting the human's presses to "released." This exactly matches T1 (suppressed while
  active) and T2 (recovers on teardown).
- **Compounding factor — no teardown on session expiry (why it looked permanent during the run):** the
  pump keeps state in `static` fields (`_virtualKeyboard`, `_instance`, `_sessionActive`,
  `DontDestroyOnLoad`). When the **server-side input session expires** — it did, repeatedly, during the
  measurement run — the backend's `EndSession` → pump `EndSession` is **never called**, so the pump keeps
  `Update()`ing (and mirror-zeroing) with no clean reset. Confirmed in-run: an `input.end_session` after
  an expiry returned `ended:false, backend:"none"` (server had no session to tear down). No exceptions in
  the Unity console — a state/logic defect, not a thrown error.

**This is a real bridge defect in the input pump — orthogonal to the S5c-b `measure_motion` data-path and
to the verify re-derivation pipeline (both proven).** Per the operator decision it was **reproduced and
confirmed only**; the fix + the live input-driven capture are deferred to a dedicated reproduce → fix →
EditMode-test task. Candidate fixes to design there: (1) do **not** mirror synthetic state onto real
devices (or scope it so it never zeroes a device the bridge isn't actively driving — the mirror exists to
let legacy `Input.GetKey` polling observe injected keys; it must not clobber real input); (2) make the
session robust to expiry — idle-tick teardown, or re-sync/clear on next `BeginSession`.

> **Supersedes** the earlier in-run hypothesis that the blocker was the project's
> `InputSystem m_RunInBackground: 0` + editor focus. Focus was held throughout the reproduction; the real
> cause is the pump above. (A target's run-in-background setting is still worth checking in general, but it
> was not the blocker here.)

### B1 — FIX (landed) and live confirmation
Fix shipped on this branch:
- `InputSystemRuntimePump.QueueStateAndUpdate` no longer mirrors synthetic state onto **real** keyboard
  devices — it injects only into the bridge's own virtual keyboard (`MirrorStateToOtherKeyboards` removed).
  A full `KeyboardState` event replaces a device's state, so mirroring the bridge's (often empty) held set
  onto the real keyboard every frame was what zeroed the developer's presses. Legacy `UnityEngine.Input`
  is still served by the separate `EditorEvent` mirror in `InputSystemBackend`, which does not clobber.
- `InputSystemRuntimePump.BeginSession` now clears `HeldKeys`/`TapFrames` so a session that was never torn
  down cleanly (e.g. expired) can't leak a phantom held key into the next session.
- `InputService` gained an **idle-timeout teardown** (`DefaultIdleTimeoutSeconds = 30`, injectable clock):
  the per-frame poll (`Tick()`, runs on `EditorApplication.update`, fires even unfocused) tears down the
  session — releasing injected key state — on idle expiry, alongside the existing play-mode-stop teardown.
  `INPUT_SESSION_EXPIRED` added. EditMode tests: idle expiry tears down + releases keys + requires a new
  session; activity refreshes the timer; timeout=0 disables.

**Live confirmation (operator):** after the fix recompiled in the live editor, the developer's **own
keyboard moves the player again** — the regression (human input dead after a bridge session) is gone. The
mirror-clobbering defect is fixed and confirmed on the real project.

**Headless EditMode test result** (editor closed; run from repo root, Unity 6000.3.9f1):
```
"/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity" \
  -batchmode -nographics -projectPath unity-dev-project \
  -runTests -testPlatform EditMode \
  -testResults /tmp/lt-editmode.xml -logFile /tmp/lt-editmode.log
```
Result: **171/176 passed.** All of the input-pump / session-teardown and S5c-b data-path tests pass —
`Tick_SessionIdlePastTimeout_TearsDownAndReleasesKeys`, `Tick_ActivityRefreshesIdleTimer`,
`Tick_IdleTimeoutDisabled_NeverTearsDown`, `EndSession_ClearsPressedKeys`,
`Compute_IncludeSamples_EmitsRelativeTrajectory`, `Compute_FixedTimestepProvenance_EmittedAndRounded`,
`Compute_EmptySamples_IncludeSamples_EmitsEmptyArrayNotError`. The remaining **5 failures are pre-existing
`-batchmode -nographics` environment artifacts unrelated to this change** (none touch the modified files):
`ComponentHandlerTests.SetProperty_*` (temp-asset naming), `InputSystemBackendTests.EndSession_ReleasesHeldKeys`
("No graphic device is available to initialize the view"), and `OpExecutorTests` / `TraceCollectorTests`
(NUnit `LogAssert` flagging intentionally-logged `[Error]` messages). Left untouched per scope.

### B2 — measure_motion window vs input-driven motion (newly surfaced; NOT this fix's scope)
With the keyboard fix in, the narrow run/jump **capture still did not complete**, for reasons separate
from B1:
- **Terrain:** in `TestingRoom` the player runs ~9.5u off the start platform into a walled pocket
  (x≈9.7); rightward drives then hit the wall. A flat-ground scene (or a short, edge-aware window) is
  needed.
- **Focus + chat coordination:** input only lands while the Unity *app* is focused; the operator must
  hold focus continuously, but must unfocus to message — a fragile hand-off.
- **Deeper interaction:** in repeated trials a held key did **not** translate to motion *inside* a
  `runtime.measure_motion` window (the window advanced game time + emitted samples correctly, but the
  controller didn't move), even though a normal focused keypress moves the player. This suggests the
  forced measure loop (pinned `captureDeltaTime` + `runInBackground`) and the controller's input read /
  focus gating interact in a way that needs its own investigation — likely the capture must sample the
  driven trajectory via the normal frame loop rather than rely on the measure window to both drive-observe.
- **Session-routing churn:** with the bridge reconnecting, `begin_session` and later key ops intermittently
  landed on different `InputService` instances (`key_down` ok, then `key_up` → `INPUT_SESSION_REQUIRED`),
  and `get_capabilities`/`end_session` reported `active:false`/`ended:false`. Pre-existing multi-connection
  artifact, worth a separate look.

**Status:** RESOLVED. The B1 keyboard-clobbering blocker is fixed + confirmed live, and the full
live input-driven capture (runSpeed/jumpApex/timeToApex) → `verify --profile precision` → **N1 tamper
rejected by re-derivation** is now proven end-to-end via `runtime.capture_input_motion` (in-loop
injection). See **B2 — pass 3: RESOLVED** below. The S5c-b data-path and offline negatives also stand.

#### B2 — pass 2 findings (after the B1 fix merged, #33; branch `feature/S5cB2LiveCapture`)
Re-attempted the capture on a fresh editor (post-fix). Refined understanding:
- **Focus is still required, even post-fix.** A clean unfocused test (begin session → hold Right → read)
  left `CharacterController2D.speed = (0,0)`: injecting only the bridge's *virtual* keyboard does **not**
  bypass the project's `InputSystem m_RunInBackground:0` focus gate — InputSystem won't process input into
  actions while the app is unfocused. So the earlier "no motion *inside* measure_motion" was almost
  certainly **just focus dropping**, not a measure-window-specific defect.
- **Session-drop is intermittent, not a per-connection routing bug.** Handlers are a single static
  `InputService` (bootstrap), and `bridge.initialize`/client-disconnect do **not** touch input sessions —
  so the earlier "multi-instance routing" guess was wrong. Verified the session **survives** short
  sequences (`begin→down→up`, `begin→down→wait300→up`, `begin→down→get_snapshot→up`) but **intermittently
  drops over multi-second spans** (`begin→wait2500→down→measure→up` failed twice with
  `INPUT_SESSION_REQUIRED`). A transient (discovery poll reconnects ~every 10s; or a play-entry settle) is
  the suspect; root cause unpinned. `end_session`/`get_capabilities` sometimes report `ended:false`/
  `active:false` — a read-routing artifact, not a real teardown.
- **Pocket terrain persists:** the player keeps ending at x≈9.7 (walled) before a run window can grade.

**Superseded by issue #37 / PR #39:** the focus requirement was later resolved by applying
Input System `backgroundBehavior=IgnoreFocus` +
`editorInputBehaviorInPlayMode=AllDeviceInputAlwaysGoesToGameView` for the life of a bridge input
session and restoring the developer's settings on teardown. `runtime.capture_input_motion` is now
verified with the Unity Editor app OS-backgrounded; the focus notes below are historical evidence from
the pre-#37 path, not current operator guidance.

#### B2 — pass 3: RESOLVED (live, branch `feature/S5cB2LiveCapture`, 2026-06-04)
The full input-driven live capture + verify + N1 tamper is **proven end-to-end**. The unblock was the
new `runtime.capture_input_motion` op (commit `cbd8340`): it injects the declared keys **inside** the
sampling loop, on the same ticks it samples the target, so there is no `key_down → measure` MCP
latency gap (the gap was what let the fast controller wall itself before a separate measure window
opened — every prior run read `deltaX=0`). With `captureFps:0` (timestep NOT pinned) the game loop runs
at its live rate and the injected input reaches the controller normally.

**Live captures** (OnlineSamples `2d-platformer-controller_Loombridge`, `DemoScene:/Player`, Unity
6000.3.x; this original proof was operator-focused; PR #39 later removed that focus requirement):
- **Run** — phases `[{[],150ms},{[RightArrow],800ms},{[],150ms}]`: phase 0 `deltaX=0` (stationary), phase 1
  `deltaX=2.25` (x:146.2→148.45 with RightArrow held — **input captured in-loop**), phase 2 `deltaX=0`
  (stops cleanly on release). Movement happens **iff** the key is held — a clean causal signature.
  Phase-1 runSpeed = 2.25/0.799 = **2.816 u/s**.
- **Jump** — phases `[{[],150ms},{[Space],400ms},{[],800ms}]`: rises to `peakY=-13.24` during the Space
  hold, falls back to ground in the settle. `jumpApex` = **0.800 u**, `timeToApex` = **40.53 ms**
  (measured from LAUNCH: the last sample still at the pre-launch baseline, which on this capture is
  3.71 ms after the sliced start; the value read 44.24 ms while the clock started at the first sample
  of the slice), `deltaX=0` (pure vertical).

**feel.json** (scratch dir, sample project left pristine): flat `runSpeed/jumpApex/timeToApex` +
`provenance.sources[]` each `derivation:"trajectory"` carrying the **raw live samples** (run-phase
slice for runSpeed; jump-press-onward slice for jumpApex/timeToApex). The reported values are the
offline re-derivation of those very samples.

**`loombridge verify --profile precision --measurements feel.json`** → `status=fail`, **0 pass / 3 fail**.
All three measured metrics fail the *band* (this is a generic sample controller, not a precision
platformer: runSpeed 2.8 vs 9, apex 0.8 vs 3, rise 44ms vs 280ms) — **the expected, honest outcome**.
Crucially, all three `rederivation` verdicts **PASS** (reported value bit-matches re-derivation from the
source's own samples): the metrics fail on band, **not** on distrust.

> **Reproduction note (2026-07-27, grammar/taste split):** this run predates report
> `schemaVersion: "2"`. `runSpeed`, `jumpApex`, and `timeToApex` are all TASTE-class
> metrics, so re-running the same command today records them as `out_of_band`
> (descriptive placement, no fail). Add `--enforce-taste` to reproduce the original
> `status=fail` verdict. The N1 tamper below is unaffected: a §0-rejected value forces
> `fail` in every mode, taste or not.

**N1 tamper (the decisive negative).** Edited the reported `jumpApex` `0.8 → 3.0` — a value sitting
*exactly* on the precision target (`3u → 3u ±12%`, so it sails through a naive band check) — while
leaving the samples byte-identical. Re-run → `rederivation jumpApex: status=fail, reported=3,
rederived=0.8`, grading detail *"measurement rejected — reported 3 does NOT match re-derivation 0.8000
from the source's own samples — tampered or param-read."* The other two metrics still pass
re-derivation (surgical rejection). **A value hand-picked to satisfy the band cannot earn a band pass,
because the raw live samples are the evidence and they refute it.** This closes the S4b self-grade hole
on a *live*-captured trajectory, not just synthetic/offline fixtures.

> Methodology notes: ran `verify` with `--root <scratch>` so the report (`.loombridge/reports/`) never
> touches the developer's sample project (verify-first non-mutation). `engine: not detected` in that
> scratch root only downgrades a *clean pass* → incomplete; it does not affect a band `fail` or the
> re-derivation verdicts (engine-independent). The frozen `~/.loombridge/runtime` had to be reinstalled
> first (it predated S5b/S5c — no `feel-rederive` gate); see [[loombridge-frozen-runtime-reinstall]].

**Historical remaining item, now fixed:** this proof originally required Unity app focus. Issue #37 /
PR #39 removed that limitation by making bridge Input System routing focus-independent for the input
session. Session-drop over long idle spans is mitigated by the keep-alive lease (B2 pass-1/FIXED #2).

---

> **Bridge-agent discipline** (see [[bridge-agents-reach-for-the-wrong-lever]]): the controller AND the
> gate/verifier source are **frozen** for this run. If a metric won't measure honestly, report it "not
> measured" and stop — do **not** detune the controller, rewrite a gate, or param-read a value to force
> a pass. Honest-or-stop.
