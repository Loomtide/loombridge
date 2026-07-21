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
/// while the real PlayerController.FixedUpdate keeps running in sync.
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
    private PlayerController _player;

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
        if (_player == null) { Fail("PlayerController not found in scene"); return; }
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

    private PlayerController FindPlayer()
    {
#if UNITY_2023_1_OR_NEWER
        return Object.FindFirstObjectByType<PlayerController>();
#else
        return Object.FindObjectOfType<PlayerController>();
#endif
    }
}
