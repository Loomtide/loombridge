using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Captures the scene hierarchy as a JSON tree with locators and component info.
    /// </summary>
    public static class HierarchyCapture
    {
        /// <summary>
        /// Captures the full hierarchy of all loaded scenes.
        /// Each node includes name, locator, component types, and children.
        /// </summary>
        /// <param name="maxDepth">Maximum recursion depth. -1 for unlimited.</param>
        public static JObject CaptureHierarchy(int maxDepth = -1)
        {
            var scenesArray = new JArray();

            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded)
                    continue;

                var rootObjects = new JArray();
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    rootObjects.Add(BuildNode(root, 0, maxDepth));
                }

                scenesArray.Add(new JObject
                {
                    ["name"] = scene.name,
                    ["rootObjects"] = rootObjects
                });
            }

            return new JObject { ["scenes"] = scenesArray };
        }

        private static JObject BuildNode(GameObject go, int currentDepth, int maxDepth)
        {
            // Build component type names
            var components = new JArray();
            foreach (Component comp in go.GetComponents<Component>())
            {
                if (comp == null) continue; // Missing script
                components.Add(comp.GetType().Name);
            }

            var node = new JObject
            {
                ["name"] = go.name,
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["components"] = components
            };

            // Recurse into children (respect maxDepth)
            if (go.transform.childCount > 0 && (maxDepth < 0 || currentDepth < maxDepth))
            {
                var children = new JArray();
                for (int c = 0; c < go.transform.childCount; c++)
                {
                    children.Add(BuildNode(go.transform.GetChild(c).gameObject, currentDepth + 1, maxDepth));
                }
                node["children"] = children;
            }

            return node;
        }
    }
}
