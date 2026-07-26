using UnityEngine;

#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif
#if UNITY_EDITOR
using UnityEditor;
#endif

public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    // Tuned to the Tiderunner feel targets (run 7 u/s; jump apex 2.2u @ ~330ms
    // with Rigidbody2D gravityScale 4.402). Verified via runtime.probe.
    [SerializeField] private float moveSpeed = 7f;
    [SerializeField] private float jumpSpeed = 14.22f;

    [Header("Variable Jump")]
    // Releasing the jump key while still rising cuts upward velocity (Celeste-style
    // short hop). Hold the key to keep the full apex.
    [SerializeField, Range(0f, 1f)] private float jumpCutMultiplier = 0.5f;

    [Header("Coyote / Buffer")]
    // Window after leaving the ground during which a jump still fires.
    [SerializeField] private float coyoteTime = 0.1f;
    // Window before landing during which a queued jump press is remembered.
    [SerializeField] private float jumpBufferTime = 0.1f;

    [Header("Air Dash")]
    // 18.75 u/s over 8 FixedUpdate steps (~0.15s @ 50Hz) = 3.0u. Verified via probe.
    [SerializeField] private float dashSpeed = 18.75f;
    [SerializeField] private float dashTime = 0.15f;
    [SerializeField] private float dashCooldown = 0.4f;

    [Header("Ground Check")]
    [SerializeField] private float groundCheckDistance = 0.15f;
    [SerializeField] private LayerMask groundLayers = ~0;

    [Header("Detection")]
    [SerializeField] private string enemyNamePrefix = "Enemy";
    [SerializeField] private string coinNamePrefix = "Coin";

    [Header("References")]
    public GameManager gameManager;

    [Header("Juice (optional)")]
    [Tooltip("Dust sprite asset path (loaded in editor); spawned at the feet on landing.")]
    public string landingDustSheet;
    [Tooltip("Dust puff sprite spawned at the feet when the player lands from a fall.")]
    public Sprite landingDustSprite;
    [Tooltip("Min downward speed at touchdown to spawn landing dust.")]
    public float landingDustMinSpeed = 3f;

    // MCP testing: set to true via unity_component_set_property to trigger jump
    public bool forceJump;

    // MCP/harness testing: when nonzero, overrides horizontal input (sign = direction).
    public float forceHorizontal;

    // MCP testing: set to true via unity_component_set_property to trigger a dash
    // (mirrors forceJump). Direction = current facing (or forceHorizontal sign).
    public bool forceDash;

    // MCP/harness testing: latch a variable-jump cut (mirrors the jump-key release
    // edge) WITHOUT synthetic keypresses. When true, the controller applies a single
    // cut on the first rising FixedUpdate of the active jump, then clears the latch.
    // Set it before firing forceJump to verify the short-hop deterministically.
    public bool forceJumpCut;

    private Rigidbody2D rb;
    private Collider2D col;
    private Vector3 spawnPoint;
    private float _horizontal;
    private bool _jumpQueued;
    private bool _jumpHeld;       // is any jump key currently held this frame
    private bool _prevJumpHeld;   // held state last Update (for release-edge detection)
    private bool _isJumping;      // a jump is in progress and still cuttable (rising)
    private bool _cutJumpRequested; // one-shot: release edge while rising -> cut once
    private bool _dashQueued;
    private bool _prevSpace, _prevUp, _prevW, _prevJumpButton;
    private bool _prevDashShift, _prevDashX, _prevDashK, _prevDashButton;

    // Feel state (Time.time-stamped windows; FixedUpdate-driven).
    private float _coyoteUntil;       // can still jump until this time after leaving ground
    private float _jumpBufferedUntil; // a pressed jump is valid until this time
    private int _facing = 1;          // last non-zero horizontal direction

    // Dash state
    private bool _isDashing;
    /// <summary>True while an air/ground dash is active — read by DashTrail for afterimages.</summary>
    public bool IsDashing => _isDashing;
    private float _dashEndsAt;
    private float _dashReadyAt;
    private int _dashDir = 1;
    private bool _dashUsedThisAir;    // one dash per airtime; refills on ground
    private float _savedGravityScale; // restored after dash gravity suspension

    // Landing-dust juice state.
    private bool _wasGrounded = true;
    private float _lastFallSpeed;     // most-recent downward speed while airborne

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        col = GetComponent<Collider2D>();
        _savedGravityScale = rb != null ? rb.gravityScale : 1f;
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(landingDustSheet)) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null || string.IsNullOrEmpty(landingDustSheet)) return;
            foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(landingDustSheet))
            {
                if (obj is Sprite s) { landingDustSprite = s; break; }
            }
        };
    }
#endif

    private void Start()
    {
        spawnPoint = transform.position;
        if (gameManager == null)
            gameManager = GameManager.Instance;

        if (UnityEngine.EventSystems.EventSystem.current != null)
            UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(null);
    }

    private void Update()
    {
        _horizontal = ReadHorizontal();
        if (Mathf.Abs(_horizontal) > 0.001f)
            _facing = _horizontal > 0f ? 1 : -1;

        bool jumpPressed = ReadJumpPressed();
        _jumpHeld = ReadJumpHeld();

        if (forceJump)
        {
            // A forced jump models a full hold: no key to release, so it must never
            // be cut. We leave _isJumping enabled but suppress the release edge below.
            jumpPressed = true;
            _prevJumpHeld = true; // pretend it was held last frame -> no release edge
            forceJump = false;
        }

        // Variable-height cut fires ONCE on the release edge while still rising — not
        // every frame the key is up (that would zero the apex). FixedUpdate consumes it.
        if (_isJumping && _prevJumpHeld && !_jumpHeld)
            _cutJumpRequested = true;
        _prevJumpHeld = _jumpHeld;

        // Harness hook: a latched cut models the release edge for the active jump
        // (probe-drivable, key-free). Consumed in FixedUpdate when the cut applies.
        if (forceJumpCut && _isJumping)
            _cutJumpRequested = true;

        // Stamp the buffer on a fresh press; FixedUpdate consumes it when grounded
        // (or within coyote). Surviving across frames is what makes early presses land.
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
        if (dashPressed)
            _dashQueued = true;
    }

    private void FixedUpdate()
    {
        Vector2 velocity = ReadVelocity();
        bool grounded = IsGrounded();

        // Landing detection: a touchdown after a fast fall emits landing dust.
        // (Mock cue: screen shake fires on a HIT only — no shake on a normal landing.)
        if (!_wasGrounded && grounded && _lastFallSpeed >= landingDustMinSpeed)
        {
            SpawnLandingDust();
        }
        if (!grounded && velocity.y < 0f)
            _lastFallSpeed = -velocity.y;
        _wasGrounded = grounded;

        // Refill resources on the ground.
        if (grounded)
        {
            _coyoteUntil = Time.time + coyoteTime;
            _dashUsedThisAir = false;
        }

        // --- Dash (overrides normal movement while active) -----------------
        if (_isDashing)
        {
            if (Time.time >= _dashEndsAt)
                EndDash(ref velocity);
            else
            {
                velocity.x = _dashDir * dashSpeed;
                velocity.y = 0f; // brief gravity suspension: flat, snappy dash
                WriteVelocity(velocity);
                _dashQueued = false;
                return;
            }
        }

        // Start a queued dash if allowed (one per airtime, off cooldown).
        if (_dashQueued && CanDash())
        {
            BeginDash(ref velocity, grounded);
            WriteVelocity(velocity);
            _dashQueued = false;
            return;
        }
        _dashQueued = false;

        // --- Horizontal ----------------------------------------------------
        velocity.x = _horizontal * moveSpeed;

        // --- Jump (coyote + buffer) ----------------------------------------
        bool wantsJump = _jumpQueued && Time.time <= _jumpBufferedUntil;
        bool canJump = grounded || Time.time <= _coyoteUntil;
        if (wantsJump && canJump)
        {
            velocity.y = jumpSpeed;
            _isJumping = true;       // now cuttable until it stops rising
            _jumpQueued = false;
            _jumpBufferedUntil = 0f; // consume buffer
            _coyoteUntil = 0f;       // consume coyote so it cannot double-fire
        }
        else if (!wantsJump)
        {
            _jumpQueued = false; // expired buffer
        }

        // --- Variable-height jump cut --------------------------------------
        // A pending release-edge cut clips upward velocity ONCE (Celeste short hop).
        if (_cutJumpRequested)
        {
            if (velocity.y > 0f)
                velocity.y *= jumpCutMultiplier;
            _cutJumpRequested = false;
            forceJumpCut = false; // clear the harness latch once honored
        }

        // Stop tracking the jump once we're no longer rising (can't be cut anymore).
        if (velocity.y <= 0f)
            _isJumping = false;

        WriteVelocity(velocity);
    }

    private bool CanDash()
    {
        return !_dashUsedThisAir && Time.time >= _dashReadyAt;
    }

    private void BeginDash(ref Vector2 velocity, bool grounded)
    {
        _isDashing = true;
        _dashEndsAt = Time.time + dashTime;
        _dashReadyAt = Time.time + dashTime + dashCooldown;
        _dashDir = (Mathf.Abs(_horizontal) > 0.001f) ? (_horizontal > 0f ? 1 : -1) : _facing;
        _dashUsedThisAir = true;

        _savedGravityScale = rb.gravityScale;
        rb.gravityScale = 0f; // suspend gravity for the dash window

        velocity.x = _dashDir * dashSpeed;
        velocity.y = 0f;
    }

    private void EndDash(ref Vector2 velocity)
    {
        _isDashing = false;
        rb.gravityScale = _savedGravityScale;
        // Hand off cleanly: hand horizontal control back to the player and drop the
        // dash's vertical hold so gravity resumes from rest (no launch on exit).
        velocity.x = _horizontal * moveSpeed;
        velocity.y = 0f;
    }

    private float ReadHorizontal()
    {
        if (Mathf.Abs(forceHorizontal) > 0.001f)
            return Mathf.Sign(forceHorizontal);
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            float input = 0f;
            if (kb.leftArrowKey.isPressed || kb.aKey.isPressed) input -= 1f;
            if (kb.rightArrowKey.isPressed || kb.dKey.isPressed) input += 1f;
            if (Mathf.Abs(input) > 0f) return input;
        }
#endif
        return Input.GetAxisRaw("Horizontal");
    }

    private bool ReadJumpPressed()
    {
        // Per-key rising-edge detection: ANY newly-pressed jump key triggers a jump, so
        // holding one jump key (e.g. W) no longer masks another (e.g. Space). Uses
        // isPressed (not wasPressedThisFrame) to stay robust to MCP double-Update.
        bool edge = false;
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            edge |= RisingEdge(kb.spaceKey.isPressed, ref _prevSpace);
            edge |= RisingEdge(kb.upArrowKey.isPressed, ref _prevUp);
            edge |= RisingEdge(kb.wKey.isPressed, ref _prevW);
        }
#endif
        edge |= RisingEdge(Input.GetButton("Jump"), ref _prevJumpButton);
        return edge;
    }

    private bool ReadJumpHeld()
    {
        // Held state for variable-height jump cut (the inverse of the rising edge).
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            if (kb.spaceKey.isPressed || kb.upArrowKey.isPressed || kb.wKey.isPressed)
                return true;
        }
#endif
        return Input.GetButton("Jump");
    }

    private bool ReadDashPressed()
    {
        // Per-key rising edge, mirroring ReadJumpPressed. Bound to Left Shift / X / K
        // plus the legacy "Fire3" button. isPressed (not wasPressedThisFrame) for
        // robustness to MCP double-Update.
        bool edge = false;
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            edge |= RisingEdge(kb.leftShiftKey.isPressed, ref _prevDashShift);
            edge |= RisingEdge(kb.xKey.isPressed, ref _prevDashX);
            edge |= RisingEdge(kb.kKey.isPressed, ref _prevDashK);
        }
#endif
        edge |= RisingEdge(Input.GetButton("Fire3"), ref _prevDashButton);
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
        if (col == null) return false;
        // Width-spanning overlap just below the feet. OverlapBoxAll + self/trigger
        // exclusion is robust to the small contact gap (~0.015u) that a single thin
        // raycast misses on scaled box colliders.
        Bounds b = col.bounds;
        Vector2 boxCenter = new Vector2(b.center.x, b.min.y - groundCheckDistance * 0.5f);
        Vector2 boxSize = new Vector2(b.size.x * 0.9f, groundCheckDistance + b.size.y * 0.1f);
        Collider2D[] hits = Physics2D.OverlapBoxAll(boxCenter, boxSize, 0f, groundLayers);
        foreach (Collider2D h in hits)
        {
            if (h != null && h.gameObject != gameObject && !h.isTrigger)
                return true;
        }
        return false;
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (collision.gameObject.name.StartsWith(enemyNamePrefix))
        {
            if (gameManager != null) gameManager.PlayerDied();
            Respawn();
        }
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (other.gameObject.name.StartsWith(coinNamePrefix))
        {
            if (gameManager != null) gameManager.AddScore(1);
            Destroy(other.gameObject);
        }
    }

    public void Respawn()
    {
        transform.position = spawnPoint;
        WriteVelocity(Vector2.zero);
        // Reset feel state so a respawn is a clean slate.
        if (_isDashing && rb != null) rb.gravityScale = _savedGravityScale;
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
    }

    /// <summary>Trampoline / bounce-pad launch: override vertical velocity upward and
    /// refill the air dash so the boost reads as a fresh hop.</summary>
    public void LaunchUp(float speed)
    {
        Vector2 v = ReadVelocity();
        v.y = speed;
        WriteVelocity(v);
        _isJumping = false;       // a pad bounce isn't a cuttable jump
        _dashUsedThisAir = false; // generous: a fresh dash after the launch
        _lastFallSpeed = 0f;
    }

    private void SpawnLandingDust()
    {
        _lastFallSpeed = 0f;
        if (landingDustSprite == null) return;
        Vector3 feet = transform.position;
        if (col != null) feet.y = col.bounds.min.y + 0.05f;
        DustPuff.Spawn(landingDustSprite, feet);
    }

    private Vector2 ReadVelocity()
    {
#if UNITY_6000_0_OR_NEWER
        return rb.linearVelocity;
#else
        return rb.velocity;
#endif
    }

    private void WriteVelocity(Vector2 value)
    {
#if UNITY_6000_0_OR_NEWER
        rb.linearVelocity = value;
#else
        rb.velocity = value;
#endif
    }
}
