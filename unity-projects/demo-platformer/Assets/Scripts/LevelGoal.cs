using UnityEngine;

/// <summary>
/// The checkpoint flag / level goal. When the player reaches it the level is won
/// (GameManager.WinLevel). Trigger-based; tag-free player detection.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class LevelGoal : MonoBehaviour
{
    public bool reached;

    private void Reset()
    {
        GetComponent<Collider2D>().isTrigger = true;
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (reached) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        reached = true;
        GameManager gm = GameManager.Instance;
        if (gm != null) gm.WinLevel();
    }
}
