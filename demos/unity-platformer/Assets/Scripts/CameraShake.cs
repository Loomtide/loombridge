using UnityEngine;

/// <summary>
/// Decaying positional screen shake for a static (or simple) 2D camera. Static API:
/// CameraShake.Shake(amplitude, duration). Applies a noise offset on top of the camera's
/// rest position in LateUpdate, on UNSCALED time so it animates during a hit-stop freeze.
/// Drop on the Main Camera (hero-shot cues G/H).
///
/// Captures the rest position when a shake begins, so it composes with a static camera
/// (Camera2DSetup, which only positions the camera on enable, not per-frame). Not intended
/// to layer on top of a per-frame follow camera without ordering care.
/// </summary>
[DisallowMultipleComponent]
public class CameraShake : MonoBehaviour
{
    private static CameraShake _instance;

    private Vector3 _restPos;
    private float _amplitude;
    private float _duration;
    private float _elapsed;
    private bool _shaking;

    private void Awake()
    {
        _instance = this;
        _restPos = transform.localPosition;
    }

    private void OnDestroy()
    {
        if (_instance == this) _instance = null;
    }

    /// <summary>Trigger a shake. Re-triggering keeps the stronger remaining amplitude.</summary>
    public static void Shake(float amplitude, float duration)
    {
        if (_instance != null) _instance.Begin(amplitude, duration);
    }

    private void Begin(float amplitude, float duration)
    {
        if (!_shaking) _restPos = transform.localPosition;
        _amplitude = Mathf.Max(_shaking ? RemainingAmplitude() : 0f, amplitude);
        _duration = Mathf.Max(0.0001f, duration);
        _elapsed = 0f;
        _shaking = true;
    }

    private float RemainingAmplitude()
    {
        return _amplitude * Mathf.Clamp01(1f - _elapsed / _duration);
    }

    private void LateUpdate()
    {
        if (!_shaking) return;
        _elapsed += Time.unscaledDeltaTime;
        float k = Mathf.Clamp01(_elapsed / _duration);
        if (k >= 1f)
        {
            transform.localPosition = _restPos;
            _shaking = false;
            return;
        }
        float damp = (1f - k) * (1f - k);   // ease-out
        float ox = (Mathf.PerlinNoise(Time.unscaledTime * 40f, 0f) - 0.5f) * 2f;
        float oy = (Mathf.PerlinNoise(0f, Time.unscaledTime * 40f) - 0.5f) * 2f;
        transform.localPosition = _restPos + new Vector3(ox, oy, 0f) * (_amplitude * damp);
    }
}
