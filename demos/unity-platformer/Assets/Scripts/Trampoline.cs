using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// Bounce pad. When the player lands on top (moving downward) it launches them upward
/// at bounceSpeed, overriding vertical velocity for a satisfying pop. Detects the
/// player via PlayerController and only fires when contact comes from above.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class Trampoline : MonoBehaviour
{
    [Tooltip("Upward launch velocity (u/s). Higher than the normal jump for a clear boost.")]
    public float bounceSpeed = 18f;

    [Header("Juice (optional)")]
    [Tooltip("Dust sprite asset path (loaded in editor).")]
    public string dustSheet;
    public Sprite dustSprite;

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(dustSheet)) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null || string.IsNullOrEmpty(dustSheet)) return;
            foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(dustSheet))
            {
                if (obj is Sprite s) { dustSprite = s; break; }
            }
        };
    }
#endif

    // Trigger-based so the pad never walls the player horizontally — running into it
    // (or landing on it) launches them straight up. A short re-arm prevents the
    // launch from re-firing every physics frame while still overlapping.
    private float _readyAt;

    private void OnTriggerEnter2D(Collider2D other) => TryBounce(other.gameObject);
    private void OnTriggerStay2D(Collider2D other) => TryBounce(other.gameObject);

    private void TryBounce(GameObject other)
    {
        if (Time.time < _readyAt) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        _readyAt = Time.time + 0.25f;
        pc.LaunchUp(bounceSpeed);

        // Anchor the puff to the player's FEET (the actual push-off point), NOT the
        // pad's collider top — clamping up to the pad top floats the puff above an
        // elevated pad. For a side approach the feet sit at ground level; for a top
        // landing they sit on the pad. Falls back to the pad top only if there's no
        // player collider.
        Collider2D pcol = pc.GetComponent<Collider2D>();
        if (pcol != null)
            SpawnDust(new Vector3(pcol.bounds.center.x, pcol.bounds.min.y, 0f));
        else
            SpawnDust(new Vector3(transform.position.x, GetComponent<Collider2D>().bounds.max.y, 0f));
    }

    private void SpawnDust(Vector3 pos)
    {
        if (dustSprite == null) return;
        DustPuff.Spawn(dustSprite, pos);
    }
}
