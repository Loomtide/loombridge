# GroundTiling: locked horizontal platform tiling

Use this component spec for 2D platformer ground and floating platforms. It is authored as a
good-by-construction Unity component: one tiled `SpriteRenderer` per platform span, optional cap/body
stack for thick terrain, and deterministic capture metadata for the `platform-tiles` and `tile-render`
gates.

This component + its JSON contract are locked here. The runnable bridge emitter that invokes
`WriteTileCaptures(string outDir)` now ships: the allowlisted `capture.invoke_static` op, driven by
**`loombridge capture --slice <ground-tiling-slice>`** (which dispatches the tiling recipe from the slice's
`platform-tiles`/`tile-render` gates), writes `platform-tiles.json` + `tile-render.json` under
`.loombridge/verify/<slice>/` with a `_provenance` block. Capture JSON is never hand-authored. Author this
component verbatim at `Assets/Scripts/Level/GroundTiling.cs` (no asmdef ⇒ Assembly-CSharp ⇒ the
Newtonsoft-free JSON above is required to compile).

```csharp
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEngine;

/// <summary>
/// Good-by-construction platform tiling for 2D platformer terrain.
///
/// Invariant:
/// - A platform span uses ONE SpriteRenderer in DrawMode.Tiled, sized to N whole tile widths and exactly
///   one tile of height.
/// - Thick ground uses at most two renderers: a capped top row and an optional body-fill row/stack below.
/// - No per-tile GameObjects are created, so per-tile border seams are structurally impossible.
/// - The BoxCollider2D top is fitted to the visible walkable surface. Prefer the opaque-pixel fitting
///   helper from game-polish-2d (FitBoxColliderToSprite) when available; otherwise set the collider top
///   to the renderer's visible top and its width to the tiled span.
///
/// Unity 2022.3+ / 6000.3 compatible: uses SpriteRenderer.drawMode/size and BoxCollider2D.
/// WriteTileCaptures emits its gate JSON WITHOUT Newtonsoft — com.unity.nuget.newtonsoft-json
/// is NOT auto-referenced by a clean-room Assembly-CSharp (no asmdef under Assets/), so a
/// JsonConvert call would fail to compile there. The JSON shape is identical to the contract
/// the platform-tiles / tile-render gates read.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(BoxCollider2D))]
public sealed class GroundTiling : MonoBehaviour
{
    public enum PlatformRole { Ground, Floating }
    public enum StackMode { SingleCapRow, CapAndBody }

    [Header("Platform")]
    public string platformName = "Ground";
    public PlatformRole role = PlatformRole.Ground;
    public StackMode stackMode = StackMode.SingleCapRow;

    [Tooltip("Whole number of source tile widths across this platform.")]
    [Min(1)] public int widthTiles = 8;

    [Tooltip("Source tile width in world units. Usually sprite.rect.width / pixelsPerUnit.")]
    [Min(0.01f)] public float tileWorldWidth = 1f;

    [Tooltip("Source tile height in world units. The CAP row is always exactly this.")]
    [Min(0.01f)] public float tileWorldHeight = 1f;

    [Tooltip("How many body (fill) rows below the cap. Make a ground thick enough to fill PAST the frame bottom so it reads as solid and has NO exposed bottom corner the player can catch on (a thin floating slab's bottom edge wedges the player's collider corner).")]
    [Min(1)] public int bodyRows = 1;

    [Header("Sprites")]
    public Sprite capSprite;
    public Sprite bodySprite;

    [Tooltip("How many sprite columns on each side form the edge/boundary band sampled for tile-render.")]
    [Range(1, 8)] public int edgeCols = 2;

    [Header("Generated renderers")]
    public SpriteRenderer capRenderer;
    public SpriteRenderer bodyRenderer;

    private BoxCollider2D _collider;

    private void Reset()
    {
        _collider = GetComponent<BoxCollider2D>();
        EnsureRenderers();
        Apply();
    }

    private void OnValidate()
    {
        widthTiles = Mathf.Max(1, widthTiles);
        tileWorldWidth = Mathf.Max(0.01f, tileWorldWidth);
        tileWorldHeight = Mathf.Max(0.01f, tileWorldHeight);
        edgeCols = Mathf.Max(1, edgeCols);
#if UNITY_EDITOR
        // Setting a Tiled SpriteRenderer.size triggers OnSpriteTilingPropertyChange, which Unity
        // refuses to SendMessage during OnValidate (it logs a warning that trips the console-clean
        // gate). OnValidate also runs on play-enter with isPlaying already true, so ALWAYS defer
        // Apply() out of the OnValidate stack via delayCall (editor-only; OnValidate never runs in a
        // built player).
        UnityEditor.EditorApplication.delayCall += () =>
        {
            if (this == null) return;
            EnsureRenderers();
            Apply();
        };
        return;
#else
        EnsureRenderers();
        Apply();
#endif
    }

    public void Apply()
    {
        EnsureRenderers();
        ConfigureRenderer(capRenderer, capSprite, "top_cap", new Vector2(widthTiles * tileWorldWidth, tileWorldHeight), Vector3.zero);

        if (stackMode == StackMode.CapAndBody && bodySprite != null)
        {
            bodyRenderer.gameObject.SetActive(true);
            int rows = Mathf.Max(1, bodyRows);
            ConfigureRenderer(
                bodyRenderer,
                bodySprite,
                "body_fill",
                new Vector2(widthTiles * tileWorldWidth, rows * tileWorldHeight),
                new Vector3(0f, -tileWorldHeight * (1f + rows) * 0.5f, 0f));
        }
        else if (bodyRenderer != null)
        {
            bodyRenderer.gameObject.SetActive(false);
        }

        FitColliderToVisibleSurface();
    }

    private void EnsureRenderers()
    {
        _collider = GetComponent<BoxCollider2D>();
        if (capRenderer == null) capRenderer = EnsureChildRenderer("CapRow");
        if (bodyRenderer == null) bodyRenderer = EnsureChildRenderer("BodyRow");
    }

    private SpriteRenderer EnsureChildRenderer(string childName)
    {
        Transform child = transform.Find(childName);
        if (child == null)
        {
            var go = new GameObject(childName);
            go.transform.SetParent(transform, false);
            child = go.transform;
        }
        var renderer = child.GetComponent<SpriteRenderer>();
        if (renderer == null) renderer = child.gameObject.AddComponent<SpriteRenderer>();
        return renderer;
    }

    private void ConfigureRenderer(SpriteRenderer renderer, Sprite sprite, string sortingRole, Vector2 size, Vector3 localPosition)
    {
        renderer.sprite = sprite;
        renderer.drawMode = SpriteDrawMode.Tiled;
        renderer.tileMode = SpriteTileMode.Continuous;
        renderer.size = size;             // X repeats, Y is exactly one source tile.
        renderer.transform.localPosition = localPosition;
        renderer.gameObject.name = sortingRole;
    }

    private void FitColliderToVisibleSurface()
    {
        if (_collider == null) return;
        float width = widthTiles * tileWorldWidth;
        float height = stackMode == StackMode.CapAndBody && bodySprite != null ? tileWorldHeight * (1f + Mathf.Max(1, bodyRows)) : tileWorldHeight;
        _collider.size = new Vector2(width, height);
        _collider.offset = new Vector2(0f, -height * 0.5f + tileWorldHeight * 0.5f);
        // If FitBoxColliderToSprite from game-polish-2d is present, run it after Apply() to trim transparent
        // sprite padding while preserving the same top-edge invariant.
    }

    /// <summary>
    /// Write platform-tiles.json and tile-render.json into outDir. Emits raw structure and raw sprite
    /// luminance samples only; the TypeScript tile-render gate computes the seam verdict. JSON is built
    /// WITHOUT Newtonsoft (see class note) so it compiles in a clean-room Assembly-CSharp; the shape is
    /// identical to the gate contract below.
    /// </summary>
    public static void WriteTileCaptures(string outDir)
    {
        Directory.CreateDirectory(outDir);
        List<Capture> captures = FindObjectsByType<GroundTiling>(FindObjectsSortMode.None).Select(p => p.ToCapture()).ToList();

        var pt = new StringBuilder();
        pt.Append("{\n  \"platforms\": [");
        for (int i = 0; i < captures.Count; i++)
        {
            Capture c = captures[i];
            if (i > 0) pt.Append(',');
            pt.Append("\n    {");
            pt.Append("\n      \"name\": ").Append(JsonStr(c.name)).Append(',');
            pt.Append("\n      \"widthTiles\": ").Append(c.widthTiles).Append(',');
            pt.Append("\n      \"heightTiles\": ").Append(c.heightTiles).Append(',');
            pt.Append("\n      \"rows\": [");
            pt.Append("\n        { \"index\": 0, \"role\": \"top_cap\" }");
            for (int row = 1; row < c.heightTiles; row++)
                pt.Append(",\n        { \"index\": ").Append(row).Append(", \"role\": \"body_fill\" }");
            pt.Append("\n      ],");
            pt.Append("\n      \"colliderTopY\": ").Append(JsonNum(c.colliderTopY)).Append(',');
            pt.Append("\n      \"visibleTopY\": ").Append(JsonNum(c.visibleTopY));
            pt.Append("\n    }");
        }
        pt.Append("\n  ]\n}\n");
        File.WriteAllText(Path.Combine(outDir, "platform-tiles.json"), pt.ToString());

        var tr = new StringBuilder();
        tr.Append("{\n  \"platforms\": [");
        for (int i = 0; i < captures.Count; i++)
        {
            Capture c = captures[i];
            if (i > 0) tr.Append(',');
            tr.Append("\n    {");
            tr.Append("\n      \"name\": ").Append(JsonStr(c.name)).Append(',');
            tr.Append("\n      \"drawMode\": ").Append(JsonStr(c.drawMode)).Append(',');
            tr.Append("\n      \"rendererCount\": ").Append(c.rendererCount).Append(',');
            tr.Append("\n      \"widthTiles\": ").Append(c.widthTiles).Append(',');
            tr.Append("\n      \"tileSprite\": {");
            tr.Append("\n        \"name\": ").Append(JsonStr(c.spriteName)).Append(',');
            tr.Append("\n        \"tileWidthPx\": ").Append(c.columnLuma.Count).Append(',');
            tr.Append("\n        \"edgeCols\": ").Append(c.edgeCols).Append(',');
            tr.Append("\n        \"columnLuma\": [");
            for (int j = 0; j < c.columnLuma.Count; j++)
            {
                if (j > 0) tr.Append(", ");
                tr.Append(JsonNum(c.columnLuma[j]));
            }
            tr.Append("]");
            tr.Append("\n      }");
            tr.Append("\n    }");
        }
        tr.Append("\n  ]\n}\n");
        File.WriteAllText(Path.Combine(outDir, "tile-render.json"), tr.ToString());
    }

    private struct Capture
    {
        public string name;
        public int widthTiles;
        public int heightTiles;
        public float colliderTopY;
        public float visibleTopY;
        public string drawMode;
        public int rendererCount;
        public string spriteName;
        public int edgeCols;
        public List<float> columnLuma;
    }

    private Capture ToCapture()
    {
        int heightTiles = stackMode == StackMode.CapAndBody && bodySprite != null ? 1 + Mathf.Max(1, bodyRows) : 1;
        Sprite sprite = capRenderer != null ? capRenderer.sprite : capSprite;
        List<float> luma = SampleColumnLuma(sprite);
        int rendererCount = 1 + (bodyRenderer != null && bodyRenderer.gameObject.activeInHierarchy ? 1 : 0);
        float visibleTopY = capRenderer != null ? capRenderer.bounds.max.y : transform.position.y + tileWorldHeight * 0.5f;
        float colliderTopY = _collider != null ? _collider.bounds.max.y : visibleTopY;

        return new Capture
        {
            name = platformName,
            widthTiles = widthTiles,
            heightTiles = heightTiles,
            colliderTopY = colliderTopY,
            visibleTopY = visibleTopY,
            drawMode = capRenderer != null ? capRenderer.drawMode.ToString() : "Tiled",
            rendererCount = rendererCount,
            spriteName = sprite != null ? sprite.name : "",
            edgeCols = edgeCols,
            columnLuma = luma,
        };
    }

    private static string JsonStr(string s)
    {
        if (s == null) return "\"\"";
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string JsonNum(float v)
    {
        return v.ToString("R", CultureInfo.InvariantCulture);
    }

    private static List<float> SampleColumnLuma(Sprite sprite)
    {
        var result = new List<float>();
        if (sprite == null || sprite.texture == null) return result;

        Rect rect = sprite.rect;
        int x0 = Mathf.RoundToInt(rect.x);
        int y0 = Mathf.RoundToInt(rect.y);
        int width = Mathf.RoundToInt(rect.width);
        int height = Mathf.RoundToInt(rect.height);

        // Mean luminance per source-sprite column, left to right. Texture import must be readable for
        // the live S3b emitter; if it is not readable, S3b should report an emitter error rather than
        // hand-authoring this JSON.
        for (int x = 0; x < width; x++)
        {
            float sum = 0f;
            int count = 0;
            for (int y = 0; y < height; y++)
            {
                Color c = sprite.texture.GetPixel(x0 + x, y0 + y);
                if (c.a <= 0.01f) continue;
                sum += 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b;
                count++;
            }
            result.Add(count == 0 ? 0f : sum / count);
        }
        return result;
    }
}
```

## Capture Contract

`WriteTileCaptures(outDir)` writes:

- `platform-tiles.json`: `platforms[]` with `name`, `widthTiles`, `heightTiles`, `rows[]`
  (`top_cap` only on row 0, `body_fill` below), `colliderTopY`, and `visibleTopY`.
- `tile-render.json`: `platforms[]` with `name`, `drawMode`, `rendererCount`, `widthTiles`, and
  `tileSprite: { name, tileWidthPx, edgeCols, columnLuma }`.

`columnLuma` is the mean luminance of every source-sprite column from left to right. The C# emitter
does not compute a seam verdict. The TypeScript `tile-render` gate compares edge bands to adjacent
interior bands and the repeated `rightEdge|leftEdge` junction against the sprite interior variation.
