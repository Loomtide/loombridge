// game-polish-2d: CharacterAnimator2D — reusable velocity-driven animation driver.
// Requires the built-in Animation module (com.unity.modules.animation) for the Animator type.
using UnityEngine;

/// <summary>
/// Reusable 2D character animation driver. Reads the character's Rigidbody2D
/// velocity and a ground overlap check each frame and writes Animator parameters
/// so idle / run / jump states switch automatically.
///
/// Decoupled from any specific controller: it observes the Rigidbody2D, not input.
/// Drop it on any 2D character that has a Rigidbody2D + Animator. Configure the
/// Animator with these parameters (names overridable below):
///   - float "speed"    : abs(horizontal velocity)
///   - bool  "grounded" : true when standing on something
///   - float "vSpeed"   : signed vertical velocity (for rise/fall, optional)
///
/// Optional facing: flips the sprite (or this transform) by horizontal velocity
/// sign, with a deadzone so a dithering near-zero velocity never rapid-flips.
/// </summary>
[RequireComponent(typeof(Rigidbody2D))]
public class CharacterAnimator2D : MonoBehaviour
{
    [Header("Animator Parameters")]
    [SerializeField] private string speedParam = "speed";
    [SerializeField] private string groundedParam = "grounded";
    [SerializeField] private string verticalSpeedParam = "vSpeed";

    [Header("Ground Check")]
    [Tooltip("Distance below the collider to probe for ground.")]
    [SerializeField] private float groundCheckDistance = 0.15f;
    [SerializeField] private LayerMask groundLayers = ~0;

    [Header("Facing")]
    [Tooltip("Flip the sprite to face movement direction.")]
    [SerializeField] private bool flipToFaceMovement = true;
    [Tooltip("Use SpriteRenderer.flipX (true) or negate localScale.x (false).")]
    [SerializeField] private bool flipViaSpriteRenderer = true;
    [Tooltip("Min horizontal speed before facing changes — prevents rapid flip dithering near zero.")]
    [SerializeField] private float facingDeadzone = 0.1f;

    private Rigidbody2D _rb;
    private Animator _animator;
    private Collider2D _col;
    private SpriteRenderer _sprite;
    private int _facing = 1;

    private int _speedHash, _groundedHash, _vSpeedHash;
    private bool _hasSpeed, _hasGrounded, _hasVSpeed;

    private void Awake()
    {
        _rb = GetComponent<Rigidbody2D>();
        _animator = GetComponent<Animator>();
        _col = GetComponent<Collider2D>();
        _sprite = GetComponentInChildren<SpriteRenderer>();

        _speedHash = Animator.StringToHash(speedParam);
        _groundedHash = Animator.StringToHash(groundedParam);
        _vSpeedHash = Animator.StringToHash(verticalSpeedParam);
        CacheParameterPresence();
    }

    private void CacheParameterPresence()
    {
        if (_animator == null) return;
        foreach (AnimatorControllerParameter p in _animator.parameters)
        {
            if (p.name == speedParam) _hasSpeed = true;
            else if (p.name == groundedParam) _hasGrounded = true;
            else if (p.name == verticalSpeedParam) _hasVSpeed = true;
        }
    }

    private void Update()
    {
        if (_animator == null || _rb == null) return;

        Vector2 v = ReadVelocity();
        if (_hasSpeed) _animator.SetFloat(_speedHash, Mathf.Abs(v.x));
        if (_hasVSpeed) _animator.SetFloat(_vSpeedHash, v.y);
        if (_hasGrounded) _animator.SetBool(_groundedHash, IsGrounded());

        if (flipToFaceMovement) UpdateFacing(v.x);
    }

    private void UpdateFacing(float vx)
    {
        if (Mathf.Abs(vx) < facingDeadzone) return; // deadzone: ignore near-zero jitter
        int desired = vx > 0f ? 1 : -1;
        if (desired == _facing) return;
        _facing = desired;

        if (flipViaSpriteRenderer && _sprite != null)
        {
            _sprite.flipX = _facing < 0;
        }
        else
        {
            Vector3 s = transform.localScale;
            s.x = Mathf.Abs(s.x) * _facing;
            transform.localScale = s;
        }
    }

    private bool IsGrounded()
    {
        if (_col == null) return false;
        Bounds b = _col.bounds;
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

    private Vector2 ReadVelocity()
    {
#if UNITY_6000_0_OR_NEWER
        return _rb.linearVelocity;
#else
        return _rb.velocity;
#endif
    }
}
