# PlatformerPlayerController: reusable feel controller

Drop this controller into platformer slices that need verified movement feel. It is extracted from the
demo `PlayerController` mechanics but intentionally has no demo gameplay dependencies: no `GameManager`,
no `DustPuff`, no collectible/enemy name-prefix scoring, and no scene-specific object names. Gameplay
slices wire hazards, pickups, SFX, animation, and dust through optional events or companion components.

Required companion components: `Rigidbody2D` and a non-trigger `Collider2D` on the same GameObject.
Optional companions: `DashTrail` reads `IsDashing`; `CharacterAnimator2D` reads velocity/grounded state;
hazard/pickup scripts may call `Respawn()` or subscribe to trigger/collision events.

This controller is **Input-System-only**. The project must include `com.unity.inputsystem` and Active
Input Handling must be Input System or Both. Do not add legacy `UnityEngine.Input` fallbacks:
Loombridge cannot input-drive `Input.GetAxis` / `Input.GetButton` polling.

```csharp
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.InputSystem;

[RequireComponent(typeof(Rigidbody2D))]
[RequireComponent(typeof(Collider2D))]
public class PlatformerPlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 7f;
    [SerializeField] private float jumpSpeed = 14.22f;

    [Header("Variable Jump")]
    [SerializeField, Range(0f, 1f)] private float jumpCutMultiplier = 0.5f;

    [Header("Coyote / Buffer")]
    [SerializeField] private float coyoteTime = 0.1f;
    [SerializeField] private float jumpBufferTime = 0.1f;

    [Header("Air Dash")]
    [SerializeField] private float dashSpeed = 18.75f;
    [SerializeField] private float dashTime = 0.15f;
    [SerializeField] private float dashCooldown = 0.4f;

    [Header("Ground Check")]
    [SerializeField] private float groundCheckDistance = 0.15f;
    [SerializeField] private LayerMask groundLayers = ~0;

    [Header("Optional Hooks")]
    public UnityEvent onJumped;
    public UnityEvent onDashStarted;
    public UnityEvent onLanded;
    public UnityEvent onRespawned;
    public UnityEvent<Collider2D> onTriggerEntered;
    public UnityEvent<Collision2D> onCollisionEntered;

    public bool forceJump;
    public float forceHorizontal;
    public bool forceDash;
    public bool forceJumpCut;

    public bool IsDashing => _isDashing;
    public bool IsGroundedNow => IsGrounded();
    public float MoveSpeed { get => moveSpeed; set => moveSpeed = value; }
    public float JumpSpeed { get => jumpSpeed; set => jumpSpeed = value; }
    public float JumpCutMultiplier { get => jumpCutMultiplier; set => jumpCutMultiplier = Mathf.Clamp01(value); }
    public float CoyoteTime { get => coyoteTime; set => coyoteTime = Mathf.Max(0f, value); }
    public float JumpBufferTime { get => jumpBufferTime; set => jumpBufferTime = Mathf.Max(0f, value); }
    public float DashSpeed { get => dashSpeed; set => dashSpeed = Mathf.Max(0f, value); }
    public float DashTime { get => dashTime; set => dashTime = Mathf.Max(0f, value); }
    public float DashCooldown { get => dashCooldown; set => dashCooldown = Mathf.Max(0f, value); }

    private Rigidbody2D _rb;
    private Collider2D _col;
    private Vector3 _spawnPoint;
    private float _horizontal;
    private bool _jumpQueued;
    private bool _jumpHeld;
    private bool _prevJumpHeld;
    private bool _isJumping;
    private bool _cutJumpRequested;
    private bool _dashQueued;
    private bool _prevSpace, _prevUp, _prevW;
    private bool _prevDashShift, _prevDashX, _prevDashK;
    private float _coyoteUntil;
    private float _jumpBufferedUntil;
    private int _facing = 1;
    private bool _isDashing;
    private float _dashEndsAt;
    private float _dashReadyAt;
    private int _dashDir = 1;
    private bool _dashUsedThisAir;
    private float _savedGravityScale = 1f;
    private bool _wasGrounded = true;

    private void Awake()
    {
        _rb = GetComponent<Rigidbody2D>();
        _col = GetComponent<Collider2D>();
        _spawnPoint = transform.position;
        _savedGravityScale = _rb.gravityScale;
    }

    private void Update()
    {
        _horizontal = ReadHorizontal();
        if (Mathf.Abs(_horizontal) > 0.001f) _facing = _horizontal > 0f ? 1 : -1;

        bool jumpPressed = ReadJumpPressed();
        _jumpHeld = ReadJumpHeld();
        if (forceJump)
        {
            jumpPressed = true;
            _prevJumpHeld = true;
            forceJump = false;
        }

        if (_isJumping && _prevJumpHeld && !_jumpHeld) _cutJumpRequested = true;
        _prevJumpHeld = _jumpHeld;
        if (forceJumpCut && _isJumping) _cutJumpRequested = true;

        if (jumpPressed)
        {
            _jumpQueued = true;
            _jumpBufferedUntil = Time.time + jumpBufferTime;
        }

        bool dashPressed = ReadDashPressed();
        if (forceDash)
        {
            dashPressed = true;
            forceDash = false;
        }
        if (dashPressed) _dashQueued = true;
    }

    private void FixedUpdate()
    {
        Vector2 velocity = ReadVelocity();
        bool grounded = IsGrounded();
        if (!_wasGrounded && grounded) onLanded?.Invoke();
        _wasGrounded = grounded;

        if (grounded)
        {
            _coyoteUntil = Time.time + coyoteTime;
            _dashUsedThisAir = false;
        }

        if (_isDashing)
        {
            if (Time.time >= _dashEndsAt) EndDash(ref velocity);
            else
            {
                velocity.x = _dashDir * dashSpeed;
                velocity.y = 0f;
                WriteVelocity(velocity);
                _dashQueued = false;
                return;
            }
        }

        if (_dashQueued && CanDash())
        {
            BeginDash(ref velocity);
            WriteVelocity(velocity);
            _dashQueued = false;
            return;
        }
        _dashQueued = false;

        velocity.x = _horizontal * moveSpeed;

        // Wall guard: don't drive horizontal velocity INTO a wall the body can't
        // enter. Continuously pushing a box into a wall under Continuous collision
        // detection forms a persistent speculative contact that kills the tangential
        // (vertical) velocity — the body PINS to the wall instead of sliding down
        // (the classic "stuck to the wall while holding toward it"). Discrete avoids
        // it but tunnels at high gravity; zeroing the into-wall component is the fix.
        if (velocity.x != 0f && IsTouchingWall(velocity.x > 0f ? 1 : -1)) velocity.x = 0f;

        bool wantsJump = _jumpQueued && Time.time <= _jumpBufferedUntil;
        bool canJump = grounded || Time.time <= _coyoteUntil;
        if (wantsJump && canJump)
        {
            velocity.y = jumpSpeed;
            _isJumping = true;
            _jumpQueued = false;
            _jumpBufferedUntil = 0f;
            _coyoteUntil = 0f;
            onJumped?.Invoke();
        }
        else if (!wantsJump)
        {
            _jumpQueued = false;
        }

        if (_cutJumpRequested)
        {
            if (velocity.y > 0f) velocity.y *= jumpCutMultiplier;
            _cutJumpRequested = false;
            forceJumpCut = false;
        }
        if (velocity.y <= 0f) _isJumping = false;

        WriteVelocity(velocity);
    }

    private bool CanDash()
    {
        return !_dashUsedThisAir && Time.time >= _dashReadyAt;
    }

    private void BeginDash(ref Vector2 velocity)
    {
        _isDashing = true;
        _dashEndsAt = Time.time + dashTime;
        _dashReadyAt = Time.time + dashTime + dashCooldown;
        _dashDir = Mathf.Abs(_horizontal) > 0.001f ? (_horizontal > 0f ? 1 : -1) : _facing;
        _dashUsedThisAir = true;
        _savedGravityScale = _rb.gravityScale;
        _rb.gravityScale = 0f;
        velocity.x = _dashDir * dashSpeed;
        velocity.y = 0f;
        onDashStarted?.Invoke();
    }

    private void EndDash(ref Vector2 velocity)
    {
        _isDashing = false;
        _rb.gravityScale = _savedGravityScale;
        velocity.x = _horizontal * moveSpeed;
        velocity.y = 0f;
    }

    public void Respawn()
    {
        transform.position = _spawnPoint;
        WriteVelocity(Vector2.zero);
        if (_isDashing) _rb.gravityScale = _savedGravityScale;
        _isDashing = false;
        _dashUsedThisAir = false;
        _jumpQueued = false;
        _dashQueued = false;
        _isJumping = false;
        _cutJumpRequested = false;
        _prevJumpHeld = false;
        _coyoteUntil = 0f;
        _jumpBufferedUntil = 0f;
        _dashReadyAt = 0f;
        onRespawned?.Invoke();
    }

    public void LaunchUp(float speed)
    {
        Vector2 velocity = ReadVelocity();
        velocity.y = speed;
        WriteVelocity(velocity);
        _isJumping = false;
        _dashUsedThisAir = false;
    }

    private float ReadHorizontal()
    {
        if (Mathf.Abs(forceHorizontal) > 0.001f) return Mathf.Sign(forceHorizontal);
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            float input = 0f;
            if (kb.leftArrowKey.isPressed || kb.aKey.isPressed) input -= 1f;
            if (kb.rightArrowKey.isPressed || kb.dKey.isPressed) input += 1f;
            if (Mathf.Abs(input) > 0f) return input;
        }
        return 0f;
    }

    private bool ReadJumpPressed()
    {
        bool edge = false;
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            edge |= RisingEdge(kb.spaceKey.isPressed, ref _prevSpace);
            edge |= RisingEdge(kb.upArrowKey.isPressed, ref _prevUp);
            edge |= RisingEdge(kb.wKey.isPressed, ref _prevW);
        }
        return edge;
    }

    private bool ReadJumpHeld()
    {
        Keyboard kb = Keyboard.current;
        if (kb != null && (kb.spaceKey.isPressed || kb.upArrowKey.isPressed || kb.wKey.isPressed)) return true;
        return false;
    }

    private bool ReadDashPressed()
    {
        bool edge = false;
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            edge |= RisingEdge(kb.leftShiftKey.isPressed, ref _prevDashShift);
            edge |= RisingEdge(kb.xKey.isPressed, ref _prevDashX);
            edge |= RisingEdge(kb.kKey.isPressed, ref _prevDashK);
        }
        return edge;
    }

    private static bool RisingEdge(bool now, ref bool prev)
    {
        bool rising = now && !prev;
        prev = now;
        return rising;
    }

    private bool IsGrounded()
    {
        Bounds bounds = _col.bounds;
        Vector2 center = new Vector2(bounds.center.x, bounds.min.y - groundCheckDistance * 0.5f);
        Vector2 size = new Vector2(bounds.size.x * 0.9f, groundCheckDistance + bounds.size.y * 0.1f);
        Collider2D[] hits = Physics2D.OverlapBoxAll(center, size, 0f, groundLayers);
        foreach (Collider2D hit in hits)
        {
            if (hit != null && hit.gameObject != gameObject && !hit.isTrigger) return true;
        }
        return false;
    }

    // A solid (non-trigger) collider immediately to the side `dir` (+1 right, -1 left),
    // sampled over the player's mid-height so the ground it stands ON is not counted as
    // a wall. The wall guard in FixedUpdate uses this to avoid pinning into walls.
    private bool IsTouchingWall(int dir)
    {
        if (dir == 0) return false;
        Bounds bounds = _col.bounds;
        const float skin = 0.04f;
        Vector2 center = new Vector2(bounds.center.x + dir * (bounds.extents.x + skin * 0.5f), bounds.center.y);
        Vector2 size = new Vector2(skin, bounds.size.y * 0.8f);
        Collider2D[] hits = Physics2D.OverlapBoxAll(center, size, 0f, groundLayers);
        foreach (Collider2D hit in hits)
        {
            if (hit != null && hit.gameObject != gameObject && !hit.isTrigger) return true;
        }
        return false;
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        onCollisionEntered?.Invoke(collision);
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        onTriggerEntered?.Invoke(other);
    }

    private Vector2 ReadVelocity()
    {
#if UNITY_6000_0_OR_NEWER
        return _rb.linearVelocity;
#else
        return _rb.velocity;
#endif
    }

    private void WriteVelocity(Vector2 value)
    {
#if UNITY_6000_0_OR_NEWER
        _rb.linearVelocity = value;
#else
        _rb.velocity = value;
#endif
    }
}
```

## Verification Contract

`FeelHarness` owns `runSpeed`, `jumpApex`, `timeToApex`, and `shortHopApex`.
`runtime.probe` owns `dashDistance`, `coyoteTime`, and `jumpBuffer`.

Final `feel.json` must include `provenance.sources[]`:

```json
{
  "provenance": {
    "sources": [{
      "source": "FeelHarness",
      "sampleCount": 180,
      "captureFps": 60,
      "measuredAt": "2026-05-31T00:00:00.000Z",
      "projectFixedTimestepBeforeMeasurement": 0.0166667,
      "measurementFixedTimestep": 0.0166667,
      "measuredMetrics": ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"]
    }]
  }
}
```
