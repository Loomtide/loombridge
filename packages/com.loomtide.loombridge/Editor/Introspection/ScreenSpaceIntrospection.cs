using System;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Projects each object's world bounds into screen space through a camera to answer the
    /// framing/composition question: is the visible character fully inside the frame, where
    /// is it horizontally (40%-anchor check), and which edge is it clipped against. This is
    /// the numeric counterpart to eyeballing a screenshot for "player clipped at the left".
    ///
    /// Bounds modes (default = opaque): which bounds drives screenRect/clip flags —
    ///   opaque   — the OPAQUE (visible) pixels of the current sprite frame (the "is the
    ///              visible CHARACTER clipped" question we care about),
    ///   renderer — the full sprite-quad renderer bounds (includes transparent padding),
    ///   collider — the collider bounds.
    /// rendererRect/colliderRect are always included as debug, plus camera/viewport info.
    /// Math mirrors ScreenshotCapture's WorldToScreenPoint projection.
    /// </summary>
    public static class ScreenSpaceIntrospection
    {
        public static JObject GetScreenRects(JArray locators, JObject cameraLocator, string boundsMode)
        {
            if (locators == null || locators.Count == 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locators' (a non-empty array).");

            string mode = string.IsNullOrEmpty(boundsMode) ? "opaque" : boundsMode.ToLowerInvariant();
            if (mode != "opaque" && mode != "renderer" && mode != "collider")
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Invalid 'boundsMode': '{boundsMode}'. Expected opaque, renderer, or collider.");

            Camera cam = ResolveCamera(cameraLocator);
            if (cam == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    "No camera available (Camera.main missing and no 'camera' locator provided).");

            // Screen dimensions: use the camera's pixel rect when sane, otherwise the active
            // Game View size, otherwise fall back to a 256x144 native frame so projection is
            // still meaningful when the editor is backgrounded (pixelRect collapses).
            int screenW, screenH;
            ScreenRectMath.ResolveScreenSize(cam, out screenW, out screenH);

            var results = new JArray();
            foreach (JToken tok in locators)
            {
                if (!(JsonValueCoercer.Rehydrate(tok) is JObject loc))
                    continue;

                GameObject go;
                try { go = LocatorResolver.Resolve(loc); }
                catch (Exception ex)
                {
                    results.Add(new JObject
                    {
                        ["locator"] = loc,
                        ["error"] = ex.Message
                    });
                    continue;
                }

                Bounds? opaque = BoundsCapture.CombinedOpaqueBounds(go);
                Bounds? renderer = BoundsCapture.CombinedBounds(go, includeColliders: false, includeRenderers: true);
                Bounds? collider = BoundsCapture.CombinedBounds(go, includeColliders: true, includeRenderers: false);

                Bounds? primary = mode == "renderer" ? renderer
                    : mode == "collider" ? collider
                    : (opaque ?? renderer); // opaque default, fall back to renderer if no sprite

                var entry = new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(go),
                    ["name"] = go.name,
                    ["boundsMode"] = mode
                };

                if (!primary.HasValue)
                {
                    entry["screenRect"] = JValue.CreateNull();
                    entry["isFullyVisible"] = false;
                    entry["isPartiallyClipped"] = false;
                    entry["clipSide"] = JValue.CreateNull();
                    entry["boundsUnavailable"] = "no measurable renderer/collider/opaque bounds";
                }
                else
                {
                    Rect r = ProjectBoundsToScreen(cam, primary.Value, screenW, screenH);
                    entry["screenRect"] = ScreenRectMath.RectJ(r);

                    bool fullyVisible = ScreenRectMath.IsFullyVisible(r, screenW, screenH);
                    bool offScreen = ScreenRectMath.IsOffScreen(r, screenW, screenH);
                    bool partiallyClipped = !fullyVisible && !offScreen;

                    entry["isFullyVisible"] = fullyVisible;
                    entry["isPartiallyClipped"] = partiallyClipped;
                    entry["isOffScreen"] = offScreen;
                    entry["clipSide"] = ScreenRectMath.ClipSideJ(r, screenW, screenH);
                    // Horizontal anchor as a fraction of screen width (the 40%-anchor check).
                    entry["centerXFraction"] = ScreenRectMath.CenterXFraction(r, screenW);
                    entry["centerYFraction"] = ScreenRectMath.CenterYFraction(r, screenH);
                }

                if (renderer.HasValue) entry["rendererRect"] = ScreenRectMath.RectJ(ProjectBoundsToScreen(cam, renderer.Value, screenW, screenH));
                if (collider.HasValue) entry["colliderRect"] = ScreenRectMath.RectJ(ProjectBoundsToScreen(cam, collider.Value, screenW, screenH));
                if (opaque.HasValue) entry["opaqueRect"] = ScreenRectMath.RectJ(ProjectBoundsToScreen(cam, opaque.Value, screenW, screenH));

                results.Add(entry);
            }

            return new JObject
            {
                ["camera"] = new JObject
                {
                    ["name"] = cam.name,
                    ["locator"] = LocatorResolver.BuildLocator(cam.gameObject),
                    ["orthographic"] = cam.orthographic,
                    ["orthographicSize"] = cam.orthographicSize,
                    ["position"] = new JObject { ["x"] = cam.transform.position.x, ["y"] = cam.transform.position.y, ["z"] = cam.transform.position.z }
                },
                ["viewport"] = new JObject
                {
                    ["width"] = screenW,
                    ["height"] = screenH,
                    ["aspect"] = (float)screenW / Mathf.Max(1, screenH)
                },
                ["boundsMode"] = mode,
                ["objects"] = results
            };
        }

        /// <summary>
        /// Projects the four XY corners of a world AABB through the camera into screen pixels
        /// (origin bottom-left, matching Camera.WorldToScreenPoint) and returns the axis-aligned
        /// screen-space bounding rect.
        /// </summary>
        private static Rect ProjectBoundsToScreen(Camera cam, Bounds b, int screenW, int screenH)
        {
            float z = b.center.z;
            Vector3[] corners =
            {
                new Vector3(b.min.x, b.min.y, z),
                new Vector3(b.max.x, b.min.y, z),
                new Vector3(b.max.x, b.max.y, z),
                new Vector3(b.min.x, b.max.y, z)
            };

            float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
            for (int i = 0; i < 4; i++)
            {
                // WorldToScreenPoint uses the camera's current pixel rect; scale to our
                // resolved screen size so backgrounded (collapsed-rect) cameras still map
                // onto the intended frame.
                Vector3 sp = cam.WorldToScreenPoint(corners[i]);
                float px = sp.x;
                float py = sp.y;
                if (cam.pixelWidth > 1 && cam.pixelHeight > 1 &&
                    (cam.pixelWidth != screenW || cam.pixelHeight != screenH))
                {
                    px = sp.x / cam.pixelWidth * screenW;
                    py = sp.y / cam.pixelHeight * screenH;
                }
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }

            return new Rect(minX, minY, maxX - minX, maxY - minY);
        }

        private static Camera ResolveCamera(JObject cameraLocator)
        {
            if (cameraLocator != null)
            {
                GameObject go = LocatorResolver.Resolve(cameraLocator);
                Camera cam = go.GetComponent<Camera>();
                if (cam == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"GameObject '{go.name}' has no Camera component.");
                return cam;
            }

            if (Camera.main != null)
                return Camera.main;

            Camera[] all = Camera.allCameras;
            return (all != null && all.Length > 0) ? all[0] : null;
        }
    }
}
