using System.Collections.Generic;
using UnityEngine;

namespace UnityBridge.Runtime
{
    /// <summary>
    /// Resolves a "/A/B[index]/C" hierarchy path to a live GameObject from inside the
    /// RUNTIME assembly.
    ///
    /// WHY IT EXISTS HERE. The Editor's <c>LocatorResolver</c> lives behind a
    /// UnityEditor reference this assembly must not take, and the pumps in this
    /// assembly resolve objects INSIDE the game loop (a recorder samples every
    /// Update; there is no editor tick to defer to). The path grammar is the same one
    /// <c>InputObserverRuntimePump.BuildRuntimePath</c> emits and the Editor resolver
    /// parses: segments split on '/', an optional "[n]" suffix selecting the n-th
    /// same-named sibling, and a root matched across ALL loaded scenes (no scene pin,
    /// which is strictly more robust for a multi-scene game).
    ///
    /// KEEP IN SYNC with LocatorResolver.ResolveByPath and with the observer's
    /// BuildRuntimePath: the same grammar in three places, guarded by
    /// InputObserverPathTests (observer path resolves back through the Editor
    /// resolver) and PlayStateRecorderTests (this resolver finds what the observer
    /// path names).
    /// </summary>
    public static class RuntimePathResolver
    {
        /// <summary>The GameObject at <paramref name="path"/>, or null when any segment misses.</summary>
        public static GameObject Resolve(string path)
        {
            if (string.IsNullOrEmpty(path))
                return null;

            // A caller may pass a scene-qualified "Scene:/A/B": the scene half is
            // dropped here (roots are searched across every loaded scene anyway), so a
            // locator written either way resolves the same object.
            int colon = path.IndexOf(":/");
            if (colon >= 0)
                path = path.Substring(colon + 1);

            var segments = new List<string>();
            foreach (string raw in path.Split('/'))
            {
                if (!string.IsNullOrEmpty(raw))
                    segments.Add(raw);
            }
            if (segments.Count == 0)
                return null;

            ParseSegment(segments[0], out string rootName, out int rootIndex);
            GameObject current = FindSceneRoot(rootName, rootIndex);
            if (current == null)
                return null;

            for (int i = 1; i < segments.Count; i++)
            {
                ParseSegment(segments[i], out string childName, out int childIndex);
                GameObject next = FindChild(current.transform, childName, childIndex);
                if (next == null)
                    return null;
                current = next;
            }
            return current;
        }

        /// <summary>Split "Name[2]" into its name and index (index 0 when no suffix).</summary>
        public static void ParseSegment(string segment, out string name, out int index)
        {
            name = segment;
            index = 0;
            int open = segment.LastIndexOf('[');
            if (open > 0 && segment.EndsWith("]"))
            {
                string inner = segment.Substring(open + 1, segment.Length - open - 2);
                if (int.TryParse(inner, out int parsed) && parsed >= 0)
                {
                    name = segment.Substring(0, open);
                    index = parsed;
                }
            }
        }

        /// <summary>The index-th root GameObject with this name across all loaded scenes, or null.</summary>
        public static GameObject FindSceneRoot(string name, int index)
        {
            int seen = 0;
            for (int s = 0; s < UnityEngine.SceneManagement.SceneManager.sceneCount; s++)
            {
                UnityEngine.SceneManagement.Scene scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(s);
                if (!scene.IsValid() || !scene.isLoaded)
                    continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    if (root.name == name)
                    {
                        if (seen == index)
                            return root;
                        seen++;
                    }
                }
            }
            return null;
        }

        /// <summary>The index-th direct child with this name under the parent, or null.</summary>
        public static GameObject FindChild(Transform parent, string name, int index)
        {
            int seen = 0;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform child = parent.GetChild(i);
                if (child.gameObject.name == name)
                {
                    if (seen == index)
                        return child.gameObject;
                    seen++;
                }
            }
            return null;
        }
    }
}
