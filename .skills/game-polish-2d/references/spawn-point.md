# SpawnPoint + SnapToSpawnPoint

Fixes the "character visibly slides/falls to its start position when the game begins" problem.
The character snaps to a designer-placed spawn marker in `Awake` — before the first physics step or
render — so there is no visible movement on start. Reusable across levels: place a `SpawnPoint`
wherever the character should begin.

## Templates

Source (verbatim from `demos/unity-platformer/Assets/Scripts/SpawnPoint.cs`):

```csharp
using UnityEngine;

/// <summary>Marker for a character spawn location. Place at the intended (grounded) start position.</summary>
public class SpawnPoint : MonoBehaviour
{
    [Tooltip("Matches SnapToSpawnPoint.spawnId. Leave 'player' for the default character.")]
    public string spawnId = "player";

    private void OnDrawGizmos()
    {
        Gizmos.color = new Color(0.3f, 1f, 0.5f, 0.9f);
        Gizmos.DrawWireSphere(transform.position, 0.25f);
        Gizmos.DrawLine(transform.position + Vector3.down * 0.4f, transform.position + Vector3.up * 0.4f);
    }
}
```

Source (verbatim from `demos/unity-platformer/Assets/Scripts/SnapToSpawnPoint.cs`):

```csharp
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
```

## Apply via MCP

1. Create both scripts under `Assets/Scripts/` (if_exists: skip).
2. Create an empty GameObject `SpawnPoint` at the character's grounded position; attach `SpawnPoint`.
3. Attach `SnapToSpawnPoint` to the character (matching `spawnId`).
4. Place the `SpawnPoint` so the character's collider rests on the ground (ground top + half the
   character collider height), so it starts grounded with no settle.

## Notes
- Snapping in `Awake` (not `Start`) ensures it happens before the first physics integration and render.
- Pair with the controller's own `spawnPoint` capture for respawn-on-death consistency.
