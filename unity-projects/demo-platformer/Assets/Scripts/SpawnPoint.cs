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
