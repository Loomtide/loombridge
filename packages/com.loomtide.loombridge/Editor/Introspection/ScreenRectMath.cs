using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Shared screen-space rect math so the world-space op (ScreenSpaceIntrospection) and the
    /// uGUI op (UIScreenSpaceIntrospection) emit IDENTICAL screenRect / clip-flag / anchor-fraction
    /// semantics. Verification gates consume both ops uniformly, so this contract must not drift.
    ///
    /// Convention: screen rects are in PIXELS, origin BOTTOM-LEFT (matching Camera.WorldToScreenPoint
    /// and RectTransformUtility.WorldToScreenPoint).
    /// </summary>
    public static class ScreenRectMath
    {
        public static JObject RectJ(Rect r) => new JObject
        {
            ["x"] = r.x, ["y"] = r.y, ["width"] = r.width, ["height"] = r.height
        };

        /// <summary>Normalized 0..1 rect = screen rect divided by the viewport, origin bottom-left.</summary>
        public static JObject ViewportRectJ(Rect r, int screenW, int screenH)
        {
            float w = Mathf.Max(1, screenW);
            float h = Mathf.Max(1, screenH);
            return new JObject
            {
                ["x"] = r.x / w, ["y"] = r.y / h, ["width"] = r.width / w, ["height"] = r.height / h
            };
        }

        public static bool IsFullyVisible(Rect r, int screenW, int screenH) =>
            r.xMin >= 0 && r.yMin >= 0 && r.xMax <= screenW && r.yMax <= screenH;

        public static bool IsOffScreen(Rect r, int screenW, int screenH) =>
            r.xMax <= 0 || r.yMax <= 0 || r.xMin >= screenW || r.yMin >= screenH;

        public static float CenterXFraction(Rect r, int screenW) =>
            ((r.xMin + r.xMax) * 0.5f) / Mathf.Max(1, screenW);

        public static float CenterYFraction(Rect r, int screenH) =>
            ((r.yMin + r.yMax) * 0.5f) / Mathf.Max(1, screenH);

        public static JToken ClipSideJ(Rect r, int screenW, int screenH)
        {
            var sides = new JArray();
            if (r.xMin < 0) sides.Add("left");
            if (r.xMax > screenW) sides.Add("right");
            if (r.yMin < 0) sides.Add("bottom");
            if (r.yMax > screenH) sides.Add("top");
            if (sides.Count == 0) return JValue.CreateNull();
            return sides;
        }

        /// <summary>
        /// Resolves the pixel screen size to project into: active Game View size, else the camera's
        /// pixel rect when sane, else a 256x144 native fallback so a backgrounded editor (collapsed
        /// pixelRect) still projects meaningfully. <paramref name="cam"/> may be null (overlay UI).
        /// </summary>
        public static void ResolveScreenSize(Camera cam, out int width, out int height)
        {
            // 1) Active Game View size (what the user sees in the tab).
            Vector2 gameViewSize = UnityEditor.Handles.GetMainGameViewSize();
            if (gameViewSize.x > 1f && gameViewSize.y > 1f)
            {
                width = Mathf.RoundToInt(gameViewSize.x);
                height = Mathf.RoundToInt(gameViewSize.y);
                return;
            }

            // 2) Camera pixel rect when sane.
            if (cam != null && cam.pixelWidth > 1 && cam.pixelHeight > 1)
            {
                width = cam.pixelWidth;
                height = cam.pixelHeight;
                return;
            }

            // 3) Native 16:9 fallback.
            width = 256;
            height = 144;
        }
    }
}
