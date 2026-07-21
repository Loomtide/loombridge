using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Computes the WORLD-space bounds of a SpriteRenderer's *opaque* pixels for the
    /// sprite it is currently displaying — i.e. the live animation frame's visible
    /// silhouette.
    ///
    /// Why this exists: SpriteRenderer.bounds is the full sprite quad, including
    /// transparent padding, and it is constant across animation frames. It therefore
    /// cannot answer "where are the character's feet right now" — the question behind
    /// feet-float bugs. This scans the sprite's alpha so the visible bottom/left/right/top
    /// are measurable per frame, in world space. Works in edit and play mode.
    ///
    /// Pixel→world mapping: a scanned pixel is in the sprite's <c>textureRect</c> (the
    /// region of the texture this sprite occupies, which may be TRIMMED relative to the
    /// logical <c>rect</c>). The sprite's pivot is measured from the logical rect's
    /// bottom-left, so the local position of a pixel is
    /// <c>(textureRect.origin + pixel − rect.origin − pivot) / ppu</c>, then transformed to
    /// world. Getting the rect-vs-textureRect offset wrong shifts the box, which is why it
    /// is handled explicitly here.
    /// </summary>
    public static class SpriteOpaqueBounds
    {
        public static bool TryComputeWorld(SpriteRenderer sr, out Bounds world,
            out string reason, float alphaThreshold = 0.1f)
        {
            return TryComputeWorld(sr, out world, out reason, out _, alphaThreshold);
        }

        /// <summary>
        /// As above, plus a <paramref name="debug"/> object with the raw scan and sprite
        /// values (rect, textureRect, pivot, ppu, flips, pixel min/max) for verification.
        /// </summary>
        public static bool TryComputeWorld(SpriteRenderer sr, out Bounds world,
            out string reason, out JObject debug, float alphaThreshold = 0.1f)
        {
            world = default;
            debug = null;
            reason = null;

            if (sr == null) { reason = "no SpriteRenderer"; return false; }
            Sprite sp = sr.sprite;
            if (sp == null) { reason = "no sprite assigned"; return false; }
            Texture2D tex = sp.texture;
            if (tex == null) { reason = "sprite has no texture"; return false; }

            Color32[] px;
            try { px = tex.GetPixels32(); }
            catch { reason = "texture not CPU-readable (enable Read/Write)"; return false; }

            Rect tr = sp.textureRect;          // region scanned (may be trimmed)
            Rect rect = sp.rect;               // logical sprite rect (pivot reference)
            int rx = Mathf.FloorToInt(tr.x);
            int ry = Mathf.FloorToInt(tr.y);
            int rw = Mathf.FloorToInt(tr.width);
            int rh = Mathf.FloorToInt(tr.height);
            int texW = tex.width;

            int minX = rw, minY = rh, maxX = -1, maxY = -1;
            for (int yy = 0; yy < rh; yy++)
            {
                int rowStart = (ry + yy) * texW + rx;
                for (int xx = 0; xx < rw; xx++)
                {
                    if (px[rowStart + xx].a / 255f > alphaThreshold)
                    {
                        if (xx < minX) minX = xx;
                        if (xx > maxX) maxX = xx;
                        if (yy < minY) minY = yy;
                        if (yy > maxY) maxY = yy;
                    }
                }
            }

            float ppu = sp.pixelsPerUnit;
            Vector2 pivotPx = sp.pivot; // pixels from the LOGICAL rect's bottom-left

            debug = new JObject
            {
                ["rect"] = RectJ(rect),
                ["textureRect"] = RectJ(tr),
                ["pivotPx"] = new JObject { ["x"] = pivotPx.x, ["y"] = pivotPx.y },
                ["ppu"] = ppu,
                ["flipX"] = sr.flipX,
                ["flipY"] = sr.flipY,
                ["scanPx"] = new JObject { ["minX"] = minX, ["minY"] = minY, ["maxX"] = maxX, ["maxY"] = maxY, ["w"] = rw, ["h"] = rh }
            };

            if (maxX < minX) { reason = "frame fully transparent"; return false; }

            // Texture-pixel → local units. The scanned pixel sits at texture position
            // (textureRect.origin + pixel); subtract the logical rect origin and the pivot
            // (both rect-relative) to land in the sprite's local space. +1 on max makes the
            // range inclusive.
            float ox = tr.x - rect.x;
            float oy = tr.y - rect.y;
            float lMinX = (ox + minX - pivotPx.x) / ppu;
            float lMaxX = (ox + maxX + 1 - pivotPx.x) / ppu;
            float lMinY = (oy + minY - pivotPx.y) / ppu;
            float lMaxY = (oy + maxY + 1 - pivotPx.y) / ppu;

            // Flips mirror the rendering around the pivot, not the transform.
            if (sr.flipX) { float t = -lMinX; lMinX = -lMaxX; lMaxX = t; }
            if (sr.flipY) { float t = -lMinY; lMinY = -lMaxY; lMaxY = t; }

            Transform t2 = sr.transform;
            world = new Bounds(t2.TransformPoint(new Vector3(lMinX, lMinY, 0f)), Vector3.zero);
            world.Encapsulate(t2.TransformPoint(new Vector3(lMaxX, lMinY, 0f)));
            world.Encapsulate(t2.TransformPoint(new Vector3(lMaxX, lMaxY, 0f)));
            world.Encapsulate(t2.TransformPoint(new Vector3(lMinX, lMaxY, 0f)));
            return true;
        }

        private static JObject RectJ(Rect r) => new JObject
        {
            ["x"] = r.x, ["y"] = r.y, ["width"] = r.width, ["height"] = r.height
        };
    }
}
