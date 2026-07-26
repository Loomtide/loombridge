using UnityEngine;

/// <summary>
/// A short-lived dust puff: spawns a single sprite that rises a little, scales up, and
/// fades to transparent over its lifetime, then destroys itself. Used for landing dust
/// and trampoline-launch dust (the hero-shot's "E · landing dust" cue). Static Spawn
/// factory keeps callers a one-liner.
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
public class DustPuff : MonoBehaviour
{
    public float lifetime = 0.24f;   // mock: fade over 240 ms
    public float riseSpeed = 1.2f;
    public float startScale = 0.5f;
    public float endScale = 1.1f;

    private SpriteRenderer _sr;
    private float _t;
    private Color _baseColor;

    public static DustPuff Spawn(Sprite sprite, Vector3 pos)
    {
        var go = new GameObject("DustPuff");
        go.transform.position = pos;
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = sprite;
        return go.AddComponent<DustPuff>();
    }

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _baseColor = _sr.color;
        transform.localScale = Vector3.one * startScale;
    }

    private void Update()
    {
        _t += Time.deltaTime;
        float k = Mathf.Clamp01(_t / lifetime);
        transform.position += Vector3.up * (riseSpeed * Time.deltaTime);
        transform.localScale = Vector3.one * Mathf.Lerp(startScale, endScale, k);
        Color c = _baseColor;
        c.a = _baseColor.a * (1f - k);
        _sr.color = c;
        if (k >= 1f) Destroy(gameObject);
    }
}
