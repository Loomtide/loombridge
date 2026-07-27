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
