using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Resolves user-provided friendly property names to actual SerializedProperty paths.
    /// Supports exact match, display name match, and camelCase matching.
    /// </summary>
    public static class FriendlyNameResolver
    {
        /// <summary>
        /// Friendly/API → serialized-property-path aliases for fields the SerializedObject
        /// iterator either hides (m_Enabled) or surfaces under a propertyPath that no longer
        /// looks like the C# member (Camera's "far clip plane" vs the `far` API property).
        /// RCL-T08: component.set_property{property_path:"enabled"} / "far" used to fail with
        /// "No property found" because NextVisible never yields m_Enabled and the Camera clip
        /// planes serialize under spaced names. Each candidate is only accepted when the target
        /// component actually HAS that serialized property (FindProperty != null), so a Camera-
        /// only alias is inert on a custom MonoBehaviour and never shadows a real field.
        /// Keys are lowercased; lookup is case-insensitive.
        /// </summary>
        private static readonly Dictionary<string, string[]> SerializedAliases =
            new Dictionary<string, string[]>
            {
                // Universal Behaviour/Renderer/Collider enable flag (hidden from NextVisible).
                ["enabled"] = new[] { "m_Enabled" },
                // Camera clip planes / projection (serialized under spaced display-style paths).
                ["far"] = new[] { "far clip plane" },
                ["farclipplane"] = new[] { "far clip plane" },
                ["near"] = new[] { "near clip plane" },
                ["nearclipplane"] = new[] { "near clip plane" },
                ["fieldofview"] = new[] { "field of view" },
                ["fov"] = new[] { "field of view" },
                ["orthographicsize"] = new[] { "orthographic size" },
                ["orthographic"] = new[] { "orthographic" },
                // Camera clear flags + background color use m_-prefixed serialized names.
                ["clearflags"] = new[] { "m_ClearFlags" },
                ["backgroundcolor"] = new[] { "m_BackGroundColor" },
                // RLH-W1: uGUI Text font/layout fields live under the nested m_FontData block,
                // so the C#-API names (Text.fontSize, Text.alignment, …) have no top-level
                // serialized property — the friendly alias maps each to its dotted serialized
                // path. so.FindProperty handles the dotted candidate directly, and the
                // FindProperty != null guard keeps every alias inert on a non-Text component
                // (a MonoBehaviour with no m_FontData never resolves these). TMP text is set
                // through ui.set_text_style, not these aliases (TMP serializes fields flat).
                ["fontsize"] = new[] { "m_FontData.m_FontSize" },
                ["fontstyle"] = new[] { "m_FontData.m_FontStyle" },
                ["alignment"] = new[] { "m_FontData.m_Alignment" },
                ["richtext"] = new[] { "m_FontData.m_RichText" },
                ["linespacing"] = new[] { "m_FontData.m_LineSpacing" },
                ["bestfit"] = new[] { "m_FontData.m_BestFit" },
                ["resizetextforbestfit"] = new[] { "m_FontData.m_BestFit" },
            };

        /// <summary>
        /// Given a user-provided property name, resolve to the actual serializedPath.
        /// Priority: exact serializedPath match, then friendly/API alias (e.g. enabled→m_Enabled,
        /// far→"far clip plane"), then displayName/camelCase fuzzy match.
        /// Throws BridgeException(INVALID_PARAMS) on zero matches.
        /// Throws BridgeException(AMBIGUOUS_PROPERTY) on multiple matches.
        /// </summary>
        public static string ResolvePropertyPath(Component component, string friendlyName)
        {
            if (string.IsNullOrEmpty(friendlyName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Property name cannot be null or empty.");

            // RLH-W1: a dotted request (m_FontData.m_FontSize, or friendly fontData.fontSize)
            // is resolved segment-by-segment so nested serialized fields are addressable. The
            // single-name path below is left byte-identical — the dotted branch never touches it.
            if (friendlyName.IndexOf('.') >= 0)
                return ResolveDottedPath(component, friendlyName);

            SerializedObject so = new SerializedObject(component);
            SerializedProperty iterator = so.GetIterator();
            bool enterChildren = true;

            // First pass: exact serializedPath match
            while (iterator.NextVisible(enterChildren))
            {
                enterChildren = false;
                if (iterator.propertyPath == friendlyName)
                {
                    string result = iterator.propertyPath;
                    so.Dispose();
                    return result;
                }
            }

            // Alias pass: map a known friendly/API name to its serialized path, but only when
            // the component actually exposes that serialized property (so Camera-only aliases
            // stay inert elsewhere). Runs before the fuzzy pass so a hidden/renamed field
            // (m_Enabled, "far clip plane") resolves deterministically.
            if (SerializedAliases.TryGetValue(friendlyName.ToLowerInvariant(), out string[] aliasCandidates))
            {
                foreach (string candidate in aliasCandidates)
                {
                    if (so.FindProperty(candidate) != null)
                    {
                        so.Dispose();
                        return candidate;
                    }
                }
            }

            // Second pass: display name match (case-insensitive) and camelCase match
            iterator = so.GetIterator();
            enterChildren = true;
            string friendlyLower = friendlyName.ToLowerInvariant();
            var candidates = new List<string>();

            while (iterator.NextVisible(enterChildren))
            {
                enterChildren = false;

                string displayLower = iterator.displayName.ToLowerInvariant();
                string pathLower = iterator.propertyPath.ToLowerInvariant();

                // Case-insensitive displayName match
                if (displayLower == friendlyLower)
                {
                    candidates.Add(iterator.propertyPath);
                    continue;
                }

                // camelCase match: convert displayName spaces to camelCase and compare
                string camelized = ToCamelCase(iterator.displayName);
                if (camelized.ToLowerInvariant() == friendlyLower)
                {
                    candidates.Add(iterator.propertyPath);
                    continue;
                }

                // Also try matching against propertyPath (case-insensitive)
                if (pathLower == friendlyLower)
                {
                    candidates.Add(iterator.propertyPath);
                }
            }

            so.Dispose();

            if (candidates.Count == 1)
                return candidates[0];

            if (candidates.Count == 0)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"No property found matching '{friendlyName}' on {component.GetType().Name}.");
            }

            // Multiple matches — ambiguous
            JArray candidatesJson = new JArray();
            foreach (string c in candidates)
                candidatesJson.Add(c);

            throw new BridgeException(ErrorCodes.AMBIGUOUS_PROPERTY,
                $"Ambiguous property '{friendlyName}' on {component.GetType().Name}. " +
                $"Candidates: {candidatesJson.ToString(Newtonsoft.Json.Formatting.None)}");
        }

        // Cap on how many sibling names an error message enumerates, so a component with
        // hundreds of serialized children still produces a bounded, readable message.
        private const int MaxListedChildren = 40;

        /// <summary>
        /// Resolve a dotted property request (e.g. "m_FontData.m_FontSize" or the friendly
        /// "fontData.fontSize") to a concrete serialized property path. Each segment is matched
        /// against the DIRECT children of the previously resolved property using the same
        /// exact/alias/displayName/camelCase rules as the single-name path. A fully-serialized
        /// dotted path resolves verbatim as a fast path. Throws INVALID_PARAMS naming the failing
        /// segment (and listing the available children of its parent) on a miss, and
        /// AMBIGUOUS_PROPERTY when a segment matches more than one child.
        /// </summary>
        private static string ResolveDottedPath(Component component, string dottedName)
        {
            SerializedObject so = new SerializedObject(component);
            try
            {
                // Fast path: a fully-serialized dotted path (m_FontData.m_FontSize) resolves as-is.
                if (so.FindProperty(dottedName) != null)
                    return dottedName;

                string[] segments = dottedName.Split('.');
                var resolved = new List<string>(segments.Length);
                SerializedProperty parent = null; // null == component root

                for (int i = 0; i < segments.Length; i++)
                {
                    string segment = segments[i];
                    if (string.IsNullOrEmpty(segment))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Empty segment in property path '{dottedName}' on {component.GetType().Name}.");

                    string relativeName = ResolveSegment(so, parent, segment, dottedName, i, component);
                    resolved.Add(relativeName);

                    parent = parent == null
                        ? so.FindProperty(relativeName)
                        : parent.FindPropertyRelative(relativeName);

                    if (parent == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Segment '{segment}' in path '{dottedName}' mapped to serialized name " +
                            $"'{relativeName}' but no such property exists on {component.GetType().Name}.");
                }

                return string.Join(".", resolved);
            }
            finally
            {
                so.Dispose();
            }
        }

        /// <summary>
        /// Match a single path segment against the direct children of <paramref name="parent"/>
        /// (or the component root when parent is null) and return the child's RELATIVE serialized
        /// name. Precedence: exact serialized name, then friendly alias, then displayName /
        /// camelCase / case-insensitive name.
        /// </summary>
        private static string ResolveSegment(
            SerializedObject so,
            SerializedProperty parent,
            string segment,
            string dottedName,
            int segmentIndex,
            Component component)
        {
            List<(string name, string display)> children = EnumerateDirectChildren(so, parent);

            // 1. Exact serialized (relative) name — deterministic, case-sensitive.
            foreach (var child in children)
            {
                if (child.name == segment)
                    return child.name;
            }

            // 2. Friendly alias whose target is a direct child of this parent (single-token aliases
            //    like "m_Enabled"; dotted aliases are handled by the single-name path, not here).
            if (SerializedAliases.TryGetValue(segment.ToLowerInvariant(), out string[] aliasCandidates))
            {
                foreach (string candidate in aliasCandidates)
                {
                    foreach (var child in children)
                    {
                        if (child.name == candidate)
                            return child.name;
                    }
                }
            }

            // 3. Fuzzy: displayName / camelCase(displayName) / case-insensitive serialized name.
            string segmentLower = segment.ToLowerInvariant();
            var matches = new List<string>();
            foreach (var child in children)
            {
                string displayLower = child.display.ToLowerInvariant();
                if (displayLower == segmentLower)
                {
                    matches.Add(child.name);
                    continue;
                }

                if (ToCamelCase(child.display).ToLowerInvariant() == segmentLower)
                {
                    matches.Add(child.name);
                    continue;
                }

                if (child.name.ToLowerInvariant() == segmentLower)
                    matches.Add(child.name);
            }

            if (matches.Count == 1)
                return matches[0];

            string parentDesc = parent == null
                ? $"{component.GetType().Name} (root)"
                : $"'{parent.propertyPath}'";

            if (matches.Count > 1)
            {
                JArray dup = new JArray();
                foreach (string m in matches)
                    dup.Add(m);
                throw new BridgeException(ErrorCodes.AMBIGUOUS_PROPERTY,
                    $"Ambiguous segment '{segment}' (index {segmentIndex}) in path '{dottedName}' under " +
                    $"{parentDesc}. Candidates: {dup.ToString(Newtonsoft.Json.Formatting.None)}");
            }

            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"No property matching segment '{segment}' (index {segmentIndex}) in path '{dottedName}' " +
                $"under {parentDesc}. Available children: {DescribeChildren(children)}");
        }

        /// <summary>
        /// Enumerate the DIRECT children (relative serialized name + display name) of a parent
        /// property, or the component's top-level visible properties when parent is null.
        /// </summary>
        private static List<(string name, string display)> EnumerateDirectChildren(
            SerializedObject so, SerializedProperty parent)
        {
            var result = new List<(string, string)>();

            if (parent == null)
            {
                SerializedProperty iterator = so.GetIterator();
                bool enterChildren = true;
                while (iterator.NextVisible(enterChildren))
                {
                    enterChildren = false; // top-level siblings only
                    result.Add((iterator.name, iterator.displayName));
                }
                return result;
            }

            SerializedProperty it = parent.Copy();
            SerializedProperty end = parent.GetEndProperty();
            bool enter = true;
            while (it.NextVisible(enter) && !SerializedProperty.EqualContents(it, end))
            {
                enter = false; // do not descend past direct children
                if (it.depth == parent.depth + 1)
                    result.Add((it.name, it.displayName));
            }
            return result;
        }

        private static string DescribeChildren(List<(string name, string display)> children)
        {
            JArray arr = new JArray();
            int count = 0;
            foreach (var child in children)
            {
                if (count >= MaxListedChildren)
                {
                    arr.Add($"…(+{children.Count - MaxListedChildren} more)");
                    break;
                }
                arr.Add(child.name);
                count++;
            }
            return arr.ToString(Newtonsoft.Json.Formatting.None);
        }

        /// <summary>
        /// Converts a display name like "Body Type" to camelCase "bodyType".
        /// </summary>
        private static string ToCamelCase(string displayName)
        {
            if (string.IsNullOrEmpty(displayName))
                return displayName;

            string[] words = displayName.Split(' ');
            if (words.Length == 0)
                return displayName;

            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < words.Length; i++)
            {
                string word = words[i];
                if (string.IsNullOrEmpty(word))
                    continue;

                if (sb.Length == 0)
                {
                    // First word: lowercase first char
                    sb.Append(char.ToLowerInvariant(word[0]));
                    if (word.Length > 1)
                        sb.Append(word.Substring(1));
                }
                else
                {
                    // Subsequent words: uppercase first char
                    sb.Append(char.ToUpperInvariant(word[0]));
                    if (word.Length > 1)
                        sb.Append(word.Substring(1));
                }
            }

            return sb.ToString();
        }
    }
}
