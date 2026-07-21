using System.Collections.Generic;
using NUnit.Framework;
using UnityBridge.Introspection;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode tests for the deterministic (non-rendering) part of the RCL-T12 overlay-UI
    /// compositing: which canvases get composited into the game capture. The actual pixel
    /// compositing (ScreenSpaceCamera swap + Camera.Render into the RenderTexture) is GPU- and
    /// canvas-layout-bound and is covered by a LIVE Unity smoke, not here.
    /// </summary>
    [TestFixture]
    public class ScreenshotCaptureTests
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

        private static Canvas NewCanvas(string name, RenderMode mode)
        {
            var go = new GameObject(name);
            Canvas canvas = go.AddComponent<Canvas>();
            canvas.renderMode = mode;
            go.AddComponent<GraphicRaycaster>();
            return canvas;
        }

        [Test]
        public void CollectActiveOverlayRootCanvases_PicksOverlayRoots_ExcludesNonOverlay()
        {
            Canvas overlay = NewCanvas("HUD", RenderMode.ScreenSpaceOverlay);
            Canvas world = NewCanvas("WorldCanvas", RenderMode.WorldSpace);

            List<Canvas> collected = ScreenshotCapture.CollectActiveOverlayRootCanvases();

            CollectionAssert.Contains(collected, overlay, "an active overlay root canvas is composited");
            CollectionAssert.DoesNotContain(collected, world, "a WorldSpace canvas is rendered by its camera, not composited");
        }

        [Test]
        public void CollectActiveOverlayRootCanvases_ExcludesInactiveAndChildCanvases()
        {
            Canvas overlay = NewCanvas("HUD", RenderMode.ScreenSpaceOverlay);

            // An inactive overlay canvas must not be composited.
            Canvas hidden = NewCanvas("HiddenHUD", RenderMode.ScreenSpaceOverlay);
            hidden.gameObject.SetActive(false);

            // A NESTED canvas under the overlay root: not a root, so excluded (the root carries it).
            var childGo = new GameObject("NestedPanel", typeof(RectTransform));
            childGo.transform.SetParent(overlay.transform, false);
            Canvas child = childGo.AddComponent<Canvas>();

            List<Canvas> collected = ScreenshotCapture.CollectActiveOverlayRootCanvases();

            CollectionAssert.Contains(collected, overlay);
            CollectionAssert.DoesNotContain(collected, hidden, "an inactive overlay canvas is excluded");
            CollectionAssert.DoesNotContain(collected, child, "a non-root (nested) canvas is excluded; its root drives it");
        }
    }
}
