# Modal end-state controller

Use this when a 2D game has a win/lose/result overlay. The overlay is not enough: after the card
appears, gameplay must stop mutating behind it unless the acceptance contract explicitly declares
`win.endStateMode: "continuous"`.

## Default behavior

Most polished 2D games should use a **modal** end state:

- Enter `Won` or `Lost` once, guarded by a `RunState` / `GameState` enum.
- Disable gameplay input immediately. UI input for restart/continue/menu remains live.
- Freeze player motion: zero velocity and skip controller movement while not `Playing`.
- Stop hazards, pickups, timers, enemy AI, camera follow side effects, and score/life changes from mutating run state.
- Show the styled `EndCard` from `juice.md` above a full-screen dim.
- Provide a visible restart affordance (commonly `R`, `Enter`, or a button) and wire it to reset the run/scene.

Prefer a logical freeze over setting `Time.timeScale = 0`. If you do use `timeScale = 0`, make restart
and UI animation use unscaled time, and restore `timeScale = 1` before leaving the state.

## Drop-in pattern

Keep this small and game-owned. The exact names can vary, but the state checks must be shared by all
gameplay systems.

```csharp
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.SceneManagement;

public enum RunState
{
    Playing,
    Won,
    Lost,
}

public class EndStateController : MonoBehaviour
{
    public static EndStateController Instance { get; private set; }

    public RunState State { get; private set; } = RunState.Playing;
    public bool IsPlaying => State == RunState.Playing;
    public bool IsEnded => State == RunState.Won || State == RunState.Lost;

    [Header("Wire in scene")]
    public Rigidbody2D playerBody;
    public MonoBehaviour playerController;
    public EndCard endCard;

    [Header("Restart")]
    public Key restartKey = Key.R;

    private bool _prevRestartHeld;

    private void Awake()
    {
        Instance = this;
    }

    private void Update()
    {
        KeyControl restartControl = Keyboard.current?[restartKey];
        bool restartHeld = restartControl != null && restartControl.isPressed;
        bool restartPressed = restartHeld && !_prevRestartHeld;
        _prevRestartHeld = restartHeld;

        if (IsEnded && restartPressed)
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene(SceneManager.GetActiveScene().buildIndex);
        }
    }

    public void Win()
    {
        EnterEnded(RunState.Won, "YOU WIN!", true);
    }

    public void Lose()
    {
        EnterEnded(RunState.Lost, "GAME OVER", false);
    }

    private void EnterEnded(RunState state, string message, bool win)
    {
        if (State != RunState.Playing)
            return;

        State = state;

        if (playerBody != null)
        {
#if UNITY_6000_0_OR_NEWER
            playerBody.linearVelocity = Vector2.zero;
#else
            playerBody.velocity = Vector2.zero;
#endif
            playerBody.angularVelocity = 0f;
        }

        if (playerController != null)
            playerController.enabled = false;

        if (endCard != null)
            endCard.Show(message, win);
    }
}
```

If replacing an older copy of this component that used a `KeyCode restartKey` field, re-assign the
restart key in the Inspector after updating the script. Unity will not reliably preserve a serialized
enum value when the field type changes from `KeyCode` to Input System `Key`.

## Wire gameplay systems

Every mutable gameplay script should early-return when the run has ended:

```csharp
if (EndStateController.Instance != null && !EndStateController.Instance.IsPlaying)
    return;
```

Apply that guard in:

- player controller input and movement,
- hazards before damage/life decrement,
- collectibles before score increment,
- timers/countdowns,
- enemies/projectiles,
- camera follow if a post-win camera drift is not part of the contract.

## Verification hook

For `verify-2d-game`, record these in `playability.json` after driving to win/lose:

```json
{
  "postWinInputLocked": true,
  "postWinPlayerFrozen": true,
  "restartWorks": true
}
```

To measure them, record player position/velocity at the first end-state frame, drive normal movement
input for about 0.5s with `unity_runtime_probe`, then assert position/score/lives did not change. Press
or invoke the declared restart action and assert the game returns to `Playing` near the spawn.
