# CharacterAnimator2D + flicker fix

Two reusable pieces that together fix the "player looks like it's flickering when moving" problem and
give the character life.

## Diagnosis: the "flicker" is usually sub-pixel shimmer, not missing animation
A small Point-filtered pixel sprite shimmers/crawls while it (or a following camera) moves at
sub-pixel positions — each frame the texels map to slightly different screen pixels. It reads as
"flicker." Two contributing causes and their fixes:
1. **Sub-pixel pixel-crawl** → Unity `PixelPerfectCamera` (snap rendering to a pixel grid). See
   `PixelPerfectSetup` below.
2. **Facing dither** → a controller that flips the sprite by raw input sign can rapid-flip near zero;
   `CharacterAnimator2D` uses a facing **deadzone**.

Adding run/idle animation then makes motion read correctly on top of a stable image.

## CharacterAnimator2D (velocity-driven, input-agnostic)
Reads the character's `Rigidbody2D` velocity + a ground overlap each frame and writes Animator
parameters, so idle/run/jump switch automatically. Decoupled from any controller (observes physics,
not input) → drop it on any 2D character with `Rigidbody2D` + `Animator`.
- Animator params it sets (names overridable): `speed` (abs vx), `grounded` (bool), `vSpeed` (signed vy).
- Caches which params actually exist on the controller, so a minimal idle/run controller works.
- Facing flip via `SpriteRenderer.flipX` (or localScale.x) with a `facingDeadzone` to stop near-zero
  rapid-flipping.
- Source: `demos/unity-platformer/Assets/Scripts/CharacterAnimator2D.cs`.

Animator setup (via `unity_animator_*`): a controller with `Idle` + `Run` states, a `speed` float
param, transitions `Idle→Run` when `speed > 0.1` and back when `speed < 0.1`. Add `Jump`/fall states
keyed off `grounded`/`vSpeed` when desired.

## PixelPerfectSetup (flicker / pixel-crawl fix)
Configures a Unity `PixelPerfectCamera` (`upscaleRT` + `pixelSnapping`). `[ExecuteAlways]` + `OnValidate`
so it applies in the editor. Requires `com.unity.2d.pixel-perfect`.
- Source (verbatim from `demos/unity-platformer/Assets/Scripts/PixelPerfectSetup.cs`):

```csharp
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
```

**Wire over MCP** — `unity_component_add` `PixelPerfectSetup` on the **Main Camera** (auto-requires
`Camera` + `PixelPerfectCamera`). Set `assetsPixelsPerUnit` to match the sprite import PPU (e.g. `100`),
`referenceResolutionX/Y` to the pixel grid (e.g. `320×180`), and leave `upscaleRenderTexture` +
`pixelSnapping` `true` for the sharpest, most stable look.

**Gotchas learned:**
- `refResolutionX/Y` sets the pixel grid; the PixelPerfectCamera derives ortho size from it, but a
  follow-camera controller can still drive position. Match `assetsPPU` to the sprite import PPU.
- **HUD render mode — use Screen Space-Camera so the bridge can verify it.** The bridge screenshot
  uses `Camera.Render`, which composites Screen Space-**Camera** UI but **not** Screen Space-Overlay
  (overlay draws after all cameras). A Camera-mode HUD on the main camera hugs the corners and shows up
  in `unity_editor_screenshot` — so you can verify it. Overlay HUDs are invisible to the screenshot
  (you'd be flying blind). If a Camera-mode HUD looks offset, set the canvas's render camera + plane
  distance rather than switching to Overlay.
- **But a Camera-mode HUD on a pixel-perfect camera with `upscaleRT=true` ships BLURRY** (crisp in
  edit mode, soft in play — the whole frame including the HUD is rasterized into the low-res RT then
  upscaled). Set `upscaleRT = false` (keep `pixelSnapping = true`) so the HUD is crisp **and** still
  captured. The verify `ui-conformance` gate fails on `upscaleRT==true` + Camera-mode HUD. See
  `hud-kit.md` → "Crisp HUD over a pixel-perfect camera".
- **Edit-vs-play zoom drift (PixelPerfect overscan) is an inherent Unity Game-View constraint — do NOT
  try to "fix" it from the camera/scripts.** With `cropFrame` off + `upscaleRT` off, `PixelPerfectCamera`
  keeps pixels square by OVERSCANNING when the Game View isn't an exact integer multiple of the reference
  resolution: play-mode shows slightly MORE world than edit-mode (more so if the panel size differs, e.g.
  *Maximize On Play*), so the two viewports look a touch differently zoomed. You CANNOT get all three of
  {no letterbox bars, identical edit↔play framing, no overscan} from the camera or an editor script —
  empirically observed during a slice-pipeline dogfood run:
  - **Windowbox (`cropFrameX = cropFrameY = true`)** removes overscan but LETTERBOXES any non-16:9 panel
    ("the game is boxed").
  - **Fixed-resolution lock (`UnityEditor.PlayModeWindow.SetCustomRenderingResolution(1280,720,…)`)** also
    removes overscan and makes edit==play, but STILL letterboxes inside a non-16:9 panel (the fixed render
    is centered with borders) — and it's sticky: undo it by selecting Free Aspect (size index 0) on the
    Game View (reflection: `selectedSizeIndex=0` + `SizeSelectionCallback(0,null)`, run in the
    `[InitializeOnLoad]` static ctor NOT delayCall — delayCall is unreliable when the editor is backgrounded).
  The reason: "no bars" ⟺ **Free Aspect** (render fills the panel ⟺ aspect tracks the panel ⟺ overscan
  varies); "no overscan / identical framing" ⟺ a **fixed** render that Unity letterboxes in a non-matching
  panel. They're mutually exclusive UNLESS the Game View **panel itself** is 16:9 — which is a per-developer
  editor setting, not something the build can or should force. **Recommendation: leave `cropFrame` off
  (tuned camera), accept the minor overscan, and — if you want a pixel-exact view — set your Game View
  panel/aspect to 16:9 yourself.** Reserve windowbox for SHIPPED standalone builds where you must guarantee
  the exact authored frame on an arbitrary player window and prefer letterbox over revealing extra world.

## Feet-on-ground: fit the collider to the sprite's opaque pixels (FitBoxColliderToSprite)
**Symptom:** the character floats above the platform. **Cause:** the sprite has transparent padding,
but the BoxCollider2D is auto-sized to the *full* sprite rect — so when the collider bottom rests on
the ground, the visible feet (above the rect bottom, due to padding) float.

**Fundamental fix:** size the collider to the *opaque* pixel bounds so the collider bottom = the
character's feet. `FitBoxColliderToSprite.cs` (reusable) does this in the editor: ensures the texture
is readable, scans alpha within the sprite's `textureRect`, and writes `BoxCollider2D.size`/`offset`
from the opaque box (offset measured from the sprite pivot, divided by PPU). Attach it (autoFit on
enable, or the "Fit Collider To Sprite" context menu).

Source (verbatim from `demos/unity-platformer/Assets/Scripts/FitBoxColliderToSprite.cs`):

```csharp
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// Fits a BoxCollider2D to the OPAQUE pixel bounds of the SpriteRenderer's sprite,
/// instead of the full (often padded) sprite rect. This makes physics match the
/// VISIBLE character — the collider bottom sits at the character's feet — so a
/// grounded character rests on the platform instead of floating above it because of
/// transparent padding in the sprite.
///
/// Reusable on any 2D character with a SpriteRenderer + BoxCollider2D. Editor-only
/// fit (no runtime cost): runs in edit mode (ExecuteAlways/OnEnable, or the context
/// menu), ensures the source texture is readable, scans alpha, and writes the
/// collider size/offset. Pair it with regrounding the spawn (collider bottom = ground top).
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(BoxCollider2D))]
public class FitBoxColliderToSprite : MonoBehaviour
{
    [Tooltip("Alpha (0-1) above which a pixel counts as opaque.")]
    public float alphaThreshold = 0.1f;
    [Tooltip("Re-fit automatically when enabled in the editor.")]
    public bool autoFit = true;

    private void OnEnable()
    {
        if (autoFit) Fit();
    }

#if UNITY_EDITOR
    // Re-fit when the component is edited in the inspector (e.g. alphaThreshold
    // changed) so the collider always tracks the visible sprite. Deferred to avoid
    // mutating assets during the OnValidate callback. Guarded so a stale manual
    // offset can never silently override the computed feet alignment.
    private void OnValidate()
    {
        if (Application.isPlaying || !autoFit) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null) return;
            Fit();
        };
    }
#endif

    [ContextMenu("Fit Collider To Sprite")]
    public void Fit()
    {
#if UNITY_EDITOR
        if (Application.isPlaying) return;
        SpriteRenderer sr = GetComponent<SpriteRenderer>();
        BoxCollider2D box = GetComponent<BoxCollider2D>();
        if (sr == null || box == null || sr.sprite == null) return;

        Sprite sp = sr.sprite;
        Texture2D tex = sp.texture;
        if (tex == null) return;

        // Ensure the texture is CPU-readable so we can scan alpha.
        string path = AssetDatabase.GetAssetPath(tex);
        TextureImporter importer = AssetImporter.GetAtPath(path) as TextureImporter;
        if (importer != null && !importer.isReadable)
        {
            importer.isReadable = true;
            importer.SaveAndReimport();
            sp = sr.sprite;
            tex = sp.texture;
        }

        Color32[] px;
        try { px = tex.GetPixels32(); }
        catch { return; }

        Rect r = sp.textureRect;
        int rx = Mathf.FloorToInt(r.x);
        int ry = Mathf.FloorToInt(r.y);
        int rw = Mathf.FloorToInt(r.width);
        int rh = Mathf.FloorToInt(r.height);
        int texW = tex.width;

        int minX = rw, minY = rh, maxX = -1, maxY = -1;
        for (int yy = 0; yy < rh; yy++)
        {
            int row = (ry + yy) * texW + rx;
            for (int xx = 0; xx < rw; xx++)
            {
                if (px[row + xx].a / 255f > alphaThreshold)
                {
                    if (xx < minX) minX = xx;
                    if (xx > maxX) maxX = xx;
                    if (yy < minY) minY = yy;
                    if (yy > maxY) maxY = yy;
                }
            }
        }
        if (maxX < minX) return; // fully transparent

        float ppu = sp.pixelsPerUnit;
        Vector2 pivotPx = sp.pivot; // pixels from the LOGICAL rect's bottom-left

        // The scan is in textureRect-local pixels, but the pivot is measured from the
        // logical sprite rect. When the sprite is TRIMMED (textureRect inset within rect),
        // those origins differ — so we must add the trim offset, or the collider lands
        // shifted (left/low) from the visible sprite and a grounded character floats.
        float ox = r.x - sp.rect.x;
        float oy = r.y - sp.rect.y;

        // Opaque box center & size in rect-local pixels (+1 for inclusive max).
        float cx = (minX + maxX + 1) * 0.5f;
        float cy = (minY + maxY + 1) * 0.5f;
        float ow = (maxX - minX + 1);
        float oh = (maxY - minY + 1);

        box.offset = new Vector2((ox + cx - pivotPx.x) / ppu, (oy + cy - pivotPx.y) / ppu);
        box.size = new Vector2(ow / ppu, oh / ppu);
        EditorUtility.SetDirty(box);
#endif
    }
}
```

**Wire over MCP** — `unity_component_add` `FitBoxColliderToSprite` on the **character** (auto-requires
`SpriteRenderer` + `BoxCollider2D`). `autoFit = true` fits on enable; or invoke the "Fit Collider To
Sprite" context menu. `alphaThreshold` defaults to `0.1`. After fitting, reground the spawn (below).

> **Gotcha — trimmed sprites (`textureRect ≠ rect`).** The alpha scan is in `textureRect`-local
> pixels, but `Sprite.pivot` is measured from the *logical* `Sprite.rect`. When the sprite is trimmed
> (the importer insets `textureRect` within `rect`), the offset must add `textureRect.origin −
> rect.origin`, or the collider lands shifted (left/low) from the visible sprite and a grounded
> character floats *even with opaque-pixel fitting*. This is exactly the bug `unity_scene_get_bounds`
> (`visibleFeetAboveColliderBottom > 0`) and an annotated `unity_editor_screenshot` (green collider vs
> yellow visible box) catch — verify the collider hugs the visible silhouette, don't assume.

After fitting, **reground the spawn**: collider bottom (world) = `transform.y + (offset.y − size.y/2)·scale`;
set the spawn so that equals the ground top. (Demo: 32² trimmed sprite, scale 2.8 → collider fit
0.36×0.62 world, centered; spawn y −2.4 → collider bottom −2.68 = ground top, feet on ground.)

Asset-side complement: when slicing a character sheet, set the pivot to bottom-center and prefer tight
bounds so feet-alignment is correct by construction.

## Character size
Scale the character transform so it reads clearly against the tiles (e.g. ~0.8–1 unit tall). The feel
metrics (jump apex height, run speed) are velocity-based and unaffected by scale — but the collider
grows, so recompute the grounded spawn Y (ground top + collider half-height) and update the SpawnPoint.

## Sprite-sheet animation without clips (wire `Sprite[]` frames over MCP)
Authoring `AnimationClip` sprite keyframes is **not** exposed over MCP — so for sheet-based characters
prefer a **clip-free, velocity-driven sprite animator** that owns its frame sets directly (idle / run /
jump / fall `Sprite[]` fields) and picks the set from the `Rigidbody2D` state each frame. (Use
`CharacterAnimator2D` + an Animator only when you already have authored clips.)

Source (verbatim from `demos/unity-platformer/Assets/Scripts/PlayerSpriteAnimator.cs`):

```csharp
using UnityEngine;
using System.Collections.Generic;
#if UNITY_EDITOR
using UnityEditor;
using System.Linq;
#endif

/// <summary>
/// Velocity-driven sprite-sheet animator for the player that needs no AnimatorController
/// or .anim clips — it owns its frame sets directly and picks Idle / Run / Jump / Fall
/// from the Rigidbody2D state each frame, cycling the active set on a wall-clock timer.
/// Also flips the SpriteRenderer to face movement (deadzoned to avoid jitter).
///
/// Frame sets are serialized Sprite[] fields. Wire them directly via MCP
/// (unity_component_set_property with a JSON array of { asset_path, sub_asset }) — that is
/// build-safe. The sheet-path fields below are an editor-only convenience that auto-fills
/// the arrays in name order; they are NOT required at runtime and do nothing in a player
/// build. Decoupled from input: it observes the body, like CharacterAnimator2D, but renders
/// directly so the pipeline stays clip-free.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(Rigidbody2D))]
public class PlayerSpriteAnimator : MonoBehaviour
{
    [Header("Sheet asset paths (editor-loads frames in name order)")]
    public string idleSheet;
    public string runSheet;
    public string jumpSheet;
    public string fallSheet;

    [Header("Frame sets (auto-filled from sheets in editor)")]
    public Sprite[] idle;
    public Sprite[] run;
    public Sprite[] jump;  // rising
    public Sprite[] fall;  // descending

    [Header("Playback")]
    public float idleFps = 12f;
    public float runFps = 18f;
    [Tooltip("Horizontal speed (u/s) above which Run plays instead of Idle.")]
    public float runThreshold = 0.3f;
    [Tooltip("Vertical speed (u/s) magnitude that counts as airborne motion.")]
    public float airThreshold = 0.1f;

    [Header("Ground / facing")]
    public float groundCheckDistance = 0.15f;
    public LayerMask groundLayers = ~0;
    public float facingDeadzone = 0.1f;

    private SpriteRenderer _sr;
    private Rigidbody2D _rb;
    private Collider2D _col;
    private Sprite[] _active;
    private float _t;
    private int _index;
    private int _facing = 1;

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _rb = GetComponent<Rigidbody2D>();
        _col = GetComponent<Collider2D>();
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
        if (Application.isPlaying) return;
        idle = LoadSheet(idleSheet, idle);
        run  = LoadSheet(runSheet, run);
        jump = LoadSheet(jumpSheet, jump);
        fall = LoadSheet(fallSheet, fall);
        if ((idle != null && idle.Length > 0))
        {
            var sr = GetComponent<SpriteRenderer>();
            if (sr != null && sr.sprite == null) sr.sprite = idle[0];
        }
    }

    // Loads all sub-sprites of a multi-sprite sheet sorted by trailing frame index, so
    // Run_0..Run_11 come back in order. Falls back to the existing array if no path.
    private static Sprite[] LoadSheet(string path, Sprite[] current)
    {
        if (string.IsNullOrEmpty(path)) return current;
        var all = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToList();
        if (all.Count == 0) return current;
        all.Sort((a, b) => FrameIndex(a.name).CompareTo(FrameIndex(b.name)));
        return all.ToArray();
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
        Vector2 v = ReadVelocity();
        bool grounded = IsGrounded();

        Sprite[] desired;
        float fps;
        if (!grounded)
        {
            if (v.y > airThreshold) { desired = jump; fps = 10f; }
            else { desired = fall; fps = 10f; }
        }
        else if (Mathf.Abs(v.x) > runThreshold) { desired = run; fps = runFps; }
        else { desired = idle; fps = idleFps; }

        if (desired == null || desired.Length == 0) desired = idle;
        if (desired != _active)
        {
            _active = desired;
            _t = 0f;
            _index = 0;
            if (_active != null && _active.Length > 0) _sr.sprite = _active[0];
        }

        if (_active != null && _active.Length > 0 && fps > 0f)
        {
            _t += Time.deltaTime * fps;
            if (_t >= 1f)
            {
                int steps = Mathf.FloorToInt(_t);
                _t -= steps;
                _index = (_index + steps) % _active.Length;
                _sr.sprite = _active[_index];
            }
        }

        UpdateFacing(v.x);
    }

    private void UpdateFacing(float vx)
    {
        if (Mathf.Abs(vx) < facingDeadzone) return;
        int desired = vx > 0f ? 1 : -1;
        if (desired == _facing) return;
        _facing = desired;
        _sr.flipX = _facing < 0;
    }

    private bool IsGrounded()
    {
        if (_col == null) return false;
        Bounds b = _col.bounds;
        Vector2 boxCenter = new Vector2(b.center.x, b.min.y - groundCheckDistance * 0.5f);
        Vector2 boxSize = new Vector2(b.size.x * 0.9f, groundCheckDistance + b.size.y * 0.1f);
        Collider2D[] hits = Physics2D.OverlapBoxAll(boxCenter, boxSize, 0f, groundLayers);
        foreach (Collider2D h in hits)
        {
            if (h != null && h.gameObject != gameObject && !h.isTrigger)
                return true;
        }
        return false;
    }

    private Vector2 ReadVelocity()
    {
#if UNITY_6000_0_OR_NEWER
        return _rb.linearVelocity;
#else
        return _rb.velocity;
#endif
    }
}
```

Wire the frame arrays straight from the sliced sheet — the bridge sets `Sprite[]` properties now:

```
unity_component_set_property
  type_name: PlayerSpriteAnimator
  property_path: run
  value: [
    { "asset_path": "Assets/Art/.../Run.png", "sub_asset": "run_0" },
    { "asset_path": "Assets/Art/.../Run.png", "sub_asset": "run_1" },
    ...                                                 // one entry per frame, in order
  ]
```

- `value` is a **JSON array**; each element is an object reference. `sub_asset` (alias `sprite_name`)
  picks one named Sprite out of a sliced sheet's texture; a bare `"Assets/.../Single.png"` string
  resolves to that sheet's Sprite (sub-asset), not the `Texture2D`.
- These are real serialized references — **build-safe**. Do **not** rely on an editor-only
  `AssetDatabase` load in `OnValidate`/`OnEnable` to populate frames; that breaks in a player build.
- `get_properties` reports an array field as `generic`/`null` (it doesn't expand contents). Verify the
  wiring at runtime instead: enter Play and confirm the `SpriteRenderer` cycles the expected frames
  (or `unity_editor_screenshot` the character).

## Art
Use a CC0 animated character spritesheet via the asset registry (idle/run frames), sliced into named
frames (`unity_asset_create_sprite sprite_mode:multiple`). Non-power-of-two sheets slice at their
native size automatically (the importer pins `npotScale=None`) — no `.meta` hand-patching. When
headless sourcing of real art isn't available, a procedural placeholder run-sheet proves the pipeline;
keep a registry entry pointing at a real CC0 source to swap in.

## SpriteSheetAnimator (clip-free environment / prop animator)
The player uses `PlayerSpriteAnimator` (velocity-driven, picks idle/run/jump/fall). **Environment props
that just loop** — pickups bob, hazards spin, flags wave — use the simpler `SpriteSheetAnimator`
instead: a single-clip frame cycler with no state machine. `[ExecuteAlways]` so it also animates in
edit mode. `sheetPath` is an
editor-only convenience that auto-loads + serializes the sub-sprites in name order; the `frames` array
is the build-safe field — wire it directly over MCP.

Source:

```csharp
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
```

**Wire over MCP** — `unity_component_add` `SpriteSheetAnimator` on each animated **prop** (fruit, saw,
flag — auto-requires `SpriteRenderer`). Set the `frames` array build-safe as a JSON array of object
references in order (the same shape as `PlayerSpriteAnimator` above):

```
unity_component_set_property
  type_name: SpriteSheetAnimator
  property_path: frames
  value: [
    { "asset_path": "Assets/Art/.../Fruit.png", "sub_asset": "fruit_0" },
    { "asset_path": "Assets/Art/.../Fruit.png", "sub_asset": "fruit_1" },
    ...                                                 // one entry per frame, in order
  ]
```

- Then set `fps` (e.g. `20`) and `loop` (`true` to cycle, `false` to hold the final frame).
- `sheetPath` is the editor-only auto-loader; **don't rely on it at runtime** — set `frames` directly,
  the same build-safe rule as `PlayerSpriteAnimator`.
- `get_properties` reports the array as `generic`/`null`; verify by entering Play and watching the prop
  cycle (or `unity_editor_screenshot`).
