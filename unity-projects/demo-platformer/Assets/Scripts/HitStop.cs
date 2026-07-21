using System.Collections;
using UnityEngine;

/// <summary>
/// Brief global "hit-stop" freeze (hero-shot cue G): sets Time.timeScale to 0 for a short
/// REAL-time window, then restores it — a punchy pause on impact. Static API:
/// HitStop.Do(seconds [, flash] [, onComplete]). Self-bootstraps a hidden persistent runner;
/// overlapping calls replace the in-flight freeze rather than stacking. Optionally flashes a
/// SpriteRenderer white for the duration of the freeze.
/// </summary>
public class HitStop : MonoBehaviour
{
    private static HitStop _instance;
    private Coroutine _running;
    private float _savedTimeScale = 1f;

    private static HitStop Instance
    {
        get
        {
            if (_instance == null)
            {
                var go = new GameObject("~HitStop") { hideFlags = HideFlags.HideAndDontSave };
                _instance = go.AddComponent<HitStop>();
            }
            return _instance;
        }
    }

    public static void Do(float seconds, SpriteRenderer flash = null, System.Action onComplete = null)
    {
        Instance.Run(seconds, flash, onComplete);
    }

    private void Run(float seconds, SpriteRenderer flash, System.Action onComplete)
    {
        if (_running != null) StopCoroutine(_running);
        _running = StartCoroutine(Freeze(seconds, flash, onComplete));
    }

    private IEnumerator Freeze(float seconds, SpriteRenderer flash, System.Action onComplete)
    {
        if (Time.timeScale != 0f) _savedTimeScale = Time.timeScale;

        Color flashBase = default;
        if (flash != null) { flashBase = flash.color; flash.color = Color.white; }

        Time.timeScale = 0f;
        yield return new WaitForSecondsRealtime(seconds);
        Time.timeScale = _savedTimeScale;

        if (flash != null) flash.color = flashBase;
        _running = null;
        onComplete?.Invoke();
    }
}
