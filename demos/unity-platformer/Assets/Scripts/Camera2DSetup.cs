using UnityEngine;

/// <summary>
/// Configures a 2D camera's background. Attach to the Camera. Applies in the editor
/// (ExecuteAlways + OnValidate) and at runtime (OnEnable). Leaves position/size to any
/// follow-camera controller so it doesn't fight it.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(Camera))]
public class Camera2DSetup : MonoBehaviour
{
    [Tooltip("Solid background color (replaces the 3D skybox).")]
    public Color backgroundColor = new Color(0.16f, 0.20f, 0.28f, 1f);
    [Tooltip("Force orthographic projection (recommended for 2D).")]
    public bool ensureOrthographic = true;

    private void OnEnable() => Apply();
    private void OnValidate() => Apply();

    private void Apply()
    {
        Camera cam = GetComponent<Camera>();
        if (cam == null) return;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = backgroundColor;
        if (ensureOrthographic) cam.orthographic = true;
    }
}
