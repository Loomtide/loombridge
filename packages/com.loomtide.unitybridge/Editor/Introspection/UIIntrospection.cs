using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Enumerates text components (TextMeshPro + UnityEngine.UI.Text) in a Canvas subtree
    /// (or scene-wide), returning each one's font asset path, color, size, alignment, and
    /// anchor. This is the data the UI-conformance gate checks against the mock's font and
    /// palette spec ("score is Press Start 2P, #ffd166").
    ///
    /// TMP-safe by REFLECTION: the bridge must compile in projects WITHOUT TextMeshPro, so
    /// we never `using TMPro`. We resolve TMP types via Type.GetType and read their
    /// font/color/size/alignment through reflection (same pattern as UIHandler). Legacy
    /// UnityEngine.UI.Text is read directly. The font ObjectReference's asset path is
    /// resolved via SerializedObject + AssetDatabase.GetAssetPath.
    /// </summary>
    public static class UIIntrospection
    {
        /// <summary>
        /// Scans text components. When <paramref name="rootLocator"/> is non-null, scans that
        /// object's subtree (typically a Canvas); otherwise scans every loaded scene root.
        /// </summary>
        public static JObject ScanTextComponents(JObject rootLocator)
        {
            var roots = new List<GameObject>();
            if (rootLocator != null)
            {
                roots.Add(LocatorResolver.Resolve(rootLocator));
            }
            else
            {
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    Scene scene = SceneManager.GetSceneAt(i);
                    if (!scene.isLoaded) continue;
                    roots.AddRange(scene.GetRootGameObjects());
                }
            }

            Type tmpType = ResolveTmpTextType();

            var components = new JArray();
            foreach (GameObject root in roots)
            {
                // Include inactive so a disabled HUD element is still reported.
                foreach (Transform t in root.GetComponentsInChildren<Transform>(true))
                {
                    GameObject go = t.gameObject;

                    // Legacy uGUI Text.
                    Text legacy = go.GetComponent<Text>();
                    if (legacy != null)
                        components.Add(DescribeLegacyText(legacy));

                    // TMP (reflection) — TextMeshProUGUI and any subclass.
                    if (tmpType != null)
                    {
                        Component tmp = go.GetComponent(tmpType);
                        if (tmp != null)
                            components.Add(DescribeTmpText(tmp));
                    }
                }
            }

            return new JObject
            {
                ["scope"] = rootLocator != null ? "subtree" : "scene",
                ["tmpAvailable"] = tmpType != null,
                ["count"] = components.Count,
                ["components"] = components
            };
        }

        // ─────────────────────────────────────────────
        // Legacy UnityEngine.UI.Text
        // ─────────────────────────────────────────────

        private static JObject DescribeLegacyText(Text text)
        {
            GameObject go = text.gameObject;
            string fontPath = ResolveFontAssetPath(text, "m_FontData.m_Font");
            // The legacy font path lives under m_FontData; fall back to the direct API.
            if (string.IsNullOrEmpty(fontPath) && text.font != null)
                fontPath = AssetDatabase.GetAssetPath(text.font);

            Color c = text.color;
            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["name"] = go.name,
                ["type"] = "UnityEngine.UI.Text",
                ["fontAssetPath"] = NullableString(fontPath),
                ["fontName"] = text.font != null ? text.font.name : (JToken)JValue.CreateNull(),
                ["color"] = ColorJ(c),
                ["fontSize"] = text.fontSize,
                ["alignment"] = text.alignment.ToString(),
                ["anchor"] = AnchorJ(go.GetComponent<RectTransform>()),
                ["text"] = text.text
            };
        }

        // ─────────────────────────────────────────────
        // TextMeshPro (reflection)
        // ─────────────────────────────────────────────

        private static JObject DescribeTmpText(Component tmp)
        {
            GameObject go = tmp.gameObject;
            Type type = tmp.GetType();

            // font asset is a TMP_FontAsset ObjectReference under the serialized field
            // m_fontAsset. Resolving via SerializedObject keeps us off a TMP type ref.
            string fontPath = ResolveFontAssetPath(tmp, "m_fontAsset");
            UnityEngine.Object fontObj = GetPropertyValue(tmp, type, "font") as UnityEngine.Object;
            if (string.IsNullOrEmpty(fontPath) && fontObj != null)
                fontPath = AssetDatabase.GetAssetPath(fontObj);

            object colorVal = GetPropertyValue(tmp, type, "color");
            Color color = colorVal is Color col ? col : Color.white;

            object fontSizeVal = GetPropertyValue(tmp, type, "fontSize");
            float fontSize = fontSizeVal is float fs ? fs : 0f;

            object alignmentVal = GetPropertyValue(tmp, type, "alignment");
            string alignment = alignmentVal != null ? alignmentVal.ToString() : null;

            object textVal = GetPropertyValue(tmp, type, "text");
            string textStr = textVal as string;

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["name"] = go.name,
                ["type"] = type.FullName,
                ["fontAssetPath"] = NullableString(fontPath),
                ["fontName"] = fontObj != null ? fontObj.name : (JToken)JValue.CreateNull(),
                ["color"] = ColorJ(color),
                ["fontSize"] = fontSize,
                ["alignment"] = NullableString(alignment),
                ["anchor"] = AnchorJ(go.GetComponent<RectTransform>()),
                ["text"] = NullableString(textStr)
            };
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        /// <summary>
        /// Resolves the asset path of a font ObjectReference at <paramref name="propertyPath"/>
        /// via SerializedObject (works for both legacy m_FontData.m_Font and TMP m_fontAsset).
        /// Returns null when the property is absent or unassigned.
        /// </summary>
        private static string ResolveFontAssetPath(Component component, string propertyPath)
        {
            try
            {
                using (var so = new SerializedObject(component))
                {
                    SerializedProperty prop = so.FindProperty(propertyPath);
                    if (prop != null &&
                        prop.propertyType == SerializedPropertyType.ObjectReference &&
                        prop.objectReferenceValue != null)
                    {
                        return AssetDatabase.GetAssetPath(prop.objectReferenceValue);
                    }
                }
            }
            catch
            {
                // Fall through to null — caller has API fallbacks.
            }
            return null;
        }

        private static object GetPropertyValue(Component target, Type type, string propertyName)
        {
            PropertyInfo prop = type.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanRead)
                return null;
            try { return prop.GetValue(target, null); }
            catch { return null; }
        }

        private static Type ResolveTmpTextType()
        {
            Type t = Type.GetType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            if (t != null) return t;

            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                t = asm.GetType("TMPro.TextMeshProUGUI");
                if (t != null) return t;
            }
            return null;
        }

        private static JObject ColorJ(Color c) => new JObject
        {
            ["r"] = c.r, ["g"] = c.g, ["b"] = c.b, ["a"] = c.a
        };

        private static JToken AnchorJ(RectTransform rt)
        {
            if (rt == null) return JValue.CreateNull();
            return new JObject
            {
                ["min"] = new JObject { ["x"] = rt.anchorMin.x, ["y"] = rt.anchorMin.y },
                ["max"] = new JObject { ["x"] = rt.anchorMax.x, ["y"] = rt.anchorMax.y },
                ["pivot"] = new JObject { ["x"] = rt.pivot.x, ["y"] = rt.pivot.y },
                ["anchoredPosition"] = new JObject { ["x"] = rt.anchoredPosition.x, ["y"] = rt.anchoredPosition.y }
            };
        }

        private static JToken NullableString(string s) =>
            string.IsNullOrEmpty(s) ? (JToken)JValue.CreateNull() : s;
    }
}
