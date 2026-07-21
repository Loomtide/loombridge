using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
using System.Linq;
#endif

/// <summary>
/// Fruit pickup. On the player's trigger overlap it adds score, fires the juice
/// (a "collected" pop sprite burst), and removes itself. Name-prefix detection keeps
/// it tag-free; the player is found by its PlayerController.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(Collider2D))]
public class Collectible : MonoBehaviour
{
    [Tooltip("Score awarded on pickup.")]
    public int value = 1;

    [Header("Juice (optional)")]
    [Tooltip("Collected.png sliced-sheet path; frames auto-load in editor.")]
    public string collectedSheet;
    [Tooltip("Collected.png frames — plays a quick pop where the fruit was.")]
    public Sprite[] collectedFrames;
    [Tooltip("Pop playback fps.")]
    public float collectedFps = 18f;

    private bool _collected;

    private void Reset()
    {
        GetComponent<Collider2D>().isTrigger = true;
    }

#if UNITY_EDITOR
    private void OnEnable() => ReloadFrames();
    private void OnValidate()
    {
        if (Application.isPlaying) return;
        EditorApplication.delayCall += () => { if (this != null) ReloadFrames(); };
    }

    private void ReloadFrames()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(collectedSheet)) return;
        var all = AssetDatabase.LoadAllAssetsAtPath(collectedSheet).OfType<Sprite>().ToList();
        if (all.Count == 0) return;
        all.Sort((a, b) =>
        {
            int ai = a.name.LastIndexOf('_'), bi = b.name.LastIndexOf('_');
            int.TryParse(ai >= 0 ? a.name.Substring(ai + 1) : "0", out int an);
            int.TryParse(bi >= 0 ? b.name.Substring(bi + 1) : "0", out int bn);
            return an.CompareTo(bn);
        });
        collectedFrames = all.ToArray();
    }
#endif

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (_collected) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        _collected = true;
        GameManager gm = GameManager.Instance;
        if (gm != null) gm.AddScore(value);

        SpawnPop();
        Destroy(gameObject);
    }

    private void SpawnPop()
    {
        if (collectedFrames == null || collectedFrames.Length == 0) return;
        var go = new GameObject("FruitPop");
        go.transform.position = transform.position;
        var sr = go.AddComponent<SpriteRenderer>();
        SpriteRenderer mine = GetComponent<SpriteRenderer>();
        if (mine != null)
        {
            sr.sortingLayerID = mine.sortingLayerID;
            sr.sortingOrder = mine.sortingOrder + 1;
        }
        sr.sprite = collectedFrames[0];
        var pop = go.AddComponent<OneShotSpriteBurst>();
        pop.frames = collectedFrames;
        pop.fps = collectedFps;
    }
}
