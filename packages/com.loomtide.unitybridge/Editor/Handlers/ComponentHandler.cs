using System;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles component-level operations: list, add, remove, get_properties, describe, set_property.
    /// Uses PropertyIntrospector and FriendlyNameResolver for property access.
    /// </summary>
    public class ComponentHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "list":
                    return HandleList(parameters);
                case "add":
                    return HandleAdd(parameters);
                case "remove":
                    return HandleRemove(parameters);
                case "get_properties":
                case "describe":
                    return HandleGetProperties(parameters);
                case "set_property":
                    return HandleSetProperty(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown component op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in ComponentHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Component op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleList(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            Component[] components = go.GetComponents<Component>();
            var result = new JArray();

            foreach (Component comp in components)
            {
                if (comp == null) continue; // Missing script
                result.Add(new JObject
                {
                    ["type_name"] = comp.GetType().Name
                });
            }

            return new JObject { ["components"] = result };
        }

        private JObject HandleAdd(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string typeName = parameters.Value<string>("type_name");
            if (string.IsNullOrEmpty(typeName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'type_name'");

            Type componentType = PropertyIntrospector.ResolveComponentType(typeName);
            if (componentType == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Could not resolve component type: '{typeName}'");

            GameObject go = LocatorResolver.Resolve(locator);
            Component comp = Undo.AddComponent(go, componentType);

            // Apply optional initial properties
            JObject properties = parameters.Value<JObject>("properties");
            if (properties != null)
            {
                SerializedObject so = new SerializedObject(comp);
                foreach (var kvp in properties)
                {
                    string resolvedPath = FriendlyNameResolver.ResolvePropertyPath(comp, kvp.Key);
                    SerializedProperty prop = so.FindProperty(resolvedPath);
                    if (prop != null)
                    {
                        SetSerializedPropertyValue(resolvedPath, prop, kvp.Value);
                    }
                }
                so.ApplyModifiedProperties();
            }

            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange($"+{comp.GetType().Name} on {DescribeTarget(go)}");
            ShowWorkVisualizer.ExpandComponent(comp);

            return new JObject
            {
                ["component_type"] = comp.GetType().Name
            };
        }

        private JObject HandleRemove(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string typeName = parameters.Value<string>("type_name");
            if (string.IsNullOrEmpty(typeName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'type_name'");

            Type componentType = PropertyIntrospector.ResolveComponentType(typeName);
            if (componentType == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Could not resolve component type: '{typeName}'");

            GameObject go = LocatorResolver.Resolve(locator);
            Component comp = go.GetComponent(componentType);
            if (comp == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Component '{typeName}' not found on '{go.name}'");

            Undo.DestroyObjectImmediate(comp);
            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["removed"] = true,
                ["type_name"] = typeName
            };
        }

        private JObject HandleGetProperties(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string typeName = parameters.Value<string>("type_name");
            if (string.IsNullOrEmpty(typeName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'type_name'");

            Type componentType = PropertyIntrospector.ResolveComponentType(typeName);
            if (componentType == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Could not resolve component type: '{typeName}'");

            GameObject go = LocatorResolver.Resolve(locator);
            Component comp = go.GetComponent(componentType);
            if (comp == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Component '{typeName}' not found on '{go.name}'");

            string search = parameters.Value<string>("search");
            string[] includePaths = null;
            JArray includePathsParam = parameters.Value<JArray>("include_paths");
            if (includePathsParam != null)
            {
                includePaths = new string[includePathsParam.Count];
                for (int i = 0; i < includePathsParam.Count; i++)
                {
                    includePaths[i] = includePathsParam[i].Value<string>();
                }
            }

            JArray props = PropertyIntrospector.DescribeProperties(comp, search, includePaths);
            return new JObject { ["properties"] = props };
        }

        private JObject HandleSetProperty(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string typeName = parameters.Value<string>("type_name");
            if (string.IsNullOrEmpty(typeName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'type_name'");

            string propertyPath = parameters.Value<string>("property_path");
            if (string.IsNullOrEmpty(propertyPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'property_path'");

            JToken value = parameters["value"];
            if (value == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'value'");
            value = JsonValueCoercer.Rehydrate(value);

            // RCL-T05: accept the pseudo-component "GameObject" so the documented
            // set_property{type_name:"GameObject"} path can set GameObject-level serialized
            // fields (m_Layer / m_TagString / m_StaticEditorFlags) — these live on the
            // GameObject's own SerializedObject, not on any Component, so the normal
            // ResolveComponentType + GetComponent path (which returned INVALID_TYPE) can't
            // reach them. scene.set_layer/scene.set_tag are the friendlier front doors.
            if (typeName == "GameObject")
            {
                GameObject targetGo = LocatorResolver.Resolve(locator);
                return SetGameObjectProperty(targetGo, propertyPath, value);
            }

            Type componentType = PropertyIntrospector.ResolveComponentType(typeName);
            if (componentType == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Could not resolve component type: '{typeName}'");

            GameObject go = LocatorResolver.Resolve(locator);
            Component comp = go.GetComponent(componentType);
            if (comp == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Component '{typeName}' not found on '{go.name}'");

            if (TrySetKnownRuntimeProperty(comp, propertyPath, value, go.name, out string runtimePath))
            {
                ShowWorkVisualizer.SelectObject(go);
                ShowWorkVisualizer.LogChange(
                    $"{DescribeTarget(go)} {comp.GetType().Name}.{runtimePath} = {DescribeValue(value)}");
                ShowWorkVisualizer.ExpandComponent(comp);
                return new JObject
                {
                    ["property_path"] = runtimePath,
                    ["type_name"] = typeName
                };
            }

            // Resolve friendly name to serialized path
            string resolvedPath = FriendlyNameResolver.ResolvePropertyPath(comp, propertyPath);

            SerializedObject so = new SerializedObject(comp);
            SerializedProperty prop = so.FindProperty(resolvedPath);
            if (prop == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Serialized property '{resolvedPath}' not found on '{typeName}'");

            Undo.RecordObject(comp, $"Set {resolvedPath} on {go.name}");
            SetSerializedPropertyValue(resolvedPath, prop, value);
            so.ApplyModifiedProperties();
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange(
                $"{DescribeTarget(go)} {comp.GetType().Name}.{resolvedPath} = {DescribeValue(value)}");
            ShowWorkVisualizer.ExpandComponent(comp);

            return new JObject
            {
                ["property_path"] = resolvedPath,
                ["type_name"] = typeName
            };
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        // Hierarchy path (e.g. "/Player") for Show Work log lines, falling back to the
        // GameObject name if the locator can't be built (e.g. runtime-created objects).
        private static string DescribeTarget(GameObject go)
        {
            if (go == null)
                return "?";
            string path = LocatorResolver.BuildLocator(go)?.Value<string>("path");
            return string.IsNullOrEmpty(path) ? go.name : path;
        }

        // Compact, single-line rendering of a JSON value for Show Work log lines so
        // structured payloads (vectors, colors, asset refs) don't dump multi-line JSON.
        private static string DescribeValue(JToken value)
        {
            if (value == null || value.Type == JTokenType.Null)
                return "null";
            return value.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static void SetSerializedPropertyValue(string resolvedPath, SerializedProperty prop, JToken value)
        {
            // Arrays and lists (Sprite[], List<float>, …) serialize as a Generic property
            // with isArray == true. Resize to the value's length and recurse per element so
            // each element is set by its own concrete type (object reference, float, etc.).
            if (prop.isArray && prop.propertyType == SerializedPropertyType.Generic)
            {
                SetArrayValue(resolvedPath, prop, value);
                return;
            }

            switch (prop.propertyType)
            {
                case SerializedPropertyType.Float:
                    prop.floatValue = value.Value<float>();
                    break;
                case SerializedPropertyType.Integer:
                    prop.intValue = value.Value<int>();
                    break;
                case SerializedPropertyType.Boolean:
                    prop.boolValue = value.Value<bool>();
                    break;
                case SerializedPropertyType.String:
                    prop.stringValue = value.Value<string>();
                    break;
                case SerializedPropertyType.Vector2:
                    prop.vector2Value = new Vector2(
                        value.Value<float>("x"),
                        value.Value<float>("y"));
                    break;
                case SerializedPropertyType.Vector3:
                    prop.vector3Value = new Vector3(
                        value.Value<float>("x"),
                        value.Value<float>("y"),
                        value.Value<float>("z"));
                    break;
                case SerializedPropertyType.Vector4:
                    prop.vector4Value = new Vector4(
                        value.Value<float>("x"),
                        value.Value<float>("y"),
                        value.Value<float>("z"),
                        value.Value<float>("w"));
                    break;
                case SerializedPropertyType.Color:
                    prop.colorValue = new Color(
                        value.Value<float>("r"),
                        value.Value<float>("g"),
                        value.Value<float>("b"),
                        value.Value<float?>("a") ?? 1f);
                    break;
                case SerializedPropertyType.Enum:
                    if (value.Type == JTokenType.String)
                    {
                        string enumName = value.Value<string>();
                        int idx = Array.IndexOf(prop.enumDisplayNames, enumName);
                        if (idx >= 0)
                            prop.enumValueIndex = idx;
                        else
                            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                $"Unknown enum value: '{enumName}'. Valid: [{string.Join(", ", prop.enumDisplayNames)}]");
                    }
                    else
                    {
                        prop.enumValueIndex = value.Value<int>();
                    }
                    break;
                case SerializedPropertyType.Rect:
                    prop.rectValue = new Rect(
                        value.Value<float>("x"),
                        value.Value<float>("y"),
                        value.Value<float>("width"),
                        value.Value<float>("height"));
                    break;
                case SerializedPropertyType.Bounds:
                    JToken center = value["center"];
                    JToken size = value["size"];
                    prop.boundsValue = new Bounds(
                        new Vector3(center.Value<float>("x"), center.Value<float>("y"), center.Value<float>("z")),
                        new Vector3(size.Value<float>("x"), size.Value<float>("y"), size.Value<float>("z")));
                    break;
                case SerializedPropertyType.ObjectReference:
                    prop.objectReferenceValue = ResolveObjectReferenceValue(resolvedPath, prop, value);
                    break;
                case SerializedPropertyType.LayerMask:
                    prop.intValue = value.Value<int>();
                    break;
                case SerializedPropertyType.Vector2Int:
                    prop.vector2IntValue = new Vector2Int(
                        value.Value<int>("x"),
                        value.Value<int>("y"));
                    break;
                case SerializedPropertyType.Vector3Int:
                    prop.vector3IntValue = new Vector3Int(
                        value.Value<int>("x"),
                        value.Value<int>("y"),
                        value.Value<int>("z"));
                    break;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_TYPE,
                        $"Cannot set property of type: {prop.propertyType}");
            }
        }

        private static void SetArrayValue(string resolvedPath, SerializedProperty prop, JToken value)
        {
            if (!(value is JArray array))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Property '{resolvedPath}' is an array; value must be a JSON array " +
                    "(e.g. [\"Assets/.../sheet.png\"] for a Sprite[], or per-element object payloads).");

            prop.arraySize = array.Count;
            for (int i = 0; i < array.Count; i++)
            {
                SerializedProperty element = prop.GetArrayElementAtIndex(i);
                SetSerializedPropertyValue($"{resolvedPath}.Array.data[{i}]", element, array[i]);
            }
        }

        private static UnityEngine.Object ResolveObjectReferenceValue(
            string resolvedPath,
            SerializedProperty prop,
            JToken value)
        {
            Type expectedType = ResolveObjectReferenceType(prop);

            if (value == null || value.Type == JTokenType.Null)
                return null;

            if (value.Type == JTokenType.String)
            {
                UnityEngine.Object assetRef = AssetReferenceResolver.Load(value.Value<string>(), expectedType, null);
                EnsureAssignable(expectedType, assetRef, resolvedPath, "asset path");
                return assetRef;
            }

            if (value.Type != JTokenType.Object)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Object reference value for '{resolvedPath}' must be null, a string asset path, or an object payload.");
            }

            var valueObject = (JObject)value;

            bool clear = valueObject.Value<bool?>("clear") ?? false;
            if (clear)
                return null;

            string assetPath = valueObject.Value<string>("asset_path");
            if (!string.IsNullOrEmpty(assetPath) || valueObject.Property("asset_path") != null)
            {
                // sub_asset (alias sprite_name) selects a named sub-asset — e.g. one sliced
                // Sprite out of a sheet's Texture2D — by name and expected type.
                string subAsset = valueObject.Value<string>("sub_asset")
                    ?? valueObject.Value<string>("sprite_name");
                UnityEngine.Object assetRef = AssetReferenceResolver.Load(assetPath, expectedType, subAsset);
                EnsureAssignable(expectedType, assetRef, resolvedPath, "asset_path");
                return assetRef;
            }

            JObject locator = valueObject.Value<JObject>("locator");
            if (locator == null && LooksLikeLocator(valueObject))
                locator = valueObject;

            if (locator != null)
            {
                UnityEngine.Object sceneRef = ResolveSceneReference(locator, expectedType, resolvedPath);
                EnsureAssignable(expectedType, sceneRef, resolvedPath, "locator");
                return sceneRef;
            }

            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"Unsupported object reference value for '{resolvedPath}'. Use null, string asset path, {{ asset_path, sub_asset? }}, {{ locator }}, or {{ clear: true }}.");
        }

        private static bool LooksLikeLocator(JObject obj)
        {
            return obj.Property("path") != null
                   || obj.Property("scene") != null
                   || obj.Property("globalObjectId") != null
                   || obj.Property("instanceId") != null
                   || obj.Property("object_id") != null;
        }

        private static UnityEngine.Object ResolveSceneReference(JObject locator, Type expectedType, string resolvedPath)
        {
            GameObject go = LocatorResolver.Resolve(locator);
            if (go == null)
            {
                throw new BridgeException(ErrorCodes.LOCATOR_UNRESOLVED,
                    $"Could not resolve locator for '{resolvedPath}'.");
            }

            if (expectedType == null || expectedType == typeof(UnityEngine.Object))
                return go;

            if (expectedType.IsAssignableFrom(typeof(GameObject)))
                return go;

            if (expectedType.IsAssignableFrom(typeof(Transform)))
                return go.transform;

            if (typeof(Component).IsAssignableFrom(expectedType))
            {
                Component component = go.GetComponent(expectedType);
                if (component != null)
                    return component;
            }

            foreach (Component candidate in go.GetComponents<Component>())
            {
                if (candidate != null && expectedType.IsAssignableFrom(candidate.GetType()))
                    return candidate;
            }

            throw new BridgeException(ErrorCodes.INVALID_TYPE,
                $"Locator '{LocatorResolver.BuildLocator(go)?.ToString(Newtonsoft.Json.Formatting.None)}' is incompatible with '{resolvedPath}'. Expected '{expectedType.Name}'.");
        }

        private static void EnsureAssignable(Type expectedType, UnityEngine.Object value, string resolvedPath, string source)
        {
            if (value == null || expectedType == null || expectedType == typeof(UnityEngine.Object))
                return;

            Type actualType = value.GetType();
            if (expectedType.IsAssignableFrom(actualType))
                return;

            throw new BridgeException(ErrorCodes.INVALID_TYPE,
                $"Cannot assign {source} value of type '{actualType.Name}' to '{resolvedPath}' (expected '{expectedType.Name}').");
        }

        private static Type ResolveObjectReferenceType(SerializedProperty prop)
        {
            if (prop == null || string.IsNullOrEmpty(prop.type))
                return null;

            const string prefix = "PPtr<";
            string propType = prop.type;
            if (!propType.StartsWith(prefix, StringComparison.Ordinal) ||
                !propType.EndsWith(">", StringComparison.Ordinal))
            {
                return null;
            }

            // Inner type name between "PPtr<" and ">". Unity emits a leading '$' for some
            // fields ("PPtr<$Sprite>") but not others ("PPtr<Sprite>") — strip it either way.
            string typeName = propType.Substring(prefix.Length, propType.Length - prefix.Length - 1);
            if (typeName.StartsWith("$", StringComparison.Ordinal))
                typeName = typeName.Substring(1);
            if (string.IsNullOrEmpty(typeName))
                return null;

            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    Type resolved = assembly.GetType(typeName, false);
                    if (resolved != null && typeof(UnityEngine.Object).IsAssignableFrom(resolved))
                        return resolved;

                    foreach (Type candidate in assembly.GetTypes())
                    {
                        if ((candidate.Name == typeName || candidate.FullName == typeName) &&
                            typeof(UnityEngine.Object).IsAssignableFrom(candidate))
                        {
                            return candidate;
                        }
                    }
                }
                catch (ReflectionTypeLoadException)
                {
                    // Skip assemblies that cannot enumerate all types.
                }
            }

            return null;
        }

        private static bool TrySetKnownRuntimeProperty(Component comp, string propertyPath, JToken value,
            string objectName, out string resolvedPath)
        {
            resolvedPath = null;

            // RCL-T08: the universal `enabled` flag. m_Enabled is hidden from the
            // SerializedObject iterator the friendly-name resolver walks, so "enabled" used to
            // fail with "No property found". Behaviour/Renderer/Collider all expose a live
            // `enabled` API setter — use it directly. This disables the COMPONENT (e.g. turns a
            // MeshRenderer off) and crucially NOT the GameObject (that is scene.set_active /
            // the GameObject pseudo-component's m_IsActive). Also covers any component whose
            // `enabled` exists only as a C# property with no serialized field.
            if ((propertyPath.Equals("enabled", StringComparison.OrdinalIgnoreCase) ||
                 propertyPath.Equals("m_Enabled", StringComparison.OrdinalIgnoreCase)) &&
                TrySetEnabledViaApi(comp, value, objectName))
            {
                resolvedPath = "enabled";
                return true;
            }

            if (comp is Rigidbody2D body2D &&
                propertyPath.Equals("freezeRotation", StringComparison.OrdinalIgnoreCase))
            {
                if (value.Type != JTokenType.Boolean)
                {
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Rigidbody2D.freezeRotation expects a boolean value.");
                }

                Undo.RecordObject(comp, $"Set freezeRotation on {objectName}");
                body2D.freezeRotation = value.Value<bool>();
                EditorUtility.SetDirty(comp);
                resolvedPath = "freezeRotation";
                return true;
            }

            // Renderer sorting (SpriteRenderer and any other Renderer): sortingOrder /
            // sortingLayerName / sortingLayerID are surfaced by get_properties but are NOT
            // plain SerializedProperty paths on the iterator the friendly-name resolver
            // walks — the SerializedObject exposes m_SortingOrder/m_SortingLayer but the
            // resolver/setter can't reliably reach them. They're core to 2D layering, so
            // set them directly on the Renderer API (the previous bridge rejected them,
            // forcing agents to fall back to z-depth layering). Accept friendly and
            // serialized aliases for each.
            if (comp is Renderer renderer)
            {
                if (propertyPath.Equals("sortingOrder", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("m_SortingOrder", StringComparison.OrdinalIgnoreCase))
                {
                    Undo.RecordObject(comp, $"Set sortingOrder on {objectName}");
                    renderer.sortingOrder = value.Value<int>();
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingOrder";
                    return true;
                }

                if (propertyPath.Equals("sortingLayerName", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("sortingLayer", StringComparison.OrdinalIgnoreCase))
                {
                    string layerName = value.Value<string>();
                    if (string.IsNullOrEmpty(layerName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            "Renderer.sortingLayerName expects a non-empty sorting layer name string.");

                    Undo.RecordObject(comp, $"Set sortingLayerName on {objectName}");
                    renderer.sortingLayerName = layerName;
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingLayerName";
                    return true;
                }

                if (propertyPath.Equals("sortingLayerID", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("m_SortingLayer", StringComparison.OrdinalIgnoreCase))
                {
                    Undo.RecordObject(comp, $"Set sortingLayerID on {objectName}");
                    renderer.sortingLayerID = value.Value<int>();
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingLayerID";
                    return true;
                }
            }

            // Canvas sorting (UI render order): mirrors the Renderer branch above. The
            // Canvas exposes m_SortingOrder/m_OverrideSorting/m_SortingLayer on its
            // SerializedObject but the friendly-name resolver/setter can't reliably reach
            // them, so set them directly on the Canvas API. overrideSorting must be true
            // for a nested/child Canvas's sortingOrder to take effect, so surface it too.
            if (comp is Canvas canvas)
            {
                if (propertyPath.Equals("sortingOrder", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("m_SortingOrder", StringComparison.OrdinalIgnoreCase))
                {
                    Undo.RecordObject(comp, $"Set sortingOrder on {objectName}");
                    canvas.sortingOrder = value.Value<int>();
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingOrder";
                    return true;
                }

                if (propertyPath.Equals("overrideSorting", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("m_OverrideSorting", StringComparison.OrdinalIgnoreCase))
                {
                    if (value.Type != JTokenType.Boolean)
                    {
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            "Canvas.overrideSorting expects a boolean value.");
                    }

                    Undo.RecordObject(comp, $"Set overrideSorting on {objectName}");
                    canvas.overrideSorting = value.Value<bool>();
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "overrideSorting";
                    return true;
                }

                if (propertyPath.Equals("sortingLayerName", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("sortingLayer", StringComparison.OrdinalIgnoreCase))
                {
                    string layerName = value.Value<string>();
                    if (string.IsNullOrEmpty(layerName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            "Canvas.sortingLayerName expects a non-empty sorting layer name string.");

                    Undo.RecordObject(comp, $"Set sortingLayerName on {objectName}");
                    canvas.sortingLayerName = layerName;
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingLayerName";
                    return true;
                }

                if (propertyPath.Equals("sortingLayerID", StringComparison.OrdinalIgnoreCase) ||
                    propertyPath.Equals("m_SortingLayer", StringComparison.OrdinalIgnoreCase))
                {
                    Undo.RecordObject(comp, $"Set sortingLayerID on {objectName}");
                    canvas.sortingLayerID = value.Value<int>();
                    EditorUtility.SetDirty(comp);
                    resolvedPath = "sortingLayerID";
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Set a component's `enabled` flag via the live API (Behaviour/Renderer/Collider all
        /// expose one). Returns false for a component type with no `enabled` member so the caller
        /// can fall through to the normal serialized path. Accepts a JSON boolean.
        /// </summary>
        private static bool TrySetEnabledViaApi(Component comp, JToken value, string objectName)
        {
            if (value == null || value.Type != JTokenType.Boolean)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'enabled' on {comp.GetType().Name} expects a boolean value.");
            bool enabled = value.Value<bool>();

            Undo.RecordObject(comp, $"Set enabled on {objectName}");
            switch (comp)
            {
                case Behaviour behaviour:
                    behaviour.enabled = enabled;
                    break;
                case Renderer renderer:
                    renderer.enabled = enabled;
                    break;
                case Collider collider:
                    collider.enabled = enabled;
                    break;
                case LODGroup lodGroup:
                    lodGroup.enabled = enabled;
                    break;
                default:
                    return false; // No `enabled` API — let the serialized path handle it.
            }
            EditorUtility.SetDirty(comp);
            return true;
        }

        // ─────────────────────────────────────────────
        // GameObject pseudo-component (RCL-T05)
        // ─────────────────────────────────────────────

        // Friendly → serialized aliases for GameObject-level fields, so set_property{type_name:
        // "GameObject"} accepts both the raw serialized name and a friendly one.
        private static readonly System.Collections.Generic.Dictionary<string, string> GameObjectAliases =
            new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["layer"] = "m_Layer",
                ["m_Layer"] = "m_Layer",
                ["tag"] = "m_TagString",
                ["tagString"] = "m_TagString",
                ["m_TagString"] = "m_TagString",
                ["staticEditorFlags"] = "m_StaticEditorFlags",
                ["static"] = "m_StaticEditorFlags",
                ["m_StaticEditorFlags"] = "m_StaticEditorFlags",
                ["name"] = "m_Name",
                ["m_Name"] = "m_Name",
                ["isActive"] = "m_IsActive",
                ["active"] = "m_IsActive",
                ["m_IsActive"] = "m_IsActive",
            };

        /// <summary>
        /// Set a GameObject-level serialized property (m_Layer / m_TagString / m_StaticEditorFlags /
        /// m_Name / m_IsActive). The value flows through the same SetSerializedPropertyValue used for
        /// component properties. scene.set_layer / scene.set_tag are the friendlier dedicated ops;
        /// this path exists so the documented set_property{type_name:"GameObject"} works too.
        /// </summary>
        private JObject SetGameObjectProperty(GameObject go, string propertyPath, JToken value)
        {
            string resolvedPath = GameObjectAliases.TryGetValue(propertyPath, out string aliased)
                ? aliased
                : propertyPath;

            SerializedObject so = new SerializedObject(go);
            SerializedProperty prop = so.FindProperty(resolvedPath);
            if (prop == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Serialized property '{resolvedPath}' not found on GameObject. " +
                    "Supported: m_Layer (layer), m_TagString (tag), m_StaticEditorFlags, m_Name, m_IsActive.");

            Undo.RecordObject(go, $"Set {resolvedPath} on {go.name}");
            SetSerializedPropertyValue(resolvedPath, prop, value);
            so.ApplyModifiedProperties();
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange($"{DescribeTarget(go)} GameObject.{resolvedPath} = {DescribeValue(value)}");

            return new JObject
            {
                ["property_path"] = resolvedPath,
                ["type_name"] = "GameObject"
            };
        }
    }
}
