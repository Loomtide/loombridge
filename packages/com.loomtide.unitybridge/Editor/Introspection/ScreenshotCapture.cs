using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Captures screenshots from Scene View or Game View.
    /// Graduated from ScreenshotSpike with clean separation.
    ///
    /// Beyond a plain capture, this supports two debugging aids:
    ///   • focusLocator — render a temporary orthographic camera framed tightly on one
    ///     object, so the agent gets a deterministic close-up regardless of where the
    ///     scene/game camera currently is.
    ///   • annotateBounds — draw each listed object's collider (green) and renderer
    ///     (magenta) world bounds onto the image, so collider-vs-sprite-vs-ground
    ///     misalignment is visible, not just inferred.
    /// </summary>
    public static class ScreenshotCapture
    {
        /// <summary>
        /// World-space axis-aligned box to draw onto a capture, with its colour.
        /// </summary>
        private struct OverlayBox
        {
            public Vector3 Min;
            public Vector3 Max;
            public Color Color;
        }

        /// <summary>
        /// Captures a screenshot from the specified view.
        /// </summary>
        /// <param name="view">"scene" or "game"</param>
        /// <param name="maxWidth">Maximum width in pixels (scales down if larger)</param>
        /// <param name="format">"jpeg" or "png"</param>
        /// <param name="quality">JPEG quality 0-100 (ignored for PNG)</param>
        /// <param name="focusLocator">Optional locator to frame a temp camera on (close-up).</param>
        /// <param name="annotateBounds">Optional array of locators whose collider/renderer
        /// world bounds are drawn onto the image.</param>
        /// <returns>JObject with image_base64, width, height, sizeBytes, format, and
        /// (when annotated) an annotations array describing the drawn bounds.</returns>
        public static JObject CaptureScreenshot(string view = "scene", int maxWidth = 1024,
            string format = "jpeg", int quality = 75,
            JObject focusLocator = null, JArray annotateBounds = null)
        {
            List<OverlayBox> overlays = BuildOverlays(annotateBounds, out JArray annotationsMeta);

            byte[] imageBytes;
            int finalWidth;
            int finalHeight;

            if (focusLocator != null)
            {
                // Deterministic close-up: a temp ortho camera framed on the object,
                // independent of the live scene/game camera position.
                GameObject target = LocatorResolver.Resolve(focusLocator);
                float aspect = ResolveGameViewAspect(ResolveMainCamera() ?? Camera.main);
                Camera focusCam = CreateFocusCamera(target, aspect, 1.6f);
                try
                {
                    (imageBytes, finalWidth, finalHeight) =
                        CaptureCameraToTexture(focusCam, maxWidth, aspect, format, quality, overlays);
                }
                finally
                {
                    if (focusCam != null)
                        UnityEngine.Object.DestroyImmediate(focusCam.gameObject);
                }
            }
            else
            {
                switch (view.ToLowerInvariant())
                {
                    case "scene":
                        (imageBytes, finalWidth, finalHeight) = CaptureSceneView(maxWidth, format, quality, overlays);
                        break;
                    case "game":
                        (imageBytes, finalWidth, finalHeight) = CaptureGameView(maxWidth, format, quality, overlays);
                        break;
                    default:
                        throw new Core.BridgeException(Core.ErrorCodes.INVALID_PARAMS,
                            $"Unknown view: '{view}'. Expected 'scene' or 'game'.");
                }
            }

            if (imageBytes == null || imageBytes.Length == 0)
            {
                throw new Core.BridgeException(Core.ErrorCodes.NOT_FOUND,
                    $"Could not capture {view} view — no active camera or view found.");
            }

            string base64 = Convert.ToBase64String(imageBytes);

            var result = new JObject
            {
                ["image_base64"] = base64,
                ["width"] = finalWidth,
                ["height"] = finalHeight,
                ["sizeBytes"] = imageBytes.Length,
                ["format"] = format.ToLowerInvariant()
            };
            if (focusLocator != null)
                result["focused"] = true;
            if (annotationsMeta.Count > 0)
                result["annotations"] = annotationsMeta;
            return result;
        }

        // ─────────────────────────────────────────────
        // Bounds overlays (annotateBounds) + focus camera (focusLocator)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Resolves each locator in <paramref name="annotateBounds"/> and produces the
        /// overlay boxes (collider = green, renderer = magenta) to draw, plus a parallel
        /// metadata array with the numeric world bounds so the response is both visual and
        /// measurable. Unresolvable locators are skipped.
        /// </summary>
        private static List<OverlayBox> BuildOverlays(JArray annotateBounds, out JArray meta)
        {
            var overlays = new List<OverlayBox>();
            meta = new JArray();
            if (annotateBounds == null)
                return overlays;

            Color colliderColor = new Color(0.2f, 1f, 0.2f);   // green  — collider
            Color rendererColor = new Color(1f, 0.2f, 1f);     // magenta — full sprite quad
            Color visibleColor = new Color(1f, 0.95f, 0.2f);   // yellow — opaque (visible) pixels

            foreach (JToken tok in annotateBounds)
            {
                // Tolerate stringified locators (defense-in-depth for clients that
                // pre-stringify array elements).
                if (!(JsonValueCoercer.Rehydrate(tok) is JObject loc))
                    continue;

                GameObject go;
                try { go = LocatorResolver.Resolve(loc); }
                catch { continue; }

                var entry = new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(go),
                    ["name"] = go.name
                };

                Bounds? cb = BoundsCapture.CombinedBounds(go, includeColliders: true, includeRenderers: false);
                if (cb.HasValue)
                {
                    overlays.Add(new OverlayBox { Min = cb.Value.min, Max = cb.Value.max, Color = colliderColor });
                    entry["colliderColor"] = "green";
                    entry["colliderBounds"] = BoundsMeta(cb.Value);
                }

                Bounds? rb = BoundsCapture.CombinedBounds(go, includeColliders: false, includeRenderers: true);
                if (rb.HasValue)
                {
                    overlays.Add(new OverlayBox { Min = rb.Value.min, Max = rb.Value.max, Color = rendererColor });
                    entry["rendererColor"] = "magenta";
                    entry["rendererBounds"] = BoundsMeta(rb.Value);
                }

                Bounds? vb = BoundsCapture.CombinedOpaqueBounds(go);
                if (vb.HasValue)
                {
                    overlays.Add(new OverlayBox { Min = vb.Value.min, Max = vb.Value.max, Color = visibleColor });
                    entry["visibleColor"] = "yellow";
                    entry["visibleBounds"] = BoundsMeta(vb.Value);
                }

                meta.Add(entry);
            }

            return overlays;
        }

        /// <summary>
        /// Builds a disabled temp orthographic camera (cloned from the main camera so
        /// clear/background/culling match) positioned to frame <paramref name="target"/>'s
        /// combined bounds with padding. Caller renders it via CaptureCameraToTexture and
        /// destroys its GameObject afterwards.
        /// </summary>
        private static Camera CreateFocusCamera(GameObject target, float aspect, float padding)
        {
            Camera mainCam = ResolveMainCamera();
            Bounds b = BoundsCapture.CombinedBounds(target)
                ?? new Bounds(target.transform.position, Vector3.one);

            var tempGo = new GameObject("~LoomtideFocusCam") { hideFlags = HideFlags.HideAndDontSave };
            Camera cam = tempGo.AddComponent<Camera>();
            if (mainCam != null)
                cam.CopyFrom(mainCam);

            cam.orthographic = true;
            float safeAspect = Mathf.Max(0.0001f, aspect);
            float halfH = Mathf.Max(b.extents.y, b.extents.x / safeAspect);
            cam.orthographicSize = Mathf.Max(0.25f, halfH * padding);

            float z = mainCam != null ? mainCam.transform.position.z : -10f;
            cam.transform.position = new Vector3(b.center.x, b.center.y, z);
            cam.transform.rotation = mainCam != null ? mainCam.transform.rotation : Quaternion.identity;
            cam.enabled = false; // rendered manually via cam.Render()
            return cam;
        }

        private static JObject BoundsMeta(Bounds b)
        {
            return new JObject
            {
                ["min"] = new JObject { ["x"] = b.min.x, ["y"] = b.min.y, ["z"] = b.min.z },
                ["max"] = new JObject { ["x"] = b.max.x, ["y"] = b.max.y, ["z"] = b.max.z },
                ["center"] = new JObject { ["x"] = b.center.x, ["y"] = b.center.y, ["z"] = b.center.z },
                ["size"] = new JObject { ["x"] = b.size.x, ["y"] = b.size.y, ["z"] = b.size.z }
            };
        }

        // ─────────────────────────────────────────────
        // Scene View Capture
        // ─────────────────────────────────────────────

        private static (byte[] bytes, int width, int height) CaptureSceneView(
            int maxWidth, string format, int quality, List<OverlayBox> overlays = null)
        {
            SceneView sceneView = SceneView.lastActiveSceneView;
            if (sceneView == null || sceneView.camera == null)
                return (null, 0, 0);

            Camera cam = sceneView.camera;

            // Derive aspect from the scene view camera's current rect, but only
            // trust it when it is within a sane range. When the editor is
            // backgrounded or the window is relaid-out, pixelRect collapses to a
            // thin strip (e.g. full width × ~20px tall), which would otherwise
            // produce an extreme aspect and a thin-strip capture. In that case we
            // fall back to the Game View aspect, then 16:9.
            float aspect = ResolveSceneViewAspect(cam);

            return CaptureCameraToTexture(cam, maxWidth, aspect, format, quality, overlays);
        }

        // ─────────────────────────────────────────────
        // Game View Capture
        // ─────────────────────────────────────────────

        private static (byte[] bytes, int width, int height) CaptureGameView(
            int maxWidth, string format, int quality, List<OverlayBox> overlays = null)
        {
            // Render the game camera into an offscreen RenderTexture at an explicit
            // resolution, in BOTH edit and play mode. This is independent of editor
            // window layout/focus, so it works while Unity is backgrounded (which it
            // is when the bridge drives it). The previous play-mode path used
            // ScreenCapture.CaptureScreenshotAsTexture(), which — when called outside
            // the end-of-frame render loop, as the bridge does — grabs the focused
            // EditorWindow (e.g. the Console) instead of the game render.
            //
            // A camera render alone does not composite Screen Space-Overlay UI (overlay canvases are
            // drawn by the player loop's end-of-frame blit, not by any camera). RCL-T12: a HUD built
            // on an Overlay canvas was therefore invisible in the game capture. compositeOverlayUI:true
            // adds a second pass that renders the Overlay canvases onto a separate transparent target
            // and alpha-merges them over the captured frame (see CompositeOverlayCanvasesOnto). The
            // render itself is SRP-safe via RenderCameraInto. World/gameplay verification is unchanged.
            Camera cam = ResolveMainCamera();
            if (cam == null)
                return (null, 0, 0);

            float aspect = ResolveGameViewAspect(cam);
            return CaptureCameraToTexture(cam, maxWidth, aspect, format, quality, overlays,
                compositeOverlayUI: true);
        }

        /// <summary>
        /// Finds the camera that drives the Game View: Camera.main first, then the
        /// first enabled camera, then any camera. Never relies on the camera's
        /// current viewport rect.
        /// </summary>
        private static Camera ResolveMainCamera()
        {
            Camera cam = Camera.main;
            if (cam != null)
                return cam;

            Camera[] all = Camera.allCameras;
            if (all != null && all.Length > 0)
            {
                foreach (Camera c in all)
                {
                    if (c != null && c.enabled && c.isActiveAndEnabled)
                        return c;
                }
                return all[0];
            }

#if UNITY_2020_1_OR_NEWER
            Camera[] every = UnityEngine.Object.FindObjectsOfType<Camera>(true);
#else
            Camera[] every = UnityEngine.Object.FindObjectsOfType<Camera>();
#endif
            return (every != null && every.Length > 0) ? every[0] : null;
        }

        /// <summary>
        /// Determines the aspect ratio to render at, independent of window focus.
        /// Prefers the active Game View resolution, then the camera's configured
        /// aspect, then a 16:9 fallback.
        /// </summary>
        private static float ResolveGameViewAspect(Camera cam)
        {
            // 1) Active Game View target size (e.g. "Free Aspect" current pixels or a
            //    fixed resolution). This reflects what the user sees in the tab.
            Vector2 gameViewSize = Handles.GetMainGameViewSize();
            if (gameViewSize.x > 1f && gameViewSize.y > 1f)
                return gameViewSize.x / gameViewSize.y;

            // 2) Camera's configured aspect (valid even when not rendered to a window).
            if (cam.aspect > 0.01f && !float.IsNaN(cam.aspect) && !float.IsInfinity(cam.aspect))
                return cam.aspect;

            // 3) Fallback.
            return 16f / 9f;
        }

        /// <summary>
        /// Aspect for the Scene View. Trusts the scene camera's pixelRect only when
        /// it is within a sane range; otherwise falls back to the Game View aspect,
        /// then 16:9. Sane range guards against the collapsed thin-strip rect that
        /// appears when the editor is backgrounded.
        /// </summary>
        private static float ResolveSceneViewAspect(Camera cam)
        {
            const float minAspect = 0.25f;  // 1:4 (very tall) — anything more extreme is bogus
            const float maxAspect = 4.0f;   // 4:1 (very wide)

            float rectW = cam.pixelRect.width;
            float rectH = cam.pixelRect.height;
            if (rectW > 1f && rectH > 1f)
            {
                float aspect = rectW / rectH;
                if (aspect >= minAspect && aspect <= maxAspect)
                    return aspect;
            }

            // pixelRect is collapsed/degenerate — reuse the Game View aspect.
            return ResolveGameViewAspect(cam);
        }

        // ─────────────────────────────────────────────
        // Camera Capture (shared between Scene and Game, edit + play)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Renders <paramref name="cam"/> into an offscreen RenderTexture at an
        /// explicit resolution derived from <paramref name="maxWidth"/> and
        /// <paramref name="aspect"/>, then reads it back into a Texture2D.
        ///
        /// The resolution is fully decoupled from the camera's current viewport
        /// (cam.pixelRect) and from any EditorWindow, so the result is a correct
        /// full-frame image regardless of editor focus or window layout.
        /// </summary>
        private static (byte[] bytes, int width, int height) CaptureCameraToTexture(
            Camera cam, int maxWidth, float aspect, string format, int quality,
            List<OverlayBox> overlays = null, bool compositeOverlayUI = false)
        {
            if (cam == null)
                return (null, 0, 0);

            // Sanitize inputs so we never produce a degenerate (thin-strip) texture.
            if (maxWidth <= 0)
                maxWidth = 1024;
            if (aspect <= 0.01f || float.IsNaN(aspect) || float.IsInfinity(aspect))
                aspect = 16f / 9f;

            int width = Mathf.Max(16, maxWidth);
            int height = Mathf.Max(16, Mathf.RoundToInt(width / aspect));

            RenderTexture rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            rt.antiAliasing = 1;

            RenderTexture previousTarget = cam.targetTexture;
            float previousAspect = cam.aspect;
            RenderTexture previousActive = RenderTexture.active;

            try
            {
                // Force the camera to render the full target at our chosen aspect.
                cam.targetTexture = rt;
                cam.aspect = (float)width / height;
                RenderCameraInto(cam, rt);

                // Latch the world frame NOW, before any overlay pass. Under a Scriptable Render
                // Pipeline (URP/HDRP) a SECOND render request into a texture CLEARS it, so a HUD
                // composite that re-used rt wiped the world frame to black. Reading it out first
                // makes the world capture bulletproof regardless of pipeline.
                RenderTexture.active = rt;
                Texture2D outputTex = new Texture2D(width, height, TextureFormat.RGB24, false);
                outputTex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                outputTex.Apply();

                // RCL-T12: composite Screen Space-Overlay HUD on top of the captured world frame.
                // Rendered into a SEPARATE transparent target and alpha-merged on the CPU, so the pass
                // can only ADD the HUD — never clear the world frame the way an in-place SRP request would.
                if (compositeOverlayUI)
                    CompositeOverlayCanvasesOnto(outputTex, width, height);

                // Draw bounds overlays while cam.aspect still matches the rendered frame,
                // so WorldToViewportPoint projects onto the right pixels. Texture pixel
                // (0,0) and viewport (0,0) are both bottom-left, so no Y flip is needed.
                if (overlays != null && overlays.Count > 0)
                {
                    foreach (OverlayBox box in overlays)
                        DrawWorldBox(outputTex, cam, box, width, height);
                    outputTex.Apply();
                }

                byte[] bytes = EncodeTexture(outputTex, format, quality);
                UnityEngine.Object.DestroyImmediate(outputTex);

                return (bytes, width, height);
            }
            finally
            {
                cam.targetTexture = previousTarget;
                // Restore aspect handling. ResetAspect() returns the camera to
                // auto-computed aspect (the normal edit-mode state); we then
                // reapply any explicit pre-existing aspect override.
                cam.ResetAspect();
                cam.aspect = previousAspect;
                RenderTexture.active = previousActive;
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
            }
        }

        /// <summary>
        /// Render <paramref name="cam"/> into <paramref name="rt"/> in a way that works under BOTH the
        /// built-in pipeline and a Scriptable Render Pipeline (URP/HDRP). A bare <c>Camera.Render()</c>
        /// draws BLACK under an SRP — the SRP only renders in response to a render request, not the
        /// legacy immediate path — so when a render pipeline is active we submit a
        /// <c>RenderPipeline.StandardRequest</c> targeting the texture, and fall back to
        /// <c>Camera.Render()</c> for the built-in pipeline. The caller has already set
        /// <c>cam.targetTexture = rt</c> (used by the legacy path and restored by the caller); the SRP
        /// request writes to the same <paramref name="rt"/> via its destination, and honours the
        /// camera's clearFlags (so the overlay-UI compositing pass, clearFlags=Nothing, still draws
        /// over the existing frame instead of replacing it).
        /// </summary>
        private static void RenderCameraInto(Camera cam, RenderTexture rt)
        {
            if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null)
            {
                var request = new UnityEngine.Rendering.RenderPipeline.StandardRequest { destination = rt };
                if (UnityEngine.Rendering.RenderPipeline.SupportsRenderRequest(cam, request))
                {
                    UnityEngine.Rendering.RenderPipeline.SubmitRenderRequest(cam, request);
                    return;
                }
            }
            // Built-in pipeline (or an SRP that does not support the request): legacy immediate render.
            cam.Render();
        }

        // ─────────────────────────────────────────────
        // Screen Space-Overlay UI compositing (RCL-T12)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Composites every active Screen Space-Overlay root canvas on TOP of the captured world frame
        /// in <paramref name="dst"/>. Overlay canvases are normally drawn by the player loop's end-of-frame
        /// blit, which a camera render bypasses — so a HUD was invisible in the game capture (RCL-T12).
        /// Technique: temporarily retarget each overlay canvas to ScreenSpaceCamera mode driven by a
        /// throwaway UI camera that renders into a SEPARATE transparent RenderTexture; the HUD is then
        /// alpha-merged (source-over) onto <paramref name="dst"/> on the CPU. Rendering into a separate
        /// target (not the world frame) is what makes this SRP-safe: an in-place SRP render request
        /// clears its destination, which would erase the world frame — here it can only ADD the HUD.
        ///
        /// Safety: every canvas mutation is reverted in the finally block, so a throw mid-pass can NEVER
        /// leave a scene canvas in ScreenSpaceCamera mode. Best-effort: any failure leaves the world
        /// frame in <paramref name="dst"/> intact and simply omits the HUD.
        /// </summary>
        private static void CompositeOverlayCanvasesOnto(Texture2D dst, int width, int height)
        {
            List<Canvas> overlays = CollectActiveOverlayRootCanvases();
            if (overlays.Count == 0)
                return;

            var camGo = new GameObject("__LoomtideUICompositeCam") { hideFlags = HideFlags.HideAndDontSave };
            var saved = new List<(Canvas canvas, RenderMode mode, Camera worldCam, float planeDistance)>();
            RenderTexture uiRt = null;
            Texture2D uiTex = null;
            RenderTexture previousActive = RenderTexture.active;
            try
            {
                uiRt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32) { antiAliasing = 1 };

                Camera uiCam = camGo.AddComponent<Camera>();
                // Clear the SEPARATE target to fully transparent so only drawn HUD pixels carry alpha.
                uiCam.clearFlags = CameraClearFlags.SolidColor;
                uiCam.backgroundColor = new Color(0f, 0f, 0f, 0f);
                uiCam.orthographic = true;
                uiCam.cullingMask = ~0;
                uiCam.nearClipPlane = 0.01f;
                uiCam.farClipPlane = 1000f;
                uiCam.targetTexture = uiRt;
                uiCam.aspect = (float)width / Mathf.Max(1, height);

                foreach (Canvas c in overlays)
                {
                    saved.Add((c, c.renderMode, c.worldCamera, c.planeDistance));
                    c.renderMode = RenderMode.ScreenSpaceCamera;
                    c.worldCamera = uiCam;
                    c.planeDistance = 1f;
                }

                Canvas.ForceUpdateCanvases();
                RenderCameraInto(uiCam, uiRt);

                RenderTexture.active = uiRt;
                uiTex = new Texture2D(width, height, TextureFormat.RGBA32, false);
                uiTex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                uiTex.Apply();

                // Source-over alpha composite of the HUD onto the world frame, on the CPU.
                Color32[] baseP = dst.GetPixels32();
                Color32[] uiP = uiTex.GetPixels32();
                bool changed = false;
                for (int i = 0; i < baseP.Length && i < uiP.Length; i++)
                {
                    float a = uiP[i].a / 255f;
                    if (a <= 0.0039f) continue; // transparent HUD pixel — keep the world frame
                    baseP[i].r = (byte)Mathf.Clamp(uiP[i].r * a + baseP[i].r * (1f - a), 0f, 255f);
                    baseP[i].g = (byte)Mathf.Clamp(uiP[i].g * a + baseP[i].g * (1f - a), 0f, 255f);
                    baseP[i].b = (byte)Mathf.Clamp(uiP[i].b * a + baseP[i].b * (1f - a), 0f, 255f);
                    changed = true;
                }
                if (changed)
                {
                    dst.SetPixels32(baseP);
                    dst.Apply();
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[UnityBridge] overlay UI compositing skipped: {ex.Message}");
            }
            finally
            {
                foreach (var s in saved)
                {
                    if (s.canvas == null) continue;
                    s.canvas.renderMode = s.mode;
                    s.canvas.worldCamera = s.worldCam;
                    s.canvas.planeDistance = s.planeDistance;
                }
                Canvas.ForceUpdateCanvases();
                RenderTexture.active = previousActive;
                if (uiTex != null) UnityEngine.Object.DestroyImmediate(uiTex);
                if (uiRt != null) { uiRt.Release(); UnityEngine.Object.DestroyImmediate(uiRt); }
                UnityEngine.Object.DestroyImmediate(camGo);
            }
        }

        /// <summary>
        /// Active ScreenSpaceOverlay ROOT canvases in loaded scenes (the units that drive an overlay
        /// HUD). Pure scene query — no rendering — so it is unit-testable headless.
        /// </summary>
        internal static List<Canvas> CollectActiveOverlayRootCanvases()
        {
            var result = new List<Canvas>();
            foreach (Canvas c in Resources.FindObjectsOfTypeAll<Canvas>())
            {
                if (c == null || !c.isActiveAndEnabled) continue;
                if (c.rootCanvas != c) continue; // root canvases only; children inherit the mode
                if (c.renderMode != RenderMode.ScreenSpaceOverlay) continue;
                if ((c.gameObject.hideFlags & (HideFlags.HideAndDontSave | HideFlags.NotEditable)) != 0) continue;
                Scene scene = c.gameObject.scene;
                if (!scene.IsValid() || !scene.isLoaded) continue;
                result.Add(c);
            }
            return result;
        }

        // ─────────────────────────────────────────────
        // Overlay drawing (project world AABB → image pixels)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Projects the four XY corners of a world-space AABB through the (already-rendered)
        /// camera and draws the rectangle outline onto the texture.
        /// </summary>
        private static void DrawWorldBox(Texture2D tex, Camera cam, OverlayBox box, int width, int height)
        {
            float z = (box.Min.z + box.Max.z) * 0.5f;
            Vector3[] world =
            {
                new Vector3(box.Min.x, box.Min.y, z),
                new Vector3(box.Max.x, box.Min.y, z),
                new Vector3(box.Max.x, box.Max.y, z),
                new Vector3(box.Min.x, box.Max.y, z)
            };

            var px = new Vector2[4];
            for (int i = 0; i < 4; i++)
            {
                Vector3 vp = cam.WorldToViewportPoint(world[i]);
                px[i] = new Vector2(vp.x * width, vp.y * height);
            }

            for (int i = 0; i < 4; i++)
                DrawLine(tex, px[i], px[(i + 1) % 4], box.Color, width, height, 2);
        }

        private static void DrawLine(Texture2D tex, Vector2 a, Vector2 b, Color color,
            int width, int height, int thickness)
        {
            int x0 = Mathf.RoundToInt(a.x), y0 = Mathf.RoundToInt(a.y);
            int x1 = Mathf.RoundToInt(b.x), y1 = Mathf.RoundToInt(b.y);
            int dx = Mathf.Abs(x1 - x0), dy = -Mathf.Abs(y1 - y0);
            int sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
            int err = dx + dy;

            while (true)
            {
                PlotThick(tex, x0, y0, color, width, height, thickness);
                if (x0 == x1 && y0 == y1) break;
                int e2 = 2 * err;
                if (e2 >= dy) { err += dy; x0 += sx; }
                if (e2 <= dx) { err += dx; y0 += sy; }
            }
        }

        private static void PlotThick(Texture2D tex, int x, int y, Color color,
            int width, int height, int thickness)
        {
            int r = Mathf.Max(0, thickness / 2);
            for (int oy = -r; oy <= r; oy++)
            for (int ox = -r; ox <= r; ox++)
            {
                int px = x + ox, py = y + oy;
                if (px >= 0 && px < width && py >= 0 && py < height)
                    tex.SetPixel(px, py, color);
            }
        }

        // ─────────────────────────────────────────────
        // Encoding
        // ─────────────────────────────────────────────

        private static byte[] EncodeTexture(Texture2D tex, string format, int quality)
        {
            switch (format.ToLowerInvariant())
            {
                case "png":
                    return tex.EncodeToPNG();
                case "jpeg":
                case "jpg":
                default:
                    return tex.EncodeToJPG(quality);
            }
        }
    }
}
