using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles UI operations: canvas creation, text/image/button placement,
    /// and RectTransform manipulation.
    /// </summary>
    public class UIHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "create_canvas":
                    return HandleCreateCanvas(parameters);
                case "add_text":
                    return HandleAddText(parameters);
                case "add_image":
                    return HandleAddImage(parameters);
                case "add_button":
                    return HandleAddButton(parameters);
                case "set_rect_transform":
                    return HandleSetRectTransform(parameters);
                case "scan_text_components":
                    return HandleScanTextComponents(parameters);
                case "set_text_style":
                    return HandleSetTextStyle(parameters);
                case "dispatch_pointer":
                    return HandleDispatchPointer(parameters);
                case "get_screen_rects":
                    return Introspection.UIScreenSpaceIntrospection.GetScreenRects(
                        parameters.Value<JArray>("locators"),
                        parameters.Value<JObject>("camera"));
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown ui op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in UIHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"UI op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleCreateCanvas(JObject parameters)
        {
            string name = parameters.Value<string>("name") ?? "Canvas";

            GameObject canvasGo = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(canvasGo, $"Create Canvas {name}");

            Canvas canvas = canvasGo.AddComponent<Canvas>();
            string renderMode = parameters.Value<string>("render_mode") ?? "overlay";
            switch (renderMode)
            {
                case "overlay":
                case "ScreenSpaceOverlay":
                    canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                    break;
                case "camera":
                case "ScreenSpaceCamera":
                    canvas.renderMode = RenderMode.ScreenSpaceCamera;
                    break;
                case "worldSpace":
                case "WorldSpace":
                    canvas.renderMode = RenderMode.WorldSpace;
                    break;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unknown render_mode: '{renderMode}'. Valid: overlay, camera, worldSpace");
            }

            canvasGo.AddComponent<CanvasScaler>();
            canvasGo.AddComponent<GraphicRaycaster>();

            // RCL-T14: a canvas without an EventSystem swallows every tap/click silently. Ensure the
            // scene has one with the input module that matches the project's active input handling
            // (InputSystemUIInputModule for new-input projects, StandaloneInputModule otherwise). A
            // scene that already has an EventSystem is left in place.
            EventSystemEnsure.Result es = EventSystemEnsure.Ensure();

            ShowWorkVisualizer.SelectObject(canvasGo);
            ShowWorkVisualizer.LogChange($"+Canvas on {DescribeTarget(canvasGo)} renderMode={canvas.renderMode}");
            ShowWorkVisualizer.ExpandComponent(canvas);
            if (es.created)
                ShowWorkVisualizer.LogChange($"+EventSystem ({es.moduleType}) — UI input enabled");

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(canvasGo),
                ["name"] = name,
                ["render_mode"] = renderMode,
                ["eventSystem"] = new JObject
                {
                    ["locator"] = es.eventSystem != null ? LocatorResolver.BuildLocator(es.eventSystem.gameObject) : null,
                    ["created"] = es.created,
                    ["inputModule"] = es.moduleType
                }
            };
        }

        private JObject HandleAddText(JObject parameters)
        {
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'parent'");

            string name = parameters.Value<string>("name") ?? "Text";
            string text = parameters.Value<string>("text") ?? "";

            GameObject parentGo = LocatorResolver.Resolve(parentLocator);

            GameObject textGo = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(textGo, $"Create Text {name}");
            textGo.transform.SetParent(parentGo.transform, false);

            int fontSize = parameters.Value<int?>("font_size") ?? 14;
            string alignment = parameters.Value<string>("alignment");
            TextBackend backend = ParseTextBackend(parameters.Value<string>("text_backend"));
            bool usingTmp;
            Component textComp = CreateTextComponent(textGo, backend, out usingTmp);

            JObject colorObj = parameters.Value<JObject>("color");
            Color textColor = new Color(
                colorObj?.Value<float?>("r") ?? 1f,
                colorObj?.Value<float?>("g") ?? 1f,
                colorObj?.Value<float?>("b") ?? 1f,
                colorObj?.Value<float?>("a") ?? 1f);

            ApplyTextComponentValues(textComp, usingTmp, text, fontSize, textColor, alignment);

            // Ensure RectTransform is available (SetParent under Canvas auto-creates it)
            ApplyRectTransformParams(textGo.GetComponent<RectTransform>(), parameters);

            ShowWorkVisualizer.SelectObject(textGo);
            ShowWorkVisualizer.LogChange(
                $"+{textComp.GetType().Name} on {DescribeTarget(textGo)} text=\"{TrimForLog(text)}\"");
            ShowWorkVisualizer.ExpandComponent(textComp);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(textGo),
                ["name"] = name,
                ["text_backend"] = usingTmp ? "tmp" : "legacy"
            };
        }

        private JObject HandleAddImage(JObject parameters)
        {
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'parent'");

            string name = parameters.Value<string>("name") ?? "Image";
            GameObject parentGo = LocatorResolver.Resolve(parentLocator);

            GameObject imageGo = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(imageGo, $"Create Image {name}");
            imageGo.transform.SetParent(parentGo.transform, false);

            Image imageComp = imageGo.AddComponent<Image>();

            // Optional color
            JObject colorObj = parameters.Value<JObject>("color");
            if (colorObj != null)
            {
                imageComp.color = new Color(
                    colorObj.Value<float?>("r") ?? 1f,
                    colorObj.Value<float?>("g") ?? 1f,
                    colorObj.Value<float?>("b") ?? 1f,
                    colorObj.Value<float?>("a") ?? 1f);
            }

            // Optional sprite
            string spritePath = parameters.Value<string>("sprite_path");
            if (!string.IsNullOrEmpty(spritePath))
            {
                Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(spritePath);
                if (sprite != null)
                    imageComp.sprite = sprite;
            }

            // Apply optional rect transform
            ApplyRectTransformParams(imageGo.GetComponent<RectTransform>(), parameters);

            ShowWorkVisualizer.SelectObject(imageGo);
            ShowWorkVisualizer.LogChange($"+Image on {DescribeTarget(imageGo)}");
            ShowWorkVisualizer.ExpandComponent(imageComp);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(imageGo),
                ["name"] = name
            };
        }

        private JObject HandleAddButton(JObject parameters)
        {
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'parent'");

            string name = parameters.Value<string>("name") ?? "Button";
            string buttonText = parameters.Value<string>("text") ?? "Button";
            int fontSize = parameters.Value<int?>("font_size") ?? 14;
            TextBackend backend = ParseTextBackend(parameters.Value<string>("text_backend"));
            GameObject parentGo = LocatorResolver.Resolve(parentLocator);

            // Create button root
            GameObject buttonGo = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(buttonGo, $"Create Button {name}");
            buttonGo.transform.SetParent(parentGo.transform, false);

            Image buttonImage = buttonGo.AddComponent<Image>();
            buttonGo.AddComponent<Button>();

            // Optional color for button background
            JObject colorObj = parameters.Value<JObject>("color");
            if (colorObj != null)
            {
                buttonImage.color = new Color(
                    colorObj.Value<float?>("r") ?? 1f,
                    colorObj.Value<float?>("g") ?? 1f,
                    colorObj.Value<float?>("b") ?? 1f,
                    colorObj.Value<float?>("a") ?? 1f);
            }

            // Create child text
            GameObject textGo = new GameObject("Text");
            textGo.transform.SetParent(buttonGo.transform, false);

            bool usingTmp;
            Component textComp = CreateTextComponent(textGo, backend, out usingTmp);
            ApplyTextComponentValues(
                textComp,
                usingTmp,
                buttonText,
                fontSize,
                Color.black,
                "MiddleCenter");

            // Stretch text to fill button
            RectTransform textRect = textGo.GetComponent<RectTransform>();
            textRect.anchorMin = Vector2.zero;
            textRect.anchorMax = Vector2.one;
            textRect.sizeDelta = Vector2.zero;
            textRect.anchoredPosition = Vector2.zero;

            // Apply optional rect transform to button
            ApplyRectTransformParams(buttonGo.GetComponent<RectTransform>(), parameters);

            ShowWorkVisualizer.SelectObject(buttonGo);
            ShowWorkVisualizer.LogChange($"+Button on {DescribeTarget(buttonGo)} text=\"{TrimForLog(buttonText)}\"");
            ShowWorkVisualizer.ExpandComponent(buttonGo.GetComponent<Button>());

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(buttonGo),
                ["name"] = name,
                ["text_backend"] = usingTmp ? "tmp" : "legacy"
            };
        }

        /// <summary>
        /// Live presses left DOWN by a dispatch_pointer action='press', keyed by the holdId the press
        /// returned. The press is re-released by action='release' with that holdId. A press persists
        /// across game frames between the two MCP calls, so an On-Screen control that polls
        /// <c>IsPressed()</c> in Update (a tap that lasts a single synchronous click otherwise misses)
        /// observes the button held for as long as the agent leaves it down (RCL-T13).
        /// </summary>
        private static readonly Dictionary<string, EventSystemPointerDispatch.HeldDrag> _activeHolds =
            new Dictionary<string, EventSystemPointerDispatch.HeldDrag>();

        private JObject HandleDispatchPointer(JObject parameters)
        {
            string action = (parameters.Value<string>("action") ?? "click").ToLowerInvariant();
            int button = parameters.Value<int?>("button") ?? 0;

            // 'release' needs only a holdId — no target/point resolution.
            if (action == "release")
                return HandlePointerRelease(parameters);

            // Resolve the handler target and the start screen point. Either an
            // explicit screen point (x/y) or a locator (rect center) is required.
            JObject locator = parameters.Value<JObject>("locator");
            GameObject target = locator != null ? LocatorResolver.Resolve(locator) : null;

            Vector2 startPoint;
            float? x = parameters.Value<float?>("x");
            float? y = parameters.Value<float?>("y");
            if (x.HasValue && y.HasValue)
                startPoint = new Vector2(x.Value, y.Value);
            else if (target != null)
                startPoint = ScreenPointOf(target);
            else
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "dispatch_pointer requires a 'locator' or explicit 'x'/'y' screen coordinates.");

            // 'press' leaves the pointer DOWN and returns a holdId (no synchronous up); pair with 'release'.
            if (action == "press")
                return HandlePointerPress(target, startPoint, button);

            EventSystemPointerDispatch.Result result;
            if (action == "click")
            {
                result = EventSystemPointerDispatch.Click(target, startPoint, button);
            }
            else if (action == "drag")
            {
                Vector2 endPoint = ResolveDragEndPoint(parameters, startPoint);
                float travelPx = parameters.Value<float?>("travelPx") ?? 0f;
                if (float.IsNaN(travelPx) || float.IsInfinity(travelPx) || travelPx < 0f)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "dispatch_pointer action='drag' parameter 'travelPx' must be a finite number >= 0.");
                result = EventSystemPointerDispatch.Drag(target, startPoint, endPoint, button, travelPx: travelPx);
            }
            else
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unknown dispatch_pointer action: '{action}'. Valid: click, drag, press, release");
            }

            var fired = new JArray();
            foreach (string h in result.handlersFired)
                fired.Add(h);

            GameObject hit = result.handlerTarget;
            ShowWorkVisualizer.SelectObject(hit);
            ShowWorkVisualizer.LogChange(
                $"UI {action} on {DescribeTarget(hit)} @({result.screenPoint.x:0.#},{result.screenPoint.y:0.#}) fired=[{string.Join(",", result.handlersFired)}]");

            return new JObject
            {
                ["action"] = action,
                ["handlerTarget"] = hit != null ? LocatorResolver.BuildLocator(hit) : null,
                ["screenPoint"] = new JObject { ["x"] = result.screenPoint.x, ["y"] = result.screenPoint.y },
                ["raycastHit"] = result.raycastHit,
                ["handlersFired"] = fired,
                ["actuated"] = result.handlersFired.Count > 0
            };
        }

        /// <summary>
        /// action='press': dispatch pointerDown and LEAVE the pointer down, registering the held press
        /// under a fresh holdId. Returns { action:"press", holdId, held:true, ... }. The press is held
        /// across frames until a matching action='release' (RCL-T13).
        /// </summary>
        private JObject HandlePointerPress(GameObject target, Vector2 startPoint, int button)
        {
            EventSystemPointerDispatch.HeldDrag held =
                EventSystemPointerDispatch.BeginPressHold(target, startPoint, button);

            string holdId = Guid.NewGuid().ToString("N").Substring(0, 12);
            _activeHolds[holdId] = held;

            GameObject pressed = held.basis;
            ShowWorkVisualizer.SelectObject(pressed);
            ShowWorkVisualizer.LogChange(
                $"UI press on {DescribeTarget(pressed)} @({held.held.x:0.#},{held.held.y:0.#}) holdId={holdId} (held down)");

            var fired = new JArray();
            foreach (string h in held.handlersFired)
                fired.Add(h);

            return new JObject
            {
                ["action"] = "press",
                ["holdId"] = holdId,
                ["handlerTarget"] = pressed != null ? LocatorResolver.BuildLocator(pressed) : null,
                ["screenPoint"] = new JObject { ["x"] = held.held.x, ["y"] = held.held.y },
                ["raycastHit"] = held.raycastHit,
                ["handlersFired"] = fired,
                ["actuated"] = held.handlersFired.Count > 0,
                ["held"] = true,
            };
        }

        /// <summary>
        /// action='release': look up the live press by 'hold_id' and dispatch pointerUp (endDrag first
        /// for a held drag), then drop it from the registry. Idempotent only insofar as the holdId must
        /// still be registered — a stale/unknown holdId is a NOT_FOUND (RCL-T13).
        /// </summary>
        private JObject HandlePointerRelease(JObject parameters)
        {
            string holdId = parameters.Value<string>("hold_id");
            if (string.IsNullOrEmpty(holdId))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "dispatch_pointer action='release' requires 'hold_id' (returned by a prior action='press').");

            if (!_activeHolds.TryGetValue(holdId, out EventSystemPointerDispatch.HeldDrag held))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No active pointer hold for hold_id '{holdId}' (already released, or the bridge reloaded since the press).");

            EventSystemPointerDispatch.Release(held);
            _activeHolds.Remove(holdId);

            ShowWorkVisualizer.LogChange($"UI release holdId={holdId}");

            var fired = new JArray();
            foreach (string h in held.handlersFired)
                fired.Add(h);

            return new JObject
            {
                ["action"] = "release",
                ["holdId"] = holdId,
                ["handlerTarget"] = held.basis != null ? LocatorResolver.BuildLocator(held.basis) : null,
                ["handlersFired"] = fired,
                ["released"] = true,
            };
        }

        private static Vector2 ResolveDragEndPoint(JObject parameters, Vector2 start)
        {
            JObject toLocator = parameters.Value<JObject>("to_locator");
            if (toLocator != null)
                return ScreenPointOf(LocatorResolver.Resolve(toLocator));

            float? toX = parameters.Value<float?>("to_x");
            float? toY = parameters.Value<float?>("to_y");
            if (toX.HasValue && toY.HasValue)
                return new Vector2(toX.Value, toY.Value);

            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                "dispatch_pointer action='drag' requires 'to_locator' or 'to_x'/'to_y'.");
        }

        private static Vector2 ScreenPointOf(GameObject go)
        {
            RectTransform rt = go.GetComponent<RectTransform>();
            Canvas canvas = go.GetComponentInParent<Canvas>();
            Camera cam = (canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay)
                ? canvas.worldCamera
                : null;
            Vector3 worldCenter = rt != null ? rt.TransformPoint(rt.rect.center) : go.transform.position;
            return RectTransformUtility.WorldToScreenPoint(cam, worldCenter);
        }

        private JObject HandleScanTextComponents(JObject parameters)
        {
            // Optional 'locator' scopes the scan to a Canvas/subtree; absent → scene-wide.
            JObject locator = parameters.Value<JObject>("locator");
            return Introspection.UIIntrospection.ScanTextComponents(locator);
        }

        // RLH-W1: one-shot text styling for uGUI Text AND TMP (reflection). uGUI Text's
        // font/layout fields live under the nested m_FontData block; TMP serializes them flat
        // under different names — this op writes each supplied style via the live component API
        // (legacy setters, TMP via reflection) so the caller doesn't need to know either layout.
        // Only the fields present in the request are touched; the rest are left as-is.
        //
        // Honesty contract (adversarial-review D1/D2/D3):
        // - Unknown alignment/font_style strings REFUSE with INVALID_PARAMS at the op level
        //   BEFORE any field is mutated, so raw-wire/ops.batch callers are guarded, not just
        //   the MCP schema enum.
        // - 'applied' only lists fields whose write ACTUALLY happened; a TMP reflection write
        //   that found no writable property lands in 'skipped' [{field, reason}] instead. The
        //   response never claims an unapplied field was applied.
        // - best_fit=true bounds the auto-sizer so it can't shrink text toward invisible: with
        //   font_size given, max=font_size and min=max(10, font_size/2); without font_size, a
        //   floor min of 10 is set only when the current min is < 1. Applies to TMP
        //   (fontSizeMin/fontSizeMax) and legacy Text (resizeTextMinSize/resizeTextMaxSize).
        private JObject HandleSetTextStyle(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);

            Text legacy = go.GetComponent<Text>();
            Component tmp = null;
            if (legacy == null && TryGetTmpTextType(out Type tmpType))
                tmp = go.GetComponent(tmpType);

            if (legacy == null && tmp == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No UnityEngine.UI.Text or TextMeshProUGUI component on '{go.name}'.");

            Component target = legacy != null ? (Component)legacy : tmp;
            bool usingTmp = legacy == null;

            // D1: validate enum-like string params UP FRONT so an invalid request refuses before
            // any field is mutated (no partial application on a bad arg).
            string alignment = parameters.Value<string>("alignment");
            if (!string.IsNullOrEmpty(alignment))
                ValidateAlignment(alignment);
            string fontStyle = parameters.Value<string>("font_style");
            if (!string.IsNullOrEmpty(fontStyle))
                ParseFontStyle(fontStyle); // throws INVALID_PARAMS on unknown; value reused below

            float? fontSize = null;
            if (parameters["font_size"] != null && parameters["font_size"].Type != JTokenType.Null)
                fontSize = parameters.Value<float>("font_size");

            bool? bestFit = null;
            if (parameters["best_fit"] != null && parameters["best_fit"].Type != JTokenType.Null)
                bestFit = parameters.Value<bool>("best_fit");

            Undo.RecordObject(target, $"Set text style on {go.name}");
            var applied = new JObject();
            var skipped = new JArray();

            if (fontSize.HasValue)
            {
                if (usingTmp)
                {
                    if (TrySetProperty(target, "fontSize", fontSize.Value))
                        applied["font_size"] = fontSize.Value;
                    else
                        skipped.Add(SkipEntry("font_size",
                            "no writable 'fontSize' property on " + target.GetType().Name));
                }
                else
                {
                    legacy.fontSize = Mathf.RoundToInt(fontSize.Value);
                    applied["font_size"] = fontSize.Value;
                }
            }

            JObject colorObj = parameters.Value<JObject>("color");
            if (colorObj != null)
            {
                Color color = new Color(
                    colorObj.Value<float?>("r") ?? 1f,
                    colorObj.Value<float?>("g") ?? 1f,
                    colorObj.Value<float?>("b") ?? 1f,
                    colorObj.Value<float?>("a") ?? 1f);
                bool colorApplied;
                if (usingTmp)
                {
                    colorApplied = TrySetProperty(target, "color", color);
                    if (!colorApplied)
                        skipped.Add(SkipEntry("color",
                            "no writable 'color' property on " + target.GetType().Name));
                }
                else
                {
                    legacy.color = color;
                    colorApplied = true;
                }
                if (colorApplied)
                    applied["color"] = new JObject
                    {
                        ["r"] = color.r, ["g"] = color.g, ["b"] = color.b, ["a"] = color.a
                    };
            }

            if (!string.IsNullOrEmpty(fontStyle))
            {
                if (usingTmp)
                {
                    if (TrySetTmpFontStyle(target, fontStyle))
                        applied["font_style"] = fontStyle;
                    else
                        skipped.Add(SkipEntry("font_style",
                            "no writable enum 'fontStyle' property on " + target.GetType().Name +
                            " (or the TMP FontStyles enum lacks '" + fontStyle + "')"));
                }
                else
                {
                    legacy.fontStyle = ParseFontStyle(fontStyle);
                    applied["font_style"] = fontStyle;
                }
            }

            if (!string.IsNullOrEmpty(alignment))
            {
                if (usingTmp)
                {
                    if (TrySetTmpAlignment(target, alignment))
                        applied["alignment"] = alignment;
                    else
                        skipped.Add(SkipEntry("alignment",
                            "no writable enum 'alignment' property on " + target.GetType().Name +
                            " (or the TMP alignment enum lacks '" + MapAlignmentToTmp(alignment) + "')"));
                }
                else
                {
                    legacy.alignment = ParseTextAnchor(alignment);
                    applied["alignment"] = alignment;
                }
            }

            if (bestFit.HasValue)
                ApplyBestFit(target, legacy, usingTmp, bestFit.Value, fontSize, applied, skipped);

            EditorUtility.SetDirty(target);
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange(
                $"~{target.GetType().Name} style on {DescribeTarget(go)} {applied.ToString(Newtonsoft.Json.Formatting.None)}");
            ShowWorkVisualizer.ExpandComponent(target);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["text_backend"] = usingTmp ? "tmp" : "legacy",
                ["applied"] = applied,
                ["skipped"] = skipped
            };
        }

        // D3: best_fit semantics. Enabling an auto-sizer without bounds lets it shrink text
        // toward invisible (TMP's fontSizeMin can be 0) or override a font_size set in the SAME
        // request (auto-size wins over fontSize). So best_fit=true always establishes bounds:
        //   with font_size:    max = font_size, min = max(10, font_size/2)
        //   without font_size: floor min to 10 only when the current min is < 1
        // best_fit=false just disables the auto-sizer and leaves bounds untouched.
        private static void ApplyBestFit(
            Component target, Text legacy, bool usingTmp, bool bestFit, float? fontSize,
            JObject applied, JArray skipped)
        {
            if (!usingTmp)
            {
                legacy.resizeTextForBestFit = bestFit;
                applied["best_fit"] = bestFit;
                if (!bestFit)
                    return;

                int min, max;
                if (fontSize.HasValue)
                {
                    max = Mathf.RoundToInt(fontSize.Value);
                    min = Mathf.RoundToInt(Mathf.Max(10f, fontSize.Value / 2f));
                    legacy.resizeTextMaxSize = max;
                    legacy.resizeTextMinSize = min;
                }
                else
                {
                    if (legacy.resizeTextMinSize >= 1)
                        return; // existing bounds are sane; leave them alone
                    legacy.resizeTextMinSize = 10;
                    min = 10;
                    max = legacy.resizeTextMaxSize;
                }
                applied["best_fit_bounds"] = new JObject { ["min"] = min, ["max"] = max };
                return;
            }

            if (!TrySetProperty(target, "enableAutoSizing", bestFit))
            {
                skipped.Add(SkipEntry("best_fit",
                    "no writable 'enableAutoSizing' property on " + target.GetType().Name));
                return;
            }
            applied["best_fit"] = bestFit;
            if (!bestFit)
                return;

            float minF, maxF;
            bool writeMax;
            if (fontSize.HasValue)
            {
                maxF = fontSize.Value;
                minF = Mathf.Max(10f, fontSize.Value / 2f);
                writeMax = true;
            }
            else
            {
                if (TryGetFloatProperty(target, "fontSizeMin", out float currentMin) && currentMin >= 1f)
                    return; // existing bounds are sane; leave them alone
                minF = 10f;
                writeMax = false;
                if (!TryGetFloatProperty(target, "fontSizeMax", out maxF))
                    maxF = 0f; // unreadable — reported as-is alongside the floored min
            }

            bool minOk = TrySetProperty(target, "fontSizeMin", minF);
            bool maxOk = !writeMax || TrySetProperty(target, "fontSizeMax", maxF);
            if (minOk && maxOk)
                applied["best_fit_bounds"] = new JObject { ["min"] = minF, ["max"] = maxF };
            else
                skipped.Add(SkipEntry("best_fit_bounds",
                    "could not write fontSizeMin/fontSizeMax on " + target.GetType().Name +
                    " — auto-sizing is ON without the requested bounds"));
        }

        private static JObject SkipEntry(string field, string reason)
        {
            return new JObject { ["field"] = field, ["reason"] = reason };
        }

        // The nine anchor names accepted by 'alignment' (shared by the legacy TextAnchor parse
        // and the TMP mapping). D1: unknown strings refuse instead of silently becoming UpperLeft.
        private static readonly string[] ValidAlignments =
        {
            "UpperLeft", "UpperCenter", "UpperRight",
            "MiddleLeft", "MiddleCenter", "MiddleRight",
            "LowerLeft", "LowerCenter", "LowerRight",
        };

        private static void ValidateAlignment(string alignment)
        {
            foreach (string valid in ValidAlignments)
            {
                if (valid == alignment)
                    return;
            }
            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"Unknown alignment '{alignment}'. Valid: {string.Join(", ", ValidAlignments)}.");
        }

        private static FontStyle ParseFontStyle(string style)
        {
            switch (style)
            {
                case "Normal": return FontStyle.Normal;
                case "Bold": return FontStyle.Bold;
                case "Italic": return FontStyle.Italic;
                case "BoldAndItalic": return FontStyle.BoldAndItalic;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unknown font_style '{style}'. Valid: Normal, Bold, Italic, BoldAndItalic.");
            }
        }

        // TMP's fontStyle is a [Flags] FontStyles enum, resolved by reflection so the bridge keeps
        // no compile-time TextMeshPro dependency. BoldAndItalic maps to the "Bold, Italic" flag
        // combo. Returns true only when the write actually happened (D2: the caller records
        // applied/skipped from this, never unconditionally). Input is validated upstream by
        // ParseFontStyle, so a parse miss here means TMP enum drift — an honest skip, not a refuse.
        private static bool TrySetTmpFontStyle(Component textComponent, string style)
        {
            PropertyInfo styleProp =
                textComponent.GetType().GetProperty("fontStyle", BindingFlags.Instance | BindingFlags.Public);
            if (styleProp == null || !styleProp.CanWrite || !styleProp.PropertyType.IsEnum)
                return false;

            string enumName = style == "BoldAndItalic" ? "Bold, Italic" : style;
            object enumValue;
            try
            {
                enumValue = Enum.Parse(styleProp.PropertyType, enumName);
            }
            catch
            {
                return false;
            }

            styleProp.SetValue(textComponent, enumValue, null);
            return true;
        }

        // Read a float property by reflection (TMP fontSizeMin/fontSizeMax). Returns false when
        // the property is missing, unreadable, or not a float.
        private static bool TryGetFloatProperty(Component target, string propertyName, out float value)
        {
            value = 0f;
            PropertyInfo prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanRead || prop.PropertyType != typeof(float))
                return false;
            value = (float)prop.GetValue(target, null);
            return true;
        }

        private JObject HandleSetRectTransform(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            RectTransform rt = go.GetComponent<RectTransform>();
            if (rt == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No RectTransform found on '{go.name}'");

            Undo.RecordObject(rt, $"Set RectTransform on {go.name}");

            JObject anchorMin = parameters.Value<JObject>("anchor_min");
            if (anchorMin != null)
                rt.anchorMin = new Vector2(
                    anchorMin.Value<float?>("x") ?? 0f,
                    anchorMin.Value<float?>("y") ?? 0f);

            JObject anchorMax = parameters.Value<JObject>("anchor_max");
            if (anchorMax != null)
                rt.anchorMax = new Vector2(
                    anchorMax.Value<float?>("x") ?? 1f,
                    anchorMax.Value<float?>("y") ?? 1f);

            JObject anchoredPosition = parameters.Value<JObject>("anchored_position");
            if (anchoredPosition != null)
                rt.anchoredPosition = new Vector2(
                    anchoredPosition.Value<float?>("x") ?? 0f,
                    anchoredPosition.Value<float?>("y") ?? 0f);

            JObject sizeDelta = parameters.Value<JObject>("size_delta");
            if (sizeDelta != null)
                rt.sizeDelta = new Vector2(
                    sizeDelta.Value<float?>("x") ?? 0f,
                    sizeDelta.Value<float?>("y") ?? 0f);

            JObject pivot = parameters.Value<JObject>("pivot");
            if (pivot != null)
                rt.pivot = new Vector2(
                    pivot.Value<float?>("x") ?? 0.5f,
                    pivot.Value<float?>("y") ?? 0.5f);

            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange(
                $"{DescribeTarget(go)} RectTransform anchoredPosition={FormatVector2(rt.anchoredPosition)} sizeDelta={FormatVector2(rt.sizeDelta)}");
            ShowWorkVisualizer.ExpandComponent(rt);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["anchored_position"] = new JObject
                {
                    ["x"] = rt.anchoredPosition.x,
                    ["y"] = rt.anchoredPosition.y
                },
                ["size_delta"] = new JObject
                {
                    ["x"] = rt.sizeDelta.x,
                    ["y"] = rt.sizeDelta.y
                }
            };
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        private enum TextBackend
        {
            Auto,
            Tmp,
            Legacy,
        }

        private static TextBackend ParseTextBackend(string rawBackend)
        {
            if (string.IsNullOrEmpty(rawBackend))
                return TextBackend.Tmp;

            switch (rawBackend.ToLowerInvariant())
            {
                case "tmp":
                case "textmeshpro":
                case "textmeshprougui":
                    return TextBackend.Tmp;
                case "legacy":
                case "ugui":
                case "text":
                    return TextBackend.Legacy;
                case "auto":
                    return TextBackend.Auto;
                default:
                    return TextBackend.Tmp;
            }
        }

        private static Component CreateTextComponent(GameObject target, TextBackend backend, out bool usingTmp)
        {
            if (TryGetTmpTextType(out Type tmpType) && backend != TextBackend.Legacy)
            {
                usingTmp = true;
                return target.AddComponent(tmpType);
            }

            if (backend == TextBackend.Tmp)
            {
                Debug.LogWarning("[Loombridge] TextMeshPro not available, falling back to UnityEngine.UI.Text");
            }

            usingTmp = false;
            return target.AddComponent<Text>();
        }

        private static bool TryGetTmpTextType(out Type tmpType)
        {
            tmpType = Type.GetType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            if (tmpType != null)
                return true;

            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                tmpType = asm.GetType("TMPro.TextMeshProUGUI");
                if (tmpType != null)
                    return true;
            }

            return false;
        }

        private static void ApplyTextComponentValues(
            Component textComponent,
            bool usingTmp,
            string text,
            int fontSize,
            Color color,
            string alignment)
        {
            if (usingTmp)
            {
                TrySetProperty(textComponent, "text", text);
                TrySetProperty(textComponent, "fontSize", (float)fontSize);
                TrySetProperty(textComponent, "color", color);
                TrySetTmpAlignment(textComponent, alignment);
                return;
            }

            Text legacyText = textComponent as Text;
            if (legacyText == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    "Failed to create UnityEngine.UI.Text component");

            legacyText.text = text;
            legacyText.fontSize = fontSize;
            legacyText.color = color;

            if (!string.IsNullOrEmpty(alignment))
                legacyText.alignment = ParseTextAnchor(alignment);
        }

        // Returns true only when the reflective write actually happened (D2: ui.set_text_style
        // records applied/skipped from this — the response must never claim an unapplied field).
        // The add_text/add_button creation paths ignore the return value, preserving their
        // original best-effort behavior.
        private static bool TrySetProperty(Component target, string propertyName, object value)
        {
            PropertyInfo prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanWrite)
                return false;

            object converted = value;
            Type propertyType = prop.PropertyType;
            Type valueType = value?.GetType();

            if (valueType != null && !propertyType.IsAssignableFrom(valueType))
            {
                try
                {
                    converted = Convert.ChangeType(value, propertyType);
                }
                catch
                {
                    return false;
                }
            }

            prop.SetValue(target, converted, null);
            return true;
        }

        // Returns true only when the write actually happened (see TrySetProperty note).
        private static bool TrySetTmpAlignment(Component textComponent, string alignment)
        {
            if (string.IsNullOrEmpty(alignment))
                return false;

            PropertyInfo alignmentProp =
                textComponent.GetType().GetProperty("alignment", BindingFlags.Instance | BindingFlags.Public);
            if (alignmentProp == null || !alignmentProp.CanWrite || !alignmentProp.PropertyType.IsEnum)
                return false;

            string enumName = MapAlignmentToTmp(alignment);
            object enumValue;
            try
            {
                enumValue = Enum.Parse(alignmentProp.PropertyType, enumName);
            }
            catch
            {
                return false;
            }

            alignmentProp.SetValue(textComponent, enumValue, null);
            return true;
        }

        private static string MapAlignmentToTmp(string alignment)
        {
            switch (alignment)
            {
                case "UpperLeft": return "TopLeft";
                case "UpperCenter": return "Top";
                case "UpperRight": return "TopRight";
                case "MiddleLeft": return "Left";
                case "MiddleCenter": return "Center";
                case "MiddleRight": return "Right";
                case "LowerLeft": return "BottomLeft";
                case "LowerCenter": return "Bottom";
                case "LowerRight": return "BottomRight";
                default: return "TopLeft";
            }
        }

        /// <summary>
        /// Applies optional RectTransform parameters from an op's JObject parameters.
        /// Looks for anchored_position and size_delta fields.
        /// </summary>
        private static void ApplyRectTransformParams(RectTransform rt, JObject parameters)
        {
            if (rt == null) return;

            JObject anchoredPosition = parameters.Value<JObject>("anchored_position");
            if (anchoredPosition != null)
                rt.anchoredPosition = new Vector2(
                    anchoredPosition.Value<float?>("x") ?? 0f,
                    anchoredPosition.Value<float?>("y") ?? 0f);

            JObject sizeDelta = parameters.Value<JObject>("size_delta");
            if (sizeDelta != null)
                rt.sizeDelta = new Vector2(
                    sizeDelta.Value<float?>("x") ?? 0f,
                    sizeDelta.Value<float?>("y") ?? 0f);
        }

        private static string DescribeTarget(GameObject go)
        {
            return LocatorResolver.BuildLocator(go).Value<string>("path") ?? go.name;
        }

        private static string TrimForLog(string value)
        {
            if (string.IsNullOrEmpty(value))
                return "";
            value = value.Replace("\n", "\\n").Replace("\r", "\\r");
            return value.Length <= 48 ? value : value.Substring(0, 45) + "...";
        }

        private static string FormatVector2(Vector2 value)
        {
            return $"({value.x:0.###}, {value.y:0.###})";
        }

        private static TextAnchor ParseTextAnchor(string alignment)
        {
            switch (alignment)
            {
                case "UpperLeft": return TextAnchor.UpperLeft;
                case "UpperCenter": return TextAnchor.UpperCenter;
                case "UpperRight": return TextAnchor.UpperRight;
                case "MiddleLeft": return TextAnchor.MiddleLeft;
                case "MiddleCenter": return TextAnchor.MiddleCenter;
                case "MiddleRight": return TextAnchor.MiddleRight;
                case "LowerLeft": return TextAnchor.LowerLeft;
                case "LowerCenter": return TextAnchor.LowerCenter;
                case "LowerRight": return TextAnchor.LowerRight;
                default: return TextAnchor.UpperLeft;
            }
        }
    }
}
