using UnityEngine;
using System.Collections.Generic;
#if UNITY_EDITOR
using UnityEditor;
using System.Linq;
#endif

/// <summary>
/// Velocity-driven sprite-sheet animator for the player that needs no AnimatorController
/// or .anim clips — it owns its frame sets directly and picks Idle / Run / Jump / Fall
/// from the Rigidbody2D state each frame, cycling the active set on a wall-clock timer.
/// Also flips the SpriteRenderer to face movement (deadzoned to avoid jitter).
///
/// Frame sets are serialized Sprite[] fields. Wire them directly via MCP
/// (unity_component_set_property with a JSON array of { asset_path, sub_asset }) — that is
/// build-safe. The sheet-path fields below are an editor-only convenience that auto-fills
/// the arrays in name order; they are NOT required at runtime and do nothing in a player
/// build. Decoupled from input: it observes the body, like CharacterAnimator2D, but renders
/// directly so the pipeline stays clip-free.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(Rigidbody2D))]
public class PlayerSpriteAnimator : MonoBehaviour
{
    [Header("Sheet asset paths (editor-loads frames in name order)")]
    public string idleSheet;
    public string runSheet;
    public string jumpSheet;
    public string fallSheet;

    [Header("Frame sets (auto-filled from sheets in editor)")]
    public Sprite[] idle;
    public Sprite[] run;
    public Sprite[] jump;  // rising
    public Sprite[] fall;  // descending

    [Header("Playback")]
    public float idleFps = 12f;
    public float runFps = 18f;
    [Tooltip("Horizontal speed (u/s) above which Run plays instead of Idle.")]
    public float runThreshold = 0.3f;
    [Tooltip("Vertical speed (u/s) magnitude that counts as airborne motion.")]
    public float airThreshold = 0.1f;

    [Header("Ground / facing")]
    public float groundCheckDistance = 0.15f;
    public LayerMask groundLayers = ~0;
    public float facingDeadzone = 0.1f;

    private SpriteRenderer _sr;
    private Rigidbody2D _rb;
    private Collider2D _col;
    private Sprite[] _active;
    private float _t;
    private int _index;
    private int _facing = 1;

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _rb = GetComponent<Rigidbody2D>();
        _col = GetComponent<Collider2D>();
    }

#if UNITY_EDITOR
    private void OnEnable() => ReloadFrames();
    private void OnValidate()
    {
        if (Application.isPlaying) return;
        EditorApplication.delayCall += () => { if (this != null) ReloadFrames(); };
    }

    private void ReloadFrames()
    {
        if (Application.isPlaying) return;
        idle = LoadSheet(idleSheet, idle);
        run  = LoadSheet(runSheet, run);
        jump = LoadSheet(jumpSheet, jump);
        fall = LoadSheet(fallSheet, fall);
        if ((idle != null && idle.Length > 0))
        {
            var sr = GetComponent<SpriteRenderer>();
            if (sr != null && sr.sprite == null) sr.sprite = idle[0];
        }
    }

    // Loads all sub-sprites of a multi-sprite sheet sorted by trailing frame index, so
    // Run_0..Run_11 come back in order. Falls back to the existing array if no path.
    private static Sprite[] LoadSheet(string path, Sprite[] current)
    {
        if (string.IsNullOrEmpty(path)) return current;
        var all = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToList();
        if (all.Count == 0) return current;
        all.Sort((a, b) => FrameIndex(a.name).CompareTo(FrameIndex(b.name)));
        return all.ToArray();
    }

    private static int FrameIndex(string name)
    {
        int us = name.LastIndexOf('_');
        if (us >= 0 && int.TryParse(name.Substring(us + 1), out int n)) return n;
        return 0;
    }
#endif

    private void Update()
    {
        Vector2 v = ReadVelocity();
        bool grounded = IsGrounded();

        Sprite[] desired;
        float fps;
        if (!grounded)
        {
            if (v.y > airThreshold) { desired = jump; fps = 10f; }
            else { desired = fall; fps = 10f; }
        }
        else if (Mathf.Abs(v.x) > runThreshold) { desired = run; fps = runFps; }
        else { desired = idle; fps = idleFps; }

        if (desired == null || desired.Length == 0) desired = idle;
        if (desired != _active)
        {
            _active = desired;
            _t = 0f;
            _index = 0;
            if (_active != null && _active.Length > 0) _sr.sprite = _active[0];
        }

        if (_active != null && _active.Length > 0 && fps > 0f)
        {
            _t += Time.deltaTime * fps;
            if (_t >= 1f)
            {
                int steps = Mathf.FloorToInt(_t);
                _t -= steps;
                _index = (_index + steps) % _active.Length;
                _sr.sprite = _active[_index];
            }
        }

        UpdateFacing(v.x);
    }

    private void UpdateFacing(float vx)
    {
        if (Mathf.Abs(vx) < facingDeadzone) return;
        int desired = vx > 0f ? 1 : -1;
        if (desired == _facing) return;
        _facing = desired;
        _sr.flipX = _facing < 0;
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
