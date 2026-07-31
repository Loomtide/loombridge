using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine;
using UnityEngine.UI;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class UIHandlerTests
    {
        private UIHandler _handler;
        private GameObject _canvasGo;
        private static System.Type TmpTextType => System.Type.GetType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");

        [SetUp]
        public void SetUp()
        {
            _handler = new UIHandler();
        }

        [TearDown]
        public void TearDown()
        {
            if (_canvasGo != null)
                Object.DestroyImmediate(_canvasGo);

            // Clean up any created GameObjects from tests
            foreach (var canvas in Object.FindObjectsOfType<Canvas>())
            {
                if (canvas.gameObject.name.StartsWith("Test"))
                    Object.DestroyImmediate(canvas.gameObject);
            }
        }

        [Test]
        public void IsAsync_ReturnsFalse()
        {
            Assert.IsFalse(_handler.IsAsync("create_canvas"));
            Assert.IsFalse(_handler.IsAsync("add_text"));
        }

        [Test]
        public void CreateCanvas_CreatesWithRequiredComponents()
        {
            var parameters = new JObject { ["name"] = "TestCanvas" };
            JObject result = _handler.HandleOp("create_canvas", parameters);

            Assert.IsNotNull(result["locator"]);

            // Find the canvas
            _canvasGo = GameObject.Find("TestCanvas");
            Assert.IsNotNull(_canvasGo, "Canvas GameObject should exist");
            Assert.IsNotNull(_canvasGo.GetComponent<Canvas>());
            Assert.IsNotNull(_canvasGo.GetComponent<CanvasScaler>());
            Assert.IsNotNull(_canvasGo.GetComponent<GraphicRaycaster>());
        }

        [Test]
        public void CreateCanvas_OverlayMode_Default()
        {
            var parameters = new JObject { ["name"] = "TestCanvasOverlay" };
            _handler.HandleOp("create_canvas", parameters);

            _canvasGo = GameObject.Find("TestCanvasOverlay");
            Assert.AreEqual(RenderMode.ScreenSpaceOverlay, _canvasGo.GetComponent<Canvas>().renderMode);
        }

        [Test]
        public void CreateCanvas_WorldSpaceMode()
        {
            var parameters = new JObject
            {
                ["name"] = "TestCanvasWorld",
                ["render_mode"] = "worldSpace"
            };
            _handler.HandleOp("create_canvas", parameters);

            _canvasGo = GameObject.Find("TestCanvasWorld");
            Assert.AreEqual(RenderMode.WorldSpace, _canvasGo.GetComponent<Canvas>().renderMode);
        }

        [Test]
        public void CreateCanvas_UnknownRenderMode_Throws()
        {
            var parameters = new JObject
            {
                ["name"] = "TestCanvasBad",
                ["render_mode"] = "invalid"
            };
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("create_canvas", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("render_mode", ex.Message);
        }

        [Test]
        public void AddText_CreatesTextUnderParent()
        {
            // Create canvas first
            _handler.HandleOp("create_canvas", new JObject { ["name"] = "TestCanvasText" });
            _canvasGo = GameObject.Find("TestCanvasText");

            var locator = LocatorResolver.BuildLocator(_canvasGo);
            var parameters = new JObject
            {
                ["parent"] = locator,
                ["name"] = "Label",
                ["text"] = "Hello World"
            };

            JObject result = _handler.HandleOp("add_text", parameters);
            Assert.IsNotNull(result["locator"]);

            Transform label = _canvasGo.transform.Find("Label");
            Assert.IsNotNull(label, "Text child should exist");
            AssertTextComponentAndValue(label.gameObject, "Hello World", expectTmpWhenAvailable: true);
        }

        [Test]
        public void AddText_LegacyBackend_UsesUnityUiText()
        {
            _handler.HandleOp("create_canvas", new JObject { ["name"] = "TestCanvasLegacyText" });
            _canvasGo = GameObject.Find("TestCanvasLegacyText");

            var locator = LocatorResolver.BuildLocator(_canvasGo);
            var parameters = new JObject
            {
                ["parent"] = locator,
                ["name"] = "LegacyLabel",
                ["text"] = "Legacy",
                ["text_backend"] = "legacy"
            };

            _handler.HandleOp("add_text", parameters);

            Transform label = _canvasGo.transform.Find("LegacyLabel");
            Assert.IsNotNull(label, "Text child should exist");
            Text textComp = label.GetComponent<Text>();
            Assert.IsNotNull(textComp, "Legacy backend should create UnityEngine.UI.Text");
            Assert.AreEqual("Legacy", textComp.text);
        }

        [Test]
        public void UnknownOp_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("nonexistent", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ───────────────────── RCL-T13: held press across frames ─────────────────────

        [Test]
        public void DispatchPointer_Press_HoldsButtonDown_ThenReleaseLetsItUp()
        {
            (GameObject buttonGo, PressTracker tracker) = NewPressableButton(out _canvasGo);
            var locator = LocatorResolver.BuildLocator(buttonGo);

            // press: pointerDown only — the button stays DOWN with no synchronous up.
            JObject pressResult = _handler.HandleOp("dispatch_pointer",
                new JObject { ["action"] = "press", ["locator"] = locator });

            Assert.AreEqual(true, pressResult.Value<bool>("held"), "press reports held:true");
            string holdId = pressResult.Value<string>("holdId");
            Assert.IsFalse(string.IsNullOrEmpty(holdId), "press returns a holdId");
            Assert.IsTrue(tracker.pressed, "an On-Screen control sees the button held down after press");
            Assert.IsFalse(tracker.released, "no pointerUp should fire while held (this is the whole point of RCL-T13)");
            Assert.AreEqual(1, tracker.downCount);
            Assert.AreEqual(0, tracker.upCount);

            // The press persists: a poll on a later 'frame' still observes it down.
            Assert.IsTrue(tracker.pressed, "the press is still held across a subsequent poll");

            // release: matching pointerUp by holdId.
            JObject releaseResult = _handler.HandleOp("dispatch_pointer",
                new JObject { ["action"] = "release", ["hold_id"] = holdId });

            Assert.AreEqual(true, releaseResult.Value<bool>("released"), "release reports released:true");
            Assert.IsFalse(tracker.pressed, "the button is up after release");
            Assert.IsTrue(tracker.released);
            Assert.AreEqual(1, tracker.upCount);
        }

        [Test]
        public void DispatchPointer_Release_UnknownHoldId_NotFound()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("dispatch_pointer",
                    new JObject { ["action"] = "release", ["hold_id"] = "deadbeef0000" }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void DispatchPointer_Release_MissingHoldId_InvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("dispatch_pointer", new JObject { ["action"] = "release" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // RLH-W1: ui.set_text_style on a legacy uGUI Text (backend-independent of TMP availability).
        [Test]
        public void SetTextStyle_LegacyText_AppliesStyling()
        {
            _canvasGo = new GameObject("TestStyleText");
            Text text = _canvasGo.AddComponent<Text>();
            text.fontSize = 14;

            JObject result = _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_canvasGo),
                ["font_size"] = 30,
                ["color"] = new JObject { ["r"] = 1f, ["g"] = 0f, ["b"] = 0f, ["a"] = 1f },
                ["alignment"] = "MiddleCenter",
                ["font_style"] = "Bold",
                ["best_fit"] = true
            });

            Assert.AreEqual("legacy", result.Value<string>("text_backend"));
            Assert.AreEqual(30, text.fontSize, "font_size must apply to legacy Text");
            Assert.AreEqual(Color.red, text.color, "color must apply");
            Assert.AreEqual(TextAnchor.MiddleCenter, text.alignment, "alignment must apply");
            Assert.AreEqual(FontStyle.Bold, text.fontStyle, "font_style must apply");
            Assert.IsTrue(text.resizeTextForBestFit, "best_fit must apply");
            // D3: best_fit + font_size establishes bounds so the auto-sizer can't shrink to invisible
            // or exceed the requested size: max = font_size, min = max(10, font_size/2).
            Assert.AreEqual(30, text.resizeTextMaxSize, "best_fit max must be the requested font_size");
            Assert.AreEqual(15, text.resizeTextMinSize, "best_fit min must be max(10, font_size/2)");
            // D2 honesty: every requested field was actually written → all in applied, none skipped.
            var applied = (JObject)result["applied"];
            Assert.IsNotNull(applied, "response reports the applied fields");
            foreach (string field in new[] { "font_size", "color", "alignment", "font_style", "best_fit", "best_fit_bounds" })
                Assert.IsNotNull(applied[field], $"'{field}' must be reported as applied");
            Assert.AreEqual(0, ((JArray)result["skipped"]).Count, "nothing was skipped on the happy path");
        }

        [Test]
        public void SetTextStyle_NoTextComponent_NotFound()
        {
            _canvasGo = new GameObject("TestStyleNoText");

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_canvasGo),
                ["font_size"] = 20
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // D1: an unknown alignment string must REFUSE (INVALID_PARAMS) before mutating anything —
        // it used to be silently coerced to UpperLeft yet reported as applied.
        [Test]
        public void SetTextStyle_InvalidAlignment_RefusesWithoutMutating()
        {
            _canvasGo = new GameObject("TestStyleBadAlign");
            Text text = _canvasGo.AddComponent<Text>();
            text.fontSize = 14;
            text.alignment = TextAnchor.LowerRight;

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_canvasGo),
                ["font_size"] = 30, // would be valid — must NOT be applied when another arg refuses
                ["alignment"] = "CenterMiddle" // not a valid TextAnchor name
            }));

            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("CenterMiddle", ex.Message, "error must name the bad value");
            StringAssert.Contains("MiddleCenter", ex.Message, "error must list the valid names");
            Assert.AreEqual(14, text.fontSize, "a refused request must not partially apply");
            Assert.AreEqual(TextAnchor.LowerRight, text.alignment, "alignment must be untouched");
        }

        // D3 (legacy): best_fit=true WITHOUT font_size floors a degenerate min (0) to 10 so the
        // auto-sizer can't shrink text toward invisible; a sane existing min is left alone.
        [Test]
        public void SetTextStyle_LegacyBestFit_NoFontSize_FloorsZeroMin()
        {
            _canvasGo = new GameObject("TestStyleBestFitFloor");
            Text text = _canvasGo.AddComponent<Text>();
            text.resizeTextMinSize = 0;

            JObject result = _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_canvasGo),
                ["best_fit"] = true
            });

            Assert.IsTrue(text.resizeTextForBestFit);
            Assert.AreEqual(10, text.resizeTextMinSize, "a zero min must be floored to 10");
            Assert.IsNotNull(result["applied"]!["best_fit_bounds"], "the floored bounds must be reported");
        }

        [Test]
        public void SetTextStyle_LegacyBestFit_SaneExistingMin_LeftAlone()
        {
            _canvasGo = new GameObject("TestStyleBestFitKeepMin");
            Text text = _canvasGo.AddComponent<Text>();
            text.resizeTextMinSize = 18;
            text.resizeTextMaxSize = 44;

            JObject result = _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_canvasGo),
                ["best_fit"] = true
            });

            Assert.IsTrue(text.resizeTextForBestFit);
            Assert.AreEqual(18, text.resizeTextMinSize, "a sane existing min must be preserved");
            Assert.AreEqual(44, text.resizeTextMaxSize, "the existing max must be preserved");
            Assert.IsNull(result["applied"]!["best_fit_bounds"], "no bounds were (re)written");
        }

        // ── TMP branch (reflection). Guarded: TMP ships with com.unity.ugui 2.x on Unity 6000,
        // but the bridge must also run on 2022.3 where TMP may be absent — Assert.Ignore keeps
        // these honest (skipped-visible) rather than silently passing.

        private GameObject NewTmpText(string name)
        {
            if (TmpTextType == null)
                Assert.Ignore("TextMeshPro not available in this test project — TMP branch not exercised.");
            _canvasGo = new GameObject(name);
            _canvasGo.AddComponent(TmpTextType);
            return _canvasGo;
        }

        [Test]
        public void SetTextStyle_Tmp_FontSizeAndColor_AppliedHonestly()
        {
            GameObject go = NewTmpText("TestStyleTmp");
            Component tmp = go.GetComponent(TmpTextType);

            JObject result = _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["font_size"] = 30,
                ["color"] = new JObject { ["r"] = 1f, ["g"] = 0f, ["b"] = 0f, ["a"] = 1f },
                ["alignment"] = "MiddleCenter",
                ["font_style"] = "Bold"
            });

            Assert.AreEqual("tmp", result.Value<string>("text_backend"));
            Assert.AreEqual(30f, (float)TmpTextType.GetProperty("fontSize")!.GetValue(tmp, null), 0.001f,
                "TMP fontSize must be written via reflection");
            Assert.AreEqual(Color.red, (Color)TmpTextType.GetProperty("color")!.GetValue(tmp, null),
                "TMP color must be written via reflection");
            // D2 honesty: everything requested landed in applied, nothing skipped.
            var applied = (JObject)result["applied"];
            foreach (string field in new[] { "font_size", "color", "alignment", "font_style" })
                Assert.IsNotNull(applied[field], $"'{field}' must be reported as applied on TMP");
            Assert.AreEqual(0, ((JArray)result["skipped"]).Count, "no field may be skipped on real TMP");
        }

        [Test]
        public void SetTextStyle_Tmp_BestFitWithFontSize_BoundsTheAutoSizer()
        {
            GameObject go = NewTmpText("TestStyleTmpBestFit");
            Component tmp = go.GetComponent(TmpTextType);

            JObject result = _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["font_size"] = 30,
                ["best_fit"] = true
            });

            Assert.IsTrue((bool)TmpTextType.GetProperty("enableAutoSizing")!.GetValue(tmp, null),
                "best_fit must enable TMP auto-sizing");
            // D3: font_size becomes the UPPER bound and min is max(10, font_size/2), so the
            // auto-sizer can neither exceed the request nor shrink toward invisible.
            Assert.AreEqual(30f, (float)TmpTextType.GetProperty("fontSizeMax")!.GetValue(tmp, null), 0.001f,
                "fontSizeMax must be the requested font_size");
            Assert.AreEqual(15f, (float)TmpTextType.GetProperty("fontSizeMin")!.GetValue(tmp, null), 0.001f,
                "fontSizeMin must be max(10, font_size/2)");
            Assert.IsNotNull(result["applied"]!["best_fit_bounds"], "bounds must be reported as applied");
            Assert.AreEqual(0, ((JArray)result["skipped"]).Count);
        }

        [Test]
        public void SetTextStyle_Tmp_InvalidAlignment_Refused()
        {
            GameObject go = NewTmpText("TestStyleTmpBadAlign");

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_text_style", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["alignment"] = "SomewhereNice"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        private static (GameObject, PressTracker) NewPressableButton(out GameObject canvasGo)
        {
            canvasGo = new GameObject("TestPressCanvas");
            Canvas canvas = canvasGo.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvasGo.AddComponent<GraphicRaycaster>();

            var es = new GameObject("EventSystem");
            es.transform.SetParent(canvasGo.transform, false);
            es.AddComponent<UnityEngine.EventSystems.EventSystem>();
            es.AddComponent<UnityEngine.EventSystems.StandaloneInputModule>();

            var go = new GameObject("PressButton", typeof(RectTransform));
            go.transform.SetParent(canvasGo.transform, false);
            ((RectTransform)go.transform).sizeDelta = new Vector2(160, 60);
            go.AddComponent<Image>();
            PressTracker tracker = go.AddComponent<PressTracker>();
            return (go, tracker);
        }

        /// <summary>
        /// Stand-in for an On-Screen control: pressed flips true on pointerDown, false on pointerUp.
        /// A real OnScreenButton drives an InputSystem control the same way and a game polls IsPressed().
        /// </summary>
        private class PressTracker : MonoBehaviour,
            UnityEngine.EventSystems.IPointerDownHandler, UnityEngine.EventSystems.IPointerUpHandler
        {
            public bool pressed;
            public bool released;
            public int downCount;
            public int upCount;

            public void OnPointerDown(UnityEngine.EventSystems.PointerEventData e) { pressed = true; downCount++; }
            public void OnPointerUp(UnityEngine.EventSystems.PointerEventData e) { pressed = false; released = true; upCount++; }
        }

        // ─────────────────────────────────────────────
        // L114: a ui op never silently ignores a parameter it does not read
        //
        // ui.add_image was called with `sprite` instead of `sprite_path`. It returned
        // success, created the Image, and dropped the sprite on the floor: the agent then
        // debugged a sprite import that had never been requested. A creation op that half-
        // honours a request produces an object nothing reports as wrong.
        // ─────────────────────────────────────────────

        [Test]
        public void AddImage_UnknownParameter_ThrowsInvalidParamsNamingTheAcceptedSet()
        {
            _handler.HandleOp("create_canvas", new JObject { ["name"] = "TestCanvasImageGuard" });
            _canvasGo = GameObject.Find("TestCanvasImageGuard");
            JObject locator = LocatorResolver.BuildLocator(_canvasGo);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("add_image", new JObject
            {
                ["parent"] = locator,
                ["name"] = "Scrim",
                // THE EXACT L114 MISSPELLING.
                ["sprite"] = "Assets/Art/scrim.png"
            }));

            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("sprite", ex.Message, "the refusal must name the offending key");
            StringAssert.Contains("sprite_path", ex.Message,
                "and the accepted set, so the caller can correct it without a docs round trip");
            Assert.IsNull(_canvasGo.transform.Find("Scrim"),
                "a refused call must create NOTHING: a half-built object is what the silent drop produced");
        }

        [Test]
        public void AddImage_DocumentedParameters_StillWork_PositiveControl()
        {
            // THE POSITIVE CONTROL. A guard that only ever sees the broken input proves the
            // message exists, not that the accepted set is right.
            _handler.HandleOp("create_canvas", new JObject { ["name"] = "TestCanvasImageOk" });
            _canvasGo = GameObject.Find("TestCanvasImageOk");
            JObject locator = LocatorResolver.BuildLocator(_canvasGo);

            JObject result = _handler.HandleOp("add_image", new JObject
            {
                ["parent"] = locator,
                ["name"] = "Scrim",
                ["color"] = new JObject { ["r"] = 0f, ["g"] = 0f, ["b"] = 0f, ["a"] = 0.5f },
                ["sprite_path"] = "Assets/__does_not_exist__.png",
                ["anchored_position"] = new JObject { ["x"] = 10f, ["y"] = 20f },
                ["size_delta"] = new JObject { ["x"] = 100f, ["y"] = 50f }
            });

            Assert.IsNotNull(result["locator"]);
            Transform scrim = _canvasGo.transform.Find("Scrim");
            Assert.IsNotNull(scrim, "every documented parameter must still be accepted");
            Image image = scrim.GetComponent<Image>();
            Assert.AreEqual(0.5f, image.color.a, 0.001f);
            RectTransform rect = scrim.GetComponent<RectTransform>();
            Assert.AreEqual(100f, rect.sizeDelta.x, 0.001f);
        }

        [Test]
        public void UiOps_UnknownParameter_IsRefusedAcrossTheCategory()
        {
            // The guard is the CATEGORY's, not one op's: a typo in any ui op is named.
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("create_canvas", new JObject
            {
                ["name"] = "TestCanvasNeverCreated",
                ["renderMode"] = "overlay"   // the documented spelling is render_mode
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("renderMode", ex.Message);
            StringAssert.Contains("render_mode", ex.Message);
            Assert.IsNull(GameObject.Find("TestCanvasNeverCreated"));
        }

        [Test]
        public void UiOps_TransportTimeoutParameter_IsNotTreatedAsUnknown()
        {
            // `timeoutMs` is resolved by the SERVER and forwarded verbatim to every handler.
            // Refusing it would break working calls over a key the ui layer never reads.
            _handler.HandleOp("create_canvas", new JObject
            {
                ["name"] = "TestCanvasTimeout",
                ["timeoutMs"] = 15000
            });
            _canvasGo = GameObject.Find("TestCanvasTimeout");
            Assert.IsNotNull(_canvasGo);
        }

        [Test]
        public void DispatchPointer_TravelPx_IsAccepted_TheReplayDriverSendsIt()
        {
            // travelPx is read by the drag branch but was absent from the op's advertised
            // schema. Enumerating the accepted set from the SCHEMA rather than from what the
            // handler READS would have made this guard break the replay driver's first drag.
            // Whatever this call fails on (no EventSystem in an EditMode scene), it must not be
            // the parameter guard.
            string travelPxFailure = FailureMessage("dispatch_pointer", new JObject
            {
                ["action"] = "drag",
                ["x"] = 10f,
                ["y"] = 10f,
                ["to_x"] = 50f,
                ["to_y"] = 50f,
                ["travelPx"] = 400f
            });
            Assert.IsFalse(travelPxFailure != null && travelPxFailure.Contains("unknown parameter"),
                "travelPx is a real, read parameter; the guard must not refuse the replay driver's own drags: "
                    + travelPxFailure);

            // LITMUS: the same call with the key misspelled IS refused, so the check above is
            // not passing merely because the guard never runs on this op.
            string typoFailure = FailureMessage("dispatch_pointer", new JObject
            {
                ["action"] = "drag",
                ["travelPxx"] = 400f
            });
            Assert.IsNotNull(typoFailure, "a misspelled key must be refused");
            StringAssert.Contains("unknown parameter", typoFailure);
            StringAssert.Contains("travelPxx", typoFailure);
        }

        /// <summary>Run an op and return its BridgeException message, or null when it did not throw one.</summary>
        private string FailureMessage(string opName, JObject parameters)
        {
            try
            {
                _handler.HandleOp(opName, parameters);
                return null;
            }
            catch (BridgeException ex)
            {
                return ex.Message;
            }
        }

        private static void AssertTextComponentAndValue(GameObject go, string expectedText, bool expectTmpWhenAvailable)
        {
            if (TmpTextType != null && expectTmpWhenAvailable)
            {
                Component tmp = go.GetComponent(TmpTextType);
                Assert.IsNotNull(tmp, "Expected TextMeshProUGUI component");

                var textProp = TmpTextType.GetProperty("text");
                Assert.IsNotNull(textProp, "TMP text property should exist");
                Assert.AreEqual(expectedText, textProp.GetValue(tmp, null) as string);
                return;
            }

            Text legacy = go.GetComponent<Text>();
            Assert.IsNotNull(legacy, "Expected UnityEngine.UI.Text component");
            Assert.AreEqual(expectedText, legacy.text);
        }
    }
}
