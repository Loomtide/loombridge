using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Scans serialized ObjectReference properties across the loaded scenes to answer two
    /// reference-integrity questions and to drive reference remapping on a destructive prefab swap.
    ///
    /// Motivating incident (art-integration dogfood): <c>asset.replace_with_prefab</c> DESTROYS the
    /// replaced GameObject's ENTIRE hierarchy, which silently NULLs every EXTERNAL serialized
    /// reference that pointed at it, at any of its components, OR at any of its DESCENDANTS
    /// (a minimap's cached extract-point ref pointed at a transform under the beacon). Nothing surfaced
    /// the break until a human noticed the minimap marker was dead. These scans let a caller
    /// (a) find those references BEFORE a destructive swap, (b) audit null/severed refs, and
    /// (c) re-point survivors AFTER instantiating the replacement.
    ///
    /// SCAN SURFACE == DESTROY SURFACE: a reference matches when the referenced object's transform
    /// IsChildOf(target.transform) — Unity's IsChildOf includes the target itself — so everything
    /// the destroy would sever is found, root and descendants alike. Each hit carries the
    /// referenced object's RELATIVE path under the target ("" for the root), which is how the
    /// remap resolves the corresponding child on the replacement instance.
    ///
    /// Determinism: iterates scenes in <see cref="SceneManager"/> order, root objects in scene
    /// root order, components in <c>GetComponentsInChildren</c> order, and each component's
    /// SerializedObject in <c>NextVisible</c> order. The standalone scan ops are bounded by a
    /// maxResults cap and report truncation; the remap scan is deliberately UNBOUNDED (a capped
    /// remap would silently miss references — the destroy surface must be fully known).
    /// Read-only except for the explicit remap path in AssetHandler, which is Undo-recorded.
    /// </summary>
    public static class ReferenceScanner
    {
        /// <summary>Default cap for the standalone scan ops; bounded so a large scene can't blow up a response.</summary>
        public const int DefaultMaxResults = 500;

        /// <summary>
        /// A found reference: a serialized ObjectReference property on
        /// <see cref="ReferencingComponent"/> that points at a scan target GameObject, one of its
        /// components, or a descendant (or a descendant's component). Types are carried as
        /// <see cref="Type"/> (editor-only) so the remap path can match components on the
        /// replacement by type + index; the JSON layer reports the type Name.
        /// </summary>
        public struct ReferenceHit
        {
            public Component ReferencingComponent;
            public Type ReferencingComponentType;
            public int ReferencingComponentIndex;   // index among same-type components on the referencing GameObject
            public string PropertyPath;
            public bool ReferencesGameObject;        // true = points at a GameObject (target root or a descendant)
            public Type ReferencedComponentType;     // null when ReferencesGameObject; else the referenced component type
            public int ReferencedComponentIndex;     // index among same-type components on the referenced GameObject
            public string RelativePath;              // path of the referenced GameObject under the target: "" = the root itself
        }

        /// <summary>A null (never-assigned) or severed (Missing) serialized ObjectReference property.</summary>
        public struct NullReferenceHit
        {
            public Component Component;
            public int ComponentIndex;
            public string PropertyPath;
            public bool Missing;                     // value is null but instanceID != 0 → a severed/broken ref
            public bool HasPrefabSourceValue;        // only computed when includePrefabDefaults: prefab source had a value here
        }

        // ─────────────────────────────────────────────
        // scene.find_references_to
        // ─────────────────────────────────────────────

        /// <summary>
        /// Scan ALL components in loaded scenes for serialized ObjectReference properties that point
        /// at <paramref name="target"/>, at any Component on it, or at ANY DESCENDANT (or a
        /// descendant's component) — the full surface a destructive swap would sever. Includes
        /// internal references (a component inside the target's hierarchy referencing a sibling).
        /// Ordered + bounded.
        /// </summary>
        public static List<ReferenceHit> ScanReferencesTo(GameObject target, int maxResults, out bool truncated)
        {
            truncated = false;
            var hits = new List<ReferenceHit>();
            if (target == null)
                return hits;

            Transform targetTransform = target.transform;

            foreach (Component component in EnumerateAllComponents())
            {
                // A missing script serializes as a null component; skip it (can't read its refs).
                if (component == null)
                    continue;

                using (var so = new SerializedObject(component))
                {
                    SerializedProperty it = so.GetIterator();
                    // enterChildren:true visits nested/struct/array elements too, so a reference held
                    // inside a List<T>/[] or a nested serialized struct is not missed.
                    while (it.NextVisible(true))
                    {
                        if (it.propertyType != SerializedPropertyType.ObjectReference)
                            continue;

                        UnityEngine.Object refObj = it.objectReferenceValue;
                        if (refObj == null)
                            continue;

                        // Resolve the referenced scene object's transform (GameObject or Component);
                        // pure asset references (materials, sprites, …) have no scene transform.
                        GameObject refGo = refObj as GameObject;
                        Component refComp = refObj as Component;
                        Transform refTransform = refGo != null ? refGo.transform
                            : refComp != null ? refComp.transform
                            : null;
                        if (refTransform == null)
                            continue;

                        // IsChildOf includes the transform itself → matches root AND descendants,
                        // i.e. exactly what Undo.DestroyObjectImmediate(target) severs.
                        if (!refTransform.IsChildOf(targetTransform))
                            continue;

                        var hit = new ReferenceHit
                        {
                            ReferencingComponent = component,
                            ReferencingComponentType = component.GetType(),
                            ReferencingComponentIndex = ComponentIndexOn(component.gameObject, component),
                            PropertyPath = it.propertyPath,
                            ReferencesGameObject = refGo != null,
                            RelativePath = RelativePathFromTo(targetTransform, refTransform),
                        };
                        if (refComp != null)
                        {
                            hit.ReferencedComponentType = refComp.GetType();
                            hit.ReferencedComponentIndex = ComponentIndexOn(refComp.gameObject, refComp);
                        }

                        hits.Add(hit);
                        if (hits.Count >= maxResults)
                        {
                            truncated = true;
                            return hits;
                        }
                    }
                }
            }

            return hits;
        }

        /// <summary>
        /// Like <see cref="ScanReferencesTo"/> but EXCLUDES references held by the target's own
        /// hierarchy (a component on the target or a descendant). Those die WITH the target on a
        /// destructive swap by design, so they are not candidates for remap — only external
        /// references (which would otherwise be silently nulled) are.
        ///
        /// UNBOUNDED on purpose: this feeds the remap path, and a capped scan would silently drop
        /// references — the destroy surface must be fully known. Cost is one SerializedObject
        /// iteration pass over every component in the loaded scenes per replaced source.
        /// </summary>
        public static List<ReferenceHit> ScanExternalReferencesTo(GameObject target)
        {
            List<ReferenceHit> all = ScanReferencesTo(target, int.MaxValue, out _);
            var external = new List<ReferenceHit>(all.Count);
            foreach (var hit in all)
            {
                if (hit.ReferencingComponent == null)
                    continue;
                Transform t = hit.ReferencingComponent.transform;
                // Internal = the referencing component lives on the target or one of its descendants.
                if (t.IsChildOf(target.transform))
                    continue;
                external.Add(hit);
            }
            return external;
        }

        /// <summary>
        /// Build the scene.find_references_to result JObject for <paramref name="target"/>.
        /// Shape: { target, references: [ { referencing: { locator, scene_path, component,
        /// component_index }, property_path, relative_path, references: "gameobject"|"&lt;ComponentType&gt;" } ],
        /// count, truncated }.
        /// </summary>
        public static JObject BuildFindReferencesResult(GameObject target, int maxResults)
        {
            List<ReferenceHit> hits = ScanReferencesTo(target, maxResults, out bool truncated);
            var arr = new JArray();
            foreach (var hit in hits)
                arr.Add(ReferenceHitToJson(hit));

            return new JObject
            {
                ["target"] = LocatorResolver.BuildLocator(target),
                ["references"] = arr,
                ["count"] = arr.Count,
                ["truncated"] = truncated,
            };
        }

        /// <summary>
        /// JSON for a single reference hit: referencing side (locator + scene_path + component
        /// type/index), the property path, the referenced object's relative_path under the target
        /// ("" = the target root itself), and what it points at (the GameObject or a component type).
        /// </summary>
        public static JObject ReferenceHitToJson(ReferenceHit hit)
        {
            GameObject referencingGo = hit.ReferencingComponent != null ? hit.ReferencingComponent.gameObject : null;
            JObject referencing = new JObject
            {
                ["locator"] = referencingGo != null ? LocatorResolver.BuildLocator(referencingGo) : null,
                ["scene_path"] = referencingGo != null ? DescribeScenePath(referencingGo.scene) : null,
                ["component"] = hit.ReferencingComponentType?.Name,
                ["component_index"] = hit.ReferencingComponentIndex,
            };
            return new JObject
            {
                ["referencing"] = referencing,
                ["property_path"] = hit.PropertyPath,
                ["relative_path"] = hit.RelativePath ?? "",
                ["references"] = hit.ReferencesGameObject ? "gameobject" : hit.ReferencedComponentType?.Name,
            };
        }

        // ─────────────────────────────────────────────
        // scene.validate_references
        // ─────────────────────────────────────────────

        /// <summary>
        /// Build the scene.validate_references result JObject: every NULL serialized ObjectReference
        /// property in scope (a subtree, or ALL loaded scenes when scope is null), grouped-by-component
        /// via deterministic ordering. Honest + simple — a reference is reported purely because it is
        /// null; there is no heuristic that guesses intent beyond nullness. A severed reference (value
        /// null but instanceID != 0, i.e. a Unity "Missing" ref — exactly what a destructive swap
        /// leaves behind) is flagged with missing:true.
        ///
        /// includePrefabDefaults (default false) is the simple mode; when true, each entry is
        /// additionally annotated with prefab_source_non_null, i.e. whether the component's prefab
        /// source had a value at that property (a strong signal the instance override nulled a
        /// reference that the prefab intended to be wired).
        /// </summary>
        public static JObject BuildValidateReferencesResult(GameObject scope, bool includePrefabDefaults, int maxResults)
        {
            var hits = new List<NullReferenceHit>();
            bool truncated = false;

            IEnumerable<Component> components = scope != null
                ? EnumerateComponentsUnder(scope)
                : EnumerateAllComponents();

            foreach (Component component in components)
            {
                if (component == null)
                    continue;

                using (var so = new SerializedObject(component))
                {
                    SerializedProperty it = so.GetIterator();
                    while (it.NextVisible(true))
                    {
                        if (it.propertyType != SerializedPropertyType.ObjectReference)
                            continue;
                        if (it.objectReferenceValue != null)
                            continue;

                        var hit = new NullReferenceHit
                        {
                            Component = component,
                            ComponentIndex = ComponentIndexOn(component.gameObject, component),
                            PropertyPath = it.propertyPath,
                            Missing = EntityIdCompat.ObjectRefId(it) != 0,
                        };
                        if (includePrefabDefaults)
                            hit.HasPrefabSourceValue = PrefabSourceHasValue(component, it.propertyPath);

                        hits.Add(hit);
                        if (hits.Count >= maxResults)
                        {
                            truncated = true;
                            break;
                        }
                    }
                }

                if (truncated)
                    break;
            }

            var arr = new JArray();
            foreach (var hit in hits)
            {
                var entry = new JObject
                {
                    ["object"] = hit.Component != null ? LocatorResolver.BuildLocator(hit.Component.gameObject) : null,
                    ["component"] = hit.Component != null ? hit.Component.GetType().Name : null,
                    ["component_index"] = hit.ComponentIndex,
                    ["property_path"] = hit.PropertyPath,
                    ["missing"] = hit.Missing,
                };
                if (includePrefabDefaults)
                    entry["prefab_source_non_null"] = hit.HasPrefabSourceValue;
                arr.Add(entry);
            }

            return new JObject
            {
                ["scope"] = scope != null ? LocatorResolver.BuildLocator(scope) : null,
                ["include_prefab_defaults"] = includePrefabDefaults,
                ["null_references"] = arr,
                ["count"] = arr.Count,
                ["truncated"] = truncated,
            };
        }

        private static bool PrefabSourceHasValue(Component component, string propertyPath)
        {
            Component source = PrefabUtility.GetCorrespondingObjectFromSource(component);
            if (source == null)
                return false;
            using (var so = new SerializedObject(source))
            {
                SerializedProperty prop = so.FindProperty(propertyPath);
                return prop != null
                    && prop.propertyType == SerializedPropertyType.ObjectReference
                    && prop.objectReferenceValue != null;
            }
        }

        // ─────────────────────────────────────────────
        // Relative path (target root → referenced descendant)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Path of <paramref name="node"/> under <paramref name="root"/>: "" when node IS root,
        /// otherwise "Child/GrandChild" with a "[index]" suffix on any segment whose name collides
        /// among same-named siblings (index among same-named siblings, matching LocatorResolver's
        /// path convention so paths stay unambiguous and deterministic).
        /// </summary>
        public static string RelativePathFromTo(Transform root, Transform node)
        {
            if (node == root)
                return "";

            var segments = new List<string>();
            Transform current = node;
            while (current != null && current != root)
            {
                segments.Add(SegmentFor(current));
                current = current.parent;
            }
            if (current != root)
                return null; // node is not under root (callers guarantee it is; defensive)

            segments.Reverse();
            return string.Join("/", segments);
        }

        /// <summary>
        /// Resolve a <see cref="RelativePathFromTo"/>-style path under <paramref name="root"/>.
        /// "" (or null) resolves to root itself; a missing segment returns null. Handles the
        /// "Name[index]" disambiguation suffix (index among same-named siblings).
        /// </summary>
        public static Transform ResolveRelativePath(Transform root, string relativePath)
        {
            if (root == null)
                return null;
            if (string.IsNullOrEmpty(relativePath))
                return root;

            Transform current = root;
            foreach (string segment in relativePath.Split('/'))
            {
                ParseSegment(segment, out string name, out int index);
                Transform next = null;
                int count = 0;
                for (int i = 0; i < current.childCount; i++)
                {
                    Transform child = current.GetChild(i);
                    if (child.name != name)
                        continue;
                    if (count == index)
                    {
                        next = child;
                        break;
                    }
                    count++;
                }
                if (next == null)
                    return null;
                current = next;
            }
            return current;
        }

        private static string SegmentFor(Transform node)
        {
            Transform parent = node.parent;
            if (parent == null)
                return node.name;

            int duplicateCount = 0;
            int myIndex = 0;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform sibling = parent.GetChild(i);
                if (sibling.name != node.name)
                    continue;
                if (sibling == node)
                    myIndex = duplicateCount;
                duplicateCount++;
            }
            return duplicateCount > 1 ? $"{node.name}[{myIndex}]" : node.name;
        }

        private static void ParseSegment(string segment, out string name, out int index)
        {
            name = segment;
            index = 0;
            int open = segment.LastIndexOf('[');
            if (open > 0 && segment.EndsWith("]"))
            {
                string idxStr = segment.Substring(open + 1, segment.Length - open - 2);
                if (int.TryParse(idxStr, out int parsed))
                {
                    name = segment.Substring(0, open);
                    index = parsed;
                }
            }
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        /// <summary>Scene asset path, falling back to the runtime name for an unsaved/untitled scene.</summary>
        public static string DescribeScenePath(Scene scene)
        {
            if (!scene.IsValid())
                return null;
            return string.IsNullOrEmpty(scene.path) ? scene.name : scene.path;
        }

        private static IEnumerable<Component> EnumerateAllComponents()
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded)
                    continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (Component c in root.GetComponentsInChildren<Component>(true))
                        yield return c;
                }
            }
        }

        private static IEnumerable<Component> EnumerateComponentsUnder(GameObject root)
        {
            foreach (Component c in root.GetComponentsInChildren<Component>(true))
                yield return c;
        }

        /// <summary>Index of <paramref name="component"/> among same-exact-type components on <paramref name="go"/>.</summary>
        private static int ComponentIndexOn(GameObject go, Component component)
        {
            Component[] same = go.GetComponents(component.GetType());
            for (int i = 0; i < same.Length; i++)
            {
                if (ReferenceEquals(same[i], component))
                    return i;
            }
            return 0;
        }
    }
}
