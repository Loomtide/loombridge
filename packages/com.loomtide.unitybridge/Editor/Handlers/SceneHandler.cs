using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles scene-level operations: create/delete objects, transform manipulation,
    /// hierarchy queries, and scene lifecycle.
    /// </summary>
    public class SceneHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "new_scene":
                    return HandleNewScene(parameters);
                case "open_scene":
                    return HandleOpenScene(parameters);
                case "get_active":
                    return HandleGetActive(parameters);
                case "find_by_name":
                    return HandleFindByName(parameters);
                case "save_scene":
                    return HandleSaveScene(parameters);
                case "create_object":
                    return HandleCreateObject(parameters);
                case "create_primitive":
                    return HandleCreatePrimitive(parameters);
                case "set_layer":
                    return HandleSetLayer(parameters);
                case "set_tag":
                    return HandleSetTag(parameters);
                case "delete_object":
                    return HandleDeleteObject(parameters);
                case "duplicate_object":
                    return HandleDuplicateObject(parameters);
                case "set_parent":
                    return HandleSetParent(parameters);
                case "set_sibling_index":
                    return HandleSetSiblingIndex(parameters);
                case "find_object":
                    return HandleFindObject(parameters);
                case "set_transform":
                    return HandleSetTransform(parameters);
                case "get_hierarchy":
                    return HandleGetHierarchy(parameters);
                case "select_object":
                    return HandleSelectObject(parameters);
                case "set_active":
                    return HandleSetActive(parameters);
                case "get_bounds":
                    return HandleGetBounds(parameters);
                case "frame_object":
                    return HandleFrameObject(parameters);
                case "get_screen_rects":
                    return HandleGetScreenRects(parameters);
                case "verify_manifest":
                    return HandleVerifyManifest(parameters);
                case "get_render_settings":
                    return HandleGetRenderSettings(parameters);
                case "set_render_settings":
                    return HandleSetRenderSettings(parameters);
                case "find_references_to":
                    return HandleFindReferencesTo(parameters);
                case "validate_references":
                    return HandleValidateReferences(parameters);
                case "snapshot_gameplay_geometry":
                    return HandleSnapshotGameplayGeometry(parameters);
                case "compare_gameplay_geometry":
                    return HandleCompareGameplayGeometry(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown scene op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in SceneHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Scene op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleNewScene(JObject parameters)
        {
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

            return new JObject
            {
                ["scene_name"] = scene.name
            };
        }

        private JObject HandleOpenScene(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'path'");

            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Cannot open a scene while in or entering Play Mode. Stop play mode first.");

            OpenSceneMode mode = OpenSceneMode.Single;
            string modeStr = parameters.Value<string>("mode");
            if (!string.IsNullOrEmpty(modeStr))
            {
                switch (modeStr)
                {
                    case "Single":
                        mode = OpenSceneMode.Single;
                        break;
                    case "Additive":
                        mode = OpenSceneMode.Additive;
                        break;
                    default:
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Invalid 'mode': '{modeStr}'. Expected 'Single' or 'Additive'.");
                }
            }

            Scene scene;
            try
            {
                scene = EditorSceneManager.OpenScene(path, mode);
            }
            catch (Exception ex)
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Failed to open scene at '{path}': {ex.Message}");
            }

            return new JObject
            {
                ["scene_name"] = scene.name,
                ["scene_path"] = scene.path,
                ["is_loaded"] = scene.isLoaded,
                ["loaded_scene_count"] = SceneManager.sceneCount
            };
        }

        /// <summary>
        /// Report the editor's ACTIVE scene: its runtime name and — crucially — its saved
        /// `Assets/**.unity` asset path. The scene-agnostic mini-game flow (`check` without
        /// `--scene`) records from the current scene and resets to this path, so it must be a real
        /// on-disk asset. An unsaved / untitled scene has an empty `Scene.path`; we return
        /// `scene_path: null` + `is_saved: false` so the caller REFUSES (can't verify the current
        /// scene) rather than guessing a name that `scene.open_scene` could never reset to.
        /// Read-only; never mutates the scene.
        /// </summary>
        private JObject HandleGetActive(JObject parameters)
        {
            Scene scene = SceneManager.GetActiveScene();
            string path = scene.path; // empty for an unsaved/untitled scene; an Assets/**.unity asset path once saved
            bool isSaved = !string.IsNullOrEmpty(path);
            return new JObject
            {
                ["scene_name"] = scene.name,
                ["scene_path"] = isSaved ? path : null,
                ["is_saved"] = isSaved,
                ["is_dirty"] = scene.isDirty,
                ["loaded_scene_count"] = SceneManager.sceneCount
            };
        }

        /// <summary>
        /// Resolve a runtime scene NAME (e.g. `StarChef`) to its saved `Assets/**.unity` asset path via
        /// AssetDatabase. The record-first scene-agnostic flow infers the scenes a playthrough visited by
        /// NAME (from the observer) and must open + scan each one, which needs the asset path. Read-only.
        ///
        /// Returns `scene_path: null` + `match_count: 0` when no scene asset has that name (the caller
        /// treats that as can't-verify — it can't open a scene it can't find), and reports `match_count`
        /// so an AMBIGUOUS name (two `StarChef.unity` in different folders) is visible rather than a silent
        /// pick — the caller refuses on ambiguity rather than guess the wrong scene.
        /// </summary>
        private JObject HandleFindByName(JObject parameters)
        {
            string name = parameters.Value<string>("name");
            if (string.IsNullOrEmpty(name))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'name'");

            // Exact-name scene assets only (FindAssets does a fuzzy match, so filter by file name).
            string[] guids = AssetDatabase.FindAssets($"{name} t:Scene");
            var paths = new System.Collections.Generic.List<string>();
            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (Path.GetFileNameWithoutExtension(path) == name && !paths.Contains(path))
                    paths.Add(path);
            }

            return new JObject
            {
                ["scene_name"] = name,
                ["scene_path"] = paths.Count == 1 ? paths[0] : null,
                ["match_count"] = paths.Count,
                ["matches"] = new JArray(paths.ToArray()),
            };
        }

        private JObject HandleSaveScene(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'path'");

            // Auto-create the parent directory (mkdir -p) so callers don't have to
            // pre-create Assets/Scenes. EditorSceneManager.SaveScene returns false
            // (no exception) if the target folder is missing, which used to surface
            // as a generic save failure; creating it here makes the op self-sufficient.
            EnsureParentDirectory(path);

            Scene activeScene = SceneManager.GetActiveScene();
            bool saved = EditorSceneManager.SaveScene(activeScene, path);

            if (!saved)
                throw new BridgeException(ErrorCodes.NOT_FOUND, $"Failed to save scene to: {path}");

            return new JObject
            {
                ["saved"] = true,
                ["path"] = path
            };
        }

        private JObject HandleCreateObject(JObject parameters)
        {
            string name = parameters.Value<string>("name") ?? "GameObject";

            GameObject go = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");

            // Optional parent
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator != null)
            {
                GameObject parent = LocatorResolver.Resolve(parentLocator);
                Undo.SetTransformParent(go.transform, parent.transform, $"Set parent of {name}");
            }

            // Optional transform.
            //
            // NOTE on coordinate space: 'position' is applied as a LOCAL position
            // (relative to the parent, if any). When a 'parent' is set this is often
            // surprising — a child placed at position (8, 4) lands at the parent's
            // origin + (8, 4), not world (8, 4). Pass 'worldPosition' instead to place
            // the object at an absolute world-space point regardless of parent. If both
            // are supplied, 'worldPosition' wins (it is applied after 'position').
            JObject position = parameters.Value<JObject>("position");
            if (position != null)
                go.transform.localPosition = ParseVector3(position);

            JObject worldPosition = parameters.Value<JObject>("worldPosition");
            if (worldPosition != null)
                go.transform.position = ParseVector3(worldPosition);

            JObject rotation = parameters.Value<JObject>("rotation");
            if (rotation != null)
                go.transform.localEulerAngles = ParseVector3(rotation);

            JObject scale = parameters.Value<JObject>("scale");
            if (scale != null)
                go.transform.localScale = ParseVector3(scale);

            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        /// <summary>
        /// Create a primitive GameObject (Cube/Sphere/Capsule/Cylinder/Plane/Quad) in one call via
        /// GameObject.CreatePrimitive — mesh + renderer + (by default) a matching collider — then
        /// apply optional name/parent/transform exactly like HandleCreateObject. This is the
        /// gray-box / blockout fast path so callers don't hand-assemble an empty GameObject with
        /// MeshFilter + MeshRenderer + a by-name built-in mesh lookup. Pass addCollider:false to
        /// strip the auto-added Collider (e.g. a pure visual decoration). Returns the new locator.
        /// </summary>
        private JObject HandleCreatePrimitive(JObject parameters)
        {
            string primitiveStr = parameters.Value<string>("primitive");
            if (string.IsNullOrEmpty(primitiveStr))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'primitive'");

            PrimitiveType primitiveType;
            switch (primitiveStr)
            {
                case "Cube": primitiveType = PrimitiveType.Cube; break;
                case "Sphere": primitiveType = PrimitiveType.Sphere; break;
                case "Capsule": primitiveType = PrimitiveType.Capsule; break;
                case "Cylinder": primitiveType = PrimitiveType.Cylinder; break;
                case "Plane": primitiveType = PrimitiveType.Plane; break;
                case "Quad": primitiveType = PrimitiveType.Quad; break;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'primitive': '{primitiveStr}'. Expected one of Cube, Sphere, Capsule, Cylinder, Plane, Quad.");
            }

            GameObject go = GameObject.CreatePrimitive(primitiveType);
            // Default the name to the primitive type (Unity already does this, but be explicit so a
            // caller-supplied name wins predictably).
            string name = parameters.Value<string>("name");
            if (!string.IsNullOrEmpty(name))
                go.name = name;
            Undo.RegisterCreatedObjectUndo(go, $"Create {go.name}");

            // addCollider defaults to true. When false, remove the Collider that
            // CreatePrimitive auto-adds (e.g. a non-colliding visual decoration).
            bool addCollider = parameters.Value<bool?>("addCollider") ?? true;
            if (!addCollider)
            {
                Collider collider = go.GetComponent<Collider>();
                if (collider != null)
                    Undo.DestroyObjectImmediate(collider);
            }

            // Optional parent (same semantics as HandleCreateObject).
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator != null)
            {
                GameObject parent = LocatorResolver.Resolve(parentLocator);
                Undo.SetTransformParent(go.transform, parent.transform, $"Set parent of {go.name}");
            }

            // Optional transform. 'position' is LOCAL; 'worldPosition' is absolute and wins when
            // both are set (applied after 'position') — mirrors HandleCreateObject exactly.
            JObject position = parameters.Value<JObject>("position");
            if (position != null)
                go.transform.localPosition = ParseVector3(position);

            JObject worldPosition = parameters.Value<JObject>("worldPosition");
            if (worldPosition != null)
                go.transform.position = ParseVector3(worldPosition);

            JObject rotation = parameters.Value<JObject>("rotation");
            if (rotation != null)
                go.transform.localEulerAngles = ParseVector3(rotation);

            JObject scale = parameters.Value<JObject>("scale");
            if (scale != null)
                go.transform.localScale = ParseVector3(scale);

            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        /// <summary>
        /// RCL-T05: set a GameObject's layer by NAME or INDEX. Layers drive raycast masks, LOS,
        /// and cover checks in a shooter, and there was no op for it (gameobject.set_layer →
        /// "Unknown category"; component.set_property{type_name:"GameObject"} → INVALID_TYPE).
        /// 'layer' accepts an integer index (0-31) or a defined layer NAME. Pass includeChildren:true
        /// to recurse the whole hierarchy (common for a whole arena piece on one layer). Returns the
        /// resolved layer index + name.
        /// </summary>
        private JObject HandleSetLayer(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            JToken layerToken = parameters?["layer"];
            if (layerToken == null || layerToken.Type == JTokenType.Null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'layer' (a layer name or an index 0-31).");

            int layerIndex;
            if (layerToken.Type == JTokenType.Integer || layerToken.Type == JTokenType.Float)
            {
                layerIndex = layerToken.Value<int>();
                if (layerIndex < 0 || layerIndex > 31)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Layer index {layerIndex} is out of range (must be 0-31).");
                if (string.IsNullOrEmpty(LayerMask.LayerToName(layerIndex)))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Layer index {layerIndex} is not a defined layer. Define it in Project Settings > Tags and Layers first.");
            }
            else
            {
                string layerName = layerToken.Value<string>();
                if (string.IsNullOrEmpty(layerName))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "'layer' name cannot be empty.");
                layerIndex = LayerMask.NameToLayer(layerName);
                if (layerIndex < 0)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Layer '{layerName}' is not a defined layer. Define it in Project Settings > Tags and Layers first.");
            }

            GameObject go = LocatorResolver.Resolve(locator);
            bool includeChildren = parameters.Value<bool?>("includeChildren") ?? false;

            Undo.RegisterFullObjectHierarchyUndo(go, $"Set layer of {go.name}");
            go.layer = layerIndex;
            if (includeChildren)
            {
                foreach (Transform child in go.GetComponentsInChildren<Transform>(true))
                    child.gameObject.layer = layerIndex;
            }
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange($"{DescribeTargetPath(go)} layer = {LayerMask.LayerToName(layerIndex)} ({layerIndex})");

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["layer"] = layerIndex,
                ["layerName"] = LayerMask.LayerToName(layerIndex),
                ["includeChildren"] = includeChildren
            };
        }

        /// <summary>
        /// RCL-T05: set a GameObject's tag. The tag MUST already exist — Unity throws on an
        /// undefined tag, so we check first and return a clear NOT_FOUND rather than letting an
        /// opaque UnityException bubble. (Creating a missing tag is intentionally out of scope.)
        /// </summary>
        private JObject HandleSetTag(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            string tag = parameters.Value<string>("tag");
            if (string.IsNullOrEmpty(tag))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'tag'.");

            if (Array.IndexOf(UnityEditorInternal.InternalEditorUtility.tags, tag) < 0)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Tag '{tag}' is not defined. Add it in Project Settings > Tags and Layers first " +
                    "(creating a missing tag is out of scope for this op).");

            GameObject go = LocatorResolver.Resolve(locator);
            Undo.RegisterCompleteObjectUndo(go, $"Set tag of {go.name}");
            go.tag = tag;
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange($"{DescribeTargetPath(go)} tag = {tag}");

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["tag"] = go.tag
            };
        }

        // Hierarchy path for Show Work log lines, falling back to the GameObject name.
        private static string DescribeTargetPath(GameObject go)
        {
            if (go == null) return "?";
            string path = LocatorResolver.BuildLocator(go)?.Value<string>("path");
            return string.IsNullOrEmpty(path) ? go.name : path;
        }

        private JObject HandleDeleteObject(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            string name = go.name;
            Undo.DestroyObjectImmediate(go);

            return new JObject
            {
                ["deleted"] = true,
                ["name"] = name
            };
        }

        private JObject HandleDuplicateObject(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject source = LocatorResolver.Resolve(locator);

            // Instantiate preserves components, child hierarchy, and the source's local
            // transform; by default the clone is parented under the same parent as the
            // source (Object.Instantiate keeps the source's parent when none is given).
            GameObject clone = UnityEngine.Object.Instantiate(source, source.transform.parent);
            // Unity appends "(Clone)" to instantiated names; strip it so a re-duplicated
            // object doesn't accumulate "(Clone)(Clone)". An explicit 'name' wins.
            string explicitName = parameters.Value<string>("name");
            clone.name = !string.IsNullOrEmpty(explicitName) ? explicitName : source.name;
            Undo.RegisterCreatedObjectUndo(clone, $"Duplicate {source.name}");

            // Optional re-parent of the clone (default: keep source's parent).
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator != null)
            {
                GameObject parent = LocatorResolver.Resolve(parentLocator);
                Undo.SetTransformParent(clone.transform, parent.transform, $"Set parent of {clone.name}");
            }

            ShowWorkVisualizer.SelectObject(clone);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(clone)
            };
        }

        private JObject HandleSetParent(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);

            // 'parent' omitted/null means unparent to the scene root.
            JObject parentLocator = parameters.Value<JObject>("parent");
            Transform parentTransform = null;
            if (parentLocator != null)
            {
                GameObject parent = LocatorResolver.Resolve(parentLocator);
                parentTransform = parent.transform;
            }

            // Unity keeps world position by default when reparenting; honor an explicit
            // worldPositionStays=false to preserve LOCAL transform values instead.
            bool worldPositionStays = parameters.Value<bool?>("worldPositionStays") ?? true;

            Undo.SetTransformParent(go.transform, parentTransform, worldPositionStays, $"Set parent of {go.name}");

            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        /// <summary>
        /// GRL-B02: reorder a GameObject among its siblings (same-parent SetSiblingIndex). A
        /// same-parent scene.set_parent is a NO-OP for reordering, but sibling order is load-bearing
        /// for uGUI draw order — a LATER sibling paints OVER an earlier one — so fixing e.g. "a Filled
        /// bar covers its label" previously forced hand-editing the scene YAML child list + a reload.
        /// Provide EXACTLY ONE of:
        ///   - index: absolute 0-based target sibling index (0 = first, drawn first / behind later siblings).
        ///   - before: a sibling (locator object OR a bare name string) to sit immediately BEFORE.
        ///   - after: a sibling (locator OR name) to sit immediately AFTER.
        /// Supplying more than one positioning arg (ambiguous) or none is REFUSED, never guessed. An
        /// out-of-range absolute index is REFUSED with the valid range (never silently clamped — a
        /// clamp would misreport where the object actually landed). before/after refuse a reference
        /// that is the object itself or lives under a DIFFERENT parent (sibling order is only defined
        /// within one parent). Undo-recorded + marks the scene dirty. Returns the resolved parentPath
        /// and old->new sibling index plus siblingCount.
        /// </summary>
        private JObject HandleSetSiblingIndex(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            Transform t = go.transform;
            Transform parent = t.parent;

            // Sibling ordering domain: the parent's children when parented, else the scene-root order.
            int siblingCount = parent != null ? parent.childCount : go.scene.rootCount;

            JToken indexToken = parameters["index"];
            bool hasIndex = indexToken != null && indexToken.Type != JTokenType.Null;
            JToken beforeToken = parameters["before"];
            bool hasBefore = beforeToken != null && beforeToken.Type != JTokenType.Null;
            JToken afterToken = parameters["after"];
            bool hasAfter = afterToken != null && afterToken.Type != JTokenType.Null;

            int provided = (hasIndex ? 1 : 0) + (hasBefore ? 1 : 0) + (hasAfter ? 1 : 0);
            if (provided == 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide exactly one of 'index' (absolute), 'before', or 'after' to position the sibling.");
            if (provided > 1)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide exactly ONE of 'index', 'before', or 'after' — they are mutually exclusive. Refusing an ambiguous request.");

            int oldIndex = t.GetSiblingIndex();
            int targetIndex;

            if (hasIndex)
            {
                if (indexToken.Type != JTokenType.Integer)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'index' must be an integer, got {indexToken.Type}.");
                targetIndex = indexToken.Value<int>();
                if (targetIndex < 0 || targetIndex > siblingCount - 1)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'index' {targetIndex} is out of range: valid sibling indices are 0..{siblingCount - 1} " +
                        $"({siblingCount} sibling(s) under {DescribeParent(parent)}). Refusing (a silent clamp would misreport where it landed).");
            }
            else
            {
                JToken refToken = hasBefore ? beforeToken : afterToken;
                string argName = hasBefore ? "before" : "after";
                Transform refT = ResolveSibling(refToken, parent, go.scene, argName);
                if (refT == t)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'{argName}' references the object itself — cannot position it relative to itself.");
                int refIndex = refT.GetSiblingIndex();
                // SetSiblingIndex targets an absolute post-removal index; the target differs by whether
                // the object currently sits before or after the reference.
                if (hasBefore)
                    targetIndex = (oldIndex < refIndex) ? refIndex - 1 : refIndex;
                else
                    targetIndex = (oldIndex < refIndex) ? refIndex : refIndex + 1;
            }

            // Recording the PARENT captures the child ordering, so PerformUndo restores the original
            // sibling order. For a scene-root object there is no parent to record — root ordering lives
            // in the scene's m_Roots, which RegisterFullObjectHierarchyUndo(go) does NOT capture, so a
            // root-level reorder may not be undo-restorable (the load-bearing uGUI case always has a
            // Canvas parent and is fully undoable).
            GameObject undoTarget = parent != null ? parent.gameObject : go;
            Undo.RegisterFullObjectHierarchyUndo(undoTarget, $"Set sibling index of {go.name}");
            t.SetSiblingIndex(targetIndex);
            int newIndex = t.GetSiblingIndex();

            EditorSceneManager.MarkSceneDirty(go.scene);
            ShowWorkVisualizer.SelectObject(go);
            ShowWorkVisualizer.LogChange($"{DescribeTargetPath(go)} sibling index {oldIndex} -> {newIndex}");

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["parentPath"] = parent != null ? DescribeTargetPath(parent.gameObject) : null,
                ["oldIndex"] = oldIndex,
                ["newIndex"] = newIndex,
                ["siblingCount"] = siblingCount
            };
        }

        /// <summary>
        /// Resolve a before/after reference sibling from either a locator OBJECT or a bare NAME string,
        /// enforcing it shares the SAME parent as the object being reordered. A name that matches no
        /// same-parent sibling is NOT_FOUND; a name that matches more than one is refused (ambiguous)
        /// rather than guessed — pass a locator to disambiguate.
        /// </summary>
        private static Transform ResolveSibling(JToken refToken, Transform parent, Scene scene, string argName)
        {
            if (refToken.Type == JTokenType.Object)
            {
                GameObject refGo = LocatorResolver.Resolve((JObject)refToken);
                if (refGo.transform.parent != parent)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'{argName}' sibling '{refGo.name}' has a different parent than the object being reordered — " +
                        "sibling order is only defined within a single parent.");
                return refGo.transform;
            }
            if (refToken.Type == JTokenType.String)
            {
                string name = refToken.Value<string>();
                if (string.IsNullOrEmpty(name))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, $"'{argName}' name cannot be empty.");

                var matches = new List<Transform>();
                if (parent != null)
                {
                    for (int i = 0; i < parent.childCount; i++)
                    {
                        Transform c = parent.GetChild(i);
                        if (c.name == name) matches.Add(c);
                    }
                }
                else
                {
                    foreach (GameObject root in scene.GetRootGameObjects())
                        if (root.name == name) matches.Add(root.transform);
                }

                if (matches.Count == 0)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"'{argName}' sibling named '{name}' not found under {DescribeParent(parent)}.");
                if (matches.Count > 1)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'{argName}' name '{name}' is ambiguous — {matches.Count} siblings share it under {DescribeParent(parent)}. Use a locator instead.");
                return matches[0];
            }
            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"'{argName}' must be a locator object or a sibling-name string, got {refToken.Type}.");
        }

        // Human-readable parent description for sibling-reorder errors.
        private static string DescribeParent(Transform parent)
        {
            return parent != null ? $"'{DescribeTargetPath(parent.gameObject)}'" : "the scene root";
        }

        /// <summary>
        /// Find a SINGLE GameObject and return its locator + transform. Two resolution modes:
        ///
        ///   - locator / path: resolve through <see cref="LocatorResolver"/> — byte-identical to
        ///     runtime.get_snapshot, INCLUDING index-0 selection when sibling names collide (so
        ///     find_object{path:"/Enemy_Chaser"} resolves the first of two same-named siblings
        ///     instead of nulling). A bare 'path' string is accepted as shorthand for a
        ///     { path } locator.
        ///   - name: recursive first-match across all loaded scenes (legacy behavior).
        ///
        /// A benign miss is NOT an exception: this returns { found:false, locator:null } so the
        /// OpExecutor does not capture an error-screenshot artifact for an ordinary not-found.
        /// Artifacts stay reserved for real exceptions (bad params, internal errors). The return
        /// is always a single object — never an array — so existing callers are unaffected on a
        /// hit (the success shape adds a "found":true flag and keeps locator/position/rotation/scale).
        /// </summary>
        private JObject HandleFindObject(JObject parameters)
        {
            // Prefer locator/path resolution (unified with get_snapshot) when supplied.
            JObject locator = parameters.Value<JObject>("locator");
            string path = parameters.Value<string>("path");
            string name = parameters.Value<string>("name");

            if (locator == null && !string.IsNullOrEmpty(path))
                locator = new JObject { ["path"] = path };

            if (locator != null)
            {
                // LocatorResolver.Resolve throws LOCATOR_UNRESOLVED on a miss; treat that as a
                // benign not-found (found:false) rather than letting it bubble to an error+artifact.
                GameObject resolved;
                try
                {
                    resolved = LocatorResolver.Resolve(locator);
                }
                catch (BridgeException)
                {
                    resolved = null;
                }
                return BuildFindResult(resolved);
            }

            if (string.IsNullOrEmpty(name))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide a 'name', 'path', or 'locator' to find an object.");

            // Name mode: recursive first-match across all loaded scenes.
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;

                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    GameObject found = FindRecursive(root, name);
                    if (found != null)
                        return BuildFindResult(found);
                }
            }

            return BuildFindResult(null);
        }

        /// <summary>
        /// Shared success/miss shape for find_object. On a hit: found=true plus the locator and
        /// world transform. On a miss: found=false, locator=null (a benign result, never an error).
        /// </summary>
        private static JObject BuildFindResult(GameObject go)
        {
            if (go == null)
            {
                return new JObject
                {
                    ["found"] = false,
                    ["locator"] = null
                };
            }

            Transform t = go.transform;
            return new JObject
            {
                ["found"] = true,
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["position"] = Vector3ToJObject(t.position),
                ["rotation"] = Vector3ToJObject(t.eulerAngles),
                ["scale"] = Vector3ToJObject(t.localScale)
            };
        }

        private JObject HandleSetTransform(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            Transform t = go.transform;

            Undo.RecordObject(t, $"Set transform of {go.name}");

            JObject position = parameters.Value<JObject>("position");
            if (position != null)
                t.position = ParseVector3(position);

            JObject rotation = parameters.Value<JObject>("rotation");
            if (rotation != null)
                t.eulerAngles = ParseVector3(rotation);

            JObject scale = parameters.Value<JObject>("scale");
            if (scale != null)
                t.localScale = ParseVector3(scale);

            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["position"] = Vector3ToJObject(t.position),
                ["rotation"] = Vector3ToJObject(t.eulerAngles),
                ["scale"] = Vector3ToJObject(t.localScale)
            };
        }

        private JObject HandleGetHierarchy(JObject parameters)
        {
            int depth = parameters?.Value<int?>("depth") ?? -1;
            return HierarchyCapture.CaptureHierarchy(depth);
        }

        private JObject HandleSelectObject(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);
            Selection.activeGameObject = go;
            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["selected"] = true,
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        // Toggle a GameObject's active self-state (GameObject.SetActive). Useful to enable
        // an inactive-by-default object for verification (e.g. a mobile-controls canvas that
        // a desktop default leaves off) without modifying the game. Reports both activeSelf
        // and activeInHierarchy so the caller can tell whether an inactive ancestor still
        // keeps it hidden.
        private JObject HandleSetActive(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            JToken activeToken = parameters?["active"];
            if (activeToken == null || activeToken.Type == JTokenType.Null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'active' (bool)");
            bool active = activeToken.Value<bool>();

            GameObject go = LocatorResolver.Resolve(locator);
            Undo.RegisterCompleteObjectUndo(go, $"Set active of {go.name}");
            go.SetActive(active);
            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["activeSelf"] = go.activeSelf,
                ["activeInHierarchy"] = go.activeInHierarchy
            };
        }

        private JObject HandleGetBounds(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            bool debug = parameters.Value<bool?>("debug") ?? false;
            return BoundsCapture.Describe(locator, debug);
        }

        private JObject HandleFrameObject(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            GameObject go = LocatorResolver.Resolve(locator);

            bool select = parameters.Value<bool?>("select") ?? true;
            if (select)
                Selection.activeGameObject = go;

            // Frame the live SceneView on the object (mirrors a human pressing F after
            // selecting). The deterministic close-up for captures is screenshot's
            // focusLocator; this is for the human watching the editor.
            Bounds? bounds = BoundsCapture.CombinedBounds(go);
            SceneView sv = SceneView.lastActiveSceneView;
            if (sv == null && SceneView.sceneViews != null && SceneView.sceneViews.Count > 0)
                sv = SceneView.sceneViews[0] as SceneView;

            bool framed = false;
            if (sv != null && bounds.HasValue)
            {
                sv.Frame(bounds.Value, instant: true);
                sv.Repaint();
                framed = true;
            }

            var result = new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["selected"] = select,
                ["framed"] = framed
            };
            if (bounds.HasValue)
            {
                result["bounds"] = new JObject
                {
                    ["center"] = Vector3ToJObject(bounds.Value.center),
                    ["size"] = Vector3ToJObject(bounds.Value.size)
                };
            }
            return result;
        }

        private JObject HandleGetScreenRects(JObject parameters)
        {
            JArray locators = parameters.Value<JArray>("locators");
            JObject camera = parameters.Value<JObject>("camera");
            string boundsMode = parameters.Value<string>("boundsMode");
            return ScreenSpaceIntrospection.GetScreenRects(locators, camera, boundsMode);
        }

        private JObject HandleVerifyManifest(JObject parameters)
        {
            return ManifestVerification.Verify(parameters);
        }

        /// <summary>
        /// Read the active scene's global lighting/environment RenderSettings (per-scene state)
        /// as a flat JSON payload: ambient source + colors + intensity (ambientColor and
        /// ambientSkyColor MIRROR each other — same underlying property), fog params, the assigned
        /// skybox material (as an asset path or null), the sun light (as a locator or null, plus
        /// sunEnabled), and the subtractive shadow color. Read-only; never mutates the scene. This is the round-trip
        /// counterpart to set_render_settings — the art-integration dogfood had to edit lighting via
        /// scene-YAML patches + reloads (which clobbered unsaved in-memory scene state); driving
        /// RenderSettings through the bridge avoids that failure mode entirely.
        ///
        /// SCOPE: scene-level UnityEngine.RenderSettings only. It does NOT read or mutate the URP
        /// asset / Volume framework post-processing — that is a separate slice.
        /// </summary>
        private JObject HandleGetRenderSettings(JObject parameters)
        {
            return BuildRenderSettingsPayload();
        }

        /// <summary>
        /// Set any subset of the active scene's global RenderSettings. Every field is optional and
        /// only PROVIDED fields are applied (a partial update leaves the rest untouched). Colors use
        /// the same { r, g, b, a } float format as create_material / ui.add_image (missing channels
        /// default to 1, via the shared ColorParsing helper).
        ///
        /// ATOMIC: validate-then-apply. ALL params are parsed and every referenced asset/object
        /// (skybox material, sun locator) is resolved BEFORE the first RenderSettings write, so a
        /// failed call leaves the scene's render settings completely untouched — never a partial
        /// ambient-applied-but-skybox-failed state.
        ///
        /// ALIASING: 'ambient_color' (RenderSettings.ambientLight) and 'ambient_sky_color'
        /// (RenderSettings.ambientSkyColor) are the SAME underlying per-scene property
        /// (m_AmbientSkyColor) — Unity exposes two names for one slot. Supplying both with
        /// different values is refused (INVALID_PARAMS) rather than silently dropping one.
        ///
        /// 'skybox_material' is an asset path (empty string / null clears it; a path to a
        /// non-Material asset is INVALID_PARAMS "exists but is not a Material", a missing asset is
        /// NOT_FOUND). 'sun' is a GameObject locator carrying a Light (null clears it).
        /// 'ambient_mode' / 'fog_mode' are string enums validated against the Unity enums — an
        /// unknown value is INVALID_PARAMS listing the valid values, and 'Custom' ambient mode is
        /// refused (this op cannot populate the ambient probe, so Custom would yield undefined
        /// ambient lighting).
        ///
        /// The active scene is marked dirty only when a value actually CHANGED (RenderSettings
        /// edits are NOT captured by Undo, so we dirty explicitly; a no-op call never dirties).
        /// Pass save:true to also write the scene to disk — refused (INVALID_PARAMS) on an untitled
        /// scene rather than silently skipping the save. Returns the resulting get_render_settings
        /// payload.
        ///
        /// SCOPE: scene-level UnityEngine.RenderSettings only — NO URP-asset / Volume mutation.
        /// </summary>
        private JObject HandleSetRenderSettings(JObject parameters)
        {
            // ═══ Phase 1: validate + resolve EVERYTHING before any write (atomicity) ═══

            string ambientModeStr = parameters.Value<string>("ambient_mode")
                ?? parameters.Value<string>("ambientMode");
            AmbientMode? ambientMode = !string.IsNullOrEmpty(ambientModeStr)
                ? ParseAmbientMode(ambientModeStr)
                : (AmbientMode?)null;

            // 'ambient_color' (ambientLight) and 'ambient_sky_color' (ambientSkyColor) alias the
            // SAME underlying property — both-with-different-values is a contradiction, refuse.
            Color? ambientColorAlias = ParseColorParam(parameters, "ambient_color", "ambientColor");
            Color? ambientSky = ParseColorParam(parameters, "ambient_sky_color", "ambientSkyColor");
            if (ambientColorAlias.HasValue && ambientSky.HasValue
                && ambientColorAlias.Value != ambientSky.Value)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "'ambient_color' and 'ambient_sky_color' are aliases of the SAME underlying " +
                    "RenderSettings property (ambientLight == ambientSkyColor); supplying both with " +
                    "different values is contradictory. Provide just one (or both with equal values).");
            }
            Color? effectiveAmbientSky = ambientSky ?? ambientColorAlias;

            Color? ambientEquator = ParseColorParam(parameters, "ambient_equator_color", "ambientEquatorColor");
            Color? ambientGround = ParseColorParam(parameters, "ambient_ground_color", "ambientGroundColor");
            float? ambientIntensity = parameters.Value<float?>("ambient_intensity")
                ?? parameters.Value<float?>("ambientIntensity");

            bool? fog = parameters.Value<bool?>("fog");
            Color? fogColor = ParseColorParam(parameters, "fog_color", "fogColor");
            string fogModeStr = parameters.Value<string>("fog_mode")
                ?? parameters.Value<string>("fogMode");
            FogMode? fogMode = !string.IsNullOrEmpty(fogModeStr)
                ? ParseFogMode(fogModeStr)
                : (FogMode?)null;
            float? fogDensity = parameters.Value<float?>("fog_density")
                ?? parameters.Value<float?>("fogDensity");
            float? fogStart = parameters.Value<float?>("fog_start_distance")
                ?? parameters.Value<float?>("fogStartDistance");
            float? fogEnd = parameters.Value<float?>("fog_end_distance")
                ?? parameters.Value<float?>("fogEndDistance");

            // Skybox material: absent → untouched; null/empty → clear; path → must resolve to a
            // Material (a wrong-typed asset gets a clearer error than a missing one).
            bool skyboxProvided = false;
            Material skyboxTarget = null;
            JToken skyboxToken = parameters["skybox_material"] ?? parameters["skyboxMaterial"];
            if (skyboxToken != null)
            {
                skyboxProvided = true;
                if (skyboxToken.Type != JTokenType.Null)
                {
                    if (skyboxToken.Type != JTokenType.String)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"'skybox_material' must be an asset-path string (or null to clear), got {skyboxToken.Type}.");
                    string skyboxPath = skyboxToken.Value<string>();
                    if (!string.IsNullOrEmpty(skyboxPath))
                    {
                        skyboxTarget = AssetDatabase.LoadAssetAtPath<Material>(skyboxPath);
                        if (skyboxTarget == null)
                        {
                            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(skyboxPath) != null)
                                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                    $"Asset at '{skyboxPath}' exists but is not a Material.");
                            throw new BridgeException(ErrorCodes.NOT_FOUND,
                                $"Skybox material not found at path: '{skyboxPath}'");
                        }
                    }
                }
            }

            // Sun light: absent → untouched; null → clear; locator → must carry a Light.
            bool sunProvided = false;
            Light sunTarget = null;
            JToken sunToken = parameters["sun"];
            if (sunToken != null)
            {
                sunProvided = true;
                if (sunToken.Type == JTokenType.Object)
                {
                    GameObject sunGo = LocatorResolver.Resolve((JObject)sunToken);
                    sunTarget = sunGo.GetComponent<Light>();
                    if (sunTarget == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"'sun' target '{sunGo.name}' has no Light component. The sun must be a GameObject carrying a Light.");
                }
                else if (sunToken.Type != JTokenType.Null)
                {
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "'sun' must be a GameObject locator object (or null to clear).");
                }
            }

            Color? subtractiveShadow = ParseColorParam(parameters, "subtractive_shadow_color", "subtractiveShadowColor");

            // save:true on an untitled scene cannot work — refuse honestly instead of silently
            // skipping the save. Validated here so the refusal happens before ANY write.
            bool save = parameters.Value<bool?>("save") ?? false;
            Scene activeScene = SceneManager.GetActiveScene();
            if (save && string.IsNullOrEmpty(activeScene.path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Cannot save an untitled scene — save it once via scene.save_scene with a path first.");

            // ═══ Phase 2: apply (everything above is validated; no exception fires below) ═══

            JObject before = BuildRenderSettingsPayload();

            if (ambientMode.HasValue)
                RenderSettings.ambientMode = ambientMode.Value;
            if (effectiveAmbientSky.HasValue)
                RenderSettings.ambientSkyColor = effectiveAmbientSky.Value; // == ambientLight (same slot)
            if (ambientEquator.HasValue)
                RenderSettings.ambientEquatorColor = ambientEquator.Value;
            if (ambientGround.HasValue)
                RenderSettings.ambientGroundColor = ambientGround.Value;
            if (ambientIntensity.HasValue)
                RenderSettings.ambientIntensity = ambientIntensity.Value;

            if (fog.HasValue)
                RenderSettings.fog = fog.Value;
            if (fogColor.HasValue)
                RenderSettings.fogColor = fogColor.Value;
            if (fogMode.HasValue)
                RenderSettings.fogMode = fogMode.Value;
            if (fogDensity.HasValue)
                RenderSettings.fogDensity = fogDensity.Value;
            if (fogStart.HasValue)
                RenderSettings.fogStartDistance = fogStart.Value;
            if (fogEnd.HasValue)
                RenderSettings.fogEndDistance = fogEnd.Value;

            if (skyboxProvided)
                RenderSettings.skybox = skyboxTarget;
            if (sunProvided)
                RenderSettings.sun = sunTarget;
            if (subtractiveShadow.HasValue)
                RenderSettings.subtractiveShadowColor = subtractiveShadow.Value;

            // ═══ Phase 3: dirty only on an ACTUAL change, then optionally save ═══

            JObject after = BuildRenderSettingsPayload();

            // RenderSettings is per-scene serialized state and its edits are NOT captured by Undo,
            // so dirty explicitly — but only when something actually changed (an empty or no-op
            // set call must not dirty the scene).
            if (!JToken.DeepEquals(before, after))
                EditorSceneManager.MarkSceneDirty(activeScene);

            if (save)
                EditorSceneManager.SaveScene(activeScene);

            return after;
        }

        /// <summary>
        /// scene.find_references_to: scan every component in the loaded scenes for a serialized
        /// ObjectReference that points at the target GameObject, any of its components, or ANY of its
        /// DESCENDANTS (and their components) — the scan surface equals the destroy surface. This is
        /// the pre-flight for a destructive prefab swap — an agent runs it BEFORE replace_with_prefab
        /// to see exactly what would be severed (the dogfood minimap incident: a cached extract-point ref —
        /// the severed ref pointed at a transform on a CHILD under the beacon). Bounded +
        /// deterministic. Read-only.
        /// </summary>
        private JObject HandleFindReferencesTo(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'locator'");

            int maxResults = parameters.Value<int?>("max_results")
                ?? parameters.Value<int?>("maxResults")
                ?? ReferenceScanner.DefaultMaxResults;

            GameObject target = LocatorResolver.Resolve(locator);
            return ReferenceScanner.BuildFindReferencesResult(target, maxResults);
        }

        /// <summary>
        /// scene.validate_references: report every NULL serialized ObjectReference property in scope
        /// (a locator subtree, or ALL loaded scenes by default), grouped-by-component via
        /// deterministic ordering. Honest + simple — a ref is reported purely because it is null; a
        /// severed "Missing" ref (null value, non-zero instanceID) is flagged missing:true. Pass
        /// include_prefab_defaults:true to additionally annotate each null with whether the prefab
        /// source had a value there. Read-only.
        /// </summary>
        private JObject HandleValidateReferences(JObject parameters)
        {
            JObject scopeLocator = parameters.Value<JObject>("scope");
            GameObject scope = scopeLocator != null ? LocatorResolver.Resolve(scopeLocator) : null;

            bool includePrefabDefaults = parameters.Value<bool?>("include_prefab_defaults")
                ?? parameters.Value<bool?>("includePrefabDefaults")
                ?? false;

            int maxResults = parameters.Value<int?>("max_results")
                ?? parameters.Value<int?>("maxResults")
                ?? ReferenceScanner.DefaultMaxResults;

            return ReferenceScanner.BuildValidateReferencesResult(scope, includePrefabDefaults, maxResults);
        }

        // ─────────────────────────────────────────────
        // Gameplay geometry safety profile (art scene safety profile — RLH-W3)
        // ─────────────────────────────────────────────

        /// <summary>
        /// scene.snapshot_gameplay_geometry: walk all loaded scenes and write a DETERMINISTIC JSON
        /// document of every collider/trigger (local-space geometry), plus layer/tag/active-state and
        /// the owning transform's world position/rotation/scale — DELIBERATELY excluding renderers and
        /// all visual-only data. This is the baseline half of the "art scene safety profile": an art
        /// pass must be visual-only, so this snapshot (taken BEFORE the pass) is what
        /// compare_gameplay_geometry checks the post-art scene against. output_path is project-relative
        /// and bridge-written so the artifact is diffable later. Two snapshots of an unchanged scene are
        /// byte-identical.
        /// </summary>
        private JObject HandleSnapshotGameplayGeometry(JObject parameters)
        {
            string outputPath = parameters.Value<string>("output_path")
                ?? parameters.Value<string>("outputPath");
            if (string.IsNullOrEmpty(outputPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'output_path' (project-relative path for the snapshot JSON).");

            HashSet<string> includeTags = ParseStringSetParam(parameters, "include_tags", "includeTags");
            HashSet<int> layers = ParseLayerSetParam(parameters, "layers");

            string absPath = ResolveProjectRelativeWritePath(outputPath, "output_path");

            JObject snapshot = GameplayGeometrySnapshot.BuildSnapshot(includeTags, layers);

            string directory = Path.GetDirectoryName(absPath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            // Deterministic, diffable, POSIX-trailing-newline. Indented JSON is line-diff friendly and
            // byte-stable given identical scene state (no timestamps / instance IDs are emitted).
            string json = snapshot.ToString(Formatting.Indented) + "\n";
            File.WriteAllText(absPath, json);

            return new JObject
            {
                ["output_path"] = outputPath,
                ["absolute_path"] = absPath,
                ["schema_version"] = GameplayGeometrySnapshot.SchemaVersion,
                ["counts"] = snapshot["counts"]?.DeepClone(),
                ["scenes"] = snapshot["scenes"]?.DeepClone(),
                ["filters"] = snapshot["filters"]?.DeepClone(),
                ["bytes_written"] = System.Text.Encoding.UTF8.GetByteCount(json),
            };
        }

        /// <summary>
        /// scene.compare_gameplay_geometry: re-walk the LIVE scenes and diff against a baseline snapshot
        /// (produced by snapshot_gameplay_geometry). The live walk reuses the baseline's OWN stored
        /// filters so both cover the same surface. HONEST: a missing baseline is NOT_FOUND, an
        /// unreadable/unparseable or schema-mismatched baseline is INVALID_PARAMS — NEVER an empty diff.
        /// verdict is "changed" whenever anything was added, removed, or modified beyond tolerance. A
        /// renamed-but-identical object shows as removed+added (identity is the scene-qualified path; no
        /// fuzzy matching).
        /// </summary>
        private JObject HandleCompareGameplayGeometry(JObject parameters)
        {
            string baselinePath = parameters.Value<string>("baseline_path")
                ?? parameters.Value<string>("baselinePath");
            if (string.IsNullOrEmpty(baselinePath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'baseline_path' (project-relative path to a snapshot JSON).");

            string absPath = ResolveProjectRelativeWritePath(baselinePath, "baseline_path");
            if (!File.Exists(absPath))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Baseline snapshot not found at '{baselinePath}'. Produce one with scene.snapshot_gameplay_geometry first.");

            JObject baseline;
            try
            {
                baseline = JObject.Parse(File.ReadAllText(absPath));
            }
            catch (Exception ex)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Baseline snapshot at '{baselinePath}' is not readable JSON: {ex.Message}. Refusing (a corrupt baseline is not an empty diff).");
            }

            int? schema = baseline.Value<int?>("schema_version");
            if (schema == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Baseline snapshot at '{baselinePath}' has no 'schema_version' — it is not a gameplay-geometry snapshot. Refusing.");
            if (schema.Value != GameplayGeometrySnapshot.SchemaVersion)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Baseline snapshot schema_version {schema.Value} != expected {GameplayGeometrySnapshot.SchemaVersion}. Re-snapshot with the current bridge. Refusing (a mismatched schema is not an empty diff).");
            if (baseline["objects"] == null || baseline["objects"].Type != JTokenType.Array)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Baseline snapshot at '{baselinePath}' has no 'objects' array — not a gameplay-geometry snapshot. Refusing.");

            JObject tolerance = parameters.Value<JObject>("tolerance");
            double posTol = tolerance?.Value<double?>("position") ?? GameplayGeometrySnapshot.DefaultPositionTolerance;
            double rotTol = tolerance?.Value<double?>("rotation") ?? GameplayGeometrySnapshot.DefaultRotationToleranceDeg;
            double sizeTol = tolerance?.Value<double?>("size") ?? GameplayGeometrySnapshot.DefaultSizeTolerance;

            // The tolerance knob exists for float noise, NOT for laundering: an unbounded tolerance
            // (position: 9999) would make ANY move read unchanged. Bounds are generous for numeric
            // jitter yet useless for hiding a real change; out-of-range is refused, never clamped
            // silently (a silent clamp would misreport what was actually compared).
            ValidateToleranceBound("position", posTol, GameplayGeometrySnapshot.MaxPositionSizeTolerance);
            ValidateToleranceBound("size", sizeTol, GameplayGeometrySnapshot.MaxPositionSizeTolerance);
            ValidateToleranceBound("rotation", rotTol, GameplayGeometrySnapshot.MaxRotationToleranceDeg);

            JObject result = GameplayGeometrySnapshot.Compare(baseline, posTol, rotTol, sizeTol);
            result["baseline_path"] = baselinePath;
            return result;
        }

        /// <summary>
        /// Refuse a caller-supplied tolerance outside [0, max]. Negative tolerances are nonsensical;
        /// values above the cap would launder real geometry changes into "unchanged".
        /// </summary>
        private static void ValidateToleranceBound(string name, double value, double max)
        {
            if (double.IsNaN(value) || value < 0 || value > max)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'tolerance.{name}' {value} is out of range [0, {max}]. The tolerance knob absorbs float " +
                    "noise only — a larger value would launder real geometry changes into 'unchanged'. Refusing.");
        }

        /// <summary>
        /// Parse an optional string-array param (accepting a snake_case primary key + camelCase alias)
        /// into a set, or null when absent. An empty array is treated as null (no filter). A
        /// present-but-non-array value is a clean INVALID_PARAMS.
        /// </summary>
        private static HashSet<string> ParseStringSetParam(JObject parameters, string snakeKey, string camelKey)
        {
            JToken token = parameters[snakeKey] ?? parameters[camelKey];
            if (token == null || token.Type == JTokenType.Null)
                return null;
            if (token.Type != JTokenType.Array)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{snakeKey}' must be an array of strings, got {token.Type}.");
            var set = new HashSet<string>();
            foreach (JToken t in (JArray)token)
                set.Add(t.ToString());
            return set.Count > 0 ? set : null;
        }

        /// <summary>
        /// Parse an optional layers filter into a set of layer INDICES. Each element may be a layer
        /// index (int) OR a layer name (string, resolved via LayerMask.NameToLayer). An unknown layer
        /// name is REFUSED (INVALID_PARAMS) rather than silently matching nothing — a filter that
        /// silently matches nothing is a footgun. Returns null when absent/empty.
        /// </summary>
        private static HashSet<int> ParseLayerSetParam(JObject parameters, string key)
        {
            JToken token = parameters[key];
            if (token == null || token.Type == JTokenType.Null)
                return null;
            if (token.Type != JTokenType.Array)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{key}' must be an array of layer names or indices, got {token.Type}.");
            var set = new HashSet<int>();
            foreach (JToken t in (JArray)token)
            {
                if (t.Type == JTokenType.Integer)
                {
                    int idx = t.Value<int>();
                    if (idx < 0 || idx > 31)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"'{key}' layer index {idx} is out of range (0-31).");
                    set.Add(idx);
                }
                else
                {
                    string name = t.ToString();
                    int idx = LayerMask.NameToLayer(name);
                    if (idx < 0)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"'{key}' contains unknown layer name '{name}'. Use a defined layer name or a 0-31 index.");
                    set.Add(idx);
                }
            }
            return set.Count > 0 ? set : null;
        }

        /// <summary>
        /// Resolve a project-relative path to an absolute path, REFUSING absolute paths and any
        /// lexical escape of the project root (".." traversal, normalized via Path.GetFullPath).
        /// Mirrors CaptureHandler's within-root discipline: bridge-written artifacts must stay inside
        /// the project so they are diffable. NOTE: GetFullPath normalizes lexically only — it does NOT
        /// resolve symlinks, so a symlink inside the project pointing outside is not detected here
        /// (same guarantee level as the existing capture path checks).
        /// </summary>
        private static string ResolveProjectRelativeWritePath(string relativePath, string paramName)
        {
            if (Path.IsPathRooted(relativePath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{paramName}' must be project-relative, got an absolute path '{relativePath}'.");

            string projectRoot = Path.GetFullPath(
                Path.GetDirectoryName(Application.dataPath) ?? Directory.GetCurrentDirectory());
            string target = Path.GetFullPath(Path.Combine(projectRoot, relativePath));

            string rootTrim = projectRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string targetTrim = target.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            bool within = string.Equals(rootTrim, targetTrim, StringComparison.Ordinal)
                || targetTrim.StartsWith(rootTrim + Path.DirectorySeparatorChar, StringComparison.Ordinal);
            if (!within)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{paramName}' '{relativePath}' escapes the project root '{projectRoot}'. Paths must stay under the project.");

            return target;
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        private static Vector3 ParseVector3(JObject obj)
        {
            return new Vector3(
                obj.Value<float?>("x") ?? 0f,
                obj.Value<float?>("y") ?? 0f,
                obj.Value<float?>("z") ?? 0f
            );
        }

        // ─────────────────────────────────────────────
        // RenderSettings helpers
        // ─────────────────────────────────────────────

        /// <summary>
        /// Snapshot the active scene's RenderSettings into the flat JSON shape shared by both
        /// get_render_settings and set_render_settings's return value. All ambient colors are
        /// reported regardless of mode so a caller can see the full state. NOTE: ambientColor
        /// (RenderSettings.ambientLight) and ambientSkyColor are the SAME underlying property, so
        /// they always MIRROR each other — both are reported for discoverability under either name.
        /// sunEnabled surfaces the sun Light's enabled state (null when no sun is assigned) so a
        /// disabled sun is visible rather than looking like a lit-but-dark mystery.
        /// </summary>
        private static JObject BuildRenderSettingsPayload()
        {
            Material skybox = RenderSettings.skybox;
            string skyboxPath = skybox != null ? AssetDatabase.GetAssetPath(skybox) : null;
            if (string.IsNullOrEmpty(skyboxPath))
                skyboxPath = null;

            Light sun = RenderSettings.sun;
            JObject sunLocator = (sun != null) ? LocatorResolver.BuildLocator(sun.gameObject) : null;

            return new JObject
            {
                ["ambientMode"] = AmbientModeToString(RenderSettings.ambientMode),
                ["ambientColor"] = ColorToJObject(RenderSettings.ambientLight),
                ["ambientSkyColor"] = ColorToJObject(RenderSettings.ambientSkyColor),
                ["ambientEquatorColor"] = ColorToJObject(RenderSettings.ambientEquatorColor),
                ["ambientGroundColor"] = ColorToJObject(RenderSettings.ambientGroundColor),
                ["ambientIntensity"] = RenderSettings.ambientIntensity,
                ["fog"] = RenderSettings.fog,
                ["fogColor"] = ColorToJObject(RenderSettings.fogColor),
                ["fogMode"] = FogModeToString(RenderSettings.fogMode),
                ["fogDensity"] = RenderSettings.fogDensity,
                ["fogStartDistance"] = RenderSettings.fogStartDistance,
                ["fogEndDistance"] = RenderSettings.fogEndDistance,
                ["skyboxMaterial"] = skyboxPath,
                ["sun"] = sunLocator,
                ["sunEnabled"] = (sun != null) ? new JValue(sun.enabled) : JValue.CreateNull(),
                ["subtractiveShadowColor"] = ColorToJObject(RenderSettings.subtractiveShadowColor)
            };
        }

        /// <summary>
        /// Parse an optional { r, g, b, a } color param, accepting a snake_case primary key with a
        /// camelCase fallback (mirrors AssetHandler's dual-key convention). Parsing goes through the
        /// shared ColorParsing helper so channel defaults are IDENTICAL to create_material /
        /// ui.add_image (every missing channel defaults to 1). Returns null when the param is absent
        /// so callers apply only provided fields; a present-but-non-object value (e.g. "red") is a
        /// clean INVALID_PARAMS instead of a cast exception.
        /// </summary>
        private static Color? ParseColorParam(JObject parameters, string snakeKey, string camelKey)
        {
            JToken token = parameters[snakeKey] ?? parameters[camelKey];
            if (token == null || token.Type == JTokenType.Null)
                return null;
            if (token.Type != JTokenType.Object)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{snakeKey}' must be an {{ r, g, b, a }} object (floats 0-1), got {token.Type}.");
            return ColorParsing.ParseColor((JObject)token);
        }

        private static JObject ColorToJObject(Color c)
        {
            return new JObject
            {
                ["r"] = c.r,
                ["g"] = c.g,
                ["b"] = c.b,
                ["a"] = c.a
            };
        }

        private static AmbientMode ParseAmbientMode(string value)
        {
            switch (value)
            {
                case "Skybox": return AmbientMode.Skybox;
                case "Trilight": return AmbientMode.Trilight;
                case "Flat": return AmbientMode.Flat;
                case "Custom":
                    // Custom sources ambient light from a caller-populated ambient probe; this op
                    // has no way to populate that probe, so setting Custom would yield UNDEFINED
                    // ambient lighting. Refuse honestly instead of producing a broken-looking scene.
                    // (get_render_settings still REPORTS Custom when a scene already uses it.)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "'ambient_mode' 'Custom' is not settable through this op: Custom sources ambient " +
                        "light from the ambient probe, which set_render_settings cannot populate, so it " +
                        "would yield undefined ambient lighting. Use Skybox, Trilight, or Flat.");
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'ambient_mode': '{value}'. Expected one of Skybox, Trilight, Flat.");
            }
        }

        private static string AmbientModeToString(AmbientMode mode)
        {
            switch (mode)
            {
                case AmbientMode.Skybox: return "Skybox";
                case AmbientMode.Trilight: return "Trilight";
                case AmbientMode.Flat: return "Flat";
                case AmbientMode.Custom: return "Custom";
                default: return mode.ToString();
            }
        }

        private static FogMode ParseFogMode(string value)
        {
            switch (value)
            {
                case "Linear": return FogMode.Linear;
                case "Exponential": return FogMode.Exponential;
                case "ExponentialSquared": return FogMode.ExponentialSquared;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'fog_mode': '{value}'. Expected one of Linear, Exponential, ExponentialSquared.");
            }
        }

        private static string FogModeToString(FogMode mode)
        {
            switch (mode)
            {
                case FogMode.Linear: return "Linear";
                case FogMode.Exponential: return "Exponential";
                case FogMode.ExponentialSquared: return "ExponentialSquared";
                default: return mode.ToString();
            }
        }

        /// <summary>
        /// Creates the parent directory of an asset-relative path (e.g. the
        /// "Assets/Scenes" folder for "Assets/Scenes/Main.unity") on disk if it is
        /// missing, then refreshes the AssetDatabase so Unity picks up the new folder.
        /// </summary>
        private static void EnsureParentDirectory(string assetPath)
        {
            // Resolve the project-relative asset path to an absolute path. Scene save
            // paths are project-relative (typically under Assets/, but Unity also
            // permits saving to a Packages/ path), so anchor on the project root
            // (parent of Application.dataPath) rather than dataPath itself.
            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string fullPath = Path.Combine(projectRoot ?? string.Empty, assetPath);
            string directory = Path.GetDirectoryName(fullPath);

            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
                AssetDatabase.Refresh();
            }
        }

        private static JObject Vector3ToJObject(Vector3 v)
        {
            return new JObject
            {
                ["x"] = v.x,
                ["y"] = v.y,
                ["z"] = v.z
            };
        }

        private static GameObject FindRecursive(GameObject root, string name)
        {
            if (root.name == name)
                return root;

            for (int i = 0; i < root.transform.childCount; i++)
            {
                GameObject found = FindRecursive(root.transform.GetChild(i).gameObject, name);
                if (found != null)
                    return found;
            }

            return null;
        }
    }
}
