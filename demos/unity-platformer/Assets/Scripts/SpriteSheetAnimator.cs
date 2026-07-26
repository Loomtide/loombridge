using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
using System.Linq;
#endif

/// <summary>
/// Lightweight sprite-sheet frame cycler for props that just loop (fruits bob, saw
/// spins, flag waves) without needing a full Animator/Controller. Point it at a sliced
/// multi-sprite sheet asset path (sheetPath) — it loads the ordered sub-sprites in the
/// editor and serializes them — then advances the SpriteRenderer each frame on a
/// wall-clock timer so it animates in edit mode too (ExecuteAlways).
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(SpriteRenderer))]
public class SpriteSheetAnimator : MonoBehaviour
{
    [Tooltip("Sliced sheet asset path; frames auto-load in name order (editor).")]
    public string sheetPath;
    public Sprite[] frames;
    [Tooltip("Playback speed in frames per second.")]
    public float fps = 20f;
    [Tooltip("Loop the clip (true) or hold the final frame (false).")]
    public bool loop = true;

    private SpriteRenderer _sr;
    private float _t;
    private int _index;

    private void OnEnable()
    {
        _sr = GetComponent<SpriteRenderer>();
#if UNITY_EDITOR
        ReloadFrames();
#endif
        _t = 0f;
        _index = 0;
        if (frames != null && frames.Length > 0 && _sr != null)
            _sr.sprite = frames[0];
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying) return;
        UnityEditor.EditorApplication.delayCall += () => { if (this != null) { ReloadFrames(); ApplyFirst(); } };
    }

    private void ReloadFrames()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(sheetPath)) return;
        var all = AssetDatabase.LoadAllAssetsAtPath(sheetPath).OfType<Sprite>().ToList();
        if (all.Count == 0) return;
        all.Sort((a, b) => FrameIndex(a.name).CompareTo(FrameIndex(b.name)));
        frames = all.ToArray();
    }

    private void ApplyFirst()
    {
        if (_sr == null) _sr = GetComponent<SpriteRenderer>();
        if (_sr != null && frames != null && frames.Length > 0) _sr.sprite = frames[0];
    }

    private static int FrameIndex(string name)
    {
        int us = name.LastIndexOf('_');
        if (us >= 0 && int.TryParse(name.Substring(us + 1), out int n)) return n;
        return 0;
    }
#endif

    private void Update()
    {
        if (_sr == null) _sr = GetComponent<SpriteRenderer>();
        if (frames == null || frames.Length == 0 || _sr == null || fps <= 0f) return;

        float dt = Application.isPlaying ? Time.deltaTime : 0.016f;
        _t += dt * fps;
        if (_t >= 1f)
        {
            int steps = Mathf.FloorToInt(_t);
            _t -= steps;
            _index += steps;
            if (_index >= frames.Length)
                _index = loop ? _index % frames.Length : frames.Length - 1;
            _sr.sprite = frames[_index];
        }
    }
}
