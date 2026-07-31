using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Enumerates serialized properties of any Component, returning structured descriptors.
    /// Uses SerializedObject/SerializedProperty iteration for accurate Unity Editor data.
    /// </summary>
    public static class PropertyIntrospector
    {
        // ─────────────────────────────────────────────
        // Common Type Lookup
        // ─────────────────────────────────────────────

        private static readonly Dictionary<string, Type> CommonTypes = new Dictionary<string, Type>
        {
            { "Transform", typeof(Transform) },
            { "Rigidbody2D", typeof(Rigidbody2D) },
            { "BoxCollider2D", typeof(BoxCollider2D) },
            { "CircleCollider2D", typeof(CircleCollider2D) },
            { "CapsuleCollider2D", typeof(CapsuleCollider2D) },
            { "SpriteRenderer", typeof(SpriteRenderer) },
            { "Animator", typeof(Animator) },
            { "Camera", typeof(Camera) },
            { "AudioSource", typeof(AudioSource) },
            { "Canvas", typeof(Canvas) },
            { "CanvasScaler", typeof(UnityEngine.UI.CanvasScaler) },
            { "GraphicRaycaster", typeof(UnityEngine.UI.GraphicRaycaster) },
            { "Text", typeof(UnityEngine.UI.Text) },
            { "UnityEngine.UI.Text", typeof(UnityEngine.UI.Text) },
            { "Image", typeof(UnityEngine.UI.Image) },
            { "UnityEngine.UI.Image", typeof(UnityEngine.UI.Image) },
            { "Button", typeof(UnityEngine.UI.Button) },
            { "UnityEngine.UI.Button", typeof(UnityEngine.UI.Button) },
            { "Rigidbody", typeof(Rigidbody) },
            { "BoxCollider", typeof(BoxCollider) },
            { "SphereCollider", typeof(SphereCollider) },
            { "MeshRenderer", typeof(MeshRenderer) },
            { "MeshFilter", typeof(MeshFilter) },
            { "Light", typeof(Light) },
            { "RectTransform", typeof(RectTransform) },
        };

        /// <summary>
        /// Resolves a component type name to a System.Type.
        /// Fast lookup for common types, then fallback to assembly scanning.
        /// Returns null if type cannot be found.
        /// </summary>
        public static Type ResolveComponentType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName))
                return null;

            // Fast path: common types
            if (CommonTypes.TryGetValue(typeName, out Type commonType))
                return commonType;

            // Fallback: search all loaded assemblies
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    foreach (Type type in assembly.GetTypes())
                    {
                        if (type.Name == typeName || type.FullName == typeName)
                        {
                            if (typeof(Component).IsAssignableFrom(type))
                                return type;
                        }
                    }
                }
                catch (ReflectionTypeLoadException)
                {
                    // Some assemblies may fail to enumerate types — skip them
                }
            }

            return null;
        }

        // ─────────────────────────────────────────────
        // Property Enumeration
        // ─────────────────────────────────────────────

        /// <summary>
        /// Enumerates all serialized properties of a Component, returning a JArray of descriptors.
        /// Each descriptor: { displayName, serializedPath, type, currentValue, readOnly?, range?, enumValues? }
        /// </summary>
        /// <param name="component">The component to introspect.</param>
        /// <param name="search">Optional filter: only properties whose displayName or serializedPath contains this string (case-insensitive).</param>
        /// <param name="includePaths">Optional: if non-null, only return properties whose serializedPath is in this list.</param>
        public static JArray DescribeProperties(Component component, string search = null, string[] includePaths = null)
        {
            var result = new JArray();
            HashSet<string> includeSet = null;

            if (includePaths != null)
            {
                includeSet = new HashSet<string>(includePaths);
            }

            SerializedObject so = new SerializedObject(component);
            SerializedProperty iterator = so.GetIterator();
            bool enterChildren = true;
            var emitted = new HashSet<string>();

            while (iterator.NextVisible(enterChildren))
            {
                enterChildren = false;

                string serializedPath = iterator.propertyPath;
                string displayName = iterator.displayName;

                // Filter by includePaths
                if (includeSet != null && !includeSet.Contains(serializedPath))
                    continue;

                // Filter by search string
                if (!string.IsNullOrEmpty(search))
                {
                    string searchLower = search.ToLowerInvariant();
                    if (!displayName.ToLowerInvariant().Contains(searchLower) &&
                        !serializedPath.ToLowerInvariant().Contains(searchLower))
                        continue;
                }

                var descriptor = new JObject
                {
                    ["displayName"] = displayName,
                    ["serializedPath"] = serializedPath,
                    ["type"] = MapPropertyType(iterator.propertyType),
                    ["currentValue"] = ExtractValue(iterator)
                };

                // Arrays (and generic lists) are surfaced as generic/null by the plain
                // SerializedProperty value extractor, hiding their contents. Expand them
                // with arraySize + a short element summary so frame-list / array fields
                // (e.g. a sprite-animation 'frames' array) are verifiable, not opaque.
                if (iterator.isArray && iterator.propertyType != SerializedPropertyType.String)
                {
                    descriptor["isArray"] = true;
                    descriptor["arraySize"] = iterator.arraySize;
                    descriptor["elements"] = SummarizeArrayElements(iterator);
                }

                // readOnly: best-effort check via field attributes
                bool readOnly = IsReadOnly(component, iterator);
                if (readOnly)
                    descriptor["readOnly"] = true;

                // range: extract from [Range] attribute if present
                JObject range = ExtractRange(component, iterator);
                if (range != null)
                    descriptor["range"] = range;

                // enumValues: extract if type is Enum
                if (iterator.propertyType == SerializedPropertyType.Enum)
                {
                    descriptor["enumValues"] = new JArray(iterator.enumDisplayNames);
                }

                // publicField: whether the backing member is a PUBLIC instance field. Runtime field
                // sampling (RuntimeFieldSampler, used to read a --state-signal property while recording)
                // reflects with BindingFlags.Public | Instance ONLY, so a `[SerializeField] private` enum
                // is serialized + visible here yet unreadable at record time. Surfacing this lets
                // stateSignal auto-detection avoid confidently proposing a signal that silently no-ops.
                FieldInfo backingField = FindField(component.GetType(), serializedPath);
                descriptor["publicField"] = backingField != null && backingField.IsPublic;

                emitted.Add(serializedPath);
                result.Add(descriptor);
            }

            // The WRITE-ONLY class (E20 / L117): fields set_property accepts and get_properties
            // could not read back. Must run BEFORE the SerializedObject is disposed.
            AppendWellKnownSerializedFields(result, so, component, search, includeSet, emitted);

            so.Dispose();

            // Renderer sorting (sortingOrder / sortingLayerName / sortingLayerID) is not
            // exposed by the SerializedProperty iterator above, so a sorting bug (a sprite
            // hidden behind same-order geometry) is invisible via get_properties. Read it
            // straight off the Renderer API and append synthetic descriptors. Respect
            // includePaths/search the same way as the iterator did.
            if (component is Renderer renderer)
            {
                AppendRendererSorting(result, renderer, search, includeSet);
            }

            return result;
        }

        /// <summary>
        /// Well-known serialized fields the <c>NextVisible</c> iterator SKIPS, read straight off
        /// the SerializedObject with <c>FindProperty</c> and appended as ordinary descriptors.
        ///
        /// THE DEFECT CLASS THIS CLOSES: write-only introspection. <c>component.set_property</c>
        /// accepts <c>m_Enabled</c> and <c>m_SortingOrder</c> (see TrySetKnownRuntimeProperty) and
        /// <c>get_properties</c> could not read either of them back, so an agent could set a value
        /// and had no way to confirm it landed. Three scrim-sorting fix attempts on a Canvas were
        /// unverifiable for exactly this reason and were abandoned as a written-justification known
        /// issue; the m_Enabled half is the same shape (L117).
        ///
        /// The fields are emitted under their SERIALIZED names, which are the names
        /// <c>set_property</c> takes, so a read and the write that follows it spell the same thing.
        /// A field the component does not carry is simply absent (Behaviour has m_Enabled, a bare
        /// Component does not); nothing is fabricated, and a path the iterator already emitted is
        /// never duplicated.
        /// </summary>
        private static void AppendWellKnownSerializedFields(JArray result, SerializedObject so,
            Component component, string search, HashSet<string> includeSet, HashSet<string> emitted)
        {
            void Append(string path, string display)
            {
                if (emitted.Contains(path))
                    return;
                if (includeSet != null && !includeSet.Contains(path))
                    return;
                if (!string.IsNullOrEmpty(search))
                {
                    string searchLower = search.ToLowerInvariant();
                    if (!display.ToLowerInvariant().Contains(searchLower) &&
                        !path.ToLowerInvariant().Contains(searchLower))
                        return;
                }

                SerializedProperty prop = so.FindProperty(path);
                if (prop == null)
                    return;

                JToken value = ExtractValue(prop);
                if (value == null)
                    return;

                emitted.Add(path);
                result.Add(new JObject
                {
                    ["displayName"] = display,
                    ["serializedPath"] = path,
                    ["type"] = MapPropertyType(prop.propertyType),
                    ["currentValue"] = value,
                    // The iterator hides these; saying so beside the value stops a reader
                    // concluding the component is somehow special.
                    ["hiddenFromIterator"] = true
                });
            }

            // Behaviour.enabled (and Renderer/Collider's own enabled flag): the universal
            // component toggle, hidden from the inspector iterator on every type that has it.
            Append("m_Enabled", "Enabled");

            // 2D/UI render order. Renderer's live values are ALSO appended by
            // AppendRendererSorting under the friendly `sortingOrder` spelling; these are the
            // serialized spellings, and Canvas (not a Renderer) has no other source at all.
            if (component is Renderer || component is Canvas)
            {
                Append("m_SortingOrder", "Sorting Order");
                Append("m_SortingLayerID", "Sorting Layer ID");
                Append("m_SortingLayer", "Sorting Layer");
            }
            if (component is Canvas)
            {
                // Without overrideSorting a nested Canvas's sortingOrder does nothing, so reading
                // the order without it would answer half the question that was actually asked.
                Append("m_OverrideSorting", "Override Sorting");
            }
        }

        /// <summary>
        /// Appends sortingOrder/sortingLayerName/sortingLayerID descriptors for a Renderer,
        /// read directly from the Renderer API (the SerializedProperty iterator drops them).
        /// </summary>
        private static void AppendRendererSorting(JArray result, Renderer renderer,
            string search, HashSet<string> includeSet)
        {
            void AddSorting(string path, string display, string typeName, JToken value)
            {
                if (includeSet != null && !includeSet.Contains(path))
                    return;
                if (!string.IsNullOrEmpty(search))
                {
                    string searchLower = search.ToLowerInvariant();
                    if (!display.ToLowerInvariant().Contains(searchLower) &&
                        !path.ToLowerInvariant().Contains(searchLower))
                        return;
                }
                result.Add(new JObject
                {
                    ["displayName"] = display,
                    ["serializedPath"] = path,
                    ["type"] = typeName,
                    ["currentValue"] = value
                });
            }

            AddSorting("sortingOrder", "Sorting Order", "int", renderer.sortingOrder);
            AddSorting("sortingLayerName", "Sorting Layer Name", "string", renderer.sortingLayerName);
            AddSorting("sortingLayerID", "Sorting Layer ID", "int", renderer.sortingLayerID);
        }

        /// <summary>
        /// Builds a short summary of an array/list SerializedProperty's elements: per element
        /// its type and a name/value, capped at a small count so the response stays compact.
        /// </summary>
        private static JArray SummarizeArrayElements(SerializedProperty arrayProp)
        {
            const int maxElements = 8;
            var arr = new JArray();
            int count = Mathf.Min(arrayProp.arraySize, maxElements);
            for (int i = 0; i < count; i++)
            {
                SerializedProperty el = arrayProp.GetArrayElementAtIndex(i);
                if (el == null)
                {
                    arr.Add(JValue.CreateNull());
                    continue;
                }

                var entry = new JObject
                {
                    ["index"] = i,
                    ["type"] = MapPropertyType(el.propertyType),
                };

                if (el.propertyType == SerializedPropertyType.ObjectReference)
                {
                    entry["name"] = el.objectReferenceValue != null
                        ? el.objectReferenceValue.name
                        : (JToken)JValue.CreateNull();
                }
                else
                {
                    entry["value"] = ExtractValue(el) ?? JValue.CreateNull();
                }

                arr.Add(entry);
            }
            return arr;
        }

        // ─────────────────────────────────────────────
        // Public C# property reading (RCL-T10)
        // ─────────────────────────────────────────────

        /// <summary>
        /// Reflects PUBLIC instance C# PROPERTIES (auto- or computed) with a public getter, so live
        /// runtime state exposed only as a property — e.g. a `Health.Current { get; }` with no
        /// `[SerializeField]` backing field — is observable in a snapshot WITHOUT the author adding a
        /// serialized field. This is purely additive to <see cref="DescribeProperties"/> (which only
        /// iterates serialized fields): the two together give both authored config and live property
        /// state.
        ///
        /// Safety / honest-or-omit discipline:
        ///   • Only properties whose return type is a JSON-simple value (bool / number / enum / string /
        ///     Vector2-4 / Color / Quaternion / Bounds / Rect) are read. Object-returning getters are
        ///     SKIPPED — this deliberately excludes side-effecting Unity getters (Renderer.material,
        ///     MeshFilter.mesh, …) that instantiate on access, so reading a snapshot never mutates state.
        ///   • Indexer properties (GetIndexParameters().Length != 0) are skipped.
        ///   • A getter that throws is skipped (never fabricates a value).
        /// Each descriptor: { name, type, value, declaringType }.
        /// </summary>
        public static JArray DescribePublicProperties(Component component, string search = null, string[] includePaths = null)
        {
            var result = new JArray();
            if (component == null)
                return result;

            HashSet<string> includeSet = includePaths != null ? new HashSet<string>(includePaths) : null;
            string searchLower = string.IsNullOrEmpty(search) ? null : search.ToLowerInvariant();

            // Dedupe by name: a `new`-shadowed property can appear twice across the hierarchy.
            var seen = new HashSet<string>();

            foreach (PropertyInfo prop in component.GetType()
                         .GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!prop.CanRead) continue;
                if (prop.GetGetMethod() == null) continue;
                if (prop.GetIndexParameters().Length != 0) continue;

                // RCL-T10 review: skip Unity base-class properties (Transform.position/forward/eulerAngles/…
                // and Object/Component/Behaviour's name/tag/enabled/hideFlags/isActiveAndEnabled). They bloat
                // every snapshot, duplicate the top-level transform block, and are not the user-game-state this
                // op exists to surface. An explicit includePaths request overrides this (a caller may still ask
                // for a Unity property by name).
                if (includeSet == null)
                {
                    string declNs = prop.DeclaringType?.Namespace;
                    if (declNs != null &&
                        (declNs == "UnityEngine" || declNs.StartsWith("UnityEngine.") ||
                         declNs == "UnityEditor" || declNs.StartsWith("UnityEditor.")))
                        continue;
                }

                string name = prop.Name;
                if (includeSet != null && !includeSet.Contains(name)) continue;
                if (searchLower != null && !name.ToLowerInvariant().Contains(searchLower)) continue;
                if (!seen.Add(name)) continue;

                // Filter to JSON-simple return types BEFORE reading, so a side-effecting
                // object-returning getter is never invoked.
                if (!IsSimpleValueType(prop.PropertyType)) continue;

                object raw;
                try
                {
                    raw = prop.GetValue(component, null);
                }
                catch
                {
                    // A throwing getter is honest-or-omit: skip it, never fabricate a value.
                    continue;
                }

                JToken value = SimpleValueToJson(prop.PropertyType, raw);
                if (value == null) continue;

                result.Add(new JObject
                {
                    ["name"] = name,
                    ["type"] = prop.PropertyType.Name,
                    ["value"] = value,
                    ["declaringType"] = prop.DeclaringType != null ? prop.DeclaringType.Name : prop.PropertyType.Name
                });
            }

            return result;
        }

        /// <summary>
        /// True when <paramref name="type"/> is a JSON-simple value the snapshot can read without
        /// side effects: bool / integral / floating / enum / string / Vector2-4 / Color / Quaternion /
        /// Bounds / Rect (and Nullable wrappers of those). Object/reference return types are excluded.
        /// </summary>
        private static bool IsSimpleValueType(Type type)
        {
            if (type == null) return false;
            Type t = Nullable.GetUnderlyingType(type) ?? type;

            if (t.IsEnum) return true;
            if (t == typeof(bool) || t == typeof(string)) return true;
            if (t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort) ||
                t == typeof(int) || t == typeof(uint) || t == typeof(long) || t == typeof(ulong) ||
                t == typeof(float) || t == typeof(double) || t == typeof(decimal)) return true;
            if (t == typeof(Vector2) || t == typeof(Vector3) || t == typeof(Vector4) ||
                t == typeof(Vector2Int) || t == typeof(Vector3Int) ||
                t == typeof(Color) || t == typeof(Color32) ||
                t == typeof(Quaternion) || t == typeof(Bounds) || t == typeof(Rect)) return true;
            return false;
        }

        /// <summary>Coerces a simple-typed value to its JSON token (matching <see cref="ExtractValue"/>'s shape).</summary>
        private static JToken SimpleValueToJson(Type declaredType, object raw)
        {
            if (raw == null) return JValue.CreateNull();
            Type t = Nullable.GetUnderlyingType(declaredType) ?? declaredType;

            if (t.IsEnum) return new JValue(raw.ToString());
            if (t == typeof(bool)) return new JValue((bool)raw);
            if (t == typeof(string)) return new JValue((string)raw);
            if (t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort) ||
                t == typeof(int) || t == typeof(uint) || t == typeof(long))
                return new JValue(Convert.ToInt64(raw));
            if (t == typeof(ulong)) return new JValue(Convert.ToUInt64(raw));
            if (t == typeof(float) || t == typeof(double) || t == typeof(decimal))
                return new JValue(Convert.ToDouble(raw));

            if (t == typeof(Vector2)) { var v = (Vector2)raw; return new JObject { ["x"] = v.x, ["y"] = v.y }; }
            if (t == typeof(Vector3)) { var v = (Vector3)raw; return new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z }; }
            if (t == typeof(Vector4)) { var v = (Vector4)raw; return new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z, ["w"] = v.w }; }
            if (t == typeof(Vector2Int)) { var v = (Vector2Int)raw; return new JObject { ["x"] = v.x, ["y"] = v.y }; }
            if (t == typeof(Vector3Int)) { var v = (Vector3Int)raw; return new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z }; }
            if (t == typeof(Color)) { var c = (Color)raw; return new JObject { ["r"] = c.r, ["g"] = c.g, ["b"] = c.b, ["a"] = c.a }; }
            if (t == typeof(Color32)) { var c = (Color32)raw; return new JObject { ["r"] = c.r, ["g"] = c.g, ["b"] = c.b, ["a"] = c.a }; }
            if (t == typeof(Quaternion)) { var q = (Quaternion)raw; return new JObject { ["x"] = q.x, ["y"] = q.y, ["z"] = q.z, ["w"] = q.w }; }
            if (t == typeof(Bounds))
            {
                var b = (Bounds)raw;
                return new JObject
                {
                    ["center"] = new JObject { ["x"] = b.center.x, ["y"] = b.center.y, ["z"] = b.center.z },
                    ["size"] = new JObject { ["x"] = b.size.x, ["y"] = b.size.y, ["z"] = b.size.z }
                };
            }
            if (t == typeof(Rect))
            {
                var r = (Rect)raw;
                return new JObject { ["x"] = r.x, ["y"] = r.y, ["width"] = r.width, ["height"] = r.height };
            }

            return null;
        }

        // ─────────────────────────────────────────────
        // Type Mapping
        // ─────────────────────────────────────────────

        private static string MapPropertyType(SerializedPropertyType type)
        {
            switch (type)
            {
                case SerializedPropertyType.Float: return "float";
                case SerializedPropertyType.Integer: return "int";
                case SerializedPropertyType.Boolean: return "bool";
                case SerializedPropertyType.String: return "string";
                case SerializedPropertyType.Vector2: return "vector2";
                case SerializedPropertyType.Vector3: return "vector3";
                case SerializedPropertyType.Vector4: return "vector4";
                case SerializedPropertyType.Color: return "color";
                case SerializedPropertyType.ObjectReference: return "objectReference";
                case SerializedPropertyType.Enum: return "enum";
                case SerializedPropertyType.Rect: return "rect";
                case SerializedPropertyType.Bounds: return "bounds";
                case SerializedPropertyType.AnimationCurve: return "animationCurve";
                case SerializedPropertyType.LayerMask: return "layerMask";
                case SerializedPropertyType.Quaternion: return "quaternion";
                case SerializedPropertyType.Vector2Int: return "vector2int";
                case SerializedPropertyType.Vector3Int: return "vector3int";
                default: return type.ToString().ToLowerInvariant();
            }
        }

        // ─────────────────────────────────────────────
        // Value Extraction
        // ─────────────────────────────────────────────

        private static JToken ExtractValue(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Float:
                    return prop.floatValue;
                case SerializedPropertyType.Integer:
                    return prop.intValue;
                case SerializedPropertyType.Boolean:
                    return prop.boolValue;
                case SerializedPropertyType.String:
                    return prop.stringValue;
                case SerializedPropertyType.Vector2:
                    return new JObject
                    {
                        ["x"] = prop.vector2Value.x,
                        ["y"] = prop.vector2Value.y
                    };
                case SerializedPropertyType.Vector3:
                    return new JObject
                    {
                        ["x"] = prop.vector3Value.x,
                        ["y"] = prop.vector3Value.y,
                        ["z"] = prop.vector3Value.z
                    };
                case SerializedPropertyType.Vector4:
                    return new JObject
                    {
                        ["x"] = prop.vector4Value.x,
                        ["y"] = prop.vector4Value.y,
                        ["z"] = prop.vector4Value.z,
                        ["w"] = prop.vector4Value.w
                    };
                case SerializedPropertyType.Color:
                    return new JObject
                    {
                        ["r"] = prop.colorValue.r,
                        ["g"] = prop.colorValue.g,
                        ["b"] = prop.colorValue.b,
                        ["a"] = prop.colorValue.a
                    };
                case SerializedPropertyType.ObjectReference:
                    return prop.objectReferenceValue != null
                        ? prop.objectReferenceValue.name
                        : JValue.CreateNull();
                case SerializedPropertyType.Enum:
                    if (prop.enumValueIndex >= 0 && prop.enumValueIndex < prop.enumDisplayNames.Length)
                        return prop.enumDisplayNames[prop.enumValueIndex];
                    return prop.enumValueIndex;
                case SerializedPropertyType.Rect:
                    Rect r = prop.rectValue;
                    return new JObject
                    {
                        ["x"] = r.x, ["y"] = r.y,
                        ["width"] = r.width, ["height"] = r.height
                    };
                case SerializedPropertyType.Bounds:
                    Bounds b = prop.boundsValue;
                    return new JObject
                    {
                        ["center"] = new JObject
                        {
                            ["x"] = b.center.x, ["y"] = b.center.y, ["z"] = b.center.z
                        },
                        ["size"] = new JObject
                        {
                            ["x"] = b.size.x, ["y"] = b.size.y, ["z"] = b.size.z
                        }
                    };
                case SerializedPropertyType.LayerMask:
                    return prop.intValue;
                case SerializedPropertyType.Quaternion:
                    return new JObject
                    {
                        ["x"] = prop.quaternionValue.x,
                        ["y"] = prop.quaternionValue.y,
                        ["z"] = prop.quaternionValue.z,
                        ["w"] = prop.quaternionValue.w
                    };
                case SerializedPropertyType.Vector2Int:
                    return new JObject
                    {
                        ["x"] = prop.vector2IntValue.x,
                        ["y"] = prop.vector2IntValue.y
                    };
                case SerializedPropertyType.Vector3Int:
                    return new JObject
                    {
                        ["x"] = prop.vector3IntValue.x,
                        ["y"] = prop.vector3IntValue.y,
                        ["z"] = prop.vector3IntValue.z
                    };
                default:
                    return null;
            }
        }

        // ─────────────────────────────────────────────
        // Attribute Helpers
        // ─────────────────────────────────────────────

        private static bool IsReadOnly(Component component, SerializedProperty prop)
        {
            // Best-effort: check for [HideInInspector] on the backing field
            FieldInfo field = FindField(component.GetType(), prop.propertyPath);
            if (field != null)
            {
                return field.GetCustomAttribute<HideInInspector>() != null;
            }
            return false;
        }

        private static JObject ExtractRange(Component component, SerializedProperty prop)
        {
            if (prop.propertyType != SerializedPropertyType.Float &&
                prop.propertyType != SerializedPropertyType.Integer)
                return null;

            FieldInfo field = FindField(component.GetType(), prop.propertyPath);
            if (field != null)
            {
                RangeAttribute rangeAttr = field.GetCustomAttribute<RangeAttribute>();
                if (rangeAttr != null)
                {
                    return new JObject
                    {
                        ["min"] = rangeAttr.min,
                        ["max"] = rangeAttr.max
                    };
                }
            }
            return null;
        }

        /// <summary>
        /// Finds a field by its serialized property path on a component type.
        /// Handles simple paths (no nested objects).
        /// </summary>
        private static FieldInfo FindField(Type type, string propertyPath)
        {
            // Simple case: direct field name (strip "m_" prefix search is handled by Unity)
            string fieldName = propertyPath;

            // If path contains '.', it's nested — just search the first segment
            int dotIndex = fieldName.IndexOf('.');
            if (dotIndex >= 0)
                fieldName = fieldName.Substring(0, dotIndex);

            Type currentType = type;
            while (currentType != null)
            {
                FieldInfo field = currentType.GetField(fieldName,
                    BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (field != null)
                    return field;
                currentType = currentType.BaseType;
            }

            return null;
        }
    }
}
