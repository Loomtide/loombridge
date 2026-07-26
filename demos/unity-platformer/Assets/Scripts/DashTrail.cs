using UnityEngine;

/// <summary>
/// Mock-faithful dash afterimage (hero-shot cue D — "dash trail / afterimage ghosts").
/// Renders AT MOST 3 cyan ghosts trailing the player while dashing: the nearest is the
/// most opaque (0.52), then 0.32, then 0.18, spaced ~0.1u apart along the dash trail.
/// When the dash ends the ghosts are held briefly (~80ms) then cleared.
///
/// Decoupled: reads PlayerController.IsDashing and clones the live SpriteRenderer frame,
/// so it works with any sprite animator. Drop on the player (needs PlayerController +
/// SpriteRenderer). The ghosts use a positive sortingOffset so they render ABOVE the
/// ground (the fix for ghosts hiding behind same-order environment sprites).
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(PlayerController))]
public class DashTrail : MonoBehaviour
{
    [Tooltip("Ghost tint — mock cyan #4dd0e1. Alpha is overridden per-ghost (0.52/0.32/0.18).")]
    public Color ghostTint = new Color(0.302f, 0.816f, 0.882f, 1f);

    [Tooltip("Per-ghost opacities, nearest (most opaque) first. Mock: 0.52 / 0.32 / 0.18.")]
    public float[] ghostOpacities = { 0.52f, 0.32f, 0.18f };

    [Tooltip("World-space spacing between successive ghosts along the trail (~0.1u = ~10px @ ppu100).")]
    public float ghostSpacing = 0.1f;

    [Tooltip("How long ghosts linger after the dash ends before being cleared (seconds).")]
    public float holdAfterDash = 0.08f;

    [Tooltip("Sorting-order offset vs the player. Positive renders ghosts ABOVE the ground " +
             "(co-planar/negative can hide them behind same-order environment sprites).")]
    public int sortingOffset = 1;

    private PlayerController _pc;
    private SpriteRenderer _sr;
    private SpriteRenderer[] _ghosts;
    private bool _wasDashing;
    private float _clearAt;
    private int _facing = 1; // last dash direction (sign of trail offset)

    private void Awake()
    {
        _pc = GetComponent<PlayerController>();
        _sr = GetComponent<SpriteRenderer>();
        int n = (ghostOpacities != null) ? ghostOpacities.Length : 0;
        _ghosts = new SpriteRenderer[n];
        for (int i = 0; i < n; i++)
        {
            var go = new GameObject("DashGhost_" + i);
            go.transform.SetParent(null, true);
            var gsr = go.AddComponent<SpriteRenderer>();
            gsr.enabled = false;
            _ghosts[i] = gsr;
        }
    }

    private void OnDestroy()
    {
        if (_ghosts == null) return;
        foreach (var g in _ghosts)
            if (g != null) Destroy(g.gameObject);
    }

    private void LateUpdate()
    {
        if (_pc == null || _sr == null || _ghosts == null) return;

        bool dashing = _pc.IsDashing;

        if (dashing)
        {
            // Trail points opposite the travel direction. Use flipX as the facing cue
            // (player faces dash direction); flipX=true => facing left.
            _facing = _sr.flipX ? -1 : 1;
            PositionGhosts();
            _wasDashing = true;
            return;
        }

        if (_wasDashing)
        {
            // Dash just ended: hold the last ghost pose for a short beat, then clear.
            _wasDashing = false;
            _clearAt = Time.time + holdAfterDash;
        }

        if (_clearAt > 0f)
        {
            if (Time.time >= _clearAt)
            {
                HideGhosts();
                _clearAt = 0f;
            }
            // else: leave the ghosts frozen in place during the hold window.
        }
    }

    private void PositionGhosts()
    {
        if (_sr.sprite == null) { HideGhosts(); return; }

        Vector3 basePos = transform.position;
        for (int i = 0; i < _ghosts.Length; i++)
        {
            var gsr = _ghosts[i];
            if (gsr == null) continue;

            // Ghost i sits (i+1) steps BEHIND the player along the trail.
            float back = -_facing * ghostSpacing * (i + 1);
            gsr.transform.position = basePos + new Vector3(back, 0f, 0f);
            gsr.transform.rotation = transform.rotation;
            gsr.transform.localScale = transform.lossyScale;

            gsr.sprite = _sr.sprite;
            gsr.flipX = _sr.flipX;
            gsr.flipY = _sr.flipY;

            Color c = ghostTint;
            c.a = ghostOpacities[i];
            gsr.color = c;

            gsr.sortingLayerID = _sr.sortingLayerID;
            gsr.sortingOrder = _sr.sortingOrder + sortingOffset;
            gsr.enabled = true;
        }
    }

    private void HideGhosts()
    {
        if (_ghosts == null) return;
        foreach (var g in _ghosts)
            if (g != null) g.enabled = false;
    }
}
