using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Projects uGUI elements (RectTransform under a Canvas) into SCREEN space — the Canvas-aware
    /// counterpart to ScreenSpaceIntrospection (which only handles world SpriteRenderers/colliders).
    /// This is the data source the deterministic UI gates consume: safe-area, required-in-frame,
    /// tap-target-size, text-clipping, control-overlap.
    ///
    /// Two selection modes:
    ///   - explicit `locators`  → project exactly those elements (resolve errors reported per-entry),
    ///   - omitted/empty        → AUTO-DISCOVER every Graphic (Image/Text/RawImage, incl. Button
    ///                             graphics) under Canvases in the loaded scene(s), inactive included.
    ///
    /// Projection mirrors ScreenSpaceIntrospection's convention: screen rects are PIXELS, origin
    /// BOTTOM-LEFT (RectTransformUtility.WorldToScreenPoint), normalized to the resolved Game-View
    /// size so a backgrounded editor still projects sensibly. The camera is selected per render mode
    /// (null for ScreenSpaceOverlay; the canvas worldCamera/Camera.main otherwise). All screenRect /
    /// clip-flag / centerX-Y-fraction math is shared via ScreenRectMath so both ops are identical.
    /// </summary>
    public static class UIScreenSpaceIntrospection
    {
        public static JObject GetScreenRects(JArray locators, JObject cameraLocator)
        {
            int screenW, screenH;
            // No camera arg is needed to size the frame for UI (overlay has no camera); pass the
            // optional camera only as a hint for its pixel rect.
            Camera hintCam = cameraLocator != null ? ResolveCamera(cameraLocator) : null;
            ScreenRectMath.ResolveScreenSize(hintCam, out screenW, out screenH);

            var results = new JArray();

            if (locators != null && locators.Count > 0)
            {
                foreach (JToken tok in locators)
                {
                    if (!(JsonValueCoercer.Rehydrate(tok) is JObject loc))
                        continue;
                    GameObject go;
                    try { go = LocatorResolver.Resolve(loc); }
                    catch (Exception ex)
                    {
                        results.Add(new JObject { ["locator"] = loc, ["error"] = ex.Message });
                        continue;
                    }
                    results.Add(BuildEntry(go, screenW, screenH));
                }
            }
            else
            {
                foreach (GameObject go in DiscoverUIElements())
                    results.Add(BuildEntry(go, screenW, screenH));
            }

            return new JObject
            {
                ["viewport"] = new JObject
                {
                    ["width"] = screenW,
                    ["height"] = screenH,
                    ["aspect"] = (float)screenW / Mathf.Max(1, screenH)
                },
                ["objects"] = results
            };
        }

        // ─────────────────────────────────────────────
        // Discovery
        // ─────────────────────────────────────────────

        private static IEnumerable<GameObject> DiscoverUIElements()
        {
            var seen = new HashSet<long>();
            // FindObjectsOfTypeAll includes inactive objects (so a hidden HUD element is still
            // reported) but also prefab assets / editor-internal objects — filter to loaded scenes.
            foreach (Graphic g in Resources.FindObjectsOfTypeAll<Graphic>())
            {
                if (g == null) continue;
                GameObject go = g.gameObject;
                if ((go.hideFlags & (HideFlags.HideAndDontSave | HideFlags.NotEditable)) != 0) continue;
                Scene scene = go.scene;
                if (!scene.IsValid() || !scene.isLoaded) continue;
                if (seen.Add(EntityIdCompat.Id(go)))
                    yield return go;
            }
        }

        // ─────────────────────────────────────────────
        // Per-element entry
        // ─────────────────────────────────────────────

        private static JObject BuildEntry(GameObject go, int screenW, int screenH)
        {
            var entry = new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["name"] = go.name,
                ["active"] = go.activeInHierarchy
            };

            RectTransform rt = go.GetComponent<RectTransform>();
            Graphic graphic = go.GetComponent<Graphic>();
            AddIdentity(entry, go, graphic);

            if (rt == null)
            {
                entry["screenRect"] = JValue.CreateNull();
                entry["viewportRect"] = JValue.CreateNull();
                entry["isVisible"] = false;
                entry["visibilityReason"] = "no-rect-transform";
                return entry;
            }

            Canvas canvas = go.GetComponentInParent<Canvas>(true);
            if (canvas == null)
            {
                entry["screenRect"] = JValue.CreateNull();
                entry["viewportRect"] = JValue.CreateNull();
                entry["isVisible"] = false;
                entry["visibilityReason"] = "no-canvas";
                return entry;
            }

            Canvas rootCanvas = canvas.rootCanvas != null ? canvas.rootCanvas : canvas;
            entry["canvasRenderMode"] = rootCanvas.renderMode.ToString();
            entry["canvasLocator"] = LocatorResolver.BuildLocator(rootCanvas.gameObject);
            // The live Canvas.scaleFactor (CanvasScaler-driven) — the px->dp density basis the
            // tap-target-size gate needs (dp = px / canvasScaleFactor). Emitting it here closes
            // the S6c-3 metadata gap so that gate no longer refuses on an absent density basis.
            entry["canvasScaleFactor"] = rootCanvas.scaleFactor;

            // Camera selection drives projection: null for ScreenSpaceOverlay (corners are already
            // screen-space). A non-overlay canvas with no resolvable camera can't be projected — refuse
            // with a reason rather than feeding null to WorldToScreenPoint (which would yield nonsense).
            bool isOverlay = rootCanvas.renderMode == RenderMode.ScreenSpaceOverlay;
            Camera cam = isOverlay ? null : (rootCanvas.worldCamera != null ? rootCanvas.worldCamera : Camera.main);
            if (!isOverlay && cam == null)
            {
                entry["screenRect"] = JValue.CreateNull();
                entry["viewportRect"] = JValue.CreateNull();
                entry["isVisible"] = false;
                entry["visibilityReason"] = "no-camera";
                return entry;
            }

            Rect r = ProjectRectTransform(rt, cam, isOverlay ? rootCanvas : null, screenW, screenH);
            entry["screenRect"] = ScreenRectMath.RectJ(r);
            entry["viewportRect"] = ScreenRectMath.ViewportRectJ(r, screenW, screenH);

            bool fullyVisible = ScreenRectMath.IsFullyVisible(r, screenW, screenH);
            bool offScreen = ScreenRectMath.IsOffScreen(r, screenW, screenH);
            entry["isFullyVisible"] = fullyVisible;
            entry["isPartiallyClipped"] = !fullyVisible && !offScreen;
            entry["isOffScreen"] = offScreen;
            entry["clipSide"] = ScreenRectMath.ClipSideJ(r, screenW, screenH);
            entry["centerXFraction"] = ScreenRectMath.CenterXFraction(r, screenW);
            entry["centerYFraction"] = ScreenRectMath.CenterYFraction(r, screenH);

            string reason = ResolveVisibilityReason(go, graphic, offScreen);
            entry["isVisible"] = reason == null;
            entry["visibilityReason"] = reason == null ? (JToken)JValue.CreateNull() : reason;
            // The uGUI hit-target pattern: an element whose OWN Graphic is invisible (alpha-0 or
            // disabled Image, raycastTarget on) with the visible art on child objects. The CONTROL
            // is visible to the player even though its own Graphic is not, and a replay anchor
            // waiting on the handler target needs that distinction. `isVisible` must NOT soften
            // (verify gates read it), so this is a separate additive field, emitted only for the
            // two own-graphic failure reasons where the pattern applies.
            if (reason == "graphic-transparent" || reason == "graphic-disabled")
                entry["descendantVisible"] = AnyDescendantGraphicVisible(go);
            return entry;
        }

        /// <summary>
        /// Why an element is not visible, in precedence order — or null when it IS visible.
        /// Mirrors the threat-model discipline of the gates: an explicit reason, never a silent skip.
        /// </summary>
        private static string ResolveVisibilityReason(GameObject go, Graphic graphic, bool offScreen)
        {
            if (!go.activeInHierarchy) return "inactive";
            // A disabled Canvas component ANYWHERE up the chain hides the element — e.g. a toggled
            // nested popup canvas whose GameObject (and the root canvas) stay active. Checking only the
            // root canvas would report such a hidden control as visible, defeating the gates.
            foreach (Canvas c in go.GetComponentsInParent<Canvas>(true))
                if (!c.isActiveAndEnabled) return "canvas-disabled";

            float alpha = 1f;
            foreach (CanvasGroup grp in go.GetComponentsInParent<CanvasGroup>(true))
            {
                alpha *= grp.alpha;
                if (grp.ignoreParentGroups) break;
            }
            if (alpha <= 0f) return "canvasgroup-alpha-zero";

            if (graphic != null)
            {
                if (!graphic.enabled) return "graphic-disabled";
                if (graphic.color.a <= 0f) return "graphic-transparent";
            }

            if (offScreen) return "off-screen";
            return null;
        }

        /// <summary>
        /// True when any ACTIVE descendant Graphic under an invisible-own-graphic element actually
        /// renders: enabled, alpha above zero, and no zero-alpha CanvasGroup between it and this
        /// element. The caller has already proven the element itself is active, on an enabled
        /// canvas, and not hidden by an ancestor CanvasGroup (its own-graphic check is what
        /// failed), so only the subtree below it needs checking here.
        /// </summary>
        private static bool AnyDescendantGraphicVisible(GameObject go)
        {
            foreach (Graphic g in go.GetComponentsInChildren<Graphic>(false))
            {
                if (g.gameObject == go) continue;
                if (!g.enabled || g.color.a <= 0f) continue;
                float alpha = 1f;
                for (Transform t = g.transform; t != null && t.gameObject != go; t = t.parent)
                {
                    CanvasGroup grp = t.GetComponent<CanvasGroup>();
                    if (grp != null)
                    {
                        alpha *= grp.alpha;
                        if (grp.ignoreParentGroups) break;
                    }
                }
                if (alpha <= 0f) continue;
                return true;
            }
            return false;
        }

        // ─────────────────────────────────────────────
        // Identity
        // ─────────────────────────────────────────────

        private static void AddIdentity(JObject entry, GameObject go, Graphic graphic)
        {
            Selectable selectable = go.GetComponent<Selectable>();
            bool isButton = go.GetComponent<Button>() != null;

            string role;
            if (isButton) role = "button";
            else if (graphic is Text || IsTmpText(graphic)) role = "text";
            else if (graphic is Image) role = "image";
            else if (graphic is RawImage) role = "rawimage";
            else if (graphic != null) role = "graphic";
            else role = "container";
            entry["role"] = role;

            entry["raycastTarget"] = graphic != null && graphic.raycastTarget;
            if (selectable != null) entry["interactable"] = selectable.interactable;

            // Text identity — legacy Text and TMP both expose `text`/`fontSize` (read via reflection
            // so the bridge keeps compiling without a hard TextMeshPro dependency).
            if (role == "text" || (graphic != null && (graphic is Text || IsTmpText(graphic))))
            {
                object textVal = GetMember(graphic, "text");
                if (textVal is string s) entry["text"] = s;
                object sizeVal = GetMember(graphic, "fontSize");
                if (sizeVal != null && TryToSingle(sizeVal, out float fs)) entry["fontSize"] = fs;
            }

            if (graphic is Image img && img.sprite != null) entry["spriteName"] = img.sprite.name;
            else if (graphic is RawImage raw && raw.texture != null) entry["spriteName"] = raw.texture.name;
        }

        private static bool IsTmpText(Graphic graphic)
        {
            if (graphic == null) return false;
            string full = graphic.GetType().FullName;
            return full != null && full.StartsWith("TMPro.", StringComparison.Ordinal);
        }

        private static object GetMember(Component target, string propertyName)
        {
            if (target == null) return null;
            PropertyInfo prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanRead) return null;
            try { return prop.GetValue(target, null); }
            catch { return null; }
        }

        private static bool TryToSingle(object value, out float result)
        {
            try { result = Convert.ToSingle(value); return true; }
            catch { result = 0f; return false; }
        }

        // ─────────────────────────────────────────────
        // Projection
        // ─────────────────────────────────────────────

        /// <summary>
        /// Projects a RectTransform's 4 world corners into screen pixels (origin bottom-left) and
        /// returns the axis-aligned screen rect. <paramref name="cam"/> is null for ScreenSpaceOverlay
        /// (corners are already in screen space); otherwise it is the resolved canvas/main camera (the
        /// caller refuses non-overlay canvases with no camera before reaching here). Points are
        /// normalized to the resolved screen size, mirroring ScreenSpaceIntrospection.ProjectBoundsToScreen,
        /// so a backgrounded editor (mismatched pixel rect) still maps onto the intended frame.
        ///
        /// For a ScreenSpaceOverlay canvas (<paramref name="cam"/> null) the world corners are already
        /// in the OVERLAY canvas's own pixel space — sized to <c>canvas.pixelRect</c>, NOT to
        /// <c>Screen.width/height</c>. In the Editor, <c>Screen.height</c> can report a stale or
        /// docked-window value while the overlay canvas is laid out against the (much larger) resolved
        /// Game-View size; normalizing by Screen.height then stretched overlay rects vertically (the
        /// RCL-T12 "~10x too tall" bug). So for overlay we take the reference frame from the canvas's
        /// actual pixel rect, falling back to the resolved screen size only if it is degenerate.
        /// </summary>
        private static Rect ProjectRectTransform(RectTransform rt, Camera cam, Canvas overlayCanvas, int screenW, int screenH)
        {
            SelectReferenceFrame(
                cam != null ? cam.pixelWidth : 0f, cam != null ? cam.pixelHeight : 0f,
                overlayCanvas != null ? overlayCanvas.pixelRect.width : 0f,
                overlayCanvas != null ? overlayCanvas.pixelRect.height : 0f,
                Screen.width, Screen.height, screenW, screenH,
                out float refW, out float refH);
            bool rescale = refW > 1 && refH > 1 && ((int)refW != screenW || (int)refH != screenH);

            var corners = new Vector3[4];
            rt.GetWorldCorners(corners);

            float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
            for (int i = 0; i < 4; i++)
            {
                Vector2 sp = RectTransformUtility.WorldToScreenPoint(cam, corners[i]);
                float px = sp.x, py = sp.y;
                if (rescale)
                {
                    px = sp.x / refW * screenW;
                    py = sp.y / refH * screenH;
                }
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }

            return new Rect(minX, minY, maxX - minX, maxY - minY);
        }

        /// <summary>
        /// Pick the pixel reference frame (refW/refH) the projected corners are normalized against,
        /// by source precedence: an explicit camera's pixel rect → an overlay canvas's own pixel rect
        /// → the live <c>Screen.*</c> size → the resolved Game-View size. Pure (Screen.* is passed in)
        /// so the RCL-T12 precedence — overlay corners normalize by the CANVAS pixel rect, never by a
        /// stale/docked-window Screen.height — is unit-testable headless. A degenerate (≤1) source is
        /// skipped to the next.
        /// </summary>
        internal static void SelectReferenceFrame(
            float camPixelW, float camPixelH,
            float overlayPixelW, float overlayPixelH,
            int liveScreenW, int liveScreenH,
            int resolvedW, int resolvedH,
            out float refW, out float refH)
        {
            if (camPixelW > 1 && camPixelH > 1)
            {
                refW = camPixelW;
                refH = camPixelH;
            }
            else if (overlayPixelW > 1 && overlayPixelH > 1)
            {
                refW = overlayPixelW;
                refH = overlayPixelH;
            }
            else
            {
                refW = liveScreenW > 1 ? liveScreenW : resolvedW;
                refH = liveScreenH > 1 ? liveScreenH : resolvedH;
            }
        }

        private static Camera ResolveCamera(JObject cameraLocator)
        {
            GameObject go = LocatorResolver.Resolve(cameraLocator);
            Camera cam = go.GetComponent<Camera>();
            if (cam == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"GameObject '{go.name}' has no Camera component.");
            return cam;
        }
    }
}
