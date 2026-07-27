using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// A damaging hazard (saw / spikes). On overlap with the player it costs a life and
/// snaps the player back to its last spawn/checkpoint via PlayerController.Respawn.
/// Works as either a trigger (isTrigger=true) or solid collision.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class Hazard : MonoBehaviour
{
    [Tooltip("Hit-stop freeze on contact (seconds, real time).")]
    public float hitStopSeconds = 0.09f;
    // Mock cue: a small, snappy hit-only shake (~4px @ ppu100). NOT fired on landing.
    public float shakeAmplitude = 0.04f;
    public float shakeDuration = 0.18f;

    [Header("Juice (optional)")]
    [Tooltip("Impact puff sprite asset path (loaded in editor).")]
    public string impactSheet;
    public Sprite impactSprite;

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(impactSheet)) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null || string.IsNullOrEmpty(impactSheet)) return;
            foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(impactSheet))
            {
                if (obj is Sprite s) { impactSprite = s; break; }
            }
        };
    }
#endif

    private bool _dead; // ignore repeat contacts during the freeze/respawn beat

    private void Hit(GameObject other)
    {
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null || _dead) return;
        _dead = true;

        // Impact FX (reads on contact): a puff at the player's contact point, fired
        // alongside the hit-stop so it lands the moment the spike connects.
        SpawnImpact(pc);

        // Juice (mock cues G+H): freeze + flash the player white for a beat, THEN the
        // screen shake fires and the player respawns.
        SpriteRenderer sr = pc.GetComponent<SpriteRenderer>();
        GameManager gm = GameManager.Instance;
        HitStop.Do(hitStopSeconds, sr, () =>
        {
            CameraShake.Shake(shakeAmplitude, shakeDuration);
            if (gm != null) gm.PlayerDied();
            pc.Respawn();
            _dead = false;
        });
    }

    private void SpawnImpact(PlayerController pc)
    {
        if (impactSprite == null) return;
        Vector3 pos = pc.transform.position;
        Collider2D pcol = pc.GetComponent<Collider2D>();
        if (pcol != null) pos.y = pcol.bounds.min.y + 0.05f;
        DustPuff.Spawn(impactSprite, pos);
    }

    private void OnTriggerEnter2D(Collider2D other) => Hit(other.gameObject);
    private void OnCollisionEnter2D(Collision2D collision) => Hit(collision.gameObject);
}
