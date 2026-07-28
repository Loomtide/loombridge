using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode tests for ui.get_screen_rects (UIScreenSpaceIntrospection): uGUI elements projected
    /// into screen space with active/visible reasons and identity.
    ///
    /// A WORLD-SPACE canvas with an explicit orthographic camera is used so projection is
    /// deterministic under headless (-nographics) runs — a ScreenSpaceOverlay canvas's RectTransform
    /// is driven by a canvas update that may not happen in batchmode, which would make a "centered"
    /// element read as (0,0)/off-screen. WorldSpace canvas rects are author-set, so corners are exact.
    /// </summary>
    [TestFixture]
    public class UIScreenRectsTests
    {
        [SetUp]
        public void SetUp()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        [TearDown]
        public void TearDown()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        private static JObject InstanceLocator(GameObject go) =>
            new JObject { ["instanceId"] = EntityIdCompat.Id(go) };

        /// <summary>A WorldSpace canvas centered at the origin, framed by an orthographic camera.</summary>
        private static Canvas MakeWorldCanvas()
        {
            var camGo = new GameObject("Cam");
            var cam = camGo.AddComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = 5f;
            camGo.transform.position = new Vector3(0, 0, -10);

            var canvasGo = new GameObject("Canvas");
            var canvas = canvasGo.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.worldCamera = cam;
            canvasGo.AddComponent<GraphicRaycaster>();

            var crt = canvasGo.GetComponent<RectTransform>();
            crt.anchorMin = crt.anchorMax = new Vector2(0.5f, 0.5f);
            crt.pivot = new Vector2(0.5f, 0.5f);
            crt.sizeDelta = new Vector2(8, 6); // within the camera frame (x∈[-4,4], y∈[-3,3])
            canvasGo.transform.position = Vector3.zero;
            return canvas;
        }

        /// <summary>Creates a Button (Image + Button) centered on the canvas at a local offset.</summary>
        private static GameObject MakeButton(Canvas canvas, string name, Vector2 size, Vector2 anchoredPos)
        {
            var go = new GameObject(name);
            go.transform.SetParent(canvas.transform, false);
            go.AddComponent<Image>();
            go.AddComponent<Button>();
            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = new Vector2(0.5f, 0.5f);
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = size;
            rt.anchoredPosition = anchoredPos;
            Canvas.ForceUpdateCanvases();
            return go;
        }

        private static JObject FindEntry(JObject result, string name)
        {
            foreach (JToken t in result.Value<JArray>("objects"))
            {
                if (t is JObject o && o.Value<string>("name") == name) return o;
            }
            return null;
        }

        [Test]
        public void GetScreenRects_CenteredButton_IsVisibleWithButtonRole()
        {
            var canvas = MakeWorldCanvas();
            var btn = MakeButton(canvas, "Play", new Vector2(2, 1), Vector2.zero);

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "Play");

            Assert.IsNotNull(entry);
            Assert.AreEqual("button", entry.Value<string>("role"));
            Assert.IsTrue(entry.Value<bool>("active"));
            Assert.IsTrue(entry.Value<bool>("isVisible"), "A centered, active button should be visible");
            Assert.AreEqual(JTokenType.Null, entry["visibilityReason"].Type, "visible element has null reason");
            Assert.IsNotNull(entry.Value<JObject>("screenRect"));
            Assert.IsFalse(entry.Value<bool>("isOffScreen"));
            // Centered on a centered canvas → roughly mid-frame horizontally.
            Assert.AreEqual(0.5f, entry.Value<float>("centerXFraction"), 0.2f);
            // viewportRect is the normalized screenRect: a small centered control sits inside [0,1]
            // with a sub-frame footprint (not the whole viewport, not negative/offscreen).
            JObject vp = entry.Value<JObject>("viewportRect");
            Assert.IsNotNull(vp);
            Assert.Greater(vp.Value<float>("x"), 0f);
            Assert.Less(vp.Value<float>("x") + vp.Value<float>("width"), 1f);
            Assert.Greater(vp.Value<float>("width"), 0f);
            Assert.Less(vp.Value<float>("width"), 1f);
            // A button is a Selectable graphic → identity reported.
            Assert.IsTrue(entry.Value<bool>("interactable"));
            Assert.IsTrue(entry.Value<bool>("raycastTarget"));
        }

        [Test]
        public void GetScreenRects_EmitsCanvasScaleFactor()
        {
            // The px->dp density basis the tap-target-size gate consumes. A plain canvas with no
            // CanvasScaler reports scaleFactor 1; the value must be present and positive (never absent,
            // which would make the gate refuse). The real per-project density is proven by live capture.
            var canvas = MakeWorldCanvas();
            var btn = MakeButton(canvas, "Play", new Vector2(2, 1), Vector2.zero);

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "Play");

            Assert.IsNotNull(entry);
            Assert.IsNotNull(entry["canvasScaleFactor"], "canvasScaleFactor must be emitted (the tap-target density basis)");
            Assert.AreNotEqual(JTokenType.Null, entry["canvasScaleFactor"].Type, "canvasScaleFactor must not be null");
            Assert.Greater(entry.Value<float>("canvasScaleFactor"), 0f, "scaleFactor must be a positive density basis");
        }

        [Test]
        public void GetScreenRects_ElementOffRightEdge_IsClippedRight()
        {
            var canvas = MakeWorldCanvas();
            // Push far past the right edge of the frame — robust regardless of exact frame size.
            var btn = MakeButton(canvas, "OffRight", new Vector2(2, 1), new Vector2(1000f, 0f));

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "OffRight");

            Assert.IsNotNull(entry);
            Assert.IsTrue(entry.Value<bool>("isOffScreen"), "Element pushed far right is off-screen");
            Assert.IsFalse(entry.Value<bool>("isFullyVisible"));
            JArray clip = entry.Value<JArray>("clipSide");
            Assert.IsNotNull(clip);
            CollectionAssert.Contains(clip.ToObject<string[]>(), "right");
        }

        [Test]
        public void GetScreenRects_InactiveElement_ReportsInactiveReason()
        {
            var canvas = MakeWorldCanvas();
            var btn = MakeButton(canvas, "Hidden", new Vector2(2, 1), Vector2.zero);
            btn.SetActive(false);

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "Hidden");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("active"));
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.AreEqual("inactive", entry.Value<string>("visibilityReason"));
        }

        [Test]
        public void GetScreenRects_CanvasGroupAlphaZero_NotVisible()
        {
            var canvas = MakeWorldCanvas();
            var panel = new GameObject("Panel");
            panel.transform.SetParent(canvas.transform, false);
            panel.AddComponent<RectTransform>();
            panel.AddComponent<CanvasGroup>().alpha = 0f;

            var btn = MakeButton(canvas, "Faded", new Vector2(2, 1), Vector2.zero);
            btn.transform.SetParent(panel.transform, false);

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "Faded");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.AreEqual("canvasgroup-alpha-zero", entry.Value<string>("visibilityReason"));
        }

        [Test]
        public void GetScreenRects_DisabledGraphic_ReportsGraphicDisabled()
        {
            var canvas = MakeWorldCanvas();
            var btn = MakeButton(canvas, "DisabledImg", new Vector2(2, 1), Vector2.zero);
            btn.GetComponent<Image>().enabled = false;

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "DisabledImg");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.AreEqual("graphic-disabled", entry.Value<string>("visibilityReason"));
        }

        [Test]
        public void GetScreenRects_TransparentGraphic_ReportsGraphicTransparent()
        {
            var canvas = MakeWorldCanvas();
            var btn = MakeButton(canvas, "Invisible", new Vector2(2, 1), Vector2.zero);
            var img = btn.GetComponent<Image>();
            img.color = new Color(1f, 1f, 1f, 0f); // fully transparent

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(btn) }, null);
            JObject entry = FindEntry(result, "Invisible");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.AreEqual("graphic-transparent", entry.Value<string>("visibilityReason"));
            // LITMUS for the hit-target-proxy field: a transparent element with NO visible child
            // art must report descendantVisible=false, or the replay anchor relaxation would
            // accept a genuinely invisible control (a silent-skip in disguise).
            Assert.IsFalse(entry.Value<bool>("descendantVisible"),
                "transparent element without visible children must not claim visible descendants");
        }

        [Test]
        public void GetScreenRects_TransparentHitTargetWithVisibleChildArt_ReportsDescendantVisible()
        {
            // The common uGUI hit-target pattern (KidsAdventure hub tile): the parent Image is
            // alpha-0 with raycastTarget on, and the visible art lives on child objects. The
            // element's own visibility verdict must NOT soften (verify gates read isVisible),
            // but the additive descendantVisible field tells a replay anchor the control's art
            // IS on screen.
            var canvas = MakeWorldCanvas();
            var tile = MakeButton(canvas, "Tile", new Vector2(3, 2), Vector2.zero);
            tile.GetComponent<Image>().color = new Color(1f, 1f, 1f, 0f);
            var icon = new GameObject("Icon");
            icon.transform.SetParent(tile.transform, false);
            icon.AddComponent<Image>().color = Color.white;
            var irt = icon.GetComponent<RectTransform>();
            irt.anchorMin = irt.anchorMax = new Vector2(0.5f, 0.5f);
            irt.pivot = new Vector2(0.5f, 0.5f);
            irt.sizeDelta = new Vector2(1, 1);
            Canvas.ForceUpdateCanvases();

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(tile) }, null);
            JObject entry = FindEntry(result, "Tile");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("isVisible"), "own-graphic verdict must not soften");
            Assert.AreEqual("graphic-transparent", entry.Value<string>("visibilityReason"));
            Assert.IsTrue(entry.Value<bool>("descendantVisible"), "visible child art must be reported");
        }

        [Test]
        public void GetScreenRects_TransparentHitTargetWithZeroAlphaGroupOverChildArt_NoDescendantVisible()
        {
            // A CanvasGroup with alpha 0 BETWEEN the hit-target and its child art hides the art;
            // descendantVisible must honour it, not just the child Graphic's own color.
            var canvas = MakeWorldCanvas();
            var tile = MakeButton(canvas, "TileHidden", new Vector2(3, 2), Vector2.zero);
            tile.GetComponent<Image>().color = new Color(1f, 1f, 1f, 0f);
            var holder = new GameObject("Holder");
            holder.transform.SetParent(tile.transform, false);
            holder.AddComponent<CanvasGroup>().alpha = 0f;
            var icon = new GameObject("Icon");
            icon.transform.SetParent(holder.transform, false);
            icon.AddComponent<Image>().color = Color.white;
            Canvas.ForceUpdateCanvases();

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(tile) }, null);
            JObject entry = FindEntry(result, "TileHidden");

            Assert.IsNotNull(entry);
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.IsFalse(entry.Value<bool>("descendantVisible"),
                "child art behind a zero-alpha CanvasGroup is not visible");
        }

        [Test]
        public void GetScreenRects_ElementWithoutCanvas_ReportsNoCanvas()
        {
            // An Image not parented under any Canvas — projection is undefined.
            var go = new GameObject("Orphan");
            go.AddComponent<RectTransform>();
            go.AddComponent<Image>();

            JObject result = UIScreenSpaceIntrospection.GetScreenRects(new JArray { InstanceLocator(go) }, null);
            JObject entry = FindEntry(result, "Orphan");

            Assert.IsNotNull(entry);
            Assert.AreEqual(JTokenType.Null, entry["screenRect"].Type, "no canvas → null screenRect");
            Assert.IsFalse(entry.Value<bool>("isVisible"));
            Assert.AreEqual("no-canvas", entry.Value<string>("visibilityReason"));
        }

        [Test]
        public void GetScreenRects_NoLocators_AutoDiscoversGraphics()
        {
            var canvas = MakeWorldCanvas();
            MakeButton(canvas, "A", new Vector2(2, 1), new Vector2(-2, 0));
            MakeButton(canvas, "B", new Vector2(2, 1), new Vector2(2, 0));

            // null locators → auto-discover every Graphic (each button's Image counts).
            JObject result = UIScreenSpaceIntrospection.GetScreenRects(null, null);
            JArray objects = result.Value<JArray>("objects");

            Assert.GreaterOrEqual(objects.Count, 2, "Both buttons' graphics should be discovered");
            Assert.IsNotNull(FindEntry(result, "A"));
            Assert.IsNotNull(FindEntry(result, "B"));
        }

        // ───────────────── RCL-T12: overlay rects normalize by the CANVAS pixel rect ─────────────────

        [Test]
        public void SelectReferenceFrame_Overlay_NormalizesByCanvasPixelRect_NotStaleScreen()
        {
            // The dogfood bug: an overlay canvas laid out at the resolved 1920x1080 Game-View, but
            // Screen.height reporting a docked-window 150px → corners normalized by 150 stretched the
            // rect ~7x vertically. With the canvas pixel rect (1080) as the reference, height is honest.
            UIScreenSpaceIntrospection.SelectReferenceFrame(
                camPixelW: 0f, camPixelH: 0f,
                overlayPixelW: 1920f, overlayPixelH: 1080f,
                liveScreenW: 400, liveScreenH: 150,   // stale/docked editor-window size
                resolvedW: 1920, resolvedH: 1080,
                out float refW, out float refH);

            Assert.AreEqual(1920f, refW, 1e-4, "overlay uses the canvas pixel-rect width");
            Assert.AreEqual(1080f, refH, 1e-4, "overlay uses the canvas pixel-rect height, not the stale Screen.height (the ~10x-too-tall bug)");
        }

        [Test]
        public void SelectReferenceFrame_Camera_WinsOverOverlayAndScreen()
        {
            UIScreenSpaceIntrospection.SelectReferenceFrame(
                camPixelW: 800f, camPixelH: 600f,
                overlayPixelW: 1920f, overlayPixelH: 1080f,
                liveScreenW: 400, liveScreenH: 150,
                resolvedW: 1920, resolvedH: 1080,
                out float refW, out float refH);

            Assert.AreEqual(800f, refW, 1e-4, "an explicit camera's pixel rect takes precedence");
            Assert.AreEqual(600f, refH, 1e-4);
        }

        [Test]
        public void SelectReferenceFrame_NoCanvasNoCam_FallsBackToLiveScreenThenResolved()
        {
            // No cam, no overlay, valid live Screen → live Screen wins.
            UIScreenSpaceIntrospection.SelectReferenceFrame(
                0f, 0f, 0f, 0f, 1280, 720, 1920, 1080, out float refW, out float refH);
            Assert.AreEqual(1280f, refW, 1e-4);
            Assert.AreEqual(720f, refH, 1e-4);

            // Degenerate live Screen → resolved Game-View size.
            UIScreenSpaceIntrospection.SelectReferenceFrame(
                0f, 0f, 0f, 0f, 0, 0, 1920, 1080, out float refW2, out float refH2);
            Assert.AreEqual(1920f, refW2, 1e-4);
            Assert.AreEqual(1080f, refH2, 1e-4);
        }
    }
}
