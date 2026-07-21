# ParallaxLayer: texture-offset scroll on a static quad

The one component this skill is built around. It scrolls a backdrop by animating
`material.mainTextureOffset` on a **static, frame-covering quad** — the quad never moves, so a texture
start/end edge is **never** inside the frame, and because the material wraps in **Repeat** mode the
offset loops in `[0,1)` texture space with **no visible seam and no snap**. Three modes:

- `AmbientDrift` — static camera; the texture drifts on its own at `driftSpeed` (TIME-based). Use it for
  title screens / ambient scenes, **not** a static gameplay level: it slides forever with no in-world
  motivation, which reads worse than a truly static backdrop.
- `TargetFollow` — **static camera, player-driven depth.** The offset is a pure function of the target's
  (the player's) CURRENT displacement from its start, on **both axes**, scaled per-layer. Moves only when
  the player moves; idle player → constant offset → no motion. **The recommended mode for a static
  one-screen level.** (Or leave the layer truly static — but don't use `AmbientDrift`.)
- `CameraFollow` — the camera moves and the layer parallaxes against it (scrolling/following camera).

Drop it on each backdrop quad.

Deterministic under `runtime.probe`: `AmbientDrift` / `CameraFollow` scroll on `Time.deltaTime` (scaled
game time) in `LateUpdate`, so advancing game-time via a probe reproduces the exact offset.
`TargetFollow` has **no time term** at all — the offset is a pure function of the target's position, so a
probe that drives the player (`forceHorizontal` / a jump) reproduces the exact offset for a given player
position. Either way the verification gate can sample it.

```csharp
using UnityEngine;

/// <summary>
/// Seamless, edge-safe parallax/scroll for a 2D backdrop layer. Scrolls the MATERIAL's
/// mainTextureOffset on a STATIC, frame-covering quad rather than translating the transform.
///
/// Why this is edge-safe: the quad never moves (AmbientDrift / TargetFollow) or is pinned to the
/// camera center each frame (CameraFollow), so it always covers the camera frame and a texture
/// start/end edge is never inside the view. Why this is seamless: the material is imported with
/// wrapMode = Repeat, so the offset wraps in [0,1) texture space onto the SAME repeating pixels —
/// no world-space teleport, no snap. (Contrast: translating the transform + Mathf.Repeat on a world
/// offset snaps the whole backdrop sideways on each wrap AND slides its own edges across the frame,
/// exposing bare camera background — the bug this component replaces.)
///
/// Three modes:
///  - AmbientDrift: static camera; the texture drifts at driftSpeed (world u/s; negative = left).
///    TIME-based — slides forever even when nothing in the world moves. Title screens / ambient
///    scenes only; NOT a static gameplay level (motiveless drift reads worse than a static backdrop).
///  - TargetFollow: STATIC camera, player-driven depth. The offset is a pure function of the target's
///    displacement from its start anchor — on BOTH axes — scaled per-layer by (factorX, factorY).
///    No time term: idle target => constant offset => no motion; the backdrop shifts ONLY when the
///    player moves (horizontal on run, vertical on jump/fall). RECOMMENDED for a static one-screen
///    level. far layer = small factor (shifts least), near layer = factor ~1 (shifts most).
///  - CameraFollow: the quad re-centers on the camera each LateUpdate (so it always covers) and the
///    offset tracks the camera's X by (1 - parallaxFactor): factor 0 = locked to the camera (farthest
///    layer, never appears to move), factor 1 = moves 1:1 with the world (nearest layer). For a
///    scrolling / following camera.
///
/// Drop on a quad GameObject (MeshFilter with the built-in Quad mesh + MeshRenderer whose material
/// uses a Repeat/Point texture). See setup-recipe.md for the MCP build steps.
/// </summary>
[RequireComponent(typeof(MeshRenderer))]
public class ParallaxLayer : MonoBehaviour
{
    public enum Mode { AmbientDrift, TargetFollow, CameraFollow }

    [Tooltip("AmbientDrift: static camera, the texture drifts on its own (time-based). " +
             "TargetFollow: static camera, the texture shifts with the player's displacement (both axes). " +
             "CameraFollow: the layer parallaxes against a moving camera.")]
    public Mode mode = Mode.TargetFollow;

    [Tooltip("AmbientDrift only — world units/second of horizontal drift (negative scrolls left).")]
    public float driftSpeed = -0.15f;

    [Tooltip("CameraFollow only — 0 = locked to the camera (farthest, never appears to move), " +
             "1 = moves 1:1 with the world (nearest). Smaller = farther/slower.")]
    [Range(0f, 1f)] public float parallaxFactor = 0.5f;

    [Tooltip("TargetFollow — the object whose motion drives the parallax. Defaults to the GameObject " +
             "tagged 'Player' (else an object named 'Player', else Camera.main as a last resort).")]
    public Transform target;

    [Tooltip("TargetFollow — fraction of the target's HORIZONTAL displacement the layer shifts. " +
             "0.3 = the layer shifts 30% of the player's X displacement. Far = small (slow), near = ~1.")]
    [Range(0f, 1f)] public float factorX = 0.5f;

    [Tooltip("TargetFollow — fraction of the target's VERTICAL displacement the layer shifts. " +
             "Default 0 for static-camera platformers; raise only when the art is oversized/edge-padded " +
             "and jump/apex verification proves no airborne seam. Far = small (slow), near = ~1.")]
    [Range(0f, 1f)] public float factorY = 0f;

    [Tooltip("World width of ONE texture tile. driftSpeed/camera/target motion are converted to " +
             "texture-offset units by dividing by this, so a tile of this width scrolls at exactly the speed.")]
    public float tileWorldWidth = 2.56f;

    [Tooltip("World height of ONE texture tile — TargetFollow's vertical mapping divides by this. " +
             "Leave 0 to reuse tileWorldWidth (square tile).")]
    public float tileWorldHeight = 0f;

    [Tooltip("Constant vertical texture offset added on top of any computed Y scroll " +
             "(AmbientDrift/CameraFollow scroll only horizontally, so this is their whole Y).")]
    public float yOffset = 0f;

    [Tooltip("Camera this layer parallaxes against / re-centers on (CameraFollow). Defaults to Camera.main.")]
    public Camera targetCamera;

    private Material _material;
    private float _offsetX;
    private Vector2 _anchor;   // TargetFollow: the target's start position, cached on enable.
    private bool _anchored;

    private void Awake()
    {
        // Instance material (GetComponent<MeshRenderer>().material clones the shared material so we
        // don't scroll every renderer that shares it).
        _material = GetComponent<MeshRenderer>().material;
        if (targetCamera == null) targetCamera = Camera.main;
    }

    private void OnEnable()
    {
        // Cache the target's START position as the parallax anchor: displacement is measured from here,
        // so at the player's spawn the offset is (0,0) and the backdrop is at rest.
        if (mode == Mode.TargetFollow)
        {
            if (target == null) target = ResolveTarget();
            if (target != null) { _anchor = target.position; _anchored = true; }
        }
    }

    private void LateUpdate()
    {
        if (_material == null) return;
        float tileW = Mathf.Approximately(tileWorldWidth, 0f) ? 1f : tileWorldWidth;
        float tileH = Mathf.Approximately(tileWorldHeight, 0f) ? tileW : tileWorldHeight;

        float ox = 0f;
        float oy = yOffset;

        if (mode == Mode.AmbientDrift)
        {
            // Static camera: accumulate texture-offset units. driftSpeed is world u/s; dividing by
            // the tile world width converts it so the texture scrolls at exactly driftSpeed.
            _offsetX += driftSpeed * Time.deltaTime / tileW;
            ox = _offsetX;
        }
        else if (mode == Mode.TargetFollow)
        {
            // Static camera, player-driven: the offset is a PURE FUNCTION of the target's current
            // displacement from its start anchor — no time term, so an idle player => constant offset.
            if (!_anchored)
            {
                if (target == null) target = ResolveTarget();
                if (target != null) { _anchor = target.position; _anchored = true; }
            }
            if (target != null)
            {
                // world displacement -> texture-space offset: a sky factorX 0.3 means the sky shifts
                // 30% of the player's X displacement; dividing by the tile world size converts world
                // units to [0,1) texture units. far layer (small factor) shifts least.
                Vector2 disp = (Vector2)target.position - _anchor;
                ox = disp.x * factorX / tileW;
                oy = disp.y * factorY / tileH + yOffset;
            }
        }
        else // CameraFollow
        {
            Camera cam = targetCamera != null ? targetCamera : Camera.main;
            if (cam != null)
            {
                // Keep the quad covering: re-center it on the camera every frame so a texture edge
                // is never exposed (the quad is sized to the frame in setup-recipe.md).
                Vector3 camPos = cam.transform.position;
                Vector3 p = transform.position;
                transform.position = new Vector3(camPos.x, camPos.y, p.z);

                // Parallax: the texture lags the world by (1 - parallaxFactor). factor 0 = the
                // texture cancels the camera motion exactly (locked, farthest); factor 1 = no lag
                // (moves 1:1 with the world, nearest).
                ox = camPos.x * (1f - parallaxFactor) / tileW;
            }
        }

        // Mathf.Repeat keeps each axis in [0,1) — SEAMLESS because the texture repeats (this is a
        // texture-space wrap, NOT a world-space teleport of the quad).
        _material.mainTextureOffset = new Vector2(Mathf.Repeat(ox, 1f), Mathf.Repeat(oy, 1f));
    }

    private Transform ResolveTarget()
    {
        // Prefer the tagged Player, then an object named "Player", then the main camera.
        GameObject go = null;
        try { go = GameObject.FindWithTag("Player"); } catch { /* tag may be undefined */ }
        if (go == null) go = GameObject.Find("Player");
        if (go != null) return go.transform;
        Camera cam = targetCamera != null ? targetCamera : Camera.main;
        return cam != null ? cam.transform : null;
    }
}
```

## Why it is edge-safe

The quad is sized to cover the **whole camera frame** (see `setup-recipe.md`) and it **never slides out
from under the frame**:

- **AmbientDrift / TargetFollow**: the quad transform is static — it stays put forever. Only the texture
  offset changes. There is no quad edge that can ever travel into view. (TargetFollow scrolls the offset
  on both axes, but it is still only the *texture* moving; the static quad keeps covering, so the coverage
  gate's bounds stay constant — see `verification.md`.)
- **CameraFollow**: every `LateUpdate` the quad is repositioned to the camera center *before* the offset
  is applied, so it is re-pinned to cover the frame each frame no matter how far the camera has moved.

Either way, the texture's start/end is never inside the frame — there is no bare-camera-background band
to expose.

## TargetFollow: the world → texture-offset mapping

Player-driven parallax for a STATIC camera. The driver is the player's **displacement from where it
started**, not time:

1. On enable, cache the target's start position as `_anchor`. At spawn `disp = 0` ⇒ offset `(0,0)` ⇒ the
   backdrop is at rest. (Subscribe to no clock; there is no time term anywhere.)
2. Each `LateUpdate`:
   ```
   Vector2 disp = (Vector2)(target.position - anchor);
   offsetX = disp.x * factorX / tileWorldWidth;
   offsetY = disp.y * factorY / tileWorldHeight;   // tileWorldHeight defaults to tileWorldWidth
   mainTextureOffset = (Mathf.Repeat(offsetX, 1f), Mathf.Repeat(offsetY, 1f));
   ```
3. Read the mapping as: **the layer shifts `factor` of the player's world displacement**, converted to
   texture-space by dividing by the tile's world size. So a sky with `factorX = 0.3` shifts **30% of the
   player's X displacement** — a far layer (small factor) shifts least, a near layer (factor ≈ 1) tracks
   the player almost 1:1. Both axes: horizontal on run, vertical on jump/fall, each with its own factor.
4. Because the offset is a pure function of the player's CURRENT position, an idle player holds the offset
   constant → the backdrop is motionless. It moves **only** when the player moves. `Mathf.Repeat(·,1f)`
   per axis keeps it seamless if the player travels far enough to wrap a tile.

`factorX`/`factorY` are separate so a layer can shift more horizontally than vertically (a grounded feel —
see `multi-layer.md`). Set `tileWorldHeight` only if the art's vertical tile differs from its horizontal
tile; otherwise it reuses `tileWorldWidth`.

## Why it is seamless

The material is imported with **wrapMode = Repeat**. `Mathf.Repeat(_offsetX, 1f)` keeps the applied
offset in `[0,1)`. As the offset crosses `1.0` it wraps back to `0.0`, and because the texture repeats,
offset `0.999…` and offset `0.0` sample **the same column of pixels** — the wrap is invisible. The
backdrop scrolls forever with no loop point and no jump.

## Contrast with the broken transform-translation approach (`BackdropDrift`)

The superseded `BackdropDrift` (in `game-polish-2d`'s `juice.md`) **translated the transform** and called
`Mathf.Repeat` on a **world-space** offset. That produced both classic parallax bugs:

- **Snap.** When the world offset wrapped, the whole backdrop teleported by the wrap distance
  (~8 units) in one frame — a visible sideways jump, not a loop.
- **Gap.** A translating quad slides *its own edges* across the frame; the instant an edge crossed the
  camera bound it revealed a band of bare camera background (skybox/clear color) on that side.

Texture-offset scrolling on a static quad has neither: the quad (and therefore its edges) never moves,
and the wrap happens in texture space where it is invisible.

## Determinism note

**AmbientDrift / CameraFollow** scroll on `Time.deltaTime` (scaled game time), not
`Time.unscaledDeltaTime`. A `unity_runtime_probe` that advances game-time reproduces the exact offset for
a given elapsed time — the **coverage** verification (`references/verification.md`) can sample the layer
across a full drift cycle deterministically. (Pausing via `Time.timeScale = 0` also pauses the drift,
which is correct.)

**TargetFollow** has **no time term** — the offset is a pure function of the target's position. So you
verify it by **driving the player**, not by advancing time: a probe (`forceHorizontal` / a jump) moves
the player a known displacement, and `mainTextureOffset` must change by exactly `displacement × factor /
tileWorldSize` per axis (far layer changes least), and stay CONSTANT when the player is idle. See
`references/verification.md`.
