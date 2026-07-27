# Camera2DSetup

Drop-in component that fixes the most common 2D presentation bug: the default 3D **skybox**
showing behind a 2D scene. Forces solid-color clear flags + orthographic, WYSIWYG in the editor.

Attach to the Main Camera. Does **not** manage camera position/size — leave that to a follow camera
(e.g. `PlatformerCameraController`) so it doesn't fight it.

## Template

Source (verbatim from `demos/unity-platformer/Assets/Scripts/Camera2DSetup.cs`):

```csharp
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
```

## Apply via MCP

1. `unity_code_create_script` → `Assets/Scripts/Camera2DSetup.cs` (if_exists: skip).
2. `unity_code_attach_script` → Main Camera.
3. Optional: `unity_component_set_property` on `Camera2DSetup` `backgroundColor` to taste.

## Notes / extensions
- For richer backgrounds, add a parallax layer set (sprites on a back sorting layer) instead of a flat
  color; source art via the asset registry. `Camera2DSetup` still ensures clear flags so the skybox
  never bleeds through.
- A good neutral background for a precision platformer is a dark, slightly cool tone so the player
  reads clearly; bright sky-blue washes out small sprites.

## Full-viewport pixel-art camera recipe

For playable demos and capture videos, the Game-view screenshot should normally be **full viewport**:
no unintended black bars, no boxed camera rect, no accidental crop from PixelPerfect settings. Use one
of these explicit modes in the acceptance contract:

- `render.viewportMode: "full"` — default for demos. Configure the main camera `rect = (0,0,1,1)`,
  use an orthographic size/reference resolution that fills the target aspect, and keep
  `PixelPerfectCamera.cropFrameX/Y` off unless you also enable a deliberate stretch/fill path. Keep
  `upscaleRT=false` when a Screen Space - Camera HUD is rendered through this camera so the HUD stays
  crisp and captured.
- `render.viewportMode: "letterbox"` — only when bars are an intentional style/format choice. Declare it
  in the contract before verification.
- `render.viewportMode: "any"` — only for tooling/debug scenes where viewport framing is irrelevant.

If the `render-frame` gate reports black/uniform borders, fix the camera/pixel-perfect setup first; do
not remove pixel-perfect blindly unless the contract accepts a plain orthographic full-viewport fallback.

## Follow camera: look-ahead must pass smoothly through zero

`PlatformerCameraController` leads the camera in the direction of travel (look-ahead). **Gotcha:**
deriving the look-ahead from `Mathf.Sign(velocity.x)` is asymmetric — `Mathf.Sign(0) == 1` in Unity, so
at rest the look-ahead snaps to **+1 (right)**, biasing the resting frame right. Worse, the look-ahead
then jumps discretely on a direction change, so stopping after moving **left** lurches the camera ~2–3×
farther than stopping after moving **right** (a one-sided "spring"), even though stopping from the right
looks fine.

**Fix:** make the look-ahead **velocity-proportional and smoothed** so it eases through zero:
```csharp
Vector2 targetLookAhead = new Vector2(
    Mathf.Clamp(velocity.x / lookAheadSpeed, -1f, 1f) * lookAhead.x,
    Mathf.Clamp(velocity.y / lookAheadSpeed, -1f, 1f) * lookAhead.y);
currentLookAhead = SmoothDamp(currentLookAhead → targetLookAhead, lookAheadSmoothing);
desired += currentLookAhead;
```
At rest the look-ahead is 0 (centered, no left/right bias); at full speed it still reaches ±lookAhead, so
the in-motion feel is unchanged. Smooth `currentLookAhead` (not just the camera position) so a direction
change never snaps.

**Verify it (don't eyeball):** transient camera feel can't be measured by driving input across separate
MCP calls — the editor ticks the sim during inter-call gaps, so a held input runs the player off the
level. Use **`unity_runtime_probe`** instead: it drives `PlayerController.forceHorizontal` through timed
phases *and* samples the camera in one deterministic, focus-independent loop. Run e.g.
`[{+1,500},{0,1200},{-1,500},{0,1200}]` measuring the Main Camera and compare the two stop phases'
`deltaX`/overshoot — buggy is asymmetric (e.g. left-stop ≈ 2.6× right-stop, rest offset +1.25), fixed is
mirror-symmetric (rest offset 0). See also `unity_scene_get_bounds` for the static rest offset.
