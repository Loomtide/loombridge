// game-polish-2d: PixelPerfectSetup — reusable flicker / pixel-crawl fix.
using UnityEngine;
using UnityEngine.U2D;

/// <summary>
/// Reusable flicker / pixel-crawl fix for 2D pixel-art games.
///
/// Symptom it solves: a small Point-filtered pixel sprite shimmers ("flickers")
/// while it (or a following camera) moves at sub-pixel positions. Each frame the
/// texels map to slightly different screen pixels, so edges crawl/shimmer.
///
/// Fix: ensure a Unity <see cref="PixelPerfectCamera"/> is present and configured so
/// rendering snaps to a consistent pixel grid (upscaleRT + pixelSnapping). Drop this
/// on the main 2D camera. It is decoupled from any follow-camera controller — it only
/// configures the PixelPerfectCamera; the controller still drives camera position.
///
/// Requires the com.unity.2d.pixel-perfect package.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(Camera))]
[RequireComponent(typeof(PixelPerfectCamera))]
public class PixelPerfectSetup : MonoBehaviour
{
    [Tooltip("Pixels-per-unit of the source art (match the sprite import PPU, e.g. 100).")]
    public int assetsPixelsPerUnit = 100;

    [Tooltip("Reference resolution width the pixel grid is sized against.")]
    public int referenceResolutionX = 320;

    [Tooltip("Reference resolution height the pixel grid is sized against.")]
    public int referenceResolutionY = 180;

    [Tooltip("Render at low res to an offscreen RT, then upscale — sharpest, most stable look.")]
    public bool upscaleRenderTexture = true;

    [Tooltip("Snap sprite rendering to the pixel grid (removes sub-pixel shimmer).")]
    public bool pixelSnapping = true;

    [Tooltip("Crop the visible area to whole pixels on X.")]
    public bool cropFrameX = false;

    [Tooltip("Crop the visible area to whole pixels on Y.")]
    public bool cropFrameY = false;

    private void OnEnable() => Apply();
    private void OnValidate() => Apply();

    private void Apply()
    {
        PixelPerfectCamera ppc = GetComponent<PixelPerfectCamera>();
        if (ppc == null) return;

        ppc.assetsPPU = Mathf.Max(1, assetsPixelsPerUnit);
        ppc.refResolutionX = Mathf.Max(1, referenceResolutionX);
        ppc.refResolutionY = Mathf.Max(1, referenceResolutionY);
        ppc.upscaleRT = upscaleRenderTexture;
        ppc.pixelSnapping = pixelSnapping;
        ppc.cropFrameX = cropFrameX;
        ppc.cropFrameY = cropFrameY;
    }
}
