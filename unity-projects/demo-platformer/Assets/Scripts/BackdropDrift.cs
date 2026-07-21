using UnityEngine;

/// <summary>
/// Slow ambient horizontal drift for a tiled backdrop layer (hero-shot bg-drift). Translates
/// the transform at a fixed speed and wraps every `wrapDistance` world units so a Repeat-tiled
/// SpriteRenderer scrolls seamlessly. Static-camera friendly: the layered backdrop still reads
/// as alive even though the camera does not move. Deterministic under runtime.probe (game time).
/// </summary>
public class BackdropDrift : MonoBehaviour
{
    [Tooltip("World units per second of horizontal drift (negative scrolls left, mock direction).")]
    public float speed = -0.15f;

    [Tooltip("Wrap the offset every N world units so a Repeat-tiled sprite loops seamlessly. " +
             "Set to the tile width (or a multiple) for a hidden seam.")]
    public float wrapDistance = 2.56f;

    private Vector3 _origin;
    private float _offset;

    private void Start() => _origin = transform.position;

    private void Update()
    {
        _offset += speed * Time.deltaTime;
        if (wrapDistance > 0.0001f)
        {
            // Keep the offset within (-wrap, wrap) so it never accumulates unbounded.
            _offset = Mathf.Repeat(_offset, wrapDistance);
        }
        transform.position = _origin + new Vector3(_offset, 0f, 0f);
    }
}
