using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Core
{
    /// <summary>
    /// Resolves GameObjects from locator JObjects (globalObjectId, path+scene, or object_id).
    /// Builds locator JObjects from GameObjects for wire protocol responses.
    /// </summary>
    public static class LocatorResolver
    {
        private static readonly Regex SegmentPattern = new Regex(@"^(.+?)\[(\d+)\]$");

        /// <summary>
        /// Resolves a GameObject from a locator JObject.
        /// Priority: globalObjectId > path+scene > object_id (legacy).
        /// Throws BridgeException(LOCATOR_UNRESOLVED) if resolution fails.
        /// </summary>
        public static GameObject Resolve(JObject locator)
        {
            if (locator == null)
                throw new BridgeException(ErrorCodes.LOCATOR_UNRESOLVED, "Locator is null.");

            // Priority 1: globalObjectId
            string globalId = locator.Value<string>("globalObjectId");
            if (!string.IsNullOrEmpty(globalId))
            {
                if (GlobalObjectId.TryParse(globalId, out GlobalObjectId gid))
                {
                    var obj = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(gid);
                    if (obj is GameObject go)
                        return go;
                    if (obj is Component comp)
                        return comp.gameObject;
                }
                // Fall through to other methods if globalObjectId parse failed
            }

            // Priority 2: path + scene
            string path = locator.Value<string>("path");
            string sceneName = locator.Value<string>("scene");
            if (!string.IsNullOrEmpty(path))
            {
                GameObject resolved = ResolveByPath(sceneName, path);
                if (resolved != null)
                    return resolved;
            }

            // Priority 3: object_id / instanceId (legacy)
            long? instanceId = locator.Value<long?>("instanceId") ?? locator.Value<long?>("object_id");
            if (instanceId.HasValue)
            {
                var obj = EntityIdCompat.ToObject(instanceId.Value);
                if (obj is GameObject go)
                    return go;
                if (obj is Component comp)
                    return comp.gameObject;
            }

            // All methods failed
            string locatorStr = locator.ToString(Newtonsoft.Json.Formatting.None);
            throw new BridgeException(ErrorCodes.LOCATOR_UNRESOLVED,
                $"Could not resolve locator: {locatorStr}");
        }

        /// <summary>
        /// Builds a locator JObject for the given GameObject.
        /// Includes scene, path (with sibling index), instanceId, and globalObjectId.
        /// </summary>
        public static JObject BuildLocator(GameObject go)
        {
            if (go == null)
                return null;

            string globalObjectId = "";
            try
            {
                GlobalObjectId gid = GlobalObjectId.GetGlobalObjectIdSlow(go);
                globalObjectId = gid.ToString();
            }
            catch
            {
                // GlobalObjectId may not be available for runtime-created objects
            }

            return new JObject
            {
                ["scene"] = go.scene.IsValid() ? go.scene.name : "",
                ["path"] = GetHierarchyPathWithIndex(go),
                ["instanceId"] = EntityIdCompat.Id(go),
                ["globalObjectId"] = globalObjectId
            };
        }

        // ─────────────────────────────────────────────
        // Path Resolution
        // ─────────────────────────────────────────────

        /// <summary>
        /// Resolves a GameObject by its hierarchy path within an optional scene.
        /// Path format: "/Root/Child/GrandChild" or "/Root/Enemy[2]/Weapon"
        /// </summary>
        private static GameObject ResolveByPath(string sceneName, string path)
        {
            if (string.IsNullOrEmpty(path))
                return null;

            // Strip leading slash
            if (path.StartsWith("/"))
                path = path.Substring(1);

            string[] segments = path.Split('/');
            if (segments.Length == 0)
                return null;

            // Find root objects in the target scene (or all scenes)
            List<GameObject> roots = new List<GameObject>();

            if (!string.IsNullOrEmpty(sceneName))
            {
                Scene scene = SceneManager.GetSceneByName(sceneName);
                if (scene.IsValid() && scene.isLoaded)
                {
                    roots.AddRange(scene.GetRootGameObjects());
                }
            }
            else
            {
                // Search all loaded scenes
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    Scene scene = SceneManager.GetSceneAt(i);
                    if (scene.isLoaded)
                        roots.AddRange(scene.GetRootGameObjects());
                }
            }

            // Resolve first segment among roots
            var (firstName, firstIndex) = ParseSegment(segments[0]);
            GameObject current = FindByNameAndIndex(roots, firstName, firstIndex);
            if (current == null)
                return null;

            // Resolve remaining segments
            for (int s = 1; s < segments.Length; s++)
            {
                var (name, index) = ParseSegment(segments[s]);

                List<GameObject> children = new List<GameObject>();
                for (int c = 0; c < current.transform.childCount; c++)
                {
                    children.Add(current.transform.GetChild(c).gameObject);
                }

                current = FindByNameAndIndex(children, name, index);
                if (current == null)
                    return null;
            }

            return current;
        }

        /// <summary>
        /// Parses a path segment like "Enemy[2]" into ("Enemy", 2) or "Player" into ("Player", 0).
        /// </summary>
        private static (string name, int index) ParseSegment(string segment)
        {
            Match match = SegmentPattern.Match(segment);
            if (match.Success)
            {
                return (match.Groups[1].Value, int.Parse(match.Groups[2].Value));
            }
            return (segment, 0);
        }

        /// <summary>
        /// Finds a GameObject by name and sibling index among a collection.
        /// Index 0 means the first object with that name, 1 means the second, etc.
        /// </summary>
        private static GameObject FindByNameAndIndex(IEnumerable<GameObject> objects, string name, int index)
        {
            int count = 0;
            foreach (var go in objects)
            {
                if (go.name == name)
                {
                    if (count == index)
                        return go;
                    count++;
                }
            }
            return null;
        }

        // ─────────────────────────────────────────────
        // Path Building
        // ─────────────────────────────────────────────

        /// <summary>
        /// Builds a hierarchy path with sibling indices for disambiguation.
        /// Format: "/Root/Child/Enemy[2]" (index only added when siblings share names).
        /// KEEP IN SYNC with the runtime clone
        /// <c>InputObserverRuntimePump.BuildRuntimePath</c> (the observer resolves paths at
        /// gesture time in its own assembly): both must emit byte-identical paths so this
        /// resolver round-trips them. Guarded by <c>InputObserverPathTests</c>.
        /// </summary>
        private static string GetHierarchyPathWithIndex(GameObject go)
        {
            var segments = new List<string>();

            Transform current = go.transform;
            while (current != null)
            {
                string segment = current.gameObject.name;

                Transform parent = current.parent;
                int duplicateCount = 0;
                int myIndex = 0;

                if (parent != null)
                {
                    // Check siblings under same parent
                    for (int i = 0; i < parent.childCount; i++)
                    {
                        Transform sibling = parent.GetChild(i);
                        if (sibling.gameObject.name == current.gameObject.name)
                        {
                            if (sibling == current)
                                myIndex = duplicateCount;
                            duplicateCount++;
                        }
                    }
                }
                else
                {
                    // Root objects — check among scene root objects
                    if (current.gameObject.scene.IsValid())
                    {
                        GameObject[] roots = current.gameObject.scene.GetRootGameObjects();
                        foreach (var root in roots)
                        {
                            if (root.name == current.gameObject.name)
                            {
                                if (root == current.gameObject)
                                    myIndex = duplicateCount;
                                duplicateCount++;
                            }
                        }
                    }
                }

                if (duplicateCount > 1)
                    segment = $"{segment}[{myIndex}]";

                segments.Add(segment);
                current = current.parent;
            }

            segments.Reverse();
            return "/" + string.Join("/", segments);
        }
    }
}
