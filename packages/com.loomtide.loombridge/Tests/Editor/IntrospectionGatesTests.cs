using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode unit tests for the Phase-A verification gates: ui.scan_text_components,
    /// scene.get_screen_rects, and scene.verify_manifest. Objects are created in a fresh
    /// scene and resolved via instanceId locators.
    /// </summary>
    [TestFixture]
    public class IntrospectionGatesTests
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

        // ─────────────────────────────────────────────
        // UIIntrospection
        // ─────────────────────────────────────────────

        [Test]
        public void ScanTextComponents_FindsLegacyText_WithColorAndSize()
        {
            var canvasGo = new GameObject("Canvas");
            canvasGo.AddComponent<Canvas>();

            var textGo = new GameObject("ScoreLabel");
            textGo.transform.SetParent(canvasGo.transform, false);
            var text = textGo.AddComponent<Text>();
            text.text = "SCORE 0";
            text.fontSize = 18;
            text.color = new Color(1f, 0.82f, 0.4f, 1f);

            JObject result = UIIntrospection.ScanTextComponents(InstanceLocator(canvasGo));

            JArray components = result.Value<JArray>("components");
            Assert.IsNotNull(components);
            Assert.GreaterOrEqual(components.Count, 1);

            JObject entry = FindComponentNamed(components, "ScoreLabel");
            Assert.IsNotNull(entry, "ScoreLabel should be enumerated");
            Assert.AreEqual("UnityEngine.UI.Text", entry.Value<string>("type"));
            Assert.AreEqual("SCORE 0", entry.Value<string>("text"));
            Assert.AreEqual(18, entry.Value<int>("fontSize"));

            JObject color = entry.Value<JObject>("color");
            Assert.IsNotNull(color);
            Assert.AreEqual(1f, color.Value<float>("r"), 0.001f);
            Assert.AreEqual(0.82f, color.Value<float>("g"), 0.001f);

            Assert.IsNotNull(entry["anchor"], "anchor should be present for a RectTransform");
        }

        [Test]
        public void ScanTextComponents_SceneWide_WhenNoLocator()
        {
            var canvasGo = new GameObject("Canvas");
            canvasGo.AddComponent<Canvas>();
            var textGo = new GameObject("Lives");
            textGo.transform.SetParent(canvasGo.transform, false);
            textGo.AddComponent<Text>().text = "x3";

            JObject result = UIIntrospection.ScanTextComponents(null);
            Assert.AreEqual("scene", result.Value<string>("scope"));
            Assert.GreaterOrEqual(result.Value<int>("count"), 1);
        }

        // ─────────────────────────────────────────────
        // ScreenSpaceIntrospection
        // ─────────────────────────────────────────────

        [Test]
        public void GetScreenRects_ObjectInFront_IsFullyVisible()
        {
            var camGo = new GameObject("Cam");
            var cam = camGo.AddComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = 5f;
            camGo.transform.position = new Vector3(0, 0, -10);

            var obj = new GameObject("Box");
            obj.transform.position = Vector3.zero;
            var sr = obj.AddComponent<SpriteRenderer>();
            sr.sprite = MakeSprite();

            var locators = new JArray { InstanceLocator(obj) };
            JObject result = ScreenSpaceIntrospection.GetScreenRects(locators, InstanceLocator(camGo), "renderer");

            JArray objects = result.Value<JArray>("objects");
            Assert.AreEqual(1, objects.Count);
            JObject entry = objects[0] as JObject;
            Assert.IsNotNull(entry.Value<JObject>("screenRect"));
            Assert.IsTrue(entry.Value<bool>("isFullyVisible"), "Centered object should be fully visible");
            Assert.IsFalse(entry.Value<bool>("isPartiallyClipped"));
            // Centered object → ~0.5 horizontal fraction.
            Assert.AreEqual(0.5f, entry.Value<float>("centerXFraction"), 0.1f);
        }

        [Test]
        public void GetScreenRects_InvalidBoundsMode_Throws()
        {
            var camGo = new GameObject("Cam");
            camGo.AddComponent<Camera>();
            var obj = new GameObject("Box");
            var locators = new JArray { InstanceLocator(obj) };

            var ex = Assert.Throws<BridgeException>(() =>
                ScreenSpaceIntrospection.GetScreenRects(locators, InstanceLocator(camGo), "bogus"));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void GetScreenRects_EmptyLocators_Throws()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                ScreenSpaceIntrospection.GetScreenRects(new JArray(), null, "opaque"));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // ManifestVerification
        // ─────────────────────────────────────────────

        [Test]
        public void VerifyManifest_AllPresent_AllOk()
        {
            new GameObject("Player");
            new GameObject("Flag");

            var manifest = new JArray
            {
                new JObject { ["name"] = "Player", ["type"] = "GameObject" },
                new JObject { ["name"] = "Flag", ["type"] = "GameObject" },
            };
            var parameters = new JObject { ["manifest"] = manifest };

            JObject result = ManifestVerification.Verify(parameters);
            Assert.IsTrue(result.Value<bool>("all_ok"), "All present → all_ok");
            Assert.AreEqual(0, result.Value<JArray>("missing").Count);
        }

        [Test]
        public void VerifyManifest_Missing_ReportedAndNotOk()
        {
            new GameObject("Player");

            var manifest = new JArray
            {
                new JObject { ["name"] = "Player", ["type"] = "GameObject" },
                new JObject { ["name"] = "Goal", ["type"] = "GameObject" },
            };
            var parameters = new JObject { ["manifest"] = manifest };

            JObject result = ManifestVerification.Verify(parameters);
            Assert.IsFalse(result.Value<bool>("all_ok"));
            JArray missing = result.Value<JArray>("missing");
            Assert.AreEqual(1, missing.Count);
            Assert.AreEqual("Goal", (missing[0] as JObject).Value<string>("name"));
        }

        [Test]
        public void VerifyManifest_PlaceholderSprite_Reported()
        {
            var go = new GameObject("Enemy");
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = MakeSprite("enemy_placeholder");

            var manifest = new JArray
            {
                new JObject { ["name"] = "Enemy", ["type"] = "GameObject" },
            };
            var parameters = new JObject { ["manifest"] = manifest };

            JObject result = ManifestVerification.Verify(parameters);
            JArray placeholders = result.Value<JArray>("placeholders");
            Assert.AreEqual(1, placeholders.Count, "Placeholder sprite should be flagged");
            Assert.IsFalse(result.Value<bool>("all_ok"));
        }

        [Test]
        public void VerifyManifest_RegexMatching_Works()
        {
            new GameObject("Fruit_Apple");
            new GameObject("Fruit_Banana");

            var manifest = new JArray
            {
                new JObject { ["nameRegex"] = "^Fruit_", ["minCount"] = 2 },
            };
            var parameters = new JObject
            {
                ["manifest"] = manifest,
                ["matching"] = new JObject { ["mode"] = "regex" },
            };

            JObject result = ManifestVerification.Verify(parameters);
            Assert.IsTrue(result.Value<bool>("all_ok"), "Two Fruit_* objects satisfy minCount=2");
        }

        [Test]
        public void VerifyManifest_NoManifestOrPath_Throws()
        {
            var ex = Assert.Throws<BridgeException>(() => ManifestVerification.Verify(new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void VerifyManifest_ObjectShapedManifest_RefusesWithInvalidParams()
        {
            // A caller that passes {"manifest": {...}} used to hit a raw Newtonsoft
            // InvalidCastException inside the handler, which lands a Unity console ERROR
            // and poisons console-clean for the rest of the editor session. It must be a
            // structured refusal naming the shape expected.
            var parameters = new JObject
            {
                ["manifest"] = new JObject { ["name"] = "Player", ["type"] = "GameObject" },
            };

            var ex = Assert.Throws<BridgeException>(() => ManifestVerification.Verify(parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("must be a JSON ARRAY", ex.Message);
            StringAssert.Contains("object", ex.Message);

            // POSITIVE CONTROL: the SAME entry inside an array is accepted, so the
            // refusal is about the shape and nothing else.
            new GameObject("Player");
            var wrapped = new JObject
            {
                ["manifest"] = new JArray { new JObject { ["name"] = "Player", ["type"] = "GameObject" } },
            };
            Assert.IsTrue(ManifestVerification.Verify(wrapped).Value<bool>("all_ok"));
        }

        [Test]
        public void VerifyManifest_ObjectShapedMatching_RefusesWithInvalidParams()
        {
            var parameters = new JObject
            {
                ["manifest"] = new JArray { new JObject { ["name"] = "Player" } },
                ["matching"] = new JArray { "regex" },
            };

            var ex = Assert.Throws<BridgeException>(() => ManifestVerification.Verify(parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("must be a JSON OBJECT", ex.Message);
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        private static JObject FindComponentNamed(JArray components, string name)
        {
            foreach (JToken t in components)
            {
                JObject o = t as JObject;
                if (o != null && o.Value<string>("name") == name)
                    return o;
            }
            return null;
        }

        private static Sprite MakeSprite(string name = "TestSprite")
        {
            var tex = new Texture2D(8, 8, TextureFormat.RGBA32, false);
            var pixels = new Color32[8 * 8];
            for (int i = 0; i < pixels.Length; i++)
                pixels[i] = new Color32(255, 255, 255, 255);
            tex.SetPixels32(pixels);
            tex.Apply();
            var sprite = Sprite.Create(tex, new Rect(0, 0, 8, 8), new Vector2(0.5f, 0.5f), 8f);
            sprite.name = name;
            return sprite;
        }
    }
}
