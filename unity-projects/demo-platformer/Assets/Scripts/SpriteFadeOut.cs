using UnityEngine;

/// <summary>
/// Fades a SpriteRenderer's alpha to zero over `lifetime` (optionally drifting), then
/// destroys the GameObject. Reusable for afterimage ghosts, sparkles, etc. Runs on
/// UNSCALED time by default so it keeps fading during a hit-stop freeze.
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
public class SpriteFadeOut : MonoBehaviour
{
    public float lifetime = 0.25f;
    public Vector2 drift = Vector2.zero;   // world units / second
    [Tooltip("Fade on unscaled time (keeps fading during a hit-stop freeze). Off = game time, " +
             "which pauses with Time.timeScale and is deterministic under runtime.probe.")]
    public bool useUnscaledTime = false;

    private SpriteRenderer _sr;
    private Color _base;
    private float _t;

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _base = _sr.color;
    }

    private void Update()
    {
        float dt = useUnscaledTime ? Time.unscaledDeltaTime : Time.deltaTime;
        _t += dt;
        float k = (lifetime <= 0f) ? 1f : Mathf.Clamp01(_t / lifetime);
        if (drift != Vector2.zero)
            transform.position += (Vector3)(drift * dt);
        Color c = _base;
        c.a = _base.a * (1f - k);
        _sr.color = c;
        if (k >= 1f) Destroy(gameObject);
    }
}
