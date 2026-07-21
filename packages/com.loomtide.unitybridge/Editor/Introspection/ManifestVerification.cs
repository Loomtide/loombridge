using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Game-agnostic verification that a scene contains the assets a contract requires, with
    /// no leftover placeholders. The contract is a list of entries — each names an object (or
    /// a name regex) and its expected type (GameObject / Sprite / Prefab) with optional
    /// minCount/required. The gate reports what's missing, what's still a placeholder, and any
    /// extras (a warning by default). This turns the asset-prepare report + mock manifest into
    /// a machine-checkable build gate.
    /// </summary>
    public static class ManifestVerification
    {
        public static JObject Verify(JObject parameters)
        {
            JArray manifest = ResolveManifest(parameters);

            // matching: how a manifest 'name' resolves to scene objects.
            JObject matching = parameters.Value<JObject>("matching");
            string matchMode = (matching?.Value<string>("mode") ?? "exact").ToLowerInvariant();
            bool caseSensitive = matching?.Value<bool?>("caseSensitive") ?? false;
            if (matchMode != "exact" && matchMode != "prefix" && matchMode != "regex")
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Invalid matching.mode: '{matchMode}'. Expected exact, prefix, or regex.");

            // placeholderRule: how a placeholder is detected.
            JObject placeholderRule = parameters.Value<JObject>("placeholderRule");
            string nameSubstring = placeholderRule?.Value<string>("nameSubstring") ?? "placeholder";
            string folder = placeholderRule?.Value<string>("assetPathFolder");

            bool extrasAsFailure = parameters.Value<bool?>("extrasAsFailure") ?? false;

            // Gather all scene GameObjects (active + inactive) for matching.
            List<GameObject> allObjects = CollectSceneObjects();

            var missing = new JArray();
            var placeholders = new JArray();
            var matchedObjectIds = new HashSet<long>();

            foreach (JToken entryTok in manifest)
            {
                JObject entry = entryTok as JObject;
                if (entry == null) continue;

                string name = entry.Value<string>("name");
                string nameRegex = entry.Value<string>("nameRegex");
                string type = entry.Value<string>("type") ?? "GameObject";
                int minCount = entry.Value<int?>("minCount") ?? 1;
                bool required = entry.Value<bool?>("required") ?? true;
                string label = name ?? nameRegex ?? "<unnamed>";

                List<GameObject> matches = MatchObjects(allObjects, name, nameRegex, matchMode, caseSensitive);
                foreach (GameObject m in matches)
                    matchedObjectIds.Add(EntityIdCompat.Id(m));

                int found = matches.Count;
                if (found < minCount && required)
                {
                    missing.Add(new JObject
                    {
                        ["name"] = label,
                        ["type"] = type,
                        ["expectedMinCount"] = minCount,
                        ["foundCount"] = found,
                        ["reason"] = found == 0 ? "no matching object in scene" : "fewer than minCount"
                    });
                }

                // Placeholder check on the matched objects' sprites.
                foreach (GameObject m in matches)
                {
                    if (TryDetectPlaceholder(m, nameSubstring, folder, out string reason, out string spriteName, out string assetPath))
                    {
                        placeholders.Add(new JObject
                        {
                            ["locator"] = LocatorResolver.BuildLocator(m),
                            ["name"] = m.name,
                            ["manifestName"] = label,
                            ["spriteName"] = NullableString(spriteName),
                            ["assetPath"] = NullableString(assetPath),
                            ["reason"] = reason
                        });
                    }
                }
            }

            // Extras: any scene object whose sprite is a placeholder but which matched no
            // manifest entry, plus (informationally) scene roots not referenced. We keep
            // 'extras' focused on placeholder leftovers that no manifest entry covers — the
            // common "leftover placeholder" symptom — to stay game-agnostic.
            var extras = new JArray();
            foreach (GameObject go in allObjects)
            {
                if (matchedObjectIds.Contains(EntityIdCompat.Id(go)))
                    continue;
                if (TryDetectPlaceholder(go, nameSubstring, folder, out string reason, out string spriteName, out string assetPath))
                {
                    extras.Add(new JObject
                    {
                        ["locator"] = LocatorResolver.BuildLocator(go),
                        ["name"] = go.name,
                        ["spriteName"] = NullableString(spriteName),
                        ["assetPath"] = NullableString(assetPath),
                        ["reason"] = "unmatched placeholder object: " + reason
                    });
                }
            }

            bool allOk = missing.Count == 0 && placeholders.Count == 0 &&
                         (!extrasAsFailure || extras.Count == 0);

            return new JObject
            {
                ["missing"] = missing,
                ["placeholders"] = placeholders,
                ["extras"] = extras,
                ["extrasAsFailure"] = extrasAsFailure,
                ["all_ok"] = allOk
            };
        }

        // ─────────────────────────────────────────────
        // Manifest resolution (inline OR file path)
        // ─────────────────────────────────────────────

        private static JArray ResolveManifest(JObject parameters)
        {
            JArray inline = parameters.Value<JArray>("manifest");
            if (inline != null)
                return inline;

            string path = parameters.Value<string>("manifestPath");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide either 'manifest' (inline array) or 'manifestPath' (JSON file path).");

            if (!File.Exists(path))
                throw new BridgeException(ErrorCodes.NOT_FOUND, $"manifestPath not found: '{path}'.");

            string json;
            try { json = File.ReadAllText(path); }
            catch (Exception ex)
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND, $"Failed to read manifestPath '{path}': {ex.Message}", ex);
            }

            JToken parsed;
            try { parsed = JToken.Parse(json); }
            catch (Exception ex)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, $"manifestPath JSON parse failed: {ex.Message}", ex);
            }

            // Accept either a bare array or an object with a "manifest" / "assets" array.
            if (parsed is JArray arr) return arr;
            if (parsed is JObject obj)
            {
                JArray m = obj.Value<JArray>("manifest") ?? obj.Value<JArray>("assets");
                if (m != null) return m;
            }
            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                "manifestPath must contain a JSON array, or an object with a 'manifest'/'assets' array.");
        }

        // ─────────────────────────────────────────────
        // Scene matching
        // ─────────────────────────────────────────────

        private static List<GameObject> CollectSceneObjects()
        {
            var objects = new List<GameObject>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (Transform t in root.GetComponentsInChildren<Transform>(true))
                        objects.Add(t.gameObject);
                }
            }
            return objects;
        }

        private static List<GameObject> MatchObjects(List<GameObject> all, string name, string nameRegex,
            string matchMode, bool caseSensitive)
        {
            var matches = new List<GameObject>();
            StringComparison cmp = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;

            Regex regex = null;
            string pattern = nameRegex ?? (matchMode == "regex" ? name : null);
            if (pattern != null)
            {
                var options = caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase;
                try { regex = new Regex(pattern, options); }
                catch (Exception ex)
                {
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, $"Invalid nameRegex '{pattern}': {ex.Message}", ex);
                }
            }

            foreach (GameObject go in all)
            {
                bool hit;
                if (regex != null)
                {
                    hit = regex.IsMatch(go.name);
                }
                else if (matchMode == "prefix")
                {
                    hit = name != null && go.name.StartsWith(name, cmp);
                }
                else // exact
                {
                    hit = name != null && string.Equals(go.name, name, cmp);
                }

                if (hit)
                    matches.Add(go);
            }
            return matches;
        }

        // ─────────────────────────────────────────────
        // Placeholder detection
        // ─────────────────────────────────────────────

        private static bool TryDetectPlaceholder(GameObject go, string nameSubstring, string folder,
            out string reason, out string spriteName, out string assetPath)
        {
            reason = null;
            spriteName = null;
            assetPath = null;

            SpriteRenderer sr = go.GetComponent<SpriteRenderer>();
            Sprite sprite = sr != null ? sr.sprite : null;
            if (sprite == null)
            {
                // Also consider a UI Image sprite.
                UnityEngine.UI.Image img = go.GetComponent<UnityEngine.UI.Image>();
                sprite = img != null ? img.sprite : null;
            }
            if (sprite == null)
                return false;

            spriteName = sprite.name;
            assetPath = AssetDatabase.GetAssetPath(sprite);

            if (!string.IsNullOrEmpty(nameSubstring) &&
                spriteName.IndexOf(nameSubstring, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                reason = $"sprite name contains '{nameSubstring}'";
                return true;
            }

            if (!string.IsNullOrEmpty(folder) && !string.IsNullOrEmpty(assetPath) &&
                assetPath.IndexOf(folder, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                reason = $"asset path under placeholder folder '{folder}'";
                return true;
            }

            return false;
        }

        private static JToken NullableString(string s) =>
            string.IsNullOrEmpty(s) ? (JToken)JValue.CreateNull() : s;
    }
}
