# HudKit (HudController)

Drop-in HUD presentation layer that replaces plain default-font score/lives labels with a polished,
framed, **TextMeshPro** readout plus a centered status message. Reusable across any 2D game: it owns
**presentation only**, and game logic calls into it.

The component (`HudController`) holds four `TMP_Text` references and exposes
`SetScore(int score, int total)`, `SetLives(int lives)`, `SetTimer(float seconds)`, and
`ShowMessage(string msg)`. Game logic (e.g. `GameManager`) holds a `public HudController hud;` and
delegates, instead of poking individual labels. This decouples scoring rules from how the HUD looks.

## Template

Source:

```csharp
using UnityEngine;
using TMPro;

/// <summary>
/// Reusable HUD presentation component for 2D demo games.
/// Owns all on-screen text presentation (score, lives, centered message).
/// Game logic (e.g. GameManager) calls into this; it never reaches into the HUD's
/// individual labels directly.
///
/// Wire the three TMP_Text fields in the inspector (or via
/// unity_component_set_property object-reference values).
/// </summary>
public class HudController : MonoBehaviour
{
    [Header("Label References (wire to TMP_Text objects)")]
    public TMP_Text scoreLabel;
    public TMP_Text livesLabel;
    public TMP_Text messageLabel;
    public TMP_Text timerLabel;

    /// <summary>Update the score readout. Format is intentionally simple; the game contract can
    /// replace it with a richer display if needed.</summary>
    public void SetScore(int score, int total)
    {
        if (scoreLabel != null)
        {
            scoreLabel.text = $"{score}/{total}";
        }
    }

    /// <summary>Update the lives readout. Replace this with icons/pips if the contract requires it.</summary>
    public void SetLives(int lives)
    {
        if (livesLabel != null)
        {
            int max = 3;
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < max; i++)
            {
                sb.Append(i < lives ? 'O' : '-'); // filled / empty pip
                if (i < max - 1) sb.Append(' ');
            }
            livesLabel.text = sb.ToString();
        }
    }

    /// <summary>Update the run timer readout as mm:ss:ff.</summary>
    public void SetTimer(float seconds)
    {
        if (timerLabel == null) return;
        int m = (int)(seconds / 60f);
        int s = (int)(seconds % 60f);
        int ff = (int)((seconds * 100f) % 100f);
        timerLabel.text = $"{m:00}:{s:00}:{ff:00}";
    }

    /// <summary>Show a centered message (e.g. "YOU WIN!" / "GAME OVER"). Pass "" to clear.</summary>
    public void ShowMessage(string msg)
    {
        if (messageLabel != null)
        {
            messageLabel.text = msg;
        }
    }
}
```

Game-logic side (delegation, null-guarded):

```csharp
public HudController hud;            // wire in inspector
// ...
private void UpdateUI()
{
    if (hud != null) { hud.SetScore(score, totalCoins); hud.SetLives(lives); }
}
private void ShowMessage(string msg) { if (hud != null) hud.ShowMessage(msg); }
```

## CRITICAL: Screen Space - Camera, not Overlay (capture-ability)

The bridge screenshot renders the **Game view via `Camera.Render`**. A **Screen Space - Overlay**
canvas is composited by the engine *after* camera rendering, so it is **NOT captured** — the HUD will
be invisible in `unity_editor_screenshot {view:"game"}` even though it shows in a live editor.

Fix: set the Canvas to **Screen Space - Camera** and assign the rendering camera. It still behaves as
a screen-anchored HUD, but now goes through the camera and is captured.

```
unity_component_set_property Canvas m_RenderMode   = 1            # ScreenSpaceCamera (0=Overlay, 2=World)
unity_component_set_property Canvas m_Camera       = {locator:{path:"/Main Camera"}}
unity_component_set_property Canvas m_PlaneDistance = 10
```

Verify the camera reference took: read back `m_Camera` (`currentValue` should be the camera object name).

## Crisp HUD over a pixel-perfect camera

A Screen Space - Camera HUD rendered through a camera that also has a **`PixelPerfectCamera`** with
**`upscaleRT = true`** comes out **soft/faded in play** (crisp in edit mode — the RT path isn't applied
there, which masks the bug). Root cause: `upscaleRT=true` renders the whole frame *including* the HUD
into a low-res render-texture (e.g. `256×144`) and upscales it, so the TMP text is rasterized at native
res and stretched up → blurry. It looks fine in edit mode but ships blurry.

**PRIMARY fix (verify-friendly): turn the RT off.** Set `upscaleRT = false`, keep `pixelSnapping = true`.
The main camera then renders at full screen resolution, so the Screen Space - Camera HUD is crisp **and**
still captured by the bridge screenshot (`Camera.Render` of the main camera composites the
Screen Space - Camera UI).

```
unity_component_set_property PixelPerfectCamera m_UpscaleRT    = false
unity_component_set_property PixelPerfectCamera m_PixelSnapping = true
```

**ALTERNATIVE (only if you must keep `upscaleRT=true`** for hard integer pixel-art upscaling): put the
HUD on a **separate UI camera with NO `PixelPerfectCamera`** — a second `Camera`, higher `depth`,
`clearFlags = Depth only`; the HUD Canvas is Screen Space - Camera referencing *that* UI camera.
**Caveat:** the bridge screenshot renders only the **main** camera, so a second-camera HUD will **NOT**
appear in verify screenshots — you'd have to verify the HUD some other way. Because of that, prefer
`upscaleRT = false`.

> The verify **`ui-conformance`** gate now **fails** if `upscaleRT == true` AND the HUD renders through
> that pixel-perfect camera (reads `scan.canvas` — see `verify-2d-game/references/framing-checks.md`).

## HUD "bounce" on play-enter under a PixelPerfectCamera — prime the runtime ortho early

**Symptom:** a Screen Space - Camera HUD renders at a slightly different scale/position for the FIRST
frame of Play Mode, then snaps to the correct layout (a one-frame jump). Edit mode and the settled play
frame both look right; only the play-enter transition flickers.

**Root cause (source-backed, observed during slice-pipeline dogfood):** in `com.unity.2d.pixel-perfect`,
`PixelPerfectCamera.LateUpdate()` computes the runtime pixel-perfect/overscan size, but
`OnPreCull()` applies it to `camera.orthographicSize` just before render. During play-enter, a
Screen Space - **Camera** HUD can perform its first canvas layout while the camera still has the
serialized/authored ortho size, then re-layout once PixelPerfect has applied the runtime overscan size.
That authored→runtime ortho delta is what produces the one-frame HUD jump. In this failure mode,
switching CanvasScaler between Constant Pixel Size and Scale With Screen Size did not remove the bounce;
the trigger was the PixelPerfect overscan transition, which only exists when the Game view is not an
exact integer multiple of the reference resolution.

**Fix — prime the camera's runtime ortho before the canvas's first layout** (do NOT just hide the HUD for
a frame; that masks it). Drop `PixelPerfectOrthoPrime` on the main camera (`[DefaultExecutionOrder(1000)]`
so it runs after PixelPerfect's own default execution slot). In `OnEnable` + `Start` (+ the first couple of
`LateUpdate`s, for late screen-size resolve) it recomputes PixelPerfect's final size with the package's
own formula and applies it to `camera.orthographicSize`, then `Canvas.ForceUpdateCanvases()`:

Write it to `Assets/Scripts/Camera/PixelPerfectOrthoPrime.cs`:

```csharp
using UnityEngine;
using UnityEngine.U2D;

/// <summary>
/// Primes the runtime Camera.orthographicSize to PixelPerfectCamera's no-crop/no-upscale
/// value before the first Screen Space - Camera HUD layout.
///
/// Use only with the no-crop / no-upscaleRT PixelPerfectCamera configuration. Other
/// PixelPerfect modes have different sizing paths; this component no-ops there.
/// </summary>
[DefaultExecutionOrder(1000)]
[RequireComponent(typeof(Camera))]
public class PixelPerfectOrthoPrime : MonoBehaviour
{
    private Camera _cam;
    private PixelPerfectCamera _ppc;
    private int _primedFrames;

    private void OnEnable()
    {
        _cam = GetComponent<Camera>();
        _ppc = GetComponent<PixelPerfectCamera>();
        _primedFrames = 0;
        Prime();
    }

    private void Start() => Prime();

    private void LateUpdate()
    {
        // Re-prime for a couple of frames in case the Game view size resolves late
        // (for example Maximize On Play). PixelPerfect owns the value afterward.
        if (_primedFrames < 2)
        {
            Prime();
            _primedFrames++;
        }
        else
        {
            enabled = false;
        }
    }

    private void Prime()
    {
        if (_cam == null || _ppc == null || !_cam.orthographic) return;
        if (_ppc.cropFrameX || _ppc.cropFrameY || _ppc.upscaleRT) return;

        int refX = Mathf.Max(1, _ppc.refResolutionX);
        int refY = Mathf.Max(1, _ppc.refResolutionY);
        int ppu = Mathf.Max(1, _ppc.assetsPPU);
        int width = Screen.width;
        int height = Screen.height;
        if (width <= 0 || height <= 0) return;

        // Matches the no-crop / no-upscale branch of
        // PixelPerfectCameraInternal.CalculateCameraProperties.
        int zoom = Mathf.Max(1, Mathf.Min(width / refX, height / refY));
        float orthoSize = (height * 0.5f) / (zoom * ppu);
        if (orthoSize <= 0f || Mathf.Approximately(_cam.orthographicSize, orthoSize)) return;

        _cam.orthographicSize = orthoSize;
        Canvas.ForceUpdateCanvases();
    }
}
```

This sets only the RUNTIME value PixelPerfect would apply anyway; the serialized authored size is
untouched, so edit mode and the `framing` gate's `camera.authoredOrthographicSize` remain valid. The
fully zero-transition option across edit→play is a Game View panel at an exact integer 16:9 multiple of
the reference resolution (no overscan at all), but that is a per-developer editor setting, not a build
artifact.

## TMP essential resources (or text renders blank)

`unity_ui_add_text text_backend:"tmp"` creates a `TextMeshProUGUI`, but TMP needs its **essential
resources** (default font asset `LiberationSans SDF`, shaders, `TMP Settings`) imported, or every TMP
label renders **blank**. There is no `Assets/TextMesh Pro/` folder in a fresh project.

Importing them headlessly is fiddly:
- `AssetDatabase.FindAssets("TMP Essential Resources")` can't find the `.unitypackage` — it lives in
  the editor install (`<EditorContents>/Resources/PackageManager/BuiltInPackages/com.unity.ugui/Package
  Resources/TMP Essential Resources.unitypackage`), outside the project's asset index.
- `AssetDatabase.ImportPackage(path,false)` is async and **refuses to unpack during Play Mode**
  ("Failed to unpack package contents").
- `[InitializeOnLoad]` + `EditorApplication.delayCall` only fires on a **real domain reload**; a
  refresh-only recompile (editor unfocused) often does not reload the domain, so the hook never runs.

**Reliable path used here:** extract the `.unitypackage` (it's a gzip tar of GUID-keyed entries, each
with `pathname` + `asset` + `asset.meta`) and reconstruct `Assets/TextMesh Pro/...` directly on disk,
**preserving each entry's original `.meta`** (so the font-asset GUID matches what TMP references), then
`unity_editor_refresh_assets`. This sidesteps domain-reload and play-mode entirely. The shipped GUIDs
must be preserved or serialized references break.

> Tip for verifying headless editor code that runs during domain reload: have it append to a file under
> `Temp/` (the bridge console buffer can drop logs emitted mid-reload). Read the file out-of-band.

## Generate a TMP SDF font asset from a TTF

When the game brief supplies a HUD font as a **TTF only**, TMP can't render it directly — it needs a
**TMP SDF font asset** (`.asset` with the glyph atlas + material baked in). If there is no prebuilt SDF
asset, build it with the Editor script below.

It builds the SDF via `TMP_FontAsset.CreateFontAsset(...)` (dynamic atlas, SDFAA render mode), writes it
with `AssetDatabase.CreateAsset`, then `AddObjectToAsset`s the atlas texture(s) + material as **sub-assets**
so the `.asset` is self-contained. It's **idempotent** (skips if the SDF already exists) and **one-shot**
(fires on domain reload via `[DidReloadScripts]`, also exposed as a menu item for manual rebuilds).

Write it to `Assets/Scripts/Editor/TmpFontAssetBuilder.cs` and set `TtfPath` / `OutPath` from the
game contract:

```csharp
#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using TMPro;

/// <summary>
/// Editor-only one-shot builder that generates a TextMeshPro SDF font asset from the
/// configured TTF and writes it to the configured SDF asset path. Runs once on domain reload if the asset is missing
/// (idempotent), so a headless refresh/recompile produces the asset without a manual menu click.
/// Also exposed as a menu item for manual rebuilds.
/// </summary>
public static class TmpFontAssetBuilder
{
    private const string TtfPath = "Assets/Fonts/<GameFont>.ttf";
    private const string OutPath = "Assets/Fonts/<GameFont> SDF.asset";

    // Runs synchronously on the main thread after every script reload (the editor being
    // backgrounded throttles delayCall, but this fires during reload). Idempotent.
    [UnityEditor.Callbacks.DidReloadScripts]
    private static void OnScriptsReloaded()
    {
        Debug.Log("[TmpFontAssetBuilder] DidReloadScripts fired; checking SDF asset.");
        BuildIfMissing();
    }

    [MenuItem("Loomtide/Build TMP Font")]
    public static void BuildMenu() => Build(force: true);

    private static void BuildIfMissing()
    {
        if (AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(OutPath) != null)
        {
            Debug.Log("[TmpFontAssetBuilder] SDF asset already present at " + OutPath);
            return;
        }
        Build(force: false);
    }

    private static void Build(bool force)
    {
        if (!force && AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(OutPath) != null) return;

        Font source = AssetDatabase.LoadAssetAtPath<Font>(TtfPath);
        if (source == null)
        {
            Debug.LogWarning("[PressStart2PFontBuilder] Source TTF not found at " + TtfPath);
            return;
        }

        // Dynamic SDF font asset: 1024 atlas, sampling 90, padding 9, raster bevel/SDFAA.
        TMP_FontAsset fontAsset = TMP_FontAsset.CreateFontAsset(
            source,
            samplingPointSize: 90,
            atlasPadding: 9,
            renderMode: UnityEngine.TextCore.LowLevel.GlyphRenderMode.SDFAA,
            atlasWidth: 1024,
            atlasHeight: 1024,
            atlasPopulationMode: AtlasPopulationMode.Dynamic,
            enableMultiAtlasSupport: true);

        if (fontAsset == null)
        {
            Debug.LogError("[PressStart2PFontBuilder] CreateFontAsset returned null.");
            return;
        }

        fontAsset.name = "PressStart2P SDF";

        AssetDatabase.CreateAsset(fontAsset, OutPath);

        // Persist the atlas texture(s) and material as sub-assets so the .asset is self-contained.
        if (fontAsset.atlasTextures != null)
        {
            foreach (var tex in fontAsset.atlasTextures)
            {
                if (tex != null && !AssetDatabase.Contains(tex))
                {
                    tex.name = "PressStart2P Atlas";
                    AssetDatabase.AddObjectToAsset(tex, fontAsset);
                }
            }
        }
        if (fontAsset.material != null && !AssetDatabase.Contains(fontAsset.material))
        {
            fontAsset.material.name = "PressStart2P SDF Material";
            AssetDatabase.AddObjectToAsset(fontAsset.material, fontAsset);
        }

        EditorUtility.SetDirty(fontAsset);
        AssetDatabase.SaveAssets();
        AssetDatabase.ImportAsset(OutPath);
        Debug.Log("[PressStart2PFontBuilder] Created TMP font asset at " + OutPath);
    }
}
#endif
```

**Trigger / domain-reload gotcha.** The builder fires on `[DidReloadScripts]` — i.e. a real **domain
reload**. After you Write the file, `unity_editor_refresh_assets` recompiles, but when the **editor is
backgrounded** a refresh-only recompile often does **not** reload the domain, so `DidReloadScripts` never
runs and the SDF silently isn't built (same class of issue as the TMP-essentials hook above). **Force a
reload with a brief Play-mode toggle**: `unity_editor_play` → `unity_editor_wait_for {isPlaying:true}` →
`unity_editor_stop`. Entering/exiting Play mode triggers a domain reload, which fires the builder. Then
confirm the asset exists before wiring TMP labels' `font` to it.
TMP **essential resources must already be present** (previous section) or `CreateFontAsset` has nothing
to build the material/shader against.

## HUD layout that screenshots cleanly

Panel (`unity_ui_add_image`, child of Canvas), anchored according to the contract:
- use contract palette/opacity, size, padding, anchor, and inset values.

Labels (`unity_ui_add_text text_backend:"tmp"`, children of the panel), padded inside:
- ScoreLabel/LivesLabel/TimerLabel: use the contract font, color roles, sizes, alignment, and anchors.

Message (`unity_ui_add_text text_backend:"tmp"`, child of Canvas), centered or anchored per contract:
- use contract font, color role, size, alignment, anchor/pivot, and sorting/render-mode requirements.
  size ~`(800,120)`. Start empty.

## Apply via MCP

1. Create `Assets/Scripts/HudController.cs` (+ `.cs.meta` with a 32-hex guid) and refactor game logic
   to delegate. Recompile: `unity_editor_refresh_assets` → `unity_editor_wait_for {compiling:false}`.
2. Ensure TMP essentials are present (see above).
3. Set Canvas to Screen Space - Camera + assign camera (see above).
4. Add panel image; add the three TMP labels; position with `unity_ui_set_rect_transform`.
5. `unity_code_attach_script HudController` to the Canvas; wire `scoreLabel/livesLabel/messageLabel`
   (and `timerLabel` if you show a run timer) via `unity_component_set_property
   value:{locator:{path:...}}`; wire game logic's `hud` to the Canvas.
6. Screenshot `view:"game"` and iterate (no clipping, readable, anchored).

## Gotchas
- `unity_component_set_property value:""` (empty string) can be dropped in transit — to "clear" a TMP
  label at edit time, set a single space `" "`; runtime `ShowMessage("")` clears it properly on play.
- Wiring object references: pass `{"locator":{"path":"/Path/To/Obj"}}` as `value` (JSON shape preserved).
- TMP component type name for property reads/writes is `TMPro.TextMeshProUGUI`.
```
