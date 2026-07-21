using UnityEngine;

/// <summary>
/// Snaps this object to a matching SpawnPoint in Awake (before first frame/physics),
/// so the character never visibly moves to its start position. Zeroes velocity if rigidbodied.
/// </summary>
public class SnapToSpawnPoint : MonoBehaviour
{
    [Tooltip("Matches the SpawnPoint.spawnId to snap to.")]
    public string spawnId = "player";

    private void Awake()
    {
        SpawnPoint target = null;
#if UNITY_2023_1_OR_NEWER
        SpawnPoint[] points = Object.FindObjectsByType<SpawnPoint>(FindObjectsSortMode.None);
#else
        SpawnPoint[] points = Object.FindObjectsOfType<SpawnPoint>();
#endif
        foreach (SpawnPoint p in points)
        {
            if (p.spawnId == spawnId) { target = p; break; }
        }
        if (target == null) return;

        transform.position = target.transform.position;
        Rigidbody2D rb = GetComponent<Rigidbody2D>();
        if (rb != null)
        {
#if UNITY_6000_0_OR_NEWER
            rb.linearVelocity = Vector2.zero;
#else
            rb.velocity = Vector2.zero;
#endif
        }
    }
}
