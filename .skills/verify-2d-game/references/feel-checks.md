# Feel gate

Verifies the locked feel targets (apex, time-to-apex, run, dash, short-hop, coyote, buffer) against measured values. This generalizes the proven feel loop (`unity-2d-game` `references/feel-presets.md`) into a gate. Assemble a `feel.json` of measured metrics; `evaluateFeel` compares each to `acceptance.feel[metric]` honoring its tolerance band.

```json
{
  "runSpeed": 7.0, "jumpApex": 2.2, "timeToApex": 325,
  "shortHopApex": 0.72, "dashDistance": 2.8125,
  "coyoteTime": 0.1, "jumpBuffer": 0.1,
  "provenance": {
    "sources": [
      {
        "source": "FeelHarness",
        "sampleCount": 180,
        "captureFps": 60,
        "measuredAt": "2026-05-31T00:00:00.000Z",
        "projectFixedTimestepBeforeMeasurement": 0.0166667,
        "measurementFixedTimestep": 0.0166667,
        "measuredMetrics": ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"]
      },
      {
        "source": "runtime.probe",
        "sampleCount": 90,
        "captureFps": 60,
        "measuredAt": "2026-05-31T00:00:01.000Z",
        "projectFixedTimestepBeforeMeasurement": 0.0166667,
        "measurementFixedTimestep": 0.0166667,
        "measuredMetrics": ["dashDistance", "coyoteTime", "jumpBuffer"]
      }
    ]
  }
}
```

Each acceptance target is `{ target, unit, band }` where `band` is `{ percent }` (symmetric %) or `{ abs }` (symmetric absolute). Measured-in-band ⇒ **pass**; out-of-band ⇒ **fail**; a metric in the contract but not measured ⇒ **warn** ("not measured"); a measured metric with no acceptance target is skipped.

## Fast tuning before final verification

For repeated numeric feel tuning, prefer the backend tuning runner rhythm before producing the final
`feel.json`: enter Play Mode once, trial candidate serialized values live, reset/replay the same
measurement recipe after each candidate is applied, write `tuning-trials.json`, stop Play Mode, then
persist the selected passing value in Edit Mode with the backend persist helper. This keeps the tuning
loop out of repeated Play Mode/domain reload churn while preserving the final deterministic gate pass.
The helper verifies the property after setting it and refuses non-passing candidates unless explicitly
overridden.

Keep the runner config generic: locators, component names, property paths, candidates, and reset
steps belong in the tuning/session config, not in core verification code. If no reliable measurement
recipe exists for a metric yet, leave it as a warning/deferred item rather than substituting a visual
or subjective pass.

## Where each measurement comes from

**FeelHarness (in-process component)** measures deterministically on the physics timeline — Settle → Jump → Land → Run. It covers **only**:
- `runSpeed` (u/s), `jumpApex` (u), `timeToApex` (ms), and `shortHopApex` if run with the jump-cut latch.

Attach it and read its measured outputs. Do NOT drive input+sampling over MCP for these — the harness is the deterministic path. It must also emit one `provenance.sources[]` entry listing exactly the metrics it measured. Record `projectFixedTimestepBeforeMeasurement` **before** pinning time, then record `measurementFixedTimestep` after the harness pins `Time.fixedDeltaTime = 1 / captureFps`.

### FeelHarness.cs — author it verbatim with `unity_code_create_script`

Don't hunt for this in a reference project — `unity_code_create_script { name: "FeelHarness", contents: <below> }` so the build is self-contained. Runs the whole measurement inside Unity on the physics timeline (FixedUpdate), so it's frame-precise and independent of editor focus / wall-clock frame rate. It pins `Time.captureDeltaTime = Time.fixedDeltaTime` so game time advances a fixed amount per frame while the real `PlatformerPlayerController.FixedUpdate` keeps running in sync. Drives jump/run through the controller's real path (`forceJump` / `forceHorizontal`), so it assumes the locked `PlatformerPlayerController` exposes those public probe fields.

```csharp
using UnityEngine;

/// <summary>
/// In-process game-feel measurement harness (2D platformer: jump + run).
///
/// Runs the entire measurement inside Unity on the physics timeline (FixedUpdate),
/// so it is frame-precise, deterministic, and independent of editor focus or
/// wall-clock frame rate — the things that make MCP-driven measurement unreliable.
///
/// Determinism: pins Time.captureDeltaTime = Time.fixedDeltaTime so game time
/// advances a fixed amount per frame regardless of machine speed or window focus,
/// while the real PlatformerPlayerController.FixedUpdate keeps running in sync.
///
/// Sequence: settle -> jump (measure apex) -> land -> run (measure speed) -> done.
///
/// Agent workflow (all via existing MCP tools, no new bridge op):
///   1. attach this script to a GameObject; set config; set Player physics params
///   2. enter play mode -> Begin() auto-runs the measurement in FixedUpdate
///   3. poll feelStatus via component get_properties until "done"
///   4. read resultApexHeight / resultTimeToApexMs / resultRunSpeed
///   5. stop, compare to feel spec, tune params, repeat
/// </summary>
public class FeelHarness : MonoBehaviour
{
    [Header("Config (set by agent before play)")]
    public bool autoRun = true;
    [Tooltip("Pins Time.captureDeltaTime = 1/captureFps for deterministic, focus-independent capture. 0 disables.")]
    public int captureFps = 60;
    public int settleSteps = 30;       // fixed steps to settle on ground before jump
    public int maxMeasureSteps = 180;  // safety cap on the jump window
    public int postApexSteps = 8;      // keep sampling past detected apex
    public int runSettleSteps = 45;    // fixed steps to land/settle after the jump
    public int runRampSteps = 8;       // fixed steps to let horizontal velocity ramp before measuring
    public int runMeasureSteps = 44;   // total run steps (steady speed measured after the ramp)

    [Header("Result (read by agent after feelStatus == done)")]
    public string feelStatus = "idle"; // idle | running | done | error
    public float resultApexHeight;     // units, peak Y minus resting Y
    public float resultTimeToApexMs;   // launch -> apex, in ms of game time
    public float resultRunSpeed;       // units/sec steady horizontal speed
    public int resultApexStep;
    public int resultLaunchStep;
    public int resultSampleCount;
    public string resultMessage = "";

    private Rigidbody2D _body;
    private PlatformerPlayerController _player;

    private float _restoreFixedDeltaTime;
    private float _restoreCaptureDeltaTime;
    private bool _restoreRunInBackground;
    private bool _settingsPinned;

    private enum Phase { Idle, Settle, JumpMeasure, RunSettle, RunMeasure, Done }
    private Phase _phase = Phase.Idle;

    private int _stepInPhase;
    private float _startY;
    private float _peakY;
    private int _measureStep;
    private int _peakStep;
    private float _prevVy;
    private bool _launched;
    private bool _apexFound;
    private float _runStartX;

    private void Start()
    {
        if (autoRun)
            Begin();
    }

    public void Begin()
    {
        _player = FindPlayer();
        if (_player == null) { Fail("PlatformerPlayerController not found in scene"); return; }
        _body = _player.GetComponent<Rigidbody2D>();
        if (_body == null) { Fail("Player has no Rigidbody2D"); return; }

        _restoreFixedDeltaTime = Time.fixedDeltaTime;
        _restoreCaptureDeltaTime = Time.captureDeltaTime;
        _restoreRunInBackground = Application.runInBackground;
        if (captureFps > 0)
        {
            Time.fixedDeltaTime = 1f / captureFps;
            Time.captureDeltaTime = 1f / captureFps;
        }
        Application.runInBackground = true;
        _settingsPinned = true;

        feelStatus = "running";
        resultMessage = "";
        _phase = Phase.Settle;
        _stepInPhase = 0;
        _measureStep = 0;
        _launched = false;
        _apexFound = false;
        _peakStep = 0;
    }

    private void FixedUpdate()
    {
        switch (_phase)
        {
            case Phase.Settle:
                _stepInPhase++;
                if (_stepInPhase >= settleSteps)
                {
                    _startY = _body.position.y;
                    _peakY = _startY;
                    _prevVy = ReadVy();
                    _player.forceJump = true; // trigger via the controller's real jump path
                    _phase = Phase.JumpMeasure;
                    _measureStep = 0;
                }
                break;

            case Phase.JumpMeasure:
                _measureStep++;
                float y = _body.position.y;
                float vy = ReadVy();

                if (!_launched && vy > 0.01f)
                {
                    _launched = true;
                    resultLaunchStep = _measureStep;
                }
                if (y > _peakY) { _peakY = y; _peakStep = _measureStep; }
                if (_launched && !_apexFound && _prevVy > 0f && vy <= 0f)
                {
                    _apexFound = true;
                    resultApexStep = _measureStep;
                }
                _prevVy = vy;

                bool jumpDone = (_apexFound && _measureStep >= resultApexStep + postApexSteps)
                                || _measureStep >= maxMeasureSteps;
                if (jumpDone)
                {
                    FinishJump();
                    _phase = Phase.RunSettle;
                    _stepInPhase = 0;
                }
                break;

            case Phase.RunSettle:
                _stepInPhase++;
                if (_stepInPhase >= runSettleSteps)
                {
                    _player.forceHorizontal = 1f; // run right via the controller's real path
                    _phase = Phase.RunMeasure;
                    _stepInPhase = 0;
                }
                break;

            case Phase.RunMeasure:
                _stepInPhase++;
                // Capture the start position only after the ramp, so we measure steady-state
                // speed (the controller's Update->FixedUpdate takes a couple frames to reach moveSpeed).
                if (_stepInPhase == runRampSteps)
                    _runStartX = _body.position.x;

                if (_stepInPhase >= runMeasureSteps)
                {
                    int measuredSteps = runMeasureSteps - runRampSteps;
                    float dx = Mathf.Abs(_body.position.x - _runStartX);
                    float seconds = measuredSteps * Time.fixedDeltaTime;
                    resultRunSpeed = seconds > 0f ? dx / seconds : 0f;
                    _player.forceHorizontal = 0f;
                    FinishAll();
                }
                break;
        }
    }

    private void FinishJump()
    {
        int launchStep = _launched ? resultLaunchStep : 0;
        int apexStep = _apexFound ? resultApexStep : _peakStep;
        resultApexStep = apexStep;
        resultLaunchStep = launchStep;
        // Apex height is peak above the resting position (true jump height).
        resultApexHeight = _peakY - _startY;
        resultTimeToApexMs = Mathf.Max(0, apexStep - launchStep) * Time.fixedDeltaTime * 1000f;
        resultSampleCount = _measureStep;
    }

    private void FinishAll()
    {
        resultMessage = _apexFound
            ? "apex via vY zero-crossing"
            : (_launched ? "apex via max-Y (no crossing in window)" : "no launch detected — did the jump fire?");
        feelStatus = "done";
        _phase = Phase.Done;
        RestoreSettings();
    }

    private void Fail(string msg)
    {
        feelStatus = "error";
        resultMessage = msg;
        _phase = Phase.Done;
        RestoreSettings();
    }

    private void RestoreSettings()
    {
        if (!_settingsPinned) return;
        Time.fixedDeltaTime = _restoreFixedDeltaTime;
        Time.captureDeltaTime = _restoreCaptureDeltaTime;
        Application.runInBackground = _restoreRunInBackground;
        _settingsPinned = false;
    }

    private void OnDisable()
    {
        // Safety: never leave global time settings pinned if play stops mid-run.
        RestoreSettings();
    }

    private float ReadVy()
    {
#if UNITY_6000_0_OR_NEWER
        return _body.linearVelocity.y;
#else
        return _body.velocity.y;
#endif
    }

    private PlatformerPlayerController FindPlayer()
    {
#if UNITY_2023_1_OR_NEWER
        return Object.FindFirstObjectByType<PlatformerPlayerController>();
#else
        return Object.FindObjectOfType<PlatformerPlayerController>();
#endif
    }
}
```

**Attach and drive it.** In edit mode `unity_scene_create_object` a `FeelHarness` GameObject and `unity_code_attach_script` the script (`autoRun=true`, `captureFps=60` by default). Enter play mode; `Begin()` auto-runs in FixedUpdate. Because the sim is frozen between MCP calls (see the ticking note below), issue a `unity_runtime_probe` (any driver — even a no-op `forceHorizontal=0` phase) to push game-time forward, then `unity_component_get_properties { locator:{path:"/FeelHarness"}, type_name:"FeelHarness" }` and read `feelStatus`. Repeat probe → poll until `feelStatus == "done"`, then read `resultRunSpeed` (→ `runSpeed`), `resultApexHeight` (→ `jumpApex`), and `resultTimeToApexMs` (→ `timeToApex`) into `feel.json`, plus a `provenance.sources[]` entry with `source:"FeelHarness"`, positive `sampleCount`, `captureFps`, `measuredAt`, both timestep fields, and `measuredMetrics` listing only the emitted metrics.

> **The harness needs ticking.** Polling `feelStatus` does **not** advance FixedUpdate while the editor is backgrounded — the sim is frozen between MCP calls, so the harness never makes progress and `feelStatus` just repeats the same in-progress value. Issue a `unity_runtime_probe` (any driver, even a no-op `forceHorizontal=0` phase) to push game-time forward, then re-read `feelStatus`. Repeat probe → poll until the harness reports complete. (Same sim-throttle rule as everywhere in this skill.)

**`unity_runtime_probe` recipes** cover the rest the harness doesn't (same sim-throttle rule as playability — physics-timeline phases, not real-time waits; state persists between calls):
- `dashDistance` (u): probe `forceDash` for the dash window, measure ΔX (player X before vs after), then compare it to the contract target.
  - **Isolate the dash segment.** Whole-phase ΔX **overstates** dash distance because it folds in the run-ramp before the dash and any drift after. Measure ΔX over *exactly* the `dashTime` window, OR read `includeSamples` and isolate the constant-velocity (~`dashSpeed`) segment — the flat-velocity span is the dash itself; the accelerating lead-in is the run ramp. Compare *that* delta to the target.
- `shortHopApex` (u): probe `forceJump` then `forceJumpCut` (release early at the first rising frame), measure peak Y above resting. Target 0.72u.
  - **Use the probe, NOT the FeelHarness HopMeasure** (S4b finding). The in-process harness pins capture = physics (60Hz), so its short-hop cut is **frame-quantized** — at `jumpCutMultiplier 0.5` it jumps {0.475, 0.858, 1.011}u with no step landing in the tight ±10% band (and it has emitted absurd values like 6.33u). The behavioral `runtime.probe` peak-Y at a **finer sampling rate (`captureFps:120`, `includeSamples:true`)** resolves the true shortest hop (~0.698u, in band) on the shipped controller. `shortHopApex` is co-owned by `runtime.probe` in the `feel-provenance` gate so the probe source certifies it; a `captureFps` that is a finer integer multiple of the 60Hz physics passes `physics-timestep`. **Never detune the controller to make a frame-quantized measurement pass** — fix the measurement (the probe), not the game.
- `coyoteTime` (s): timed probe phases around leaving-ground — leave the ledge, then `forceJump` after a delay; the max delay that still jumps is the coyote window. Target 0.1s (±0.02 abs).
- `jumpBuffer` (s): `forceJump` slightly *before* landing; the max early-press that still triggers on touchdown is the buffer. Target 0.1s (±0.02 abs).
  - **Precision caveat for coyote + jumpBuffer.** At 60Hz FixedUpdate the window quantizes to ~16.7ms per step ≈ the whole ±0.02s tolerance band, so a single behavioral pass/fail probe is **not trustworthy** (one frame of jitter flips the result). **Bisect over the delay** to find the actual boundary (the largest delay that still jumps) and compare that boundary to the target. **Do NOT read the serialized `coyoteTime`/`jumpBufferTime` parameter off the controller and report it as the measured value** — that is a self-grade (the value trivially equals the target because both equal the param), and `feel-provenance` proves a source *claims* to have measured a metric, NOT that the value was *behaviorally derived*. If you genuinely cannot bisect a metric, OMIT it (the gate warns on an unmeasured metric) rather than report a param-read as a measurement.
- (camera feel, optional): probe `forceHorizontal` then `0`, measure the camera transform look-ahead/settle.

Assemble all measured values into `feel.json` and save it. Probe-sourced metrics must add a separate
`provenance.sources[]` entry with `source:"runtime.probe"` and `measuredMetrics` listing exactly the
metrics the probe measured. A source that lists only harness metrics does **not** certify dash/coyote/buffer;
`feel-provenance` fails those metrics. `physics-timestep` also reads these same sources and checks both
`projectFixedTimestepBeforeMeasurement` and `measurementFixedTimestep` against `acceptance.physics.fixedTimestep`.

## Verifying transient FX (juice puffs / bursts) — pin them to catch them

A juice puff fades in ~240ms (`DustPuff.lifetime`), and a burst is gone in a few frames. That makes them
**nearly impossible to catch over the bridge**: (i) the sim throttles between MCP calls (same rule as
above), so the FX fades to nothing before your next `find_object` / `get_bounds` query lands; and (ii)
you can't reliably *place* the player on the hazard/trampoline that triggers it — `unity_scene_set_transform`
does **NOT** reliably move a *dynamic Rigidbody2D* in play mode (the physics step snaps it back), so a
teleport doesn't take. Two techniques make transient FX verifiable:

**Pin the effect so it persists.** Temporarily neutralize the FX's self-destruct/motion so the spawned
object STAYS at its spawn point, then measure WHERE it spawned, then revert:
- Raise the transient component's `lifetime` high (e.g. `30`) and zero its motion — `riseSpeed = 0` and
  any `drift`/`endScale` change — via `unity_component_set_property` (or a temp edit to the `.cs`). Now
  the spawned `DustPuff`/burst object persists, frozen at its spawn position.
- Trigger it (drive the player onto the trampoline/hazard — see below), then `unity_scene_find_object`
  for the spawned object (e.g. name `DustPuff`) and `unity_scene_get_bounds` it to confirm its **spawn
  location**. A trampoline-launch puff should sit at the **player's feet ≈ ground/pad surface**, NOT
  floating up at the pad top or mid-air — exactly the `juice-cue-presence` "launch dust anchored to feet,
  not mid-air" rubric.
- **Revert** the pinned values afterward (restore `lifetime` / `riseSpeed`) so the build ships its real
  short-lived FX. Same trick as raising `DashTrail.holdAfterDash` to freeze the dash ghosts long enough to
  count + color-check them.

**Drive, don't teleport.** To reach the hazard/trampoline that spawns the FX, move the player with
`unity_runtime_probe` forces (`forceHorizontal`, `forceDash`) on the physics timeline — NOT
`unity_scene_set_transform`. A dynamic-rigidbody player teleported by set_transform gets snapped back by
the next physics step and never actually arrives; probe forces drive it through the controller's real
path (same driver the feel probes use), so it genuinely lands on the pad/spike and the trigger fires.

Cross-references the **`juice-cue-presence`** rubric (`vlm-review.md`): a hit/impact particle is present
AT the hazard contact on death, and trampoline launch dust is anchored to the pad surface / feet contact,
not floating mid-air above the pad.

## Contract-conformant example

With on-target measurements for every metric declared in `acceptance.feel`, every `feel.*` check passes
and the gate verdict is **pass**. An out-of-band measured metric flips that check to **fail**; an
unmeasured declared metric is a **warn**, never a fail.
