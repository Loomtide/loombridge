# Loombridge Tools Reference

> Auto-generated from OpRegistry. 125 tools across 14 categories.
>
> Regenerate: \`npm run docs:tools\`

## Table of Contents

- [Scene Operations](#scene-operations) (26 tools)
- [Editor Operations](#editor-operations) (19 tools)
- [Input Operations](#input-operations) (11 tools)
- [Runtime Operations](#runtime-operations) (10 tools)
- [Component Operations](#component-operations) (6 tools)
- [Code Operations](#code-operations) (4 tools)
- [Animator Operations](#animator-operations) (9 tools)
- [UI Operations](#ui-operations) (9 tools)
- [Asset Operations](#asset-operations) (19 tools)
- [Package Operations](#package-operations) (4 tools)
- [Capture Operations](#capture-operations) (1 tools)
- [Ops Operations](#ops-operations) (3 tools)
- [Replay Operations](#replay-operations) (1 tools)
- [Observe Operations](#observe-operations) (3 tools)

---

## Scene Operations

| Tool | Description |
|------|-------------|
| `unity_scene_new_scene` | Create a new empty scene with default GameObjects. Replaces the current scene. |
| `unity_scene_open_scene` | Open an existing scene file from disk. Defaults to Single mode (replaces current scene); use Additive to load alongside. Cannot be called in Play Mode. |
| `unity_scene_save_scene` | Save the active scene to disk at the specified path. |
| `unity_scene_create_object` | Create a new GameObject in the active scene. Returns locator for the created object. |
| `unity_scene_create_primitive` | Create a primitive GameObject (Cube/Sphere/Capsule/Cylinder/Plane/Quad) in one call — mesh, renderer, and (by default) a matching collider, like GameObject.CreatePrimitive. Use this for gray-box / blockout geometry instead of hand-assembling an empty GameObject with MeshFilter+MeshRenderer. Returns the locator for the created object. |
| `unity_scene_set_layer` | Set a GameObject's layer by NAME or INDEX (RCL-T05). Layers drive raycast masks, line-of-sight, and cover checks in a shooter. 'layer' accepts a defined layer name (e.g. 'Enemy') or an integer index 0-31. Pass includeChildren:true to apply it to the whole hierarchy (a common need for an arena piece). Errors NOT_FOUND if the layer is undefined. Returns the resolved { layer, layerName }. |
| `unity_scene_set_tag` | Set a GameObject's tag (RCL-T05). The tag must already exist — Unity throws on an undefined tag, so this returns a clear NOT_FOUND instead. Creating a missing tag is out of scope. Returns the applied { tag }. |
| `unity_scene_delete_object` | Delete a GameObject from the scene. Supports undo. |
| `unity_scene_duplicate_object` | Duplicate a GameObject (with its components and child hierarchy), preserving the source's local transform. The clone is parented under the source's parent by default; pass 'parent' to reparent it. Returns the locator of the new object. |
| `unity_scene_set_parent` | Reparent a GameObject. Omit 'parent' to unparent it to the scene root. World position is kept by default (worldPositionStays=true); set it false to preserve local transform values instead. Returns the updated locator. |
| `unity_scene_set_sibling_index` | Reorder a GameObject among its siblings (same-parent child/draw order). A same-parent scene.set_parent is a NO-OP for reordering, but sibling order is load-bearing for uGUI draw order — a LATER sibling paints OVER an earlier one — so this is how you fix e.g. a Filled bar covering its label WITHOUT hand-editing the scene YAML. Provide EXACTLY ONE of 'index' (absolute 0-based), 'before', or 'after' (a sibling locator OR a bare name string); supplying more than one (ambiguous) or none is refused. An out-of-range 'index' is refused with the valid range (never silently clamped); before/after refuse a reference that is the object itself or lives under a different parent. Undo-recorded for parented objects (a scene-ROOT reorder may not be undo-restorable — root order lives in the scene, not the object hierarchy); marks the scene dirty. Returns the resolved parentPath plus oldIndex -> newIndex and siblingCount. |
| `unity_scene_find_object` | Find a single GameObject and return its locator + transform. Resolve by 'name' (first match across all loaded scenes) OR by a 'locator' / 'path' that resolves exactly like runtime.get_snapshot — including index-0 selection when sibling names collide (e.g. path '/Enemy_Chaser' resolves the first of two same-named siblings). On a benign miss it returns { found: false, locator: null } (no error, no error screenshot artifact). The return is always a single object, never an array. |
| `unity_scene_set_transform` | Set the world-space position, rotation, and/or scale of a GameObject. |
| `unity_scene_get_hierarchy` | Get the full scene hierarchy tree. Optionally limit depth. |
| `unity_scene_select_object` | Select a GameObject in the Unity Editor (updates Inspector). |
| `unity_scene_set_active` | Set a GameObject's active self-state (GameObject.SetActive). Enable an inactive-by-default object so it can be driven/verified — e.g. a mobile-controls canvas a desktop default leaves off — WITHOUT modifying the game. Works in Edit or Play Mode. Returns the locator plus activeSelf and activeInHierarchy (so you can tell whether an inactive ANCESTOR still keeps it hidden even after you set it active). |
| `unity_scene_get_bounds` | Get world-space bounds for a GameObject: every collider and renderer as a world AABB (min/max/center/size). For sprites also reports visibleBounds — the opaque (visible) pixels of the current animation frame, not the padded quad. Convenience fields: colliderBottomY, visibleBottomY, and visibleFeetAboveColliderBottom (>0 means the visible feet sit above the collider bottom, so a grounded character will float). The numeric counterpart to a screenshot. |
| `unity_scene_frame_object` | Select and frame a GameObject in the live Scene View (like selecting it and pressing F), so a subsequent scene-view look is centered on it. For a deterministic close-up capture regardless of editor focus, prefer unity_editor_screenshot with focusLocator. |
| `unity_scene_get_screen_rects` | Project each object's world bounds into SCREEN space through a camera (default Camera.main) to answer the framing/composition question: is the visible character fully inside the frame, where is it horizontally (the 40%-anchor check via centerXFraction), and which edge it is clipped against. boundsMode (default opaque) picks the primary bounds: opaque = visible sprite pixels (the 'is the CHARACTER clipped' question), renderer = full sprite quad, collider. Per object returns screenRect{x,y,width,height}, isFullyVisible, isPartiallyClipped, isOffScreen, clipSide[], centerXFraction/centerYFraction, plus rendererRect/colliderRect/opaqueRect as debug, and camera + viewport (width/height/aspect) info. The numeric counterpart to eyeballing a screenshot. |
| `unity_scene_verify_manifest` | Game-agnostic check that the scene contains the assets a contract requires, with no leftover placeholders. Provide an inline 'manifest' array OR a 'manifestPath' to a JSON file (bare array, or an object with a manifest/assets array). Each entry: { name | nameRegex, type (GameObject|Sprite|Prefab), primitive?, minCount?, required? }. 'matching' controls how name resolves (mode exact|prefix|regex, caseSensitive). 'placeholderRule' detects placeholders by sprite-name substring (default 'placeholder') and/or an asset-path folder. Extras (unmatched placeholder objects) are a warning unless extrasAsFailure=true. Returns { missing[], placeholders[], extras[], all_ok }. |
| `unity_scene_get_render_settings` | Read the ACTIVE scene's global lighting/environment RenderSettings (per-scene state): ambientMode (Skybox|Trilight|Flat|Custom), ambientColor + ambientSkyColor/ambientEquatorColor/ambientGroundColor (all as {r,g,b,a}; ambientColor and ambientSkyColor MIRROR each other — they are the same underlying Unity property exposed under two names), ambientIntensity, fog (bool) + fogColor + fogMode (Linear|Exponential|ExponentialSquared) + fogDensity/fogStartDistance/fogEndDistance, skyboxMaterial (asset path or null), sun (a GameObject locator or null) + sunEnabled (the sun Light's enabled state, null when no sun — a disabled sun is visible instead of a lit-but-dark mystery), and subtractiveShadowColor. Read-only. SCOPE: scene-level UnityEngine.RenderSettings only — it does NOT read the URP asset or Volume-framework post-processing (a separate slice). The round-trip counterpart to set_render_settings. |
| `unity_scene_find_references_to` | Find every serialized ObjectReference in the loaded scenes that points at the target GameObject, at any Component on it, or at ANY of its DESCENDANTS (and their components) — the scan surface equals the destroy surface. This is the PRE-FLIGHT for a destructive prefab swap: run it BEFORE asset.replace_with_prefab (which DESTROYS the replaced object's whole hierarchy and silently NULLs external references into it — in a real incident a minimap component's cached extract-point reference pointed at a transform on a CHILD under the beacon) to see exactly what would be severed. Scans SerializedObject properties across all components (including nested/array refs) and is bounded + deterministically ordered. Returns { target, references: [ { referencing: { locator, scene_path, component, component_index }, property_path, relative_path ('' = the target root, else the referenced descendant's path under the target), references: 'gameobject' | '<ComponentType>' } ], count, truncated }. Read-only. |
| `unity_scene_set_render_settings` | Set any subset of the ACTIVE scene's global RenderSettings (lighting/environment). Every field is optional and only PROVIDED fields are applied — a partial update leaves the rest untouched. ATOMIC: validate-then-apply — all params are parsed and the skybox material / sun locator resolved BEFORE the first write, so a failed call leaves render settings completely untouched. Colors use the same {r,g,b,a} float format as create_material/ui.add_image (missing channels default to 1). NOTE ambient_color and ambient_sky_color are ALIASES of the same underlying Unity property (ambientLight == ambientSkyColor); supplying both with different values is refused. Drives scene lighting through the bridge instead of hand-patching scene YAML + reloading (which clobbers unsaved in-memory scene state). Marks the active scene dirty only when a value actually changed (RenderSettings edits are not captured by Undo); pass save:true to also write the scene to disk (refused with INVALID_PARAMS on an untitled scene — save it via scene.save_scene first). Unknown ambient_mode/fog_mode values fail with INVALID_PARAMS listing the valid values; ambient_mode 'Custom' is refused (this op cannot populate the ambient probe Custom reads from). Returns the resulting get_render_settings payload. SCOPE: scene-level UnityEngine.RenderSettings only — NO URP-asset or Volume post-processing mutation (a separate slice). |
| `unity_scene_validate_references` | Report every NULL serialized ObjectReference property in scope (a locator subtree, or ALL loaded scenes by default), grouped-by-component via deterministic ordering. Honest + simple — a reference is reported purely because it is null, with no heuristic guessing intent beyond nullness. A SEVERED reference (null value but a non-zero instanceID, i.e. a Unity 'Missing' ref — exactly what a destructive prefab swap leaves behind) is flagged missing:true so a broken wiring is distinguishable from a never-assigned optional field. Pass include_prefab_defaults:true to additionally annotate each null with prefab_source_non_null (whether the component's prefab source had a value there). Returns { scope, include_prefab_defaults, null_references: [ { object, component, component_index, property_path, missing } ], count, truncated }. Read-only. |
| `unity_scene_snapshot_gameplay_geometry` | Serialize the GAMEPLAY GEOMETRY of ALL loaded scenes to a deterministic, diffable JSON file — the baseline half of the 'art scene safety profile' (art-integration dogfood, 'Art Is A Parallel Vertical'): an art pass must be VISUAL-ONLY, so graybox colliders, triggers, LOS blockers, and serialized gameplay tuning must survive it UNCHANGED. Take this snapshot BEFORE the art pass, then run scene.compare_gameplay_geometry after to PROVE nothing gameplay-relevant moved. For every GameObject carrying a Collider/Collider2D it records: each collider's type, is_trigger, enabled, and LOCAL-space geometry (center/size/radius/height/offset/points per collider type), plus the object's layer, tag, active_self/active_in_hierarchy, hierarchy path, and the owning transform's WORLD position/rotation(quaternion)/scale. MeshColliders carry a mesh FINGERPRINT (shared_mesh name + vertex_count + triangle_count + local bounds) so an in-place mesh edit or a same-named mesh swap cannot read unchanged. Renderers and all visual-only data are EXCLUDED by design. Objects are keyed and sorted by a stable SCENE-ASSET-PATH-qualified key (scene NAME is not unique across additively-loaded scenes; untitled scenes disambiguate by load index), so two snapshots of an unchanged scene are BYTE-IDENTICAL (no timestamps/instance IDs emitted). output_path is PROJECT-RELATIVE and written by the bridge (refused if it escapes the project root); the file carries schema_version (currently 2) + counts. Returns { output_path, absolute_path, schema_version, counts, scenes, filters, bytes_written }. |
| `unity_scene_compare_gameplay_geometry` | Re-walk the LIVE loaded scenes and diff them against a baseline snapshot (from scene.snapshot_gameplay_geometry) — the verify half of the 'art scene safety profile'. The live walk reuses the baseline's OWN stored filters (include_tags/layers) so both cover the same surface. HONEST BY DESIGN: a MISSING baseline is NOT_FOUND; an unreadable / unparseable / schema-mismatched baseline (including an OLDER schema_version — an old baseline cannot prove the current invariants; re-snapshot) is INVALID_PARAMS; a snapshot with DUPLICATE identity keys on either side is INVALID_PARAMS (colliding identities cannot honestly diff) — NEVER a silent empty diff. Returns { verdict: 'unchanged' | 'changed', unchanged_count, added: [{path, scene, colliders}], removed: [...], modified: [{path, scene, field, baseline, current}], tolerance, filters, baseline_path }. verdict is 'changed' WHENEVER added, removed, or modified is non-empty. Floats are compared with BOUNDED tolerances: position/size max 0.1, rotation max 5 degrees — generous for float noise, refused above the cap (INVALID_PARAMS) so the knob can never launder a real move; negatives also refused. Exact-match fields (type, layer, tag, active_self, active_in_hierarchy — so deactivating a collider-less ANCESTOR still reads as changed — is_trigger, enabled, direction, point_count, vertex_count, triangle_count, shared_mesh) refuse any drift. A RENAMED-but-identical object shows as removed + added — identity is the scene-asset-path-qualified hierarchy path; there is NO fuzzy matching. Read-only (the live scene is not mutated). |

### unity_scene_new_scene

Create a new empty scene with default GameObjects. Replaces the current scene.

**Wire command:** `scene.new_scene`

*No parameters.*

### unity_scene_open_scene

Open an existing scene file from disk. Defaults to Single mode (replaces current scene); use Additive to load alongside. Cannot be called in Play Mode.

**Wire command:** `scene.open_scene`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path to the scene file (e.g. Assets/Scenes/Main.unity) |
| `mode` | "Single" \| "Additive" | No | Load mode (default: Single) |

### unity_scene_save_scene

Save the active scene to disk at the specified path.

**Wire command:** `scene.save_scene`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path to save the scene (e.g. Assets/Scenes/Main.unity) |

### unity_scene_create_object

Create a new GameObject in the active scene. Returns locator for the created object.

**Wire command:** `scene.create_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Name for the new GameObject (default: 'GameObject') |
| `parent` | object | No | Optional parent object locator |
| `position` | object | No | Local position (relative to parent when parent is set) |
| `worldPosition` | object | No | World-space position. Applied after 'position'; takes precedence when both are set. Use this to place a child without computing parent-relative coordinates. |
| `rotation` | object | No | Local euler angles |
| `scale` | object | No | Local scale |

### unity_scene_create_primitive

Create a primitive GameObject (Cube/Sphere/Capsule/Cylinder/Plane/Quad) in one call — mesh, renderer, and (by default) a matching collider, like GameObject.CreatePrimitive. Use this for gray-box / blockout geometry instead of hand-assembling an empty GameObject with MeshFilter+MeshRenderer. Returns the locator for the created object.

**Wire command:** `scene.create_primitive`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `primitive` | "Cube" \| "Sphere" \| "Capsule" \| "Cylinder" \| "Plane" \| "Quad" | Yes | Primitive type (PrimitiveType). Required. |
| `name` | string | No | Name for the new GameObject (default: the primitive type, e.g. 'Cube') |
| `parent` | object | No | Optional parent object locator |
| `position` | object | No | Local position (relative to parent when parent is set) |
| `worldPosition` | object | No | World-space position. Applied after 'position'; takes precedence when both are set. |
| `rotation` | object | No | Local euler angles |
| `scale` | object | No | Local scale |
| `addCollider` | boolean | No | Keep the auto-added Collider (default: true). Set false to remove it (e.g. a pure visual decoration). |

### unity_scene_set_layer

Set a GameObject's layer by NAME or INDEX (RCL-T05). Layers drive raycast masks, line-of-sight, and cover checks in a shooter. 'layer' accepts a defined layer name (e.g. 'Enemy') or an integer index 0-31. Pass includeChildren:true to apply it to the whole hierarchy (a common need for an arena piece). Errors NOT_FOUND if the layer is undefined. Returns the resolved { layer, layerName }.

**Wire command:** `scene.set_layer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `layer` | string,number | Yes | Layer name (e.g. 'Enemy') or integer index 0-31. Must be an existing layer. |
| `includeChildren` | boolean | No | Also set the layer on every descendant (default false). |

### unity_scene_set_tag

Set a GameObject's tag (RCL-T05). The tag must already exist — Unity throws on an undefined tag, so this returns a clear NOT_FOUND instead. Creating a missing tag is out of scope. Returns the applied { tag }.

**Wire command:** `scene.set_tag`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `tag` | string | Yes | An existing tag name (e.g. 'Player', 'Enemy'). |

### unity_scene_delete_object

Delete a GameObject from the scene. Supports undo.

**Wire command:** `scene.delete_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |

### unity_scene_duplicate_object

Duplicate a GameObject (with its components and child hierarchy), preserving the source's local transform. The clone is parented under the source's parent by default; pass 'parent' to reparent it. Returns the locator of the new object.

**Wire command:** `scene.duplicate_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Locator of the object to duplicate |
| `name` | string | No | Optional name for the clone (default: same as the source, without Unity's '(Clone)' suffix) |
| `parent` | object | No | Optional parent for the clone (default: same parent as the source) |

### unity_scene_set_parent

Reparent a GameObject. Omit 'parent' to unparent it to the scene root. World position is kept by default (worldPositionStays=true); set it false to preserve local transform values instead. Returns the updated locator.

**Wire command:** `scene.set_parent`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Locator of the object to reparent |
| `parent` | object | No | Optional new parent locator. Omit/null = unparent to scene root. |
| `worldPositionStays` | boolean | No | Keep world position when reparenting (default: true). False preserves local position/rotation/scale. |

### unity_scene_set_sibling_index

Reorder a GameObject among its siblings (same-parent child/draw order). A same-parent scene.set_parent is a NO-OP for reordering, but sibling order is load-bearing for uGUI draw order — a LATER sibling paints OVER an earlier one — so this is how you fix e.g. a Filled bar covering its label WITHOUT hand-editing the scene YAML. Provide EXACTLY ONE of 'index' (absolute 0-based), 'before', or 'after' (a sibling locator OR a bare name string); supplying more than one (ambiguous) or none is refused. An out-of-range 'index' is refused with the valid range (never silently clamped); before/after refuse a reference that is the object itself or lives under a different parent. Undo-recorded for parented objects (a scene-ROOT reorder may not be undo-restorable — root order lives in the scene, not the object hierarchy); marks the scene dirty. Returns the resolved parentPath plus oldIndex -> newIndex and siblingCount.

**Wire command:** `scene.set_sibling_index`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Locator of the object to reorder |
| `index` | number | No | Absolute target sibling index (0-based; 0 = first, drawn first / behind later siblings). Valid range 0..siblingCount-1; out of range is refused, not clamped. Mutually exclusive with before/after. |
| `before` | any | No | Position the object immediately BEFORE this sibling — a locator object OR a bare sibling-name string. Must share the same parent. Mutually exclusive with index/after. |
| `after` | any | No | Position the object immediately AFTER this sibling — a locator object OR a bare sibling-name string. Must share the same parent. Mutually exclusive with index/before. |

### unity_scene_find_object

Find a single GameObject and return its locator + transform. Resolve by 'name' (first match across all loaded scenes) OR by a 'locator' / 'path' that resolves exactly like runtime.get_snapshot — including index-0 selection when sibling names collide (e.g. path '/Enemy_Chaser' resolves the first of two same-named siblings). On a benign miss it returns { found: false, locator: null } (no error, no error screenshot artifact). The return is always a single object, never an array.

**Wire command:** `scene.find_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Name of the GameObject to find (first match wins). Provide this OR a locator/path. |
| `path` | string | No | Hierarchy path to resolve (e.g. '/Enemy_Chaser' or '/Root/Enemy[2]'). Resolves like get_snapshot (index-0 on duplicate names). Convenience shorthand for locator.path. |
| `locator` | object | No | Full locator to resolve (path/scene/globalObjectId/instanceId), same resolution as runtime.get_snapshot. Provide this OR a name. |

### unity_scene_set_transform

Set the world-space position, rotation, and/or scale of a GameObject.

**Wire command:** `scene.set_transform`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `position` | object | No | World position |
| `rotation` | object | No | World euler angles |
| `scale` | object | No | Local scale |

### unity_scene_get_hierarchy

Get the full scene hierarchy tree. Optionally limit depth.

**Wire command:** `scene.get_hierarchy`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `depth` | number | No | Maximum hierarchy depth (-1 for unlimited) |

### unity_scene_select_object

Select a GameObject in the Unity Editor (updates Inspector).

**Wire command:** `scene.select_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |

### unity_scene_set_active

Set a GameObject's active self-state (GameObject.SetActive). Enable an inactive-by-default object so it can be driven/verified — e.g. a mobile-controls canvas a desktop default leaves off — WITHOUT modifying the game. Works in Edit or Play Mode. Returns the locator plus activeSelf and activeInHierarchy (so you can tell whether an inactive ANCESTOR still keeps it hidden even after you set it active).

**Wire command:** `scene.set_active`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `active` | boolean | Yes | Desired active self-state (true = enable). |

### unity_scene_get_bounds

Get world-space bounds for a GameObject: every collider and renderer as a world AABB (min/max/center/size). For sprites also reports visibleBounds — the opaque (visible) pixels of the current animation frame, not the padded quad. Convenience fields: colliderBottomY, visibleBottomY, and visibleFeetAboveColliderBottom (>0 means the visible feet sit above the collider bottom, so a grounded character will float). The numeric counterpart to a screenshot.

**Wire command:** `scene.get_bounds`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `debug` | boolean | No | Include verbose per-sprite scan details (rect/textureRect/pivot/ppu/pixel min-max) in a visibleDebug field. Default false. |

### unity_scene_frame_object

Select and frame a GameObject in the live Scene View (like selecting it and pressing F), so a subsequent scene-view look is centered on it. For a deterministic close-up capture regardless of editor focus, prefer unity_editor_screenshot with focusLocator.

**Wire command:** `scene.frame_object`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `select` | boolean | No | Also select the object in the editor (default: true) |

### unity_scene_get_screen_rects

Project each object's world bounds into SCREEN space through a camera (default Camera.main) to answer the framing/composition question: is the visible character fully inside the frame, where is it horizontally (the 40%-anchor check via centerXFraction), and which edge it is clipped against. boundsMode (default opaque) picks the primary bounds: opaque = visible sprite pixels (the 'is the CHARACTER clipped' question), renderer = full sprite quad, collider. Per object returns screenRect{x,y,width,height}, isFullyVisible, isPartiallyClipped, isOffScreen, clipSide[], centerXFraction/centerYFraction, plus rendererRect/colliderRect/opaqueRect as debug, and camera + viewport (width/height/aspect) info. The numeric counterpart to eyeballing a screenshot.

**Wire command:** `scene.get_screen_rects`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locators` | object[] | Yes | Objects to project into screen space. |
| `camera` | object | No | Optional camera locator. Defaults to Camera.main. |
| `boundsMode` | "opaque" \| "renderer" \| "collider" | No | Which bounds drives screenRect/clip flags (default opaque = visible sprite pixels). |

### unity_scene_verify_manifest

Game-agnostic check that the scene contains the assets a contract requires, with no leftover placeholders. Provide an inline 'manifest' array OR a 'manifestPath' to a JSON file (bare array, or an object with a manifest/assets array). Each entry: { name | nameRegex, type (GameObject|Sprite|Prefab), primitive?, minCount?, required? }. 'matching' controls how name resolves (mode exact|prefix|regex, caseSensitive). 'placeholderRule' detects placeholders by sprite-name substring (default 'placeholder') and/or an asset-path folder. Extras (unmatched placeholder objects) are a warning unless extrasAsFailure=true. Returns { missing[], placeholders[], extras[], all_ok }.

**Wire command:** `scene.verify_manifest`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `manifest` | object[] | No | Inline manifest entries. Alternative to manifestPath. |
| `manifestPath` | string | No | Path to a JSON manifest file. Alternative to inline manifest. |
| `matching` | object | No | How manifest names resolve to scene objects. |
| `placeholderRule` | object | No | How a placeholder sprite is detected. |
| `extrasAsFailure` | boolean | No | Treat unmatched placeholder extras as a failure (default false → warning). |

### unity_scene_get_render_settings

Read the ACTIVE scene's global lighting/environment RenderSettings (per-scene state): ambientMode (Skybox|Trilight|Flat|Custom), ambientColor + ambientSkyColor/ambientEquatorColor/ambientGroundColor (all as {r,g,b,a}; ambientColor and ambientSkyColor MIRROR each other — they are the same underlying Unity property exposed under two names), ambientIntensity, fog (bool) + fogColor + fogMode (Linear|Exponential|ExponentialSquared) + fogDensity/fogStartDistance/fogEndDistance, skyboxMaterial (asset path or null), sun (a GameObject locator or null) + sunEnabled (the sun Light's enabled state, null when no sun — a disabled sun is visible instead of a lit-but-dark mystery), and subtractiveShadowColor. Read-only. SCOPE: scene-level UnityEngine.RenderSettings only — it does NOT read the URP asset or Volume-framework post-processing (a separate slice). The round-trip counterpart to set_render_settings.

**Wire command:** `scene.get_render_settings`

*No parameters.*

### unity_scene_find_references_to

Find every serialized ObjectReference in the loaded scenes that points at the target GameObject, at any Component on it, or at ANY of its DESCENDANTS (and their components) — the scan surface equals the destroy surface. This is the PRE-FLIGHT for a destructive prefab swap: run it BEFORE asset.replace_with_prefab (which DESTROYS the replaced object's whole hierarchy and silently NULLs external references into it — in a real incident a minimap component's cached extract-point reference pointed at a transform on a CHILD under the beacon) to see exactly what would be severed. Scans SerializedObject properties across all components (including nested/array refs) and is bounded + deterministically ordered. Returns { target, references: [ { referencing: { locator, scene_path, component, component_index }, property_path, relative_path ('' = the target root, else the referenced descendant's path under the target), references: 'gameobject' | '<ComponentType>' } ], count, truncated }. Read-only.

**Wire command:** `scene.find_references_to`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | The GameObject whose inbound references to find. |
| `max_results` | integer | No | Cap on reported references (default 500). Alias: maxResults. |
| `maxResults` | integer | No | Alias for max_results. |

### unity_scene_set_render_settings

Set any subset of the ACTIVE scene's global RenderSettings (lighting/environment). Every field is optional and only PROVIDED fields are applied — a partial update leaves the rest untouched. ATOMIC: validate-then-apply — all params are parsed and the skybox material / sun locator resolved BEFORE the first write, so a failed call leaves render settings completely untouched. Colors use the same {r,g,b,a} float format as create_material/ui.add_image (missing channels default to 1). NOTE ambient_color and ambient_sky_color are ALIASES of the same underlying Unity property (ambientLight == ambientSkyColor); supplying both with different values is refused. Drives scene lighting through the bridge instead of hand-patching scene YAML + reloading (which clobbers unsaved in-memory scene state). Marks the active scene dirty only when a value actually changed (RenderSettings edits are not captured by Undo); pass save:true to also write the scene to disk (refused with INVALID_PARAMS on an untitled scene — save it via scene.save_scene first). Unknown ambient_mode/fog_mode values fail with INVALID_PARAMS listing the valid values; ambient_mode 'Custom' is refused (this op cannot populate the ambient probe Custom reads from). Returns the resulting get_render_settings payload. SCOPE: scene-level UnityEngine.RenderSettings only — NO URP-asset or Volume post-processing mutation (a separate slice).

**Wire command:** `scene.set_render_settings`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ambient_mode` | "Skybox" \| "Trilight" \| "Flat" | No | Ambient/environment lighting source. Trilight = the gradient (sky/equator/ground) mode; Flat = a single ambient color. 'Custom' is intentionally NOT settable (the op cannot populate the ambient probe it reads from), though get_render_settings still reports it when a scene already uses it. |
| `ambient_color` | object | No | Flat ambient color (RenderSettings.ambientLight). ALIAS of ambient_sky_color — both names write the same underlying per-scene property; supplying both with different values is refused. |
| `ambient_sky_color` | object | No | Trilight gradient sky color (RenderSettings.ambientSkyColor). ALIAS of ambient_color — same underlying property. |
| `ambient_equator_color` | object | No | Trilight gradient equator color. |
| `ambient_ground_color` | object | No | Trilight gradient ground color. |
| `ambient_intensity` | number | No | Ambient intensity multiplier (used in Skybox mode). |
| `fog` | boolean | No | Enable/disable fog. |
| `fog_color` | object | No | Fog color. |
| `fog_mode` | "Linear" \| "Exponential" \| "ExponentialSquared" | No | Fog falloff mode. Linear uses fog_start_distance/fog_end_distance; Exponential(Squared) use fog_density. |
| `fog_density` | number | No | Fog density (Exponential / ExponentialSquared modes). |
| `fog_start_distance` | number | No | Fog start distance (Linear mode). |
| `fog_end_distance` | number | No | Fog end distance (Linear mode). |
| `skybox_material` | string | No | Asset path to a skybox Material (e.g. 'Assets/Art/Sky.mat'). Empty string or null clears the skybox. A path to a non-Material asset is INVALID_PARAMS; a missing asset is NOT_FOUND. |
| `sun` | object | No | GameObject locator for the light to use as the sun (must carry a Light). Null clears the sun override. |
| `subtractive_shadow_color` | object | No | Shadow color used by the Subtractive shadow mixing mode. |
| `save` | boolean | No | Also save the active scene to disk after applying (default false). Refused on an untitled scene — save it once via scene.save_scene first. The scene is marked dirty whenever a value actually changed. |

### unity_scene_validate_references

Report every NULL serialized ObjectReference property in scope (a locator subtree, or ALL loaded scenes by default), grouped-by-component via deterministic ordering. Honest + simple — a reference is reported purely because it is null, with no heuristic guessing intent beyond nullness. A SEVERED reference (null value but a non-zero instanceID, i.e. a Unity 'Missing' ref — exactly what a destructive prefab swap leaves behind) is flagged missing:true so a broken wiring is distinguishable from a never-assigned optional field. Pass include_prefab_defaults:true to additionally annotate each null with prefab_source_non_null (whether the component's prefab source had a value there). Returns { scope, include_prefab_defaults, null_references: [ { object, component, component_index, property_path, missing } ], count, truncated }. Read-only.

**Wire command:** `scene.validate_references`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `scope` | object | No | Optional subtree to scan. Omit to scan all loaded scenes. |
| `include_prefab_defaults` | boolean | No | Annotate each null with whether the prefab source had a value (default false). Alias: includePrefabDefaults. |
| `includePrefabDefaults` | boolean | No | Alias for include_prefab_defaults. |
| `max_results` | integer | No | Cap on reported null references (default 500). Alias: maxResults. |
| `maxResults` | integer | No | Alias for max_results. |

### unity_scene_snapshot_gameplay_geometry

Serialize the GAMEPLAY GEOMETRY of ALL loaded scenes to a deterministic, diffable JSON file — the baseline half of the 'art scene safety profile' (art-integration dogfood, 'Art Is A Parallel Vertical'): an art pass must be VISUAL-ONLY, so graybox colliders, triggers, LOS blockers, and serialized gameplay tuning must survive it UNCHANGED. Take this snapshot BEFORE the art pass, then run scene.compare_gameplay_geometry after to PROVE nothing gameplay-relevant moved. For every GameObject carrying a Collider/Collider2D it records: each collider's type, is_trigger, enabled, and LOCAL-space geometry (center/size/radius/height/offset/points per collider type), plus the object's layer, tag, active_self/active_in_hierarchy, hierarchy path, and the owning transform's WORLD position/rotation(quaternion)/scale. MeshColliders carry a mesh FINGERPRINT (shared_mesh name + vertex_count + triangle_count + local bounds) so an in-place mesh edit or a same-named mesh swap cannot read unchanged. Renderers and all visual-only data are EXCLUDED by design. Objects are keyed and sorted by a stable SCENE-ASSET-PATH-qualified key (scene NAME is not unique across additively-loaded scenes; untitled scenes disambiguate by load index), so two snapshots of an unchanged scene are BYTE-IDENTICAL (no timestamps/instance IDs emitted). output_path is PROJECT-RELATIVE and written by the bridge (refused if it escapes the project root); the file carries schema_version (currently 2) + counts. Returns { output_path, absolute_path, schema_version, counts, scenes, filters, bytes_written }.

**Wire command:** `scene.snapshot_gameplay_geometry`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `output_path` | string | Yes | Project-relative path for the snapshot JSON (e.g. '.loombridge/art/gameplay-geometry.json'). Absolute paths or paths escaping the project root are refused. Alias: outputPath. |
| `outputPath` | string | No | Alias for output_path. |
| `include_tags` | string[] | No | Optional tag allowlist — only objects whose tag is in this set are snapshotted. Omit (or empty) to include every collider-bearing object. Alias: includeTags. STORED in the file so compare_gameplay_geometry re-walks the identical surface. |
| `includeTags` | string[] | No | Alias for include_tags. |
| `layers` | string,integer[] | No | Optional layer allowlist — only objects on these layers are snapshotted. Each element is a layer NAME (resolved via LayerMask; an unknown name is refused, never silently ignored) or a 0-31 index. Omit to include all layers. STORED in the file (as indices) so compare re-walks the identical surface. |

### unity_scene_compare_gameplay_geometry

Re-walk the LIVE loaded scenes and diff them against a baseline snapshot (from scene.snapshot_gameplay_geometry) — the verify half of the 'art scene safety profile'. The live walk reuses the baseline's OWN stored filters (include_tags/layers) so both cover the same surface. HONEST BY DESIGN: a MISSING baseline is NOT_FOUND; an unreadable / unparseable / schema-mismatched baseline (including an OLDER schema_version — an old baseline cannot prove the current invariants; re-snapshot) is INVALID_PARAMS; a snapshot with DUPLICATE identity keys on either side is INVALID_PARAMS (colliding identities cannot honestly diff) — NEVER a silent empty diff. Returns { verdict: 'unchanged' | 'changed', unchanged_count, added: [{path, scene, colliders}], removed: [...], modified: [{path, scene, field, baseline, current}], tolerance, filters, baseline_path }. verdict is 'changed' WHENEVER added, removed, or modified is non-empty. Floats are compared with BOUNDED tolerances: position/size max 0.1, rotation max 5 degrees — generous for float noise, refused above the cap (INVALID_PARAMS) so the knob can never launder a real move; negatives also refused. Exact-match fields (type, layer, tag, active_self, active_in_hierarchy — so deactivating a collider-less ANCESTOR still reads as changed — is_trigger, enabled, direction, point_count, vertex_count, triangle_count, shared_mesh) refuse any drift. A RENAMED-but-identical object shows as removed + added — identity is the scene-asset-path-qualified hierarchy path; there is NO fuzzy matching. Read-only (the live scene is not mutated).

**Wire command:** `scene.compare_gameplay_geometry`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `baseline_path` | string | Yes | Project-relative path to a snapshot JSON previously written by scene.snapshot_gameplay_geometry. Missing → NOT_FOUND; corrupt/mismatched → INVALID_PARAMS. Alias: baselinePath. |
| `baselinePath` | string | No | Alias for baseline_path. |
| `tolerance` | object | No | Optional float tolerances. Any omitted field falls back to its default. BOUNDED: values outside [0, max] are refused with INVALID_PARAMS — the knob absorbs float noise only and cannot be used to launder a real geometry change into 'unchanged'. |

## Editor Operations

| Tool | Description |
|------|-------------|
| `unity_editor_screenshot` | Take a screenshot of the Scene or Game view. Returns base64-encoded image. For named artifacts, pass outputPath (for example captures/start.png or .loombridge/captures/start.png); the server writes the screenshot there and returns JSON with path/width/height/format/sizeBytes/sha256. Do not scrape trace/artifacts for agent-facing screenshots. For debugging: pass focusLocator to render a deterministic close-up framed on one object (independent of the live camera), and/or annotateBounds to draw objects' collider (green), full sprite quad (magenta), and visible/opaque pixels (yellow) world bounds onto the image so collider-vs-feet-vs-ground alignment is visible. Annotated captures also return the numeric bounds as a text block. Note: the game view is captured via Camera.Render, which composites Screen Space-Camera UI but NOT Screen Space-Overlay UI — use a Camera-mode HUD canvas if you need the HUD to appear in the screenshot. |
| `unity_editor_set_game_view_size` | Set the Unity Game View render resolution to a fixed width x height in pixels, so a 'Scale With Screen Size' uGUI canvas genuinely RE-LAYS-OUT at that aspect (CanvasScaler re-evaluates) — not just a cropped screenshot. Use to capture/verify a UI across multiple device aspects (e.g. 1280x720 landscape then 2400x1080 tall): after setting the size, the existing unity_editor_screenshot and unity_ui_get_screen_rects ops read the new size automatically (viewport + canvasScaleFactor change). Returns the applied {width,height,aspect} plus {previousWidth,previousHeight}. The op is idempotent — to RESTORE the prior size, call again with the returned previousWidth/previousHeight. |
| `unity_editor_focus_game_view` | Best-effort focus of the Unity Game View so simulated Input-System pointer events can route to world-space game code. Use before world-pointer input capture. Returns gameViewAvailable/gameViewFocused. RCL-T09: focus is never a hard block — when the editor cannot acquire OS focus (the headless/background norm) it DEGRADES gracefully: returns focusDegraded:true and (in Play Mode) enables Application.runInBackground so the player loop still ticks unfocused, instead of failing FOCUS_REQUIRED. For a deterministic sim-advance without focus, use editor.tick. |
| `unity_editor_get_state` | Get the current editor state: play_mode, compile status, selected object, and show_work_enabled plus error_count + last_error (console errors/exceptions since the last clear_console). Clear the console before entering Play Mode, then check error_count > 0 here to catch a thrown exception instead of mistaking it for 'play mode not working'; pull console_logs for the full stack. |
| `unity_editor_get_project_diagnostics` | Project-level capability diagnostics — the 'why does a symbol/module look missing while error_count stays 0?' probe (the late-polish dogfood learnings §10, where ParticleSystem + ScreenCapture modules were disabled yet the console read clean). Returns: { unity_version, render_pipeline: { mode: 'URP'|'HDRP'|'built-in'|'custom', asset_type }, installed_packages: [{ name, version }] (from PackageManager.GetAllRegisteredPackages — direct AND indirect/built-in deps), package_query_failed: boolean, disabled_built_in_modules: string[] | null (BEST-EFFORT: a known optional com.unity.modules.* that is NOT in the registered-package set reads as disabled/removed; enabled built-in modules are registered packages, so absence is a real signal — but the checked set is a curated list of gameplay/FX/import modules, not exhaustive. NULL ≠ []: when the package query fails this is null with package_query_failed:true, so a broken query can never read as 'nothing disabled'; [] is the positive claim that every checked module is enabled), editor_assembly_count + player_assembly_count (the two script-assembly sets, reported separately), last_compile: the CompileWatcher's latest result or null }. Read-only. Results reflect the package registry at call time — immediately after a domain reload the registry may still be resolving. |
| `unity_editor_audit_mobile_assets` | Mobile-optimization WEIGHT audit — measure before you optimize (the late-polish dogfood learnings §9, where a 30.7k-tri T-wall mesh instanced 57× was the real per-frame cost, not the textures that took the blame). Walks the CURRENTLY-LOADED scenes (NOT a full-project AssetDatabase scan — the honest, bounded gameplay working set) and returns: { payload_kind: 'mobile_asset_audit', payload_version: 1 (the discriminator `loombridge mobile-audit` requires — save this response verbatim), textures: { entries:[{ path, name, width, height, format, compression, estimated_bytes }] (shared-material + SpriteRenderer textures, deduped, sorted by estimated bytes desc), total_count, truncated }, audio: { entries:[{ path, name, length_seconds, channels, frequency, load_type, compression_format, file_bytes }] (AudioSource clips, sorted by file bytes desc), total_count, truncated }, meshes: { entries:[{ path, name, vertex_count, triangle_count, instance_count, triangle_load, reason? }] (MeshFilter/SkinnedMeshRenderer shared meshes; instance_count = references across loaded scenes; triangle_load = triangle_count × instance_count; sorted by triangle_load desc — the 57× wall surfaces at the top; counted via Mesh.GetIndexCount submesh metadata so NON-READABLE meshes — imported FBX defaults Read/Write OFF — are still counted correctly, never a false zero; when a count is unobtainable the entry carries triangle_count: null + a reason), total_count, truncated, unreadable_count (entries with null triangle_count — a visible blind spot, the report flags it) }, quality_settings: { level_name, shadow_distance, shadow_resolution, shadow_cascades, msaa, vsync_count, pixel_light_count }, render_pipeline_settings: URP-only reflected { asset_type, shadow_distance, msaa_sample_count, render_scale, supports_hdr, main_light_shadow_resolution, shadow_cascade_count } | null (null + render_pipeline_settings_unavailable_reason when no scriptable pipeline is active or it is not URP — reflection-safe, never throws), build_scenes:[{ path, enabled }], loaded_scene_count, loaded_scenes:[path] }. BOUNDED: each category is truncated to max_entries (default 50) with total_count + truncated flags. Read-only (no AssetDatabase.Refresh, no scene mutation). Feed the output to `loombridge mobile-audit` for advisory findings — always stamped hardware_unvalidated until a device build proves frame rate/memory/post-processing cost. |
| `unity_editor_set_show_work` | Enable or disable Loombridge Show Work Mode for demo recordings. When enabled, high-signal bridge ops select/ping the GameObject or asset they just changed so the Unity Hierarchy, Project window, Inspector, and Scene view visibly follow the agent's work. Disabled by default. |
| `unity_editor_show_work_pulse` | Make a single important Show Work beat visible without slowing a bulk/generated editor-script build: select/ping a GameObject, optionally frame it in Scene view, optionally expand one component, and log a [ShowWork] note. Use for high-signal milestones such as camera, player, manager, HUD, hazards, collectibles, and end-card. |
| `unity_editor_play` | Enter Play Mode in the Unity Editor. |
| `unity_editor_stop` | Exit Play Mode and return to Edit Mode. |
| `unity_editor_pause` | Toggle pause in Play Mode. |
| `unity_editor_console_logs` | Get recent Unity Console log entries, NEWEST-LAST (chronological; 'count' takes the most recent N). Optional guards, all BACKWARD-COMPATIBLE (omit for the original behavior): 'severity' (error|warning|log) or 'errors_only' filters to that level BEFORE the count cap (so errors_only returns the last N ERRORS, not errors within the last N of any type); 'max_chars' truncates each entry's message + stackTrace to that length, stamping the entry truncated:true + original_message_length so an over-budget blob (a single 61k-char log line once exceeded the client token budget) is cut HONESTLY server-side. Returns { logs, returned } plus severity / max_chars / truncated_count when those guards are set. |
| `unity_editor_clear_console` | Clear all Unity Console log entries. |
| `unity_editor_refresh_assets` | Trigger AssetDatabase.Refresh() to detect external file changes (newly added scripts, sprites, etc.) without requiring the Unity window to receive focus. Returns compile/update state so caller can decide whether to wait_for. |
| `unity_editor_execute_menu_item` | Run an Editor menu item by path via EditorApplication.ExecuteMenuItem — the re-runnable Editor-builder-script pattern (a [MenuItem] that regenerates a blockout / runs a project tool), without the ops.batch round-trip fragility. SECURITY: STRICTLY gated by the project-configurable allowlist; menu items have NO built-in default, so a path must be opted in via menuItems[] in the project's .loombridge/editor-allowlist.json or the call is REFUSED (INVALID_PARAMS) — never invoked. Returns { menuPath, executed }: executed=false means the gate passed but Unity found no enabled menu item at that path (wrong path, or disabled by its validate function) — distinct from a refusal. LONG BUILDS: this op runs SYNCHRONOUSLY and defaults to the generic 10s wire timeout, but a menu item that triggers a PLAYER BUILD (a [MenuItem] wrapping BuildPipeline.BuildPlayer — iOS/Android/standalone) takes MINUTES and will otherwise time out mid-build (GRL-C26: three such timeouts in one session). RAISE timeoutMs per call for those, e.g. { "menuPath": "MyGame/Build iOS", "timeoutMs": 600000 }. |
| `unity_editor_begin_undo_group` | Begin a named undo group. All subsequent operations will be grouped under this name. |
| `unity_editor_end_undo_group` | End and collapse the current undo group. |
| `unity_editor_wait_for` | Wait for editor conditions to be met: compilation complete, not updating, specific play mode, frame countdown, or delay window. Deterministic wait for input automation (for example { frames: 8 } after key_tap). Never use sleep. RETURNS { waited_ms } and — WHEN a compilation FINISHED at or after this wait started — a compileResult: { compileId, finishedAtMs, succeeded, errorCount, errors: [{ file, line, column, message }] }. This is the AUTHORITATIVE compiler-error report (a flat errors[] aggregated across assemblies; each error's file locates its assembly): after a script change, chain unity_editor_wait_for { compiling: false } and read compileResult.succeeded / compileResult.errors[] instead of scraping Editor.log or grepping compiled DLLs (`strings *.dll | grep` sentinels are brittle and stale). Attribution rule: compileResult is attached ONLY when the latest compilation finished at/after this wait's start (finishedAtMs >= waitStart), so an earlier stale compile is never reported as this wait's result; when no compilation occurred in the wait window, compileResult is omitted entirely (its absence means 'no compile happened here', not 'compile succeeded'). PLAY-MODE DEFERRAL (INFORMATIONAL): a { compiling: false } wait that completes IN PLAY MODE without an attributed compile carries compileDeferred:true + compileDeferredMessage. This fires on ANY such wait — including the innocent play-mode settle where nothing was edited, which is the NORMAL outcome — because Unity exposes no cheap pending-recompile flag, so pending script edits cannot be detected. Read it conditionally: IF you edited scripts during Play Mode, Unity defers their compilation until Play Mode stops, so this wait CANNOT confirm those edits compiled (after you eventually exit Play Mode, wait for { compiling: false } again and read compileResult); if you did not edit scripts, ignore the hint. It is NOT an instruction to stop Play Mode. |
| `unity_editor_tick` | Deterministically ADVANCE the running simulation by a number of frames or a duration, with NO screenshot/sampling overhead (unlike runtime.measure_motion) — RCL-T09. Forces Application.runInBackground=true so the player loop ticks while the editor is unfocused (the headless/background norm), optionally pins Time.captureDeltaTime (captureFps) so each tick is a fixed game-time step, steps the player loop, then restores both. Use to let game logic settle after wiring or input WITHOUT a sleep and WITHOUT needing editor.focus_game_view. Requires Play Mode (a stopped editor does not run game Update) — returns PLAY_MODE_REQUIRED otherwise. Provide EXACTLY ONE of 'frames' or 'durationMs'. Returns { advancedFrames, advancedMs }. |

### unity_editor_screenshot

Take a screenshot of the Scene or Game view. Returns base64-encoded image. For named artifacts, pass outputPath (for example captures/start.png or .loombridge/captures/start.png); the server writes the screenshot there and returns JSON with path/width/height/format/sizeBytes/sha256. Do not scrape trace/artifacts for agent-facing screenshots. For debugging: pass focusLocator to render a deterministic close-up framed on one object (independent of the live camera), and/or annotateBounds to draw objects' collider (green), full sprite quad (magenta), and visible/opaque pixels (yellow) world bounds onto the image so collider-vs-feet-vs-ground alignment is visible. Annotated captures also return the numeric bounds as a text block. Note: the game view is captured via Camera.Render, which composites Screen Space-Camera UI but NOT Screen Space-Overlay UI — use a Camera-mode HUD canvas if you need the HUD to appear in the screenshot.

**Wire command:** `editor.screenshot`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `view` | "scene" \| "game" | No | Which editor view to capture (default: scene) |
| `maxWidth` | number | No | Maximum width in pixels (default: 1024) |
| `format` | "jpeg" \| "png" | No | Image format (default: jpeg) |
| `quality` | number | No | JPEG quality 1-100 (default: 75) |
| `outputPath` | string | No | Optional server-side file path for a named screenshot artifact. Relative paths must be under .loombridge/ or captures/ from the MCP server cwd; absolute paths must stay under ~/loombridge-runs or /tmp. |
| `focusLocator` | object | No | Optional: frame a temp camera tightly on this object for a close-up. |
| `annotateBounds` | object[] | No | Optional: locators whose collider (green), full sprite quad (magenta), and visible/opaque pixels (yellow) world bounds are drawn onto the image. Use to see alignment (e.g. visible feet vs collider vs ground). |

### unity_editor_set_game_view_size

Set the Unity Game View render resolution to a fixed width x height in pixels, so a 'Scale With Screen Size' uGUI canvas genuinely RE-LAYS-OUT at that aspect (CanvasScaler re-evaluates) — not just a cropped screenshot. Use to capture/verify a UI across multiple device aspects (e.g. 1280x720 landscape then 2400x1080 tall): after setting the size, the existing unity_editor_screenshot and unity_ui_get_screen_rects ops read the new size automatically (viewport + canvasScaleFactor change). Returns the applied {width,height,aspect} plus {previousWidth,previousHeight}. The op is idempotent — to RESTORE the prior size, call again with the returned previousWidth/previousHeight.

**Wire command:** `editor.set_game_view_size`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `width` | number | Yes | Game View render width in pixels (integer, 16-8192). |
| `height` | number | Yes | Game View render height in pixels (integer, 16-8192). |

### unity_editor_focus_game_view

Best-effort focus of the Unity Game View so simulated Input-System pointer events can route to world-space game code. Use before world-pointer input capture. Returns gameViewAvailable/gameViewFocused. RCL-T09: focus is never a hard block — when the editor cannot acquire OS focus (the headless/background norm) it DEGRADES gracefully: returns focusDegraded:true and (in Play Mode) enables Application.runInBackground so the player loop still ticks unfocused, instead of failing FOCUS_REQUIRED. For a deterministic sim-advance without focus, use editor.tick.

**Wire command:** `editor.focus_game_view`

*No parameters.*

### unity_editor_get_state

Get the current editor state: play_mode, compile status, selected object, and show_work_enabled plus error_count + last_error (console errors/exceptions since the last clear_console). Clear the console before entering Play Mode, then check error_count > 0 here to catch a thrown exception instead of mistaking it for 'play mode not working'; pull console_logs for the full stack.

**Wire command:** `editor.get_state`

*No parameters.*

### unity_editor_get_project_diagnostics

Project-level capability diagnostics — the 'why does a symbol/module look missing while error_count stays 0?' probe (the late-polish dogfood learnings §10, where ParticleSystem + ScreenCapture modules were disabled yet the console read clean). Returns: { unity_version, render_pipeline: { mode: 'URP'|'HDRP'|'built-in'|'custom', asset_type }, installed_packages: [{ name, version }] (from PackageManager.GetAllRegisteredPackages — direct AND indirect/built-in deps), package_query_failed: boolean, disabled_built_in_modules: string[] | null (BEST-EFFORT: a known optional com.unity.modules.* that is NOT in the registered-package set reads as disabled/removed; enabled built-in modules are registered packages, so absence is a real signal — but the checked set is a curated list of gameplay/FX/import modules, not exhaustive. NULL ≠ []: when the package query fails this is null with package_query_failed:true, so a broken query can never read as 'nothing disabled'; [] is the positive claim that every checked module is enabled), editor_assembly_count + player_assembly_count (the two script-assembly sets, reported separately), last_compile: the CompileWatcher's latest result or null }. Read-only. Results reflect the package registry at call time — immediately after a domain reload the registry may still be resolving.

**Wire command:** `editor.get_project_diagnostics`

*No parameters.*

### unity_editor_audit_mobile_assets

Mobile-optimization WEIGHT audit — measure before you optimize (the late-polish dogfood learnings §9, where a 30.7k-tri T-wall mesh instanced 57× was the real per-frame cost, not the textures that took the blame). Walks the CURRENTLY-LOADED scenes (NOT a full-project AssetDatabase scan — the honest, bounded gameplay working set) and returns: { payload_kind: 'mobile_asset_audit', payload_version: 1 (the discriminator `loombridge mobile-audit` requires — save this response verbatim), textures: { entries:[{ path, name, width, height, format, compression, estimated_bytes }] (shared-material + SpriteRenderer textures, deduped, sorted by estimated bytes desc), total_count, truncated }, audio: { entries:[{ path, name, length_seconds, channels, frequency, load_type, compression_format, file_bytes }] (AudioSource clips, sorted by file bytes desc), total_count, truncated }, meshes: { entries:[{ path, name, vertex_count, triangle_count, instance_count, triangle_load, reason? }] (MeshFilter/SkinnedMeshRenderer shared meshes; instance_count = references across loaded scenes; triangle_load = triangle_count × instance_count; sorted by triangle_load desc — the 57× wall surfaces at the top; counted via Mesh.GetIndexCount submesh metadata so NON-READABLE meshes — imported FBX defaults Read/Write OFF — are still counted correctly, never a false zero; when a count is unobtainable the entry carries triangle_count: null + a reason), total_count, truncated, unreadable_count (entries with null triangle_count — a visible blind spot, the report flags it) }, quality_settings: { level_name, shadow_distance, shadow_resolution, shadow_cascades, msaa, vsync_count, pixel_light_count }, render_pipeline_settings: URP-only reflected { asset_type, shadow_distance, msaa_sample_count, render_scale, supports_hdr, main_light_shadow_resolution, shadow_cascade_count } | null (null + render_pipeline_settings_unavailable_reason when no scriptable pipeline is active or it is not URP — reflection-safe, never throws), build_scenes:[{ path, enabled }], loaded_scene_count, loaded_scenes:[path] }. BOUNDED: each category is truncated to max_entries (default 50) with total_count + truncated flags. Read-only (no AssetDatabase.Refresh, no scene mutation). Feed the output to `loombridge mobile-audit` for advisory findings — always stamped hardware_unvalidated until a device build proves frame rate/memory/post-processing cost.

**Wire command:** `editor.audit_mobile_assets`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `max_entries` | integer | No | Max entries returned per category (textures/audio/meshes), each sorted by its weight. Default 50. total_count + truncated report what was cut. (alias: maxEntries) |

### unity_editor_set_show_work

Enable or disable Loombridge Show Work Mode for demo recordings. When enabled, high-signal bridge ops select/ping the GameObject or asset they just changed so the Unity Hierarchy, Project window, Inspector, and Scene view visibly follow the agent's work. Disabled by default.

**Wire command:** `editor.set_show_work`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `enabled` | boolean | No | Whether Show Work Mode should be enabled (default true). |

### unity_editor_show_work_pulse

Make a single important Show Work beat visible without slowing a bulk/generated editor-script build: select/ping a GameObject, optionally frame it in Scene view, optionally expand one component, and log a [ShowWork] note. Use for high-signal milestones such as camera, player, manager, HUD, hazards, collectibles, and end-card.

**Wire command:** `editor.show_work_pulse`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Locator for the GameObject to select/ping. |
| `note` | string | No | Short visible note for the Console, e.g. 'Building Player'. |
| `frame` | boolean | No | Whether to frame the object in Scene view (default false). |
| `component_type` | string | No | Optional component type name to expand in Inspector. |

### unity_editor_play

Enter Play Mode in the Unity Editor.

**Wire command:** `editor.play`

*No parameters.*

### unity_editor_stop

Exit Play Mode and return to Edit Mode.

**Wire command:** `editor.stop`

*No parameters.*

### unity_editor_pause

Toggle pause in Play Mode.

**Wire command:** `editor.pause`

*No parameters.*

### unity_editor_console_logs

Get recent Unity Console log entries, NEWEST-LAST (chronological; 'count' takes the most recent N). Optional guards, all BACKWARD-COMPATIBLE (omit for the original behavior): 'severity' (error|warning|log) or 'errors_only' filters to that level BEFORE the count cap (so errors_only returns the last N ERRORS, not errors within the last N of any type); 'max_chars' truncates each entry's message + stackTrace to that length, stamping the entry truncated:true + original_message_length so an over-budget blob (a single 61k-char log line once exceeded the client token budget) is cut HONESTLY server-side. Returns { logs, returned } plus severity / max_chars / truncated_count when those guards are set.

**Wire command:** `editor.console_logs`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `count` | number | No | Number of most-recent entries to return (default: 50). Applied AFTER any severity filter. |
| `severity` | "error" \| "warning" \| "log" | No | Only return entries at this level. Contradicting errors_only is refused. |
| `errors_only` | boolean | No | Shorthand for severity:'error' (only errors/exceptions/asserts). |
| `max_chars` | number | No | Truncate each entry's message and stackTrace to at most this many characters (>= 0). A truncated entry gains truncated:true + original_message_length/original_stackTrace_length so the cut is explicit. Omit for no truncation. |

### unity_editor_clear_console

Clear all Unity Console log entries.

**Wire command:** `editor.clear_console`

*No parameters.*

### unity_editor_refresh_assets

Trigger AssetDatabase.Refresh() to detect external file changes (newly added scripts, sprites, etc.) without requiring the Unity window to receive focus. Returns compile/update state so caller can decide whether to wait_for.

**Wire command:** `editor.refresh_assets`

*No parameters.*

### unity_editor_execute_menu_item

Run an Editor menu item by path via EditorApplication.ExecuteMenuItem — the re-runnable Editor-builder-script pattern (a [MenuItem] that regenerates a blockout / runs a project tool), without the ops.batch round-trip fragility. SECURITY: STRICTLY gated by the project-configurable allowlist; menu items have NO built-in default, so a path must be opted in via menuItems[] in the project's .loombridge/editor-allowlist.json or the call is REFUSED (INVALID_PARAMS) — never invoked. Returns { menuPath, executed }: executed=false means the gate passed but Unity found no enabled menu item at that path (wrong path, or disabled by its validate function) — distinct from a refusal. LONG BUILDS: this op runs SYNCHRONOUSLY and defaults to the generic 10s wire timeout, but a menu item that triggers a PLAYER BUILD (a [MenuItem] wrapping BuildPipeline.BuildPlayer — iOS/Android/standalone) takes MINUTES and will otherwise time out mid-build (GRL-C26: three such timeouts in one session). RAISE timeoutMs per call for those, e.g. { "menuPath": "MyGame/Build iOS", "timeoutMs": 600000 }.

**Wire command:** `editor.execute_menu_item`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `menuPath` | string | Yes | Menu item path to execute (e.g. 'Tools/MyGame/Generate Blockout'); must be listed in menuItems[] of .loombridge/editor-allowlist.json. |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 10000). A menu item that triggers a PLAYER BUILD (BuildPipeline.BuildPlayer) runs for minutes — raise this well above the default (e.g. 600000 for a full iOS/Android/standalone build) or the call times out mid-build. |

### unity_editor_begin_undo_group

Begin a named undo group. All subsequent operations will be grouped under this name.

**Wire command:** `editor.begin_undo_group`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Name for the undo group |

### unity_editor_end_undo_group

End and collapse the current undo group.

**Wire command:** `editor.end_undo_group`

*No parameters.*

### unity_editor_wait_for

Wait for editor conditions to be met: compilation complete, not updating, specific play mode, frame countdown, or delay window. Deterministic wait for input automation (for example { frames: 8 } after key_tap). Never use sleep. RETURNS { waited_ms } and — WHEN a compilation FINISHED at or after this wait started — a compileResult: { compileId, finishedAtMs, succeeded, errorCount, errors: [{ file, line, column, message }] }. This is the AUTHORITATIVE compiler-error report (a flat errors[] aggregated across assemblies; each error's file locates its assembly): after a script change, chain unity_editor_wait_for { compiling: false } and read compileResult.succeeded / compileResult.errors[] instead of scraping Editor.log or grepping compiled DLLs (`strings *.dll | grep` sentinels are brittle and stale). Attribution rule: compileResult is attached ONLY when the latest compilation finished at/after this wait's start (finishedAtMs >= waitStart), so an earlier stale compile is never reported as this wait's result; when no compilation occurred in the wait window, compileResult is omitted entirely (its absence means 'no compile happened here', not 'compile succeeded'). PLAY-MODE DEFERRAL (INFORMATIONAL): a { compiling: false } wait that completes IN PLAY MODE without an attributed compile carries compileDeferred:true + compileDeferredMessage. This fires on ANY such wait — including the innocent play-mode settle where nothing was edited, which is the NORMAL outcome — because Unity exposes no cheap pending-recompile flag, so pending script edits cannot be detected. Read it conditionally: IF you edited scripts during Play Mode, Unity defers their compilation until Play Mode stops, so this wait CANNOT confirm those edits compiled (after you eventually exit Play Mode, wait for { compiling: false } again and read compileResult); if you did not edit scripts, ignore the hint. It is NOT an instruction to stop Play Mode.

**Wire command:** `editor.wait_for`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `compiling` | boolean | No | Wait until compiling matches this value |
| `updating` | boolean | No | Wait until updating matches this value |
| `playMode` | "playing" \| "paused" \| "stopped" | No | Wait until play mode matches |
| `frames` | number | No | Wait this many editor frames before completion checks |
| `delayMs` | number | No | Wait at least this many milliseconds before completion checks |
| `timeoutMs` | number | No | Max time to wait in milliseconds |

### unity_editor_tick

Deterministically ADVANCE the running simulation by a number of frames or a duration, with NO screenshot/sampling overhead (unlike runtime.measure_motion) — RCL-T09. Forces Application.runInBackground=true so the player loop ticks while the editor is unfocused (the headless/background norm), optionally pins Time.captureDeltaTime (captureFps) so each tick is a fixed game-time step, steps the player loop, then restores both. Use to let game logic settle after wiring or input WITHOUT a sleep and WITHOUT needing editor.focus_game_view. Requires Play Mode (a stopped editor does not run game Update) — returns PLAY_MODE_REQUIRED otherwise. Provide EXACTLY ONE of 'frames' or 'durationMs'. Returns { advancedFrames, advancedMs }.

**Wire command:** `editor.tick`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `frames` | integer | No | Number of player-loop frames to advance. Provide this OR durationMs. |
| `durationMs` | number | No | Game-time milliseconds to advance. Provide this OR frames. |
| `captureFps` | integer | No | Pin Time.captureDeltaTime to 1/captureFps for a fixed game-time step per tick (default 60). 0 disables pinning (live rate). |

## Input Operations

| Tool | Description |
|------|-------------|
| `unity_input_get_capabilities` | Get deterministic input capability status (supported/unsupported + reason), backend availability, focus status, play mode requirement, and limitations. |
| `unity_input_begin_session` | Begin an input automation session. Selects the first available backend unless one is explicitly requested. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first. |
| `unity_input_key_down` | Press and hold a key in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first. |
| `unity_input_key_up` | Release a held key in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first. |
| `unity_input_key_tap` | Tap a key (key_down + key_up) in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first. |
| `unity_input_click_ui` | Dispatch a UI click through the active input backend. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first. |
| `unity_input_observe_start` | Begin OBSERVING the developer's real left-clicks during manual Play (the observe-a-human-session recorder). Unlike the input-driving ops, this does not inject input and needs no input session — it reads legacy UnityEngine.Input + the uGUI EventSystem in the game's Update loop. Requires Play Mode. FOCUSES the Game view first, so the human's first taps reach the game instead of being swallowed by the editor; a gesture that still arrives while the Game view is unfocused is dropped and counted as `droppedUnfocused` rather than recorded as a step the game never processed. Pair with input.observe_stop to collect the recorded clicks (each resolved to a locator). |
| `unity_input_pointer_tap` | Tap a SIMULATED Input System pointer (left button, press→release) at a Game-View screen point (x, y in pixels, origin BOTTOM-LEFT — matching Camera.WorldToScreenPoint / get_screen_rects). Drives NON-uGUI / world-space targets a game resolves from `Pointer.current` (e.g. a Physics2D.OverlapPoint sprite hit) — what the EventSystem dispatch can't reach. Requires Play Mode + the Input System (ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a legacy-only project. Editor should be focused. |
| `unity_input_pointer_tap_world` | Tap a SIMULATED Input System pointer at a WORLD coordinate. Projects {x,y,z?} through Camera.main (or an explicit camera locator) to Game-View screen pixels, then uses the same pointer path as input.pointer_tap. Drives NON-uGUI / world-space targets a game resolves from `Pointer.current`. Requires Play Mode + the Input System (ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a legacy-only project. Refuses if the world point cannot project into the camera pixel rect. |
| `unity_input_observe_stop` | Stop observing and return { clicks: [{ tMs, locator, button }], keyEdges: [{ key, edge, tMs }], observed, droppedNoTarget, droppedUnfocused }, each click resolved to a locator. `observed:false` means the recorder was not live at stop (never started, or Play Mode was restarted after observe_start) — an empty clicks then is 'observation died', NOT 'clicked nothing', so refuse it. `droppedUnfocused` counts gestures the editor swallowed because the Game view lacked input focus: the game never processed them, so they are reported and never recorded. MUST be called while Play Mode is still active (runtime objects are destroyed on stop). Feed the clicks to the replay recorder to mint a trace. |
| `unity_input_end_session` | End the active input session and release pressed keys. |

### unity_input_get_capabilities

Get deterministic input capability status (supported/unsupported + reason), backend availability, focus status, play mode requirement, and limitations.

**Wire command:** `input.get_capabilities`

*No parameters.*

### unity_input_begin_session

Begin an input automation session. Selects the first available backend unless one is explicitly requested. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first.

**Wire command:** `input.begin_session`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `backend` | "InputSystem" \| "EditorEvent" | No | Optional explicit backend preference |
| `sessionId` | string | No | Optional deterministic session identifier |
| `allowEditMode` | boolean | No | Allow input while not in Play Mode (default: false) |

### unity_input_key_down

Press and hold a key in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first.

**Wire command:** `input.key_down`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | Unity KeyCode name (for example Space, LeftArrow, A) |

### unity_input_key_up

Release a held key in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first.

**Wire command:** `input.key_up`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | Unity KeyCode name (for example Space, LeftArrow, A) |

### unity_input_key_tap

Tap a key (key_down + key_up) in the active input session. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first.

**Wire command:** `input.key_tap`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | Unity KeyCode name (for example Space, LeftArrow, A) |

### unity_input_click_ui

Dispatch a UI click through the active input backend. Fails fast with deterministic blocker [INPUT_CAPABILITY_BLOCKED] when input capability is unsupported; run unity_input_get_capabilities first.

**Wire command:** `input.click_ui`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `x` | number | No | Mouse X coordinate relative to Game View |
| `y` | number | No | Mouse Y coordinate relative to Game View |
| `button` | number | No | Mouse button index (default: 0) |

### unity_input_observe_start

Begin OBSERVING the developer's real left-clicks during manual Play (the observe-a-human-session recorder). Unlike the input-driving ops, this does not inject input and needs no input session — it reads legacy UnityEngine.Input + the uGUI EventSystem in the game's Update loop. Requires Play Mode. FOCUSES the Game view first, so the human's first taps reach the game instead of being swallowed by the editor; a gesture that still arrives while the Game view is unfocused is dropped and counted as `droppedUnfocused` rather than recorded as a step the game never processed. Pair with input.observe_stop to collect the recorded clicks (each resolved to a locator).

**Wire command:** `input.observe_start`

*No parameters.*

### unity_input_pointer_tap

Tap a SIMULATED Input System pointer (left button, press→release) at a Game-View screen point (x, y in pixels, origin BOTTOM-LEFT — matching Camera.WorldToScreenPoint / get_screen_rects). Drives NON-uGUI / world-space targets a game resolves from `Pointer.current` (e.g. a Physics2D.OverlapPoint sprite hit) — what the EventSystem dispatch can't reach. Requires Play Mode + the Input System (ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a legacy-only project. Editor should be focused.

**Wire command:** `input.pointer_tap`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `x` | number | Yes | Screen X in Game-View pixels (origin bottom-left). |
| `y` | number | Yes | Screen Y in Game-View pixels (origin bottom-left). |
| `button` | number | No | Reserved; only the left button (0) is simulated in v1. |

### unity_input_pointer_tap_world

Tap a SIMULATED Input System pointer at a WORLD coordinate. Projects {x,y,z?} through Camera.main (or an explicit camera locator) to Game-View screen pixels, then uses the same pointer path as input.pointer_tap. Drives NON-uGUI / world-space targets a game resolves from `Pointer.current`. Requires Play Mode + the Input System (ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a legacy-only project. Refuses if the world point cannot project into the camera pixel rect.

**Wire command:** `input.pointer_tap_world`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `x` | number | Yes | World X coordinate. |
| `y` | number | Yes | World Y coordinate. |
| `z` | number | No | World Z coordinate (default 0). |
| `camera` | object | No | Optional Camera locator. Defaults to Camera.main. |
| `button` | number | No | Reserved; only the left button (0) is simulated in v1. |

### unity_input_observe_stop

Stop observing and return { clicks: [{ tMs, locator, button }], keyEdges: [{ key, edge, tMs }], observed, droppedNoTarget, droppedUnfocused }, each click resolved to a locator. `observed:false` means the recorder was not live at stop (never started, or Play Mode was restarted after observe_start) — an empty clicks then is 'observation died', NOT 'clicked nothing', so refuse it. `droppedUnfocused` counts gestures the editor swallowed because the Game view lacked input focus: the game never processed them, so they are reported and never recorded. MUST be called while Play Mode is still active (runtime objects are destroyed on stop). Feed the clicks to the replay recorder to mint a trace.

**Wire command:** `input.observe_stop`

*No parameters.*

### unity_input_end_session

End the active input session and release pressed keys.

**Wire command:** `input.end_session`

*No parameters.*

## Runtime Operations

| Tool | Description |
|------|-------------|
| `unity_runtime_get_snapshot` | Get a generic runtime snapshot for a scene object: identity, active flags, transform values, and optional component property values. |
| `unity_runtime_assert_condition` | Evaluate a comparator against runtime state and return a deterministic pass/fail result. |
| `unity_runtime_wait_for_condition` | Wait deterministically until a runtime condition passes or timeout is reached. Supports comparator semantics with frames/delay/timeout controls. |
| `unity_runtime_measure_motion` | Measure a GameObject's motion over a game-time window during Play Mode and return game-feel metrics: peakY/deltaY (jump apex height), timeToApexMs, deltaX/avgRunSpeed (run speed), plus minY/durationMs/sampleCount. Sampling is keyed off GAME TIME (not editor frame count) so it is robust to editor frame-rate swings. captureFps pins Time.captureDeltaTime during sampling for deterministic, high-resolution, focus-independent capture. Generic primitive — issue input (e.g. hold RightArrow, or set the jump just before) so the window captures the resulting motion. Requires Play Mode (and an active input session for input-driven motion). Set includeSamples=true to also return the raw trajectory (samples[]: tMs/x/y/z relative to start; z is present once the bridge emits a 3D trajectory) plus projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance, so feel metrics can be re-derived from the raw samples (verify-first re-derivation). measure_motion observes the project's real physics rate (never pins Time.fixedDeltaTime), so the two timestep fields are equal. PERF (RCL-T07): a measure's wall-clock cost is ~ (durationMs/1000 * captureFps) editor ticks at the backgrounded editor's slow rate (the ~10s/call overhead the dogfood saw); set fastForward=true to pump the player loop and finish the SAME game-time window in less wall-clock (best-effort ITERATION speed-up — samples stay honest/re-derivable, but the sampling cadence and thus derived peakY/timeToApexMs may differ from a non-fastForward run, so do NOT use it for a gate-bound feel capture). The op stays in Play Mode, so also AMORTIZE by issuing several measure windows back-to-back in one play session instead of re-entering play per measure. |
| `unity_runtime_probe` | Deterministically drive one component property/field through a sequence of timed phases WHILE sampling a target object's transform position — all inside a single focus-independent loop (forces runInBackground + pins Time.captureDeltaTime). Use to measure TRANSIENT game-feel reproducibly (camera follow on stop, recoil, knockback, dash): driving input across separate MCP calls is unreliable because the editor ticks the sim during inter-call gaps. Game-agnostic — 'driver' and 'measure' are any objects. Two forms: SINGLE-driver — a top-level 'driver' plus phases[].value (one property over the phases); or MULTI-driver — each phase supplies its own phases[].drivers[] (set SEVERAL properties simultaneously at a phase boundary, e.g. run + jump). Both forms share one sampling loop and are back-compatible. Returns per-phase startX/endX/deltaX, minX/maxX (overshoot), Y equivalents, and durationMs; optionally the full trajectory. Requires Play Mode. |
| `unity_runtime_capture_sequence` | Single-shot deterministic runtime capture for verification. Drives phased component inputs like unity_runtime_probe, samples the measured object's motion, and captures named Game-view frames inside the same pinned simulation loop (start/end/atMs/apexY triggers). Use this instead of probe-then-screenshot when verifying jump/dash/camera/artifact states; it avoids extra MCP turns and screenshot timing races. Requires Play Mode. |
| `unity_runtime_capture_input_motion` | Capture an INPUT-DRIVEN trajectory (run, jump, ...) in ONE call by injecting the declared keys INSIDE the sampling loop. Use this instead of a separate input.key_down then runtime.measure_motion: those are two MCP calls with a ~150-250ms latency gap, during which a fast controller can traverse the whole runway and be walled before the measure window even opens (every run window reads deltaX=0). Here the keys are driven from sample t=0 on the same ticks that sample the target, so there is no key_down->measure gap. Pass 'phases' as an ordered list of { keys:[KeyCode names], durationMs } or { keys, fixedTicks } (empty keys = a settle phase with no keys held); each phase's keys are diffed tick-to-tick and only the changes are injected (idempotent). captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the game loop runs at its live rate and injected input reaches the controller; set captureFps>0 to pin the timestep like measure_motion (still injecting in-loop). Requires Play Mode and an active input session (input.begin_session) — keys are driven through the same input pipeline as the input.* ops (Game-view focus + virtual-only injection apply). All held keys are released when the capture ends. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, samples[]:{tMs,x,y,z}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance) plus a per-phase breakdown (index/keys/requestedDurationMs/sampleCount/startX/endX/deltaX/startY/endY/deltaY/minY/maxY). When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit). |
| `unity_runtime_capture_pointer_motion` | Capture a POINTER-DRIVEN trajectory (a launch-aligned jump arc, ...) in ONE call by dispatching a pointer tap INSIDE the sampling loop. Use target:{locator} for games driven by on-screen uGUI buttons, or world:{x,y,z?,camera?} for Input-System world-space pointer reads. This is the pointer analog of runtime.capture_input_motion. Instead of firing an async runtime.measure_motion and a separate ui.dispatch_pointer (two MCP calls with a ~450ms WS round-trip gap between the tap and sample-0, which made timeToApex measured from the first sample wrong and forced trimming the launch by hand), this samples a baseline for 'settleMs', then dispatches the tap on a tick, latches the dispatch elapsedMs, and keeps sampling for 'captureMs'. The capture is therefore launch-aligned. captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the EventSystem + game run at their live rate and the tap is processed; set captureFps>0 to pin the timestep like measure_motion (still dispatching in-loop). Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, samples[]:{tMs,x,y}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance — deltaY is the true jumpApex since 'settleMs' established the ground baseline) PLUS pointerDispatchMs (the elapsedMs the FIRST tap fired, the launch reference; null if never dispatched), timeToApexFromDispatchMs (apex elapsedMs minus pointerDispatchMs — the launch-aligned timeToApex; null if not dispatched or no rise), taps:[{ atMs, dispatchedMs, actuated, raycastHit, handlersFired, world?, screen?, camera?, mode? }] (per scheduled tap — see the 'taps' param for multi-tap), and dispatch:{...} = the first tap's outcome. Honest: uGUI target taps report actuation from EventSystem handlers; world Input-System taps report dispatch/projection only (actuated:null), so callers must require motion or another response signal before grading. When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit). |
| `unity_runtime_capture_pointer_hold_motion` | Capture motion while a uGUI control is driven by a SUSTAINED pointer hold. With 'dragTo', this is the joystick-hold analog of capture_pointer_motion's tap; without 'dragTo', it is a button press/hold/release. Use drag mode for games whose locomotion is driven by an on-screen JOYSTICK (legacy-Input mobile titles, e.g. a Fixed Joystick → run speed) where a single tap can't elicit continuous movement. It samples a baseline for 'settleMs', then ONCE presses 'target' and optionally drags to 'dragTo' ({dx,dy} screen px from the target center — a magnitude past the joystick radius clamps to FULL deflection), HOLDS, and at 'releaseMs'/'releaseFixedTicks' (or the window end) RELEASES the pointer. The bridge captures the trajectory; the caller derives runSpeed/accel/decel from samples[] (deterministic-CLI-vs-bridge split — same as the keyed capture_input_motion run metrics). captureFps defaults to 0 (live rate so the EventSystem + game run normally); set >0 to pin the timestep. Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/deltaX/avgRunSpeed/durationMs/sampleCount, samples[]:{tMs,x,y}, timestep provenance) PLUS holdDispatchMs (the elapsedMs the hold began; null if never dispatched), releaseMs (the elapsedMs the pointer released; null if held to the window end), optional requestedFixedTicks/actualFixedTicks for fixed-tick release, and dispatch:{ actuated, raycastHit, handlersFired }. In drag mode actuated=true means 'drag' fired; in button mode actuated=true means pointerDown and pointerUp fired. Honest: if the hold does not actuate, the flat capture is STILL returned with dispatch.actuated:false so the caller sees WHY there was no motion (not an error). When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] on the same tick clock as the position samples (honest-or-omit; unresolvable fields carry a reason and are never sampled). |
| `unity_runtime_sample_animator` | HONEST animation-progress verification for an Animator. Motivating incident: an unfocused/headless editor advances physics but NOT Animator time even with runInBackground, so an agent could 'verify' an animation from a STATIC pose that was actually FROZEN. This op resolves the GameObject (refuses NOT_FOUND if it has no Animator), samples layer-0 state (fullPathHash/normalizedTime/speed), animator.playableGraph.IsPlaying()/animator.speed, and each requested bone's LOCAL pose (localRotation+localPosition) across a window, then computes verdict fields HONESTLY: time_advancing (normalizedTime strictly increased — judged PER STATE between CONSECUTIVE same-fullPathHash samples, because Unity's normalizedTime is MONOTONIC within a looping state (integer part = loop count) and a cross-state comparison proves nothing), bones_moving (any requested bone's LOCAL rotation/position delta above epsilon — SKELETAL-local motion only, never root motion: a physics-driven root moving under a frozen animator must not read as animation), and a status that NAMES the frozen case instead of laundering it into a pass. status is one of: 'ok' (sampled a real window), 'blocked_culled' (cullingMode=CullCompletely and animator time did not advance — the offscreen-culled freeze; focus-INDEPENDENT and checked BEFORE any focus diagnosis so a focused editor cannot launder it into ok), 'blocked_unfocused' (the animator was EXPECTED to advance — enabled + controller + speed != 0 + activeInHierarchy + isInitialized — but animator time did NOT advance across the window AND the editor application is inactive: the physics-advances-but-Animator-frozen defect. NOTE: under -batchmode isApplicationActive is ALWAYS false, so there this status simply means 'editor app inactive'; the sampling loop pins Time.captureDeltaTime so game time DID advance across the window, which makes the frozen animator strong evidence of the Animator-update throttle regardless of the focus flag), 'insufficient_samples' (the window produced <2 distinct-timestamp samples, so advancement can never be established — refuse, not skip), or 'edit_mode_static' (paused-scene single-shot pose read; never time_advancing). It NEVER reports time_advancing:true from a single sample or identical timestamps (at most one sample is recorded per tick, each with a distinct game-time stamp). Works in BOTH play mode (samples across real frames using measure_motion's focus-independent machinery: forces runInBackground + pins Time.captureDeltaTime; play-mode exit / domain reload mid-window restores pinned time and errors cleanly instead of leaking capture state) and edit mode (single-shot pose + status edit_mode_static). Focus signal: UnityEditorInternal.InternalEditorUtility.isApplicationActive. Returns { status, status_note? (present for blocked_* — names the cause and the fix), time_advancing, bones_moving, playMode, editorHasFocus, animatorPlaying, animatorSpeed, culling_mode, active_in_hierarchy, is_initialized, graphPlaying, currentState, sampleCount, distinctTimeSamples, durationMs, bones:[{path,resolved}], samples:[{tMs,normalizedTime,fullPathHash,stateSpeed,graphPlaying,bones:[{path,resolved,localRotation,localPosition}]}] }. |

### unity_runtime_get_snapshot

Get a generic runtime snapshot for a scene object: identity, active flags, transform values, and optional component property values.

**Wire command:** `runtime.get_snapshot`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `components` | string[] | No | Optional component type filters (name or full type name) |
| `include_paths` | string[] | No | Optional serialized property paths to include per selected component |

### unity_runtime_assert_condition

Evaluate a comparator against runtime state and return a deterministic pass/fail result.

**Wire command:** `runtime.assert_condition`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `component` | string | No | Optional component type name when asserting component properties |
| `property_path` | string | Yes | Runtime property path (or component property path when component is set) |
| `operator` | "equals" \| "not_equals" \| "greater_than" \| "less_than" \| "approx" \| "contains" | Yes |  |
| `expected` | string,object,number,boolean,null | Yes | Expected value for comparison (preserves JSON shape; do not pre-stringify). |
| `tolerance` | number | No | Tolerance used by operator=approx (default: 0.001) |

### unity_runtime_wait_for_condition

Wait deterministically until a runtime condition passes or timeout is reached. Supports comparator semantics with frames/delay/timeout controls.

**Wire command:** `runtime.wait_for_condition`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `component` | string | No | Optional component type name when asserting component properties |
| `property_path` | string | Yes | Runtime property path (or component property path when component is set) |
| `operator` | "equals" \| "not_equals" \| "greater_than" \| "less_than" \| "approx" \| "contains" | Yes |  |
| `expected` | string,object,number,boolean,null | Yes | Expected value for comparison (preserves JSON shape; do not pre-stringify). |
| `tolerance` | number | No | Tolerance used by operator=approx (default: 0.001) |
| `compiling` | boolean | No | Optional editor compiling predicate while polling |
| `updating` | boolean | No | Optional editor updating predicate while polling |
| `playMode` | "playing" \| "paused" \| "stopped" | No | Optional play mode predicate while polling |
| `frames` | number | No | Wait this many editor frames before polling completion |
| `delayMs` | number | No | Wait at least this many milliseconds before polling completion |
| `timeoutMs` | number | No | Max time to wait in milliseconds |

### unity_runtime_measure_motion

Measure a GameObject's motion over a game-time window during Play Mode and return game-feel metrics: peakY/deltaY (jump apex height), timeToApexMs, deltaX/avgRunSpeed (run speed), plus minY/durationMs/sampleCount. Sampling is keyed off GAME TIME (not editor frame count) so it is robust to editor frame-rate swings. captureFps pins Time.captureDeltaTime during sampling for deterministic, high-resolution, focus-independent capture. Generic primitive — issue input (e.g. hold RightArrow, or set the jump just before) so the window captures the resulting motion. Requires Play Mode (and an active input session for input-driven motion). Set includeSamples=true to also return the raw trajectory (samples[]: tMs/x/y/z relative to start; z is present once the bridge emits a 3D trajectory) plus projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance, so feel metrics can be re-derived from the raw samples (verify-first re-derivation). measure_motion observes the project's real physics rate (never pins Time.fixedDeltaTime), so the two timestep fields are equal. PERF (RCL-T07): a measure's wall-clock cost is ~ (durationMs/1000 * captureFps) editor ticks at the backgrounded editor's slow rate (the ~10s/call overhead the dogfood saw); set fastForward=true to pump the player loop and finish the SAME game-time window in less wall-clock (best-effort ITERATION speed-up — samples stay honest/re-derivable, but the sampling cadence and thus derived peakY/timeToApexMs may differ from a non-fastForward run, so do NOT use it for a gate-bound feel capture). The op stays in Play Mode, so also AMORTIZE by issuing several measure windows back-to-back in one play session instead of re-entering play per measure.

**Wire command:** `runtime.measure_motion`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `durationMs` | number | No | Game-time window to sample, in milliseconds (default 1200). A full jump arc fits in ~800-1200ms. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps during sampling for deterministic high-res capture (default 120). Set 0 to disable pinning and sample at the live frame rate. |
| `includeSamples` | boolean | No | Also return the raw trajectory (samples[]: {tMs,x,y} relative to start) + projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance, for offline re-derivation of feel metrics. Default false. |
| `fastForward` | boolean | No | RCL-T07: pump the player loop (QueuePlayerLoopUpdate) each tick so the same game-time window finishes in less wall-clock. Best-effort ITERATION speed-up — the returned samples stay honest and re-derivable, but pumping an extra tick can coarsen/shift the sampling cadence so the DERIVED feel values may differ from a non-fastForward run; do NOT use it for a gate-bound feel capture. Default false. The response echoes fastForward. |

### unity_runtime_probe

Deterministically drive one component property/field through a sequence of timed phases WHILE sampling a target object's transform position — all inside a single focus-independent loop (forces runInBackground + pins Time.captureDeltaTime). Use to measure TRANSIENT game-feel reproducibly (camera follow on stop, recoil, knockback, dash): driving input across separate MCP calls is unreliable because the editor ticks the sim during inter-call gaps. Game-agnostic — 'driver' and 'measure' are any objects. Two forms: SINGLE-driver — a top-level 'driver' plus phases[].value (one property over the phases); or MULTI-driver — each phase supplies its own phases[].drivers[] (set SEVERAL properties simultaneously at a phase boundary, e.g. run + jump). Both forms share one sampling loop and are back-compatible. Returns per-phase startX/endX/deltaX, minX/maxX (overshoot), Y equivalents, and durationMs; optionally the full trajectory. Requires Play Mode.

**Wire command:** `runtime.probe`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `measure` | object | Yes | Locator of the object whose transform.position is sampled (e.g. the camera). |
| `driver` | object | No | SINGLE-driver form: the property/field set at each phase boundary via phases[].value. Optional when each phase supplies its own phases[].drivers[]. |
| `phases` | object[] | Yes | Ordered phases. Single-driver: each is { value, durationMs }. Multi-driver: each is { durationMs, drivers:[{locator,type_name,property_path,value}] } — all drivers set simultaneously at the boundary (e.g. simultaneous run + jump). |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps (default 120). 0 disables pinning. |
| `includeSamples` | boolean | No | Return the full per-tick trajectory (tMs/x/y/phase). Default false. |
| `resetDriversOnEnd` | boolean | No | Zero every driven force*/value field when the probe ends so a left-set driver does not keep moving the object during the inter-call gap (default: true). Set false to leave the last value applied. |

### unity_runtime_capture_sequence

Single-shot deterministic runtime capture for verification. Drives phased component inputs like unity_runtime_probe, samples the measured object's motion, and captures named Game-view frames inside the same pinned simulation loop (start/end/atMs/apexY triggers). Use this instead of probe-then-screenshot when verifying jump/dash/camera/artifact states; it avoids extra MCP turns and screenshot timing races. Requires Play Mode.

**Wire command:** `runtime.capture_sequence`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `measure` | object | Yes | Locator of the object whose transform.position is sampled and used for apexY capture. |
| `driver` | object | No | SINGLE-driver form: the property/field set at each phase boundary via phases[].value. Optional when phases supply drivers[]. |
| `phases` | object[] | Yes | Ordered runtime phases. Same shape as unity_runtime_probe phases. |
| `captures` | object[] | Yes | Named screenshots to capture inside the runtime loop. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps (default 120). 0 disables pinning. |
| `includeSamples` | boolean | No | Return full per-tick trajectory. Default false. |
| `resetDriversOnEnd` | boolean | No | Zero every driven force*/value field at the end (default true). |

### unity_runtime_capture_input_motion

Capture an INPUT-DRIVEN trajectory (run, jump, ...) in ONE call by injecting the declared keys INSIDE the sampling loop. Use this instead of a separate input.key_down then runtime.measure_motion: those are two MCP calls with a ~150-250ms latency gap, during which a fast controller can traverse the whole runway and be walled before the measure window even opens (every run window reads deltaX=0). Here the keys are driven from sample t=0 on the same ticks that sample the target, so there is no key_down->measure gap. Pass 'phases' as an ordered list of { keys:[KeyCode names], durationMs } or { keys, fixedTicks } (empty keys = a settle phase with no keys held); each phase's keys are diffed tick-to-tick and only the changes are injected (idempotent). captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the game loop runs at its live rate and injected input reaches the controller; set captureFps>0 to pin the timestep like measure_motion (still injecting in-loop). Requires Play Mode and an active input session (input.begin_session) — keys are driven through the same input pipeline as the input.* ops (Game-view focus + virtual-only injection apply). All held keys are released when the capture ends. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, samples[]:{tMs,x,y,z}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance) plus a per-phase breakdown (index/keys/requestedDurationMs/sampleCount/startX/endX/deltaX/startY/endY/deltaY/minY/maxY). When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit).

**Wire command:** `runtime.capture_input_motion`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `measure` | object | Yes | Locator of the object whose transform.position is sampled (e.g. the player). |
| `phases` | object[] | Yes | Ordered timed input phases. Each is { keys:[KeyCode names], durationMs } or { keys, fixedTicks }. Empty keys = a settle phase (no keys held). fixedTicks is converted by the bridge using the live project Time.fixedDeltaTime, for stimulus-sensitive recipes such as canonical short-hop. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = do NOT pin; sample at the live frame rate so injected input runs normally). Set >0 for deterministic pinned capture (still injects in-loop). |
| `includeSamples` | boolean | No | Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true. |
| `sampledFields` | object[] | No | L3a: optional per-tick runtime-member sampling. Each entry samples a NON-transform runtime signal (e.g. AudioSource.isPlaying for a jump SFX, ParticleSystem.particleCount/isEmitting for landing dust) on the SAME tick clock as the position samples, so cross-modal sync (input->SFX, contact->dust, input->anim-state) can be derived. Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('jumping')) — on the live component (NOT serialized fields); only JSON-scalar members are supported (bool, integer, float, enum->underlying number). A field that cannot be resolved (no GameObject / no component / no such member or method / non-scalar member) is reported in fieldTimeline with an 'unresolved' reason and is never sampled (honest-or-omit — never a fabricated 0/false). Adds a fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] to the response; existing callers that omit sampledFields see an unchanged response (no fieldTimeline). |

### unity_runtime_capture_pointer_motion

Capture a POINTER-DRIVEN trajectory (a launch-aligned jump arc, ...) in ONE call by dispatching a pointer tap INSIDE the sampling loop. Use target:{locator} for games driven by on-screen uGUI buttons, or world:{x,y,z?,camera?} for Input-System world-space pointer reads. This is the pointer analog of runtime.capture_input_motion. Instead of firing an async runtime.measure_motion and a separate ui.dispatch_pointer (two MCP calls with a ~450ms WS round-trip gap between the tap and sample-0, which made timeToApex measured from the first sample wrong and forced trimming the launch by hand), this samples a baseline for 'settleMs', then dispatches the tap on a tick, latches the dispatch elapsedMs, and keeps sampling for 'captureMs'. The capture is therefore launch-aligned. captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the EventSystem + game run at their live rate and the tap is processed; set captureFps>0 to pin the timestep like measure_motion (still dispatching in-loop). Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, samples[]:{tMs,x,y}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance — deltaY is the true jumpApex since 'settleMs' established the ground baseline) PLUS pointerDispatchMs (the elapsedMs the FIRST tap fired, the launch reference; null if never dispatched), timeToApexFromDispatchMs (apex elapsedMs minus pointerDispatchMs — the launch-aligned timeToApex; null if not dispatched or no rise), taps:[{ atMs, dispatchedMs, actuated, raycastHit, handlersFired, world?, screen?, camera?, mode? }] (per scheduled tap — see the 'taps' param for multi-tap), and dispatch:{...} = the first tap's outcome. Honest: uGUI target taps report actuation from EventSystem handlers; world Input-System taps report dispatch/projection only (actuated:null), so callers must require motion or another response signal before grading. When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit).

**Wire command:** `runtime.capture_pointer_motion`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `measure` | object | Yes | Locator of the object whose transform.position is sampled (e.g. the player). |
| `target` | object | No | Locator of the uGUI element to tap (e.g. /ControllesMobiles/ButtonJump). Tapped via EventSystemPointerDispatch.Click at its rect center. Mutually exclusive with world. |
| `world` | object | No | Input-System world-space pointer tap. Projects {x,y,z?} through Camera.main or world.camera to Game-View screen pixels, then dispatches the simulated pointer in-loop. Mutually exclusive with target. |
| `settleMs` | number | No | Baseline sampling window before the tap, establishing the ground reference (>= 0, default 300). The (single) tap is dispatched on the first tick at/after settleMs. Ignored when 'taps' is supplied. |
| `captureMs` | number | No | Sampling window after the LAST tap (the arc), in ms (> 0, default 1000). Capture finishes at (last tap atMs) + captureMs. |
| `taps` | object[] | No | Optional MULTI-TAP schedule: an ASCENDING array of { atMs } (elapsedMs from capture start). Each tap is dispatched on 'target' IN-LOOP at its scheduled time, so a multi-tap mechanism — e.g. a double-jump = a 2nd tap while AIRBORNE — is driven with precise, loop-controlled timing rather than the jitter of separate MCP calls (which made the harness land the 2nd tap after touchdown). Supersedes 'settleMs' (the first tap's atMs IS the settle). Each tap's outcome is returned in the response 'taps[]': { atMs, dispatchedMs, actuated, raycastHit, handlersFired }. Omit for the default single tap at settleMs. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = do NOT pin; sample at the live frame rate so the EventSystem + dispatched tap run normally). Set >0 for deterministic pinned capture (still dispatches in-loop). |
| `includeSamples` | boolean | No | Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true. |
| `sampledFields` | object[] | No | L3a: optional per-tick runtime-member sampling. Each entry samples a NON-transform runtime signal (e.g. AudioSource.isPlaying for a jump SFX, ParticleSystem.particleCount/isEmitting for landing dust) on the SAME tick clock as the position samples, so cross-modal sync (tap->SFX, contact->dust, tap->anim-state) can be derived. Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('jumping')) — on the live component (NOT serialized fields); only JSON-scalar members are supported (bool, integer, float, enum->underlying number). A field that cannot be resolved (no GameObject / no component / no such member or method / non-scalar member) is reported in fieldTimeline with an 'unresolved' reason and is never sampled (honest-or-omit — never a fabricated 0/false). Adds a fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] to the response; existing callers that omit sampledFields see an unchanged response (no fieldTimeline). |

### unity_runtime_capture_pointer_hold_motion

Capture motion while a uGUI control is driven by a SUSTAINED pointer hold. With 'dragTo', this is the joystick-hold analog of capture_pointer_motion's tap; without 'dragTo', it is a button press/hold/release. Use drag mode for games whose locomotion is driven by an on-screen JOYSTICK (legacy-Input mobile titles, e.g. a Fixed Joystick → run speed) where a single tap can't elicit continuous movement. It samples a baseline for 'settleMs', then ONCE presses 'target' and optionally drags to 'dragTo' ({dx,dy} screen px from the target center — a magnitude past the joystick radius clamps to FULL deflection), HOLDS, and at 'releaseMs'/'releaseFixedTicks' (or the window end) RELEASES the pointer. The bridge captures the trajectory; the caller derives runSpeed/accel/decel from samples[] (deterministic-CLI-vs-bridge split — same as the keyed capture_input_motion run metrics). captureFps defaults to 0 (live rate so the EventSystem + game run normally); set >0 to pin the timestep. Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/deltaX/avgRunSpeed/durationMs/sampleCount, samples[]:{tMs,x,y}, timestep provenance) PLUS holdDispatchMs (the elapsedMs the hold began; null if never dispatched), releaseMs (the elapsedMs the pointer released; null if held to the window end), optional requestedFixedTicks/actualFixedTicks for fixed-tick release, and dispatch:{ actuated, raycastHit, handlersFired }. In drag mode actuated=true means 'drag' fired; in button mode actuated=true means pointerDown and pointerUp fired. Honest: if the hold does not actuate, the flat capture is STILL returned with dispatch.actuated:false so the caller sees WHY there was no motion (not an error). When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] on the same tick clock as the position samples (honest-or-omit; unresolvable fields carry a reason and are never sampled).

**Wire command:** `runtime.capture_pointer_hold_motion`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `measure` | object | Yes | Locator of the object whose transform.position is sampled (e.g. the player). |
| `target` | object | Yes | Locator of the uGUI control to hold (e.g. /ControllesMobiles/ButtonJump or /ControllesMobiles/Fixed Joystick). Pressed from its rect center. |
| `dragTo` | object | No | Optional held deflection as a screen-pixel offset from the target center. Omit for button hold/release. When present, at least one of dx/dy must be non-zero. For a horizontal run, set dx (e.g. { dx: 200 } for full right, { dx: -200 } for left); a magnitude beyond the joystick radius clamps to full deflection. |
| `settleMs` | number | No | Baseline sampling window before the hold begins (>= 0, default 300). The press/hold is dispatched on the first tick at/after settleMs. |
| `captureMs` | number | No | Sampling window after settleMs, in ms (> 0, default 1500). Capture finishes at settleMs + captureMs. |
| `releaseMs` | number | No | Optional: release the hold this many ms AFTER the hold begins, then keep sampling to the window end so deceleration or jump response is captured. Must be > 0 and <= captureMs. Omit to hold for the whole window (released at the end). |
| `releaseFixedTicks` | integer | No | Optional: release this many project fixed physics ticks after the hold begins. Must be positive. Mutually exclusive with releaseMs. Emits requestedFixedTicks/actualFixedTicks for stimulus-sensitive metrics such as shortHopApex. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = live rate so the EventSystem + dragged control run normally). Set >0 for deterministic pinned capture. |
| `includeSamples` | boolean | No | Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true. |
| `sampledFields` | object[] | No | L3a: optional per-tick runtime-member sampling on the SAME tick clock as the position samples (e.g. a run-loop SFX or dust), so cross-modal sync can be derived. Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('moving')) — on the live component (NOT serialized fields); only JSON-scalar members are supported. A field that cannot be resolved (no GameObject / no component / no such member or method / non-scalar member) is reported with an 'unresolved' reason and is never sampled (honest-or-omit — never a fabricated 0/false). Adds fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }]; callers that omit sampledFields see an unchanged response. |

### unity_runtime_sample_animator

HONEST animation-progress verification for an Animator. Motivating incident: an unfocused/headless editor advances physics but NOT Animator time even with runInBackground, so an agent could 'verify' an animation from a STATIC pose that was actually FROZEN. This op resolves the GameObject (refuses NOT_FOUND if it has no Animator), samples layer-0 state (fullPathHash/normalizedTime/speed), animator.playableGraph.IsPlaying()/animator.speed, and each requested bone's LOCAL pose (localRotation+localPosition) across a window, then computes verdict fields HONESTLY: time_advancing (normalizedTime strictly increased — judged PER STATE between CONSECUTIVE same-fullPathHash samples, because Unity's normalizedTime is MONOTONIC within a looping state (integer part = loop count) and a cross-state comparison proves nothing), bones_moving (any requested bone's LOCAL rotation/position delta above epsilon — SKELETAL-local motion only, never root motion: a physics-driven root moving under a frozen animator must not read as animation), and a status that NAMES the frozen case instead of laundering it into a pass. status is one of: 'ok' (sampled a real window), 'blocked_culled' (cullingMode=CullCompletely and animator time did not advance — the offscreen-culled freeze; focus-INDEPENDENT and checked BEFORE any focus diagnosis so a focused editor cannot launder it into ok), 'blocked_unfocused' (the animator was EXPECTED to advance — enabled + controller + speed != 0 + activeInHierarchy + isInitialized — but animator time did NOT advance across the window AND the editor application is inactive: the physics-advances-but-Animator-frozen defect. NOTE: under -batchmode isApplicationActive is ALWAYS false, so there this status simply means 'editor app inactive'; the sampling loop pins Time.captureDeltaTime so game time DID advance across the window, which makes the frozen animator strong evidence of the Animator-update throttle regardless of the focus flag), 'insufficient_samples' (the window produced <2 distinct-timestamp samples, so advancement can never be established — refuse, not skip), or 'edit_mode_static' (paused-scene single-shot pose read; never time_advancing). It NEVER reports time_advancing:true from a single sample or identical timestamps (at most one sample is recorded per tick, each with a distinct game-time stamp). Works in BOTH play mode (samples across real frames using measure_motion's focus-independent machinery: forces runInBackground + pins Time.captureDeltaTime; play-mode exit / domain reload mid-window restores pinned time and errors cleanly instead of leaking capture state) and edit mode (single-shot pose + status edit_mode_static). Focus signal: UnityEditorInternal.InternalEditorUtility.isApplicationActive. Returns { status, status_note? (present for blocked_* — names the cause and the fix), time_advancing, bones_moving, playMode, editorHasFocus, animatorPlaying, animatorSpeed, culling_mode, active_in_hierarchy, is_initialized, graphPlaying, currentState, sampleCount, distinctTimeSamples, durationMs, bones:[{path,resolved}], samples:[{tMs,normalizedTime,fullPathHash,stateSpeed,graphPlaying,bones:[{path,resolved,localRotation,localPosition}]}] }.

**Wire command:** `runtime.sample_animator`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Locator of the GameObject carrying the Animator (refuses NOT_FOUND if it has no Animator component). |
| `durationMs` | number | No | Play-mode sampling window in milliseconds (default 500, max 28000 — the op's 30000ms transport timeout minus a response margin; a longer window is refused). Ignored in edit mode (single-shot). 'duration_ms' is accepted as a back-compat alias. |
| `samples` | integer | No | Play-mode target sample count across the window (default 8, minimum 2 — a single sample can never establish time_advancing). At most one sample is recorded per tick. |
| `captureFps` | number | No | Pin Time.captureDeltaTime to 1/captureFps during play-mode sampling so game time advances deterministically per tick regardless of focus (default 60). 0 disables pinning (live rate). |
| `bones` | string[] | No | Optional child-transform paths (relative to the Animator GameObject, e.g. 'Armature/Spine/RightHand') whose LOCAL pose (localRotation + localPosition) is recorded each sample; drives bones_moving. Local-space on purpose: bones_moving measures skeletal animation, NOT root motion — a physics-moved root never counts. Unresolved paths are reported honestly (resolved:false) and never fabricated. |

## Component Operations

| Tool | Description |
|------|-------------|
| `unity_component_list` | List all components attached to a GameObject. |
| `unity_component_add` | Add a component to a GameObject by type name. Optionally set initial properties. |
| `unity_component_remove` | Remove a component from a GameObject by type name. |
| `unity_component_get_properties` | Get all serialized properties of a component with their current values. Supports search filtering and path inclusion. |
| `unity_component_describe` | Describe a component's properties (alias for get_properties). Returns property descriptors with types and current values. |
| `unity_component_set_property` | Set a serialized property value on a component. Supports friendly names and object-reference payloads (asset_path/locator/null). Object refs are resolved by the field's own type, so AUDIO refs bind the same way as Sprites: an AudioSource.clip / AudioClip field takes a string .wav/.ogg asset path, and an AudioMixerGroup field (e.g. AudioSource.outputAudioMixerGroup) takes { asset_path: '<mixer>.mixer', sub_asset: '<group name>' } to pick one group sub-asset out of the .mixer. |

### unity_component_list

List all components attached to a GameObject.

**Wire command:** `component.list`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |

### unity_component_add

Add a component to a GameObject by type name. Optionally set initial properties.

**Wire command:** `component.add`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `type_name` | string | Yes | Component type name (e.g. 'Rigidbody', 'BoxCollider2D') |
| `properties` | object | No | Optional initial property values to set |

### unity_component_remove

Remove a component from a GameObject by type name.

**Wire command:** `component.remove`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `type_name` | string | Yes | Component type name to remove |

### unity_component_get_properties

Get all serialized properties of a component with their current values. Supports search filtering and path inclusion.

**Wire command:** `component.get_properties`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `type_name` | string | Yes | Component type name |
| `search` | string | No | Optional search filter for property names |
| `include_paths` | string[] | No | Optional list of specific property paths to include |

### unity_component_describe

Describe a component's properties (alias for get_properties). Returns property descriptors with types and current values.

**Wire command:** `component.describe`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `type_name` | string | Yes | Component type name |
| `search` | string | No | Optional search filter for property names |
| `include_paths` | string[] | No | Optional list of specific property paths to include |

### unity_component_set_property

Set a serialized property value on a component. Supports friendly names and object-reference payloads (asset_path/locator/null). Object refs are resolved by the field's own type, so AUDIO refs bind the same way as Sprites: an AudioSource.clip / AudioClip field takes a string .wav/.ogg asset path, and an AudioMixerGroup field (e.g. AudioSource.outputAudioMixerGroup) takes { asset_path: '<mixer>.mixer', sub_asset: '<group name>' } to pick one group sub-asset out of the .mixer.

**Wire command:** `component.set_property`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `type_name` | string | Yes | Component type name |
| `property_path` | string | Yes | Property path or friendly name |
| `value` | string,object,number,boolean,array,null | Yes | Value to set. For object references: a string asset path (e.g. an AudioClip .wav/.ogg or a Sprite), { asset_path, sub_asset? } (sub_asset picks one named sub-asset — a sliced Sprite from a sheet, or an AudioMixerGroup from a .mixer), { locator }, null, or { clear: true }. For array/list fields (e.g. Sprite[] animation frames): a JSON array of the above. JSON shape is preserved — do not pre-stringify. |

## Code Operations

| Tool | Description |
|------|-------------|
| `unity_code_create_script` | Create a new C# script file under Assets/. Triggers compilation. Use if_exists to control re-run behavior. |
| `unity_code_read_script` | Read the contents of a C# script file. |
| `unity_code_modify_script` | Replace the full contents of an existing C# script file. Triggers recompilation. |
| `unity_code_attach_script` | Attach a compiled MonoBehaviour script to a GameObject by script name. |

### unity_code_create_script

Create a new C# script file under Assets/. Triggers compilation. Use if_exists to control re-run behavior.

**Wire command:** `code.create_script`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path for the script (e.g. Assets/Scripts/MyScript.cs) |
| `content` | string | Yes | Full C# source code content |
| `if_exists` | "error" \| "replace" \| "skip" | No | Behavior when the target path already exists: 'error' (default, current behavior), 'replace' (overwrite content), 'skip' (no-op). |

### unity_code_read_script

Read the contents of a C# script file.

**Wire command:** `code.read_script`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the script to read |

### unity_code_modify_script

Replace the full contents of an existing C# script file. Triggers recompilation.

**Wire command:** `code.modify_script`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the script to modify |
| `content` | string | Yes | New full C# source code content |

### unity_code_attach_script

Attach a compiled MonoBehaviour script to a GameObject by script name.

**Wire command:** `code.attach_script`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `script_name` | string | Yes | Name of the MonoBehaviour script (without .cs) |

## Animator Operations

| Tool | Description |
|------|-------------|
| `unity_animator_create_controller` | Create a new AnimatorController asset at the specified path. Replaces existing. |
| `unity_animator_add_parameter` | Add a parameter to an AnimatorController. |
| `unity_animator_add_state` | Add a state to an AnimatorController layer. |
| `unity_animator_set_default_state` | Set the default (entry) state for an AnimatorController layer. |
| `unity_animator_add_transition` | Add a transition between states in an AnimatorController. Use '*' as from for AnyState transitions. |
| `unity_animator_assign_controller` | Assign an AnimatorController to a GameObject's Animator component. Adds Animator if missing. |
| `unity_animator_get_state_machine` | Get the full state machine definition of an AnimatorController: parameters, layers, states, and transitions. |
| `unity_animator_set_state_motion` | Bind (or re-bind) the motion clip and/or playback speed of an EXISTING state in an AnimatorController — at least one of motion/speed is required (speed-only updates allowed). motion accepts a string asset path (native .anim) or { asset_path, sub_asset? } to select a named clip sub-asset out of an imported FBX/GLB — resolution goes through the AssetDatabase so both native (.anim, motion ref type 2) and imported clip sub-assets (type 3) bind correctly without hand-editing controller YAML. Any key in the motion object other than asset_path/sub_asset/clear is refused (INVALID_PARAMS), and when no sub_asset is given and the container holds more than one clip the op refuses listing the candidates instead of silently binding the first. If the sub-asset is not found the AssetDatabase is refreshed and resolution retried once; a persistent miss returns a distinguishable NOT_FOUND noting the asset may not be imported yet (e.g. an FBX whose avatar/clip sub-assets need the ModelImporter configured). Returns motionBound + the bound motion name, plus accurate motionChanged/speedChanged flags (a no-op re-bind reports false and skips the asset write). |
| `unity_animator_apply_spec` | Apply a declarative spec to an AnimatorController. Creates or updates parameters, states, transitions idempotently. A state may carry a 'motion' (string .anim path, or { asset_path, sub_asset? } for an imported FBX/GLB clip sub-asset) and a 'speed' — these are BOUND onto the state (m_Motion / speed), not ignored. ATOMIC: the ENTIRE spec is validated and every motion resolved before any mutation, so a refused spec leaves the controller untouched. Refuse-not-skip: any unknown key anywhere in the spec (top level, parameter, layer, state, transition, condition, motion selector) is a hard INVALID_PARAMS refusal naming the key and location, and a transition from/to or defaultState naming a missing state refuses instead of being skipped. |

### unity_animator_create_controller

Create a new AnimatorController asset at the specified path. Replaces existing.

**Wire command:** `animator.create_controller`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path for the controller (e.g. Assets/Animations/Player.controller) |

### unity_animator_add_parameter

Add a parameter to an AnimatorController.

**Wire command:** `animator.add_parameter`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |
| `name` | string | Yes | Parameter name |
| `type` | "Float" \| "Int" \| "Bool" \| "Trigger" | No | Parameter type (default: Float) |
| `defaultValue` | any | No | Default value for the parameter |

### unity_animator_add_state

Add a state to an AnimatorController layer.

**Wire command:** `animator.add_state`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |
| `state_name` | string | Yes | Name of the new state |
| `layer` | number | No | Layer index (default: 0) |
| `position` | object | No | Visual position in the Animator window |

### unity_animator_set_default_state

Set the default (entry) state for an AnimatorController layer.

**Wire command:** `animator.set_default_state`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |
| `state_name` | string | Yes | Name of the state to set as default |
| `layer` | number | No | Layer index (default: 0) |

### unity_animator_add_transition

Add a transition between states in an AnimatorController. Use '*' as from for AnyState transitions.

**Wire command:** `animator.add_transition`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |
| `from` | string | Yes | Source state name ('*' for AnyState) |
| `to` | string | Yes | Destination state name |
| `layer` | number | No | Layer index (default: 0) |
| `hasExitTime` | boolean | No | Whether transition has exit time (default: false) |
| `exitTime` | number | No | Exit time if hasExitTime is true (default: 0.9) |
| `duration` | number | No | Transition duration in seconds (default: 0.1) |
| `conditions` | object[] | No | Transition conditions |

### unity_animator_assign_controller

Assign an AnimatorController to a GameObject's Animator component. Adds Animator if missing.

**Wire command:** `animator.assign_controller`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |
| `locator` | object | Yes | Entity locator identifying a GameObject |

### unity_animator_get_state_machine

Get the full state machine definition of an AnimatorController: parameters, layers, states, and transitions.

**Wire command:** `animator.get_state_machine`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController |

### unity_animator_set_state_motion

Bind (or re-bind) the motion clip and/or playback speed of an EXISTING state in an AnimatorController — at least one of motion/speed is required (speed-only updates allowed). motion accepts a string asset path (native .anim) or { asset_path, sub_asset? } to select a named clip sub-asset out of an imported FBX/GLB — resolution goes through the AssetDatabase so both native (.anim, motion ref type 2) and imported clip sub-assets (type 3) bind correctly without hand-editing controller YAML. Any key in the motion object other than asset_path/sub_asset/clear is refused (INVALID_PARAMS), and when no sub_asset is given and the container holds more than one clip the op refuses listing the candidates instead of silently binding the first. If the sub-asset is not found the AssetDatabase is refreshed and resolution retried once; a persistent miss returns a distinguishable NOT_FOUND noting the asset may not be imported yet (e.g. an FBX whose avatar/clip sub-assets need the ModelImporter configured). Returns motionBound + the bound motion name, plus accurate motionChanged/speedChanged flags (a no-op re-bind reports false and skips the asset write).

**Wire command:** `animator.set_state_motion`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `controller_path` | string | Yes | Asset path of the AnimatorController |
| `state_name` | string | Yes | Name of the existing state to bind |
| `layer` | number | No | Layer index (default: 0) |
| `motion` | string,object | No | The motion clip to bind: a string asset path to a native .anim, or { asset_path, sub_asset? } to select a named clip out of an imported FBX/GLB (take names may look like 'Armature|Armature|...|baselayer'). { clear: true } unbinds. Optional when speed is provided. |
| `speed` | number | No | Playback speed multiplier for the state (may be sent without motion) |

### unity_animator_apply_spec

Apply a declarative spec to an AnimatorController. Creates or updates parameters, states, transitions idempotently. A state may carry a 'motion' (string .anim path, or { asset_path, sub_asset? } for an imported FBX/GLB clip sub-asset) and a 'speed' — these are BOUND onto the state (m_Motion / speed), not ignored. ATOMIC: the ENTIRE spec is validated and every motion resolved before any mutation, so a refused spec leaves the controller untouched. Refuse-not-skip: any unknown key anywhere in the spec (top level, parameter, layer, state, transition, condition, motion selector) is a hard INVALID_PARAMS refusal naming the key and location, and a transition from/to or defaultState naming a missing state refuses instead of being skipped.

**Wire command:** `animator.apply_spec`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the AnimatorController (created if missing) |
| `spec` | object | Yes | Declarative spec with parameters, layers, states, and transitions |

## UI Operations

| Tool | Description |
|------|-------------|
| `unity_ui_create_canvas` | Create a new Canvas GameObject with CanvasScaler and GraphicRaycaster. Also ensures the scene has an EventSystem (with InputSystemUIInputModule for new-Input-System projects, else StandaloneInputModule) so uGUI buttons/touch controls actually receive input — an existing EventSystem is reused. Returns the canvas locator plus an eventSystem { locator, created, inputModule }. |
| `unity_ui_add_text` | Add a UI text element (TextMeshPro-first, legacy fallback) as a child of a parent. |
| `unity_ui_add_image` | Add a UI Image element as a child of a parent. |
| `unity_ui_add_button` | Add a UI Button with child label text (TextMeshPro-first, legacy fallback). |
| `unity_ui_set_rect_transform` | Set RectTransform properties on a UI element: anchors, position, size, pivot. |
| `unity_ui_scan_text_components` | Enumerate text components (TextMeshPro + UnityEngine.UI.Text) in a Canvas/subtree (when 'locator' is given) or scene-wide (when omitted) — the data the UI-conformance gate checks against the mock's font and palette spec. Per component returns { locator, name, type, fontAssetPath, fontName, color{r,g,b,a}, fontSize, alignment, anchor, text }. TMP is read via reflection (no hard TextMeshPro dependency); the font asset path is resolved from the serialized font ObjectReference. Inactive objects are included so a disabled HUD element is still reported. |
| `unity_ui_dispatch_pointer` | Actuate a uGUI control by dispatching a synthetic pointer event through the EventSystem (ExecuteEvents), independent of the active input module. Unlike unity_input_click_ui (which goes through the editor/input backend), this drives uGUI on BOTH the legacy StandaloneInputModule and the new InputSystemUIInputModule with no game-code change — the mechanism behind backend-agnostic action traces. Target either a 'locator' (dispatches to the element's handler; screen point computed from its rect center) or explicit 'x'/'y' screen coordinates (raycast finds the element). action='click' fires pointerDown→Up→Click; action='drag' fires down→(initializePotentialDrag)→beginDrag→drag→endDrag→up toward 'to_locator' or 'to_x'/'to_y'. Returns { handlerTarget, screenPoint, raycastHit, handlersFired[], actuated }, where actuated means ≥1 handler in the sequence accepted the event — NOT that the widget's value necessarily changed; confirm real effects with unity_runtime_assert_condition. Requires an active EventSystem in the scene (Play Mode for runtime modules). For a HELD press that must span game frames (an On-Screen Button/Stick that polls IsPressed() in Update — an instant click is down+up in one synchronous call and is missed by the next frame's poll): action='press' dispatches pointerDown and LEAVES the pointer down, returning a 'holdId'; the press persists across frames (let the game tick, e.g. via a runtime capture/measure in between) until action='release' { hold_id } dispatches the matching pointerUp. |
| `unity_ui_get_screen_rects` | Project uGUI elements (RectTransform under a Canvas) into SCREEN space — the Canvas-aware counterpart to scene.get_screen_rects (which only handles world SpriteRenderers/colliders). This is the data source for the deterministic UI gates: safe-area, required-in-frame, tap-target-size, text-clipping, control-overlap. 'locators' is OPTIONAL: pass it to project exactly those elements; OMIT it to auto-discover every Graphic (Image/Text/RawImage, including Button graphics) under Canvases in the loaded scene(s), inactive ones included. Per element returns screenRect{x,y,width,height} (pixels, origin bottom-left), viewportRect{...} (normalized 0..1), active, isVisible + visibilityReason (inactive | canvas-disabled | canvasgroup-alpha-zero | graphic-disabled | graphic-transparent | no-canvas | no-camera | no-rect-transform | off-screen), descendantVisible (only on graphic-disabled/graphic-transparent entries: true when active child art renders, i.e. the invisible-hit-target pattern where the CONTROL is visible but its own Graphic is not), isFullyVisible/isPartiallyClipped/isOffScreen/clipSide, centerXFraction/centerYFraction, raycastTarget, role (button|text|image|rawimage|graphic|container), canvasRenderMode/canvasLocator, plus identity extras (text/fontSize, spriteName, interactable). Pixel→dp conversion for tap-target floors is the gate layer's job; this op returns pixel and normalized rects. |
| `unity_ui_set_text_style` | Set font/layout styling on an existing UI text element — uGUI Text OR TextMeshProUGUI (TMP read via reflection, no hard dependency). uGUI Text's font fields (fontSize/alignment/…) serialize under the nested m_FontData block, so this is the front door for them rather than component.set_property. Only the fields you pass are changed; the rest are left as-is. Unknown alignment/font_style strings REFUSE with INVALID_PARAMS before anything is mutated (enforced op-side, not just this schema). Returns { locator, text_backend (legacy|tmp), applied, skipped }: 'applied' lists only fields whose write actually happened; a field the backend could not write lands in 'skipped' [{field, reason}] instead. best_fit=true always bounds the auto-sizer so it cannot shrink text toward invisible: with font_size given, max=font_size and min=max(10, font_size/2) (font_size becomes the UPPER bound, reported as applied.best_fit_bounds); without font_size, min is floored to 10 only when the current min is < 1. best_fit=false disables auto-sizing and leaves bounds untouched. |

### unity_ui_create_canvas

Create a new Canvas GameObject with CanvasScaler and GraphicRaycaster. Also ensures the scene has an EventSystem (with InputSystemUIInputModule for new-Input-System projects, else StandaloneInputModule) so uGUI buttons/touch controls actually receive input — an existing EventSystem is reused. Returns the canvas locator plus an eventSystem { locator, created, inputModule }.

**Wire command:** `ui.create_canvas`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Canvas name (default: 'Canvas') |
| `render_mode` | "overlay" \| "camera" \| "worldSpace" | No | Canvas render mode (default: overlay) |

### unity_ui_add_text

Add a UI text element (TextMeshPro-first, legacy fallback) as a child of a parent.

**Wire command:** `ui.add_text`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `parent` | object | Yes | Parent object locator (Canvas or UI element) |
| `name` | string | No | Text element name (default: 'Text') |
| `text` | string | No | Text content |
| `text_backend` | "tmp" \| "legacy" \| "auto" | No | Text rendering backend (default: tmp). Uses legacy uGUI Text when requested or TMP unavailable. |
| `font_size` | number | No | Font size in pixels (default: 14) |
| `color` | object | No | Text color |
| `alignment` | "UpperLeft" \| "UpperCenter" \| "UpperRight" \| "MiddleLeft" \| "MiddleCenter" \| "MiddleRight" \| "LowerLeft" \| "LowerCenter" \| "LowerRight" | No | Text alignment |
| `anchored_position` | object | No | Anchored position |
| `size_delta` | object | No | Size delta (width/height) |

### unity_ui_add_image

Add a UI Image element as a child of a parent.

**Wire command:** `ui.add_image`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `parent` | object | Yes | Parent object locator |
| `name` | string | No | Image element name (default: 'Image') |
| `color` | object | No | Image tint color |
| `sprite_path` | string | No | Asset path to a sprite to display |
| `anchored_position` | object | No | Anchored position |
| `size_delta` | object | No | Size delta (width/height) |

### unity_ui_add_button

Add a UI Button with child label text (TextMeshPro-first, legacy fallback).

**Wire command:** `ui.add_button`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `parent` | object | Yes | Parent object locator |
| `name` | string | No | Button name (default: 'Button') |
| `text` | string | No | Button label text (default: 'Button') |
| `text_backend` | "tmp" \| "legacy" \| "auto" | No | Label text backend (default: tmp). |
| `font_size` | number | No | Label font size (default: 14) |
| `color` | object | No | Button background color |
| `anchored_position` | object | No | Anchored position |
| `size_delta` | object | No | Size delta (width/height) |

### unity_ui_set_rect_transform

Set RectTransform properties on a UI element: anchors, position, size, pivot.

**Wire command:** `ui.set_rect_transform`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `anchor_min` | object | No | Anchor min (0-1) |
| `anchor_max` | object | No | Anchor max (0-1) |
| `anchored_position` | object | No | Anchored position |
| `size_delta` | object | No | Size delta |
| `pivot` | object | No | Pivot point (0-1) |

### unity_ui_scan_text_components

Enumerate text components (TextMeshPro + UnityEngine.UI.Text) in a Canvas/subtree (when 'locator' is given) or scene-wide (when omitted) — the data the UI-conformance gate checks against the mock's font and palette spec. Per component returns { locator, name, type, fontAssetPath, fontName, color{r,g,b,a}, fontSize, alignment, anchor, text }. TMP is read via reflection (no hard TextMeshPro dependency); the font asset path is resolved from the serialized font ObjectReference. Inactive objects are included so a disabled HUD element is still reported.

**Wire command:** `ui.scan_text_components`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | No | Optional Canvas/subtree root to scan. Omit to scan all loaded scenes. |

### unity_ui_dispatch_pointer

Actuate a uGUI control by dispatching a synthetic pointer event through the EventSystem (ExecuteEvents), independent of the active input module. Unlike unity_input_click_ui (which goes through the editor/input backend), this drives uGUI on BOTH the legacy StandaloneInputModule and the new InputSystemUIInputModule with no game-code change — the mechanism behind backend-agnostic action traces. Target either a 'locator' (dispatches to the element's handler; screen point computed from its rect center) or explicit 'x'/'y' screen coordinates (raycast finds the element). action='click' fires pointerDown→Up→Click; action='drag' fires down→(initializePotentialDrag)→beginDrag→drag→endDrag→up toward 'to_locator' or 'to_x'/'to_y'. Returns { handlerTarget, screenPoint, raycastHit, handlersFired[], actuated }, where actuated means ≥1 handler in the sequence accepted the event — NOT that the widget's value necessarily changed; confirm real effects with unity_runtime_assert_condition. Requires an active EventSystem in the scene (Play Mode for runtime modules). For a HELD press that must span game frames (an On-Screen Button/Stick that polls IsPressed() in Update — an instant click is down+up in one synchronous call and is missed by the next frame's poll): action='press' dispatches pointerDown and LEAVES the pointer down, returning a 'holdId'; the press persists across frames (let the game tick, e.g. via a runtime capture/measure in between) until action='release' { hold_id } dispatches the matching pointerUp.

**Wire command:** `ui.dispatch_pointer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | No | Target uGUI element. Provide this or x/y. |
| `x` | number | No | Screen X (omit when locator is given) |
| `y` | number | No | Screen Y (omit when locator is given) |
| `action` | "click" \| "drag" \| "press" \| "release" | No | Pointer action (default: click). 'press' = pointerDown held across frames → returns holdId; 'release' = pointerUp for a prior press (requires hold_id). |
| `button` | number | No | Pointer button: 0=left, 1=right, 2=middle (default: 0) |
| `to_locator` | object | No | Drag destination element (action=drag) |
| `to_x` | number | No | Drag destination screen X (action=drag) |
| `to_y` | number | No | Drag destination screen Y (action=drag) |
| `hold_id` | string | No | Held-press token from a prior action='press'; required by action='release'. |

### unity_ui_get_screen_rects

Project uGUI elements (RectTransform under a Canvas) into SCREEN space — the Canvas-aware counterpart to scene.get_screen_rects (which only handles world SpriteRenderers/colliders). This is the data source for the deterministic UI gates: safe-area, required-in-frame, tap-target-size, text-clipping, control-overlap. 'locators' is OPTIONAL: pass it to project exactly those elements; OMIT it to auto-discover every Graphic (Image/Text/RawImage, including Button graphics) under Canvases in the loaded scene(s), inactive ones included. Per element returns screenRect{x,y,width,height} (pixels, origin bottom-left), viewportRect{...} (normalized 0..1), active, isVisible + visibilityReason (inactive | canvas-disabled | canvasgroup-alpha-zero | graphic-disabled | graphic-transparent | no-canvas | no-camera | no-rect-transform | off-screen), descendantVisible (only on graphic-disabled/graphic-transparent entries: true when active child art renders, i.e. the invisible-hit-target pattern where the CONTROL is visible but its own Graphic is not), isFullyVisible/isPartiallyClipped/isOffScreen/clipSide, centerXFraction/centerYFraction, raycastTarget, role (button|text|image|rawimage|graphic|container), canvasRenderMode/canvasLocator, plus identity extras (text/fontSize, spriteName, interactable). Pixel→dp conversion for tap-target floors is the gate layer's job; this op returns pixel and normalized rects.

**Wire command:** `ui.get_screen_rects`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locators` | object[] | No | Optional UI elements to project. Omit (or pass empty) to auto-discover all Graphics under Canvases. |
| `camera` | object | No | Optional camera locator used as a pixel-rect hint for ScreenSpaceCamera/WorldSpace canvases. Overlay canvases need no camera. |

### unity_ui_set_text_style

Set font/layout styling on an existing UI text element — uGUI Text OR TextMeshProUGUI (TMP read via reflection, no hard dependency). uGUI Text's font fields (fontSize/alignment/…) serialize under the nested m_FontData block, so this is the front door for them rather than component.set_property. Only the fields you pass are changed; the rest are left as-is. Unknown alignment/font_style strings REFUSE with INVALID_PARAMS before anything is mutated (enforced op-side, not just this schema). Returns { locator, text_backend (legacy|tmp), applied, skipped }: 'applied' lists only fields whose write actually happened; a field the backend could not write lands in 'skipped' [{field, reason}] instead. best_fit=true always bounds the auto-sizer so it cannot shrink text toward invisible: with font_size given, max=font_size and min=max(10, font_size/2) (font_size becomes the UPPER bound, reported as applied.best_fit_bounds); without font_size, min is floored to 10 only when the current min is < 1. best_fit=false disables auto-sizing and leaves bounds untouched.

**Wire command:** `ui.set_text_style`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Target UI element carrying a Text or TextMeshProUGUI component |
| `font_size` | number | No | Font size in pixels (rounded to int for uGUI Text). With best_fit=true this becomes the auto-sizer's max. |
| `color` | object | No | Text color |
| `font_style` | "Normal" \| "Bold" \| "Italic" \| "BoldAndItalic" | No | Font style. BoldAndItalic maps to the TMP Bold|Italic flag combo. Unknown values refuse. |
| `alignment` | "UpperLeft" \| "UpperCenter" \| "UpperRight" \| "MiddleLeft" \| "MiddleCenter" \| "MiddleRight" \| "LowerLeft" \| "LowerCenter" \| "LowerRight" | No | Text alignment (mapped to the TMP alignment enum for TMP components). Unknown values refuse. |
| `best_fit` | boolean | No | Auto-resize text to fit its rect (uGUI resizeTextForBestFit / TMP enableAutoSizing). true always establishes min/max bounds — see the op description for the exact semantics. |

## Asset Operations

| Tool | Description |
|------|-------------|
| `unity_asset_create_sprite` | Create a sprite texture at the specified asset path from external image input or generated solid color. |
| `unity_asset_create_material` | Create a new Material asset with the specified shader, including optional URP/PBR texture slots. |
| `unity_asset_create_prefab` | Save a scene GameObject as a prefab asset. Pass connect_source:true to keep the source instance connected to the created prefab. |
| `unity_asset_create_prefab_variant` | Create a prefab variant asset from a base prefab, with optional transform, mesh, material, and collider overrides.  NOTE: child paths resolve by name (transform.Find) — same-named siblings are unaddressable beyond the first; root-level component overrides search children for the first matching component (back-compat) — use overrides_by_path for precise targeting.Root-level renderer_materials/mesh_filter_mesh/collider_size target the first matching component in the hierarchy; use overrides_by_path to target a specific child precisely. |
| `unity_asset_replace_with_prefab` | Replace scene objects with a prefab while preserving parent, sibling index, local position, rotation, and scale. Requires expected_scene_path to guard against mutating the wrong active scene. Pass remap_references:true to preserve serialized-reference integrity across the swap: BEFORE destroying each source, EVERY external serialized reference into its hierarchy is found (root, components, and all DESCENDANTS — the scan is UNBOUNDED so the destroy surface is fully known); AFTER instantiating the replacement each is re-pointed to the corresponding object on the new instance: the referenced object's relative path under the source is resolved on the replacement, then components matched by type + index on that child. A reference whose child path or component type is absent on the replacement is reported as unmapped with a reason (NOT silently dropped) — it still nulls on destroy, but it is surfaced. Each replacement entry then carries remapped[] and unmapped[]. With dry_run:true, mappability is evaluated against the prefab ASSET's hierarchy so would-be-unmapped references are reported honestly without mutating. External references may live in loaded scenes OUTSIDE the guarded active scene: a live remap REFUSES up front (before any mutation) listing the affected scene paths unless allow_cross_scene_remap:true explicitly permits those writes; every reported reference carries its referencing scene_path. Default false (behavior unchanged). Pair with scene.find_references_to to pre-flight the swap. |
| `unity_asset_instantiate_prefab` | Instantiate a prefab into the active scene. |
| `unity_asset_set_texture_import_settings` | Set deterministic TextureImporter settings such as NormalMap, sRGB, mipmaps, readability, alpha source, and sprite import mode. IMPORTANT for 2D: setting texture_type:'Sprite' WITHOUT sprite_mode defaults the importer to Single, which produces exactly one usable sprite. A texture left in Multiple mode but never sliced yields ZERO sprite sub-assets (so a later asset.assign_sprite fails 'Sprite not found'); pass sprite_mode:'multiple' only when you will also slice it (see asset.create_sprite slicing). An already-sliced Multiple sheet is left untouched by the default (its slices are never wiped). Returns the resolved texture_type, sRGB, mipmaps, readable, alpha_source, and sprite_import_mode. |
| `unity_asset_channel_pack` | Pack generator texture maps into a Unity-ready texture. Default preset 'metallic_smoothness' writes R=metallic, A=smoothness (1-roughness). Preset 'mask_map' writes the HDRP-style R=metallic, G=occlusion, B=detail, A=smoothness layout. |
| `unity_asset_set_renderer_materials` | Assign a Renderer.sharedMaterials array by material asset paths, with optional submesh-count validation. |
| `unity_asset_list_sub_assets` | List every asset object at an asset path via AssetDatabase.LoadAllAssetsAtPath (includes representations and hidden sub-assets such as FBX clips/avatars). Returns per object {name, type, fileID, guid, isMainAsset}, plus length/isLooping for AnimationClips and isHuman/isValid for Avatars. Eliminates the manual grep-a-temp-prefab-for-m_Animation trick used to discover FBX clip fileIDs. If nothing loads, force-imports just that asset synchronously (never a global Refresh, which could recompile unrelated dirty scripts) and retries once; distinguishes 'no such asset' / 'path is a folder' / 'asset exists but not yet imported'. |
| `unity_asset_inspect_model_importer` | Inspect the ModelImporter for a model asset (.fbx/.obj/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not a ModelImporter. Returns {animationType, avatarSetup, importAnimation, globalScale, useFileScale, fileScale, materialImportMode, clipAnimations:[{name, takeName, firstFrame, lastFrame, loopTime}], defaultClipAnimations (names), importedTakeInfos (names)} — the FBX import state the dogfood session read by hand-cloning a known-good .fbx.meta. |
| `unity_asset_configure_model_importer` | Configure a model asset's ModelImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not a model. Model reimport re-serializes sub-assets but does NOT compile scripts, so no domain reload occurs and the response is synchronous — rigged-model reimports are still slow, hence the 90s default timeout (tune per call via timeoutMs). clip_overrides edit takes discovered on the model (matched by take_name) — e.g. forcing loopTime on a walk cycle — replacing the hand-edited .fbx.meta clipAnimations block. Combining animation-discovery settings (animation_type/avatar_setup/import_animation) with clip_overrides in one call works but costs TWO internal reimports: the first refreshes take discovery under the new settings, the second applies the overrides. Resulting clip names must be unique (refuses INVALID_PARAMS on collision). |
| `unity_asset_inspect_audio_importer` | Inspect the AudioImporter for an audio asset (.wav/.ogg/.mp3/.aiff/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not an AudioImporter. Returns {force_to_mono, load_in_background, ambisonic, default_sample_settings:{load_type, compression_format, quality, sample_rate_setting, sample_rate_override, preload_audio_data, conversion_mode}, clip:{length, channels, frequency, samples} when the AudioClip is loadable (else null)} — the import state the SFX dogfood tuned by hand-editing .wav.meta. conversion_mode is Unity's undocumented raw int field on AudioImporterSampleSettings (no public enum type exists), reported as-is so inspect is a complete settings dump. Reads the DEFAULT platform sample settings only; per-platform overrides are out of scope. |
| `unity_asset_configure_audio_importer` | Configure an audio asset's AudioImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not an audio clip. Writes force_to_mono / load_in_background on the importer and load_type / compression_format / quality / sample_rate_setting / sample_rate_override / preload_audio_data / conversion_mode on the DEFAULT-platform AudioImporterSampleSettings (per-platform overrides are OUT OF SCOPE for this slice). Role-specific import: short critical SFX prefer load_type=DecompressOnLoad + compression_format=PCM|ADPCM; music/long ambience prefer Streaming. Audio reimport re-encodes the clip but does NOT compile scripts, so no domain reload occurs and the response is synchronous — re-encoding a long clip can still exceed the 10s wire fallback, hence the 90s default timeout (tune per call via timeoutMs). Enum params accept the name (load_type: DecompressOnLoad|CompressedInMemory|Streaming; compression_format: PCM|Vorbis|ADPCM; sample_rate_setting: PreserveSampleRate|OptimizeSampleRate|OverrideSampleRate) or the raw int, and refuse INVALID_PARAMS listing the valid values. |
| `unity_asset_assign_sprite` | Assign a sprite asset to a SpriteRenderer or UI Image component on a GameObject. If no sprite resolves at sprite_path, the NOT_FOUND error DIAGNOSES why (texture is not Sprite type / is Sprite Mode Multiple with zero sliced sub-sprites / named sub-sprite absent) and names the fix — see asset.set_texture_import_settings sprite_mode. |
| `unity_asset_picker_open` | Open (or refresh) the Loombridge asset picker — a human-in-the-loop EditorWindow that proposes options with thumbnails for the user to confirm or swap. The agent supplies slots of candidate options with its pre-selected pick; the user single-selects per slot and clicks Confirm or Cancel. Resets picker state to 'pending'. This is a generic options-with-thumbnails surface (the agent assembles slots/options); poll unity_asset_picker_state for the outcome. Note: opening does not block — use the poll handshake. |
| `unity_asset_picker_state` | Poll the Loombridge asset picker handshake state. Returns { status: 'none'|'pending'|'confirmed'|'cancelled', selection: { <slot>: <optionId> } }. 'none' before opening or after close, 'pending' while the user is choosing, 'confirmed' with the chosen ids after the user clicks Confirm, 'cancelled' if the user clicks Cancel or closes the window. The agent polls this (with its own timeout) until confirmed/cancelled. |
| `unity_asset_picker_close` | Close the Loombridge asset picker window and reset state to 'none'. Use after reading a confirmed/cancelled outcome, or to dismiss the picker. |
| `unity_asset_browser_open` | Open (or refresh) the Loombridge registry Asset Browser EditorWindow. The agent supplies a generic library payload assembled from the registry/profile (categories, assets, local thumbnail paths, metadata, and seeded inventory/default selections). The browser supports search, category and metadata filters, grid cards, inventory add/remove/swap, and a preview modal. It reuses the existing asset picker poll handshake: this call resets state to 'pending', and unity_asset_picker_state returns the confirmed/cancelled outcome. |

### unity_asset_create_sprite

Create a sprite texture at the specified asset path from external image input or generated solid color.

**Wire command:** `asset.create_sprite`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path for the sprite PNG (e.g. Assets/Sprites/Square.png) |
| `source_path` | string | No | Optional external local image file path (.png/.jpg/.jpeg) |
| `source_url` | string | No | Optional external image URL (.png/.jpg/.jpeg) |
| `width` | number | No | Texture width in pixels (default: 32) |
| `height` | number | No | Texture height in pixels (default: 32) |
| `color` | object | No | Fill color for generated textures (default: white) |
| `pixels_per_unit` | number | No | Sprite pixels per unit (default: 100) |
| `sprite_mode` | "single" \| "multiple" | No | Sprite import mode (default: single) |
| `filter_mode` | "Point" \| "Bilinear" | No | Texture filter mode |
| `readable` | boolean | No | Enable Read/Write on the imported texture so scene.get_bounds can compute alpha-trimmed visibleBounds (default: true) |
| `default_sprite_name` | string | No | Default named sub-sprite for multiple imports |
| `slicing` | object | No | Named sprite slicing metadata for sprite_mode=multiple. Supports grid or explicit rects. |

### unity_asset_create_material

Create a new Material asset with the specified shader, including optional URP/PBR texture slots.

**Wire command:** `asset.create_material`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path for the material (e.g. Assets/Materials/Red.mat) |
| `shader` | string | No | Shader name (default: 'Standard'). Alias: 'URP/Lit' maps to 'Universal Render Pipeline/Lit'. |
| `color` | object | No | Material color |
| `texture` | string | No | Optional asset path of a texture to assign as the material's main texture (alias: mainTexture) |
| `mainTexture` | string | No | Alias for texture |
| `base_map` | string | No | Optional base color texture path (alias: baseMap) |
| `baseMap` | string | No | Alias for base_map |
| `normal_map` | string | No | Optional normal map texture path (alias: normalMap) |
| `normalMap` | string | No | Alias for normal_map |
| `normal_scale` | number | No | Normal map scale (default: 1) |
| `metallic_map` | string | No | Optional metallic/smoothness texture path (alias: metallicMap) |
| `metallicMap` | string | No | Alias for metallic_map |
| `metallic` | number | No | Metallic scalar used with metallic maps (default: 1) |
| `smoothness` | number | No | Smoothness scalar used with metallic maps (default: 0.5) |
| `emission_map` | string | No | Optional emission texture path (alias: emissionMap) |
| `emissionMap` | string | No | Alias for emission_map |
| `emission_color` | object | No | Optional emission color (alias: emissionColor) |
| `emissionColor` | object | No | Alias for emission_color |
| `emission_intensity` | number | No | Emission intensity multiplier (default: 1; alias: emissionIntensity) |
| `emissionIntensity` | number | No | Alias for emission_intensity |
| `surface` | "opaque" \| "transparent" | No | URP Lit surface type. 'transparent' sets _Surface=1, _ZWrite=0, queue=Transparent(3000), and the _SURFACE_TYPE_TRANSPARENT keyword; 'opaque' restores queue=Geometry(2000). Refuses if the shader has no _Surface property. |
| `blend` | "alpha" \| "additive" | No | Transparent blend mode (implies a transparent surface). 'alpha' = SrcAlpha/OneMinusSrcAlpha; 'additive' = One/One. |
| `render_queue` | number | No | Explicit renderQueue override; wins over the surface-type default (alias: renderQueue) |
| `renderQueue` | number | No | Alias for render_queue |
| `specular_highlights` | boolean | No | Decal-safe: set false to disable specular highlights (_SpecularHighlights + _SPECULARHIGHLIGHTS_OFF). Refuses if the shader lacks the property (alias: specularHighlights) |
| `specularHighlights` | boolean | No | Alias for specular_highlights |
| `environment_reflections` | boolean | No | Decal-safe: set false to disable environment reflections (_EnvironmentReflections + _ENVIRONMENTREFLECTIONS_OFF). Refuses if the shader lacks the property (alias: environmentReflections) |
| `environmentReflections` | boolean | No | Alias for environment_reflections |

### unity_asset_create_prefab

Save a scene GameObject as a prefab asset. Pass connect_source:true to keep the source instance connected to the created prefab.

**Wire command:** `asset.create_prefab`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path for the prefab (e.g. Assets/Prefabs/Enemy.prefab) |
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `connect_source` | boolean | No | Use SaveAsPrefabAssetAndConnect so the source scene instance becomes a connected prefab instance (default: false) |
| `expected_scene_path` | string | No | Optional active scene guard. Refuses if the active scene path differs. |
| `allow_dirty_scene` | boolean | No | Allow mutation when the guarded active scene is dirty (default: false) |

### unity_asset_create_prefab_variant

Create a prefab variant asset from a base prefab, with optional transform, mesh, material, and collider overrides.  NOTE: child paths resolve by name (transform.Find) — same-named siblings are unaddressable beyond the first; root-level component overrides search children for the first matching component (back-compat) — use overrides_by_path for precise targeting.Root-level renderer_materials/mesh_filter_mesh/collider_size target the first matching component in the hierarchy; use overrides_by_path to target a specific child precisely.

**Wire command:** `asset.create_prefab_variant`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `base_prefab_path` | string | Yes | Asset path of the base prefab (alias: basePrefabPath) |
| `basePrefabPath` | string | No | Alias for base_prefab_path |
| `path` | string | Yes | Asset path for the prefab variant (aliases: variant_path, variantPath) |
| `variant_path` | string | No | Alias for path |
| `variantPath` | string | No | Alias for path |
| `overrides` | object | No | Optional overrides applied to the variant root. Transform: local_position/localPosition/position, local_rotation_euler/localRotationEuler/rotation_euler, local_scale/localScale/scale. Components (target the first matching component in the hierarchy): renderer_materials/rendererMaterials (array of material asset paths), mesh_filter_mesh/meshFilterMesh ({ asset_path, sub_asset? } — refuses an ambiguous multi-mesh asset unless sub_asset disambiguates), collider_size/colliderSize (BoxCollider { size, center }, SphereCollider { radius, center }, CapsuleCollider { radius, height, center } — refuses when the given fields do not match the target collider type). overrides_by_path/overridesByPath: a { "Child/Path": { renderer_materials?, mesh_filter_mesh?, collider_size? } } map that targets specific children precisely (the precise form); an unknown child path refuses with the available child paths. |

### unity_asset_replace_with_prefab

Replace scene objects with a prefab while preserving parent, sibling index, local position, rotation, and scale. Requires expected_scene_path to guard against mutating the wrong active scene. Pass remap_references:true to preserve serialized-reference integrity across the swap: BEFORE destroying each source, EVERY external serialized reference into its hierarchy is found (root, components, and all DESCENDANTS — the scan is UNBOUNDED so the destroy surface is fully known); AFTER instantiating the replacement each is re-pointed to the corresponding object on the new instance: the referenced object's relative path under the source is resolved on the replacement, then components matched by type + index on that child. A reference whose child path or component type is absent on the replacement is reported as unmapped with a reason (NOT silently dropped) — it still nulls on destroy, but it is surfaced. Each replacement entry then carries remapped[] and unmapped[]. With dry_run:true, mappability is evaluated against the prefab ASSET's hierarchy so would-be-unmapped references are reported honestly without mutating. External references may live in loaded scenes OUTSIDE the guarded active scene: a live remap REFUSES up front (before any mutation) listing the affected scene paths unless allow_cross_scene_remap:true explicitly permits those writes; every reported reference carries its referencing scene_path. Default false (behavior unchanged). Pair with scene.find_references_to to pre-flight the swap.

**Wire command:** `asset.replace_with_prefab`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the prefab to instantiate for each replacement |
| `locators` | object[] | Yes | Scene objects to replace |
| `expected_scene_path` | string | Yes | Required active scene guard |
| `allow_dirty_scene` | boolean | No | Allow mutation when the guarded active scene is dirty (default: false) |
| `dry_run` | boolean | No | Return the replacement plan without mutating the scene (default: false) |
| `remap_references` | boolean | No | Re-point external serialized references from each destroyed source's hierarchy (root + descendants) to the new instance, reporting remapped[]/unmapped[] (default: false). Alias: remapReferences. |
| `remapReferences` | boolean | No | Alias for remap_references. |
| `allow_cross_scene_remap` | boolean | No | Permit remap_references to write serialized references in loaded scenes OTHER than the guarded active scene (default: false → the op refuses before any mutation, listing the affected scenes). Alias: allowCrossSceneRemap. |
| `allowCrossSceneRemap` | boolean | No | Alias for allow_cross_scene_remap. |

### unity_asset_instantiate_prefab

Instantiate a prefab into the active scene.

**Wire command:** `asset.instantiate_prefab`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Asset path of the prefab to instantiate |
| `parent` | object | No | Optional parent object locator |
| `position` | object | No | Local position for the instance |
| `expected_scene_path` | string | No | Optional active scene guard. Refuses if the active scene path differs. |
| `allow_dirty_scene` | boolean | No | Allow mutation when the guarded active scene is dirty (default: false) |

### unity_asset_set_texture_import_settings

Set deterministic TextureImporter settings such as NormalMap, sRGB, mipmaps, readability, alpha source, and sprite import mode. IMPORTANT for 2D: setting texture_type:'Sprite' WITHOUT sprite_mode defaults the importer to Single, which produces exactly one usable sprite. A texture left in Multiple mode but never sliced yields ZERO sprite sub-assets (so a later asset.assign_sprite fails 'Sprite not found'); pass sprite_mode:'multiple' only when you will also slice it (see asset.create_sprite slicing). An already-sliced Multiple sheet is left untouched by the default (its slices are never wiped). Returns the resolved texture_type, sRGB, mipmaps, readable, alpha_source, and sprite_import_mode.

**Wire command:** `asset.set_texture_import_settings`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Texture asset path |
| `texture_type` | "Default" \| "NormalMap" \| "Sprite" | No | Texture importer type |
| `sprite_mode` | "single" \| "multiple" | No | Sprite import mode → TextureImporter.spriteImportMode. When texture_type is 'Sprite' and sprite_mode is omitted, the importer defaults to Single (a texture left Multiple/unsliced yields zero usable sprites). Use 'multiple' only when slicing the sheet (alias: spriteMode). |
| `spriteMode` | "single" \| "multiple" | No | Alias for sprite_mode |
| `sRGB` | boolean | No | sRGB sampling flag (alias: srgb) |
| `srgb` | boolean | No | Alias for sRGB |
| `mipmaps` | boolean | No | Enable mipmaps (alias: mipmapEnabled) |
| `mipmapEnabled` | boolean | No | Alias for mipmaps |
| `readable` | boolean | No | Read/Write enabled flag |
| `alpha_source` | "None" \| "FromInput" \| "FromGrayScale" | No | Texture alpha source |

### unity_asset_channel_pack

Pack generator texture maps into a Unity-ready texture. Default preset 'metallic_smoothness' writes R=metallic, A=smoothness (1-roughness). Preset 'mask_map' writes the HDRP-style R=metallic, G=occlusion, B=detail, A=smoothness layout.

**Wire command:** `asset.channel_pack`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Output texture asset path (.png/.jpg/.jpeg under Assets/) |
| `preset` | "metallic_smoothness" \| "mask_map" | No | Channel layout preset (default: metallic_smoothness) |
| `metallic_path` | string | No | Optional metallic grayscale texture path (alias: metallicPath). R channel. |
| `metallicPath` | string | No | Alias for metallic_path |
| `roughness_path` | string | No | Optional roughness grayscale texture path (alias: roughnessPath). Alpha stores 1-roughness as smoothness. |
| `roughnessPath` | string | No | Alias for roughness_path |
| `smoothness_path` | string | No | mask_map only: direct smoothness grayscale texture path (alternative to roughness_path). Alpha channel (alias: smoothnessPath). |
| `smoothnessPath` | string | No | Alias for smoothness_path |
| `occlusion_path` | string | No | mask_map only: occlusion/AO grayscale texture path. G channel (aliases: occlusionPath, ao_path, aoPath). Default 1 (no occlusion). |
| `occlusionPath` | string | No | Alias for occlusion_path |
| `ao_path` | string | No | Alias for occlusion_path |
| `aoPath` | string | No | Alias for occlusion_path |
| `detail_path` | string | No | mask_map only: detail-mask grayscale texture path. B channel (aliases: detailPath, detail_mask_path, detailMaskPath). Default 0. |
| `detailPath` | string | No | Alias for detail_path |
| `detail_mask_path` | string | No | Alias for detail_path |
| `detailMaskPath` | string | No | Alias for detail_path |
| `mipmaps` | boolean | No | Enable mipmaps on the packed texture (default: true) |
| `readable` | boolean | No | Keep the packed texture CPU-readable for channel diagnostics (default: true) |

### unity_asset_set_renderer_materials

Assign a Renderer.sharedMaterials array by material asset paths, with optional submesh-count validation.

**Wire command:** `asset.set_renderer_materials`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `materials` | string[] | Yes | Material asset paths to assign to Renderer.sharedMaterials |
| `strict_submesh_count` | boolean | No | Refuse when the material count differs from the renderer mesh submesh count (default: false) |

### unity_asset_list_sub_assets

List every asset object at an asset path via AssetDatabase.LoadAllAssetsAtPath (includes representations and hidden sub-assets such as FBX clips/avatars). Returns per object {name, type, fileID, guid, isMainAsset}, plus length/isLooping for AnimationClips and isHuman/isValid for Avatars. Eliminates the manual grep-a-temp-prefab-for-m_Animation trick used to discover FBX clip fileIDs. If nothing loads, force-imports just that asset synchronously (never a global Refresh, which could recompile unrelated dirty scripts) and retries once; distinguishes 'no such asset' / 'path is a folder' / 'asset exists but not yet imported'.

**Wire command:** `asset.list_sub_assets`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `asset_path` | string | Yes | Asset path under Assets/ (e.g. an .fbx, .glb, or .controller) |

### unity_asset_inspect_model_importer

Inspect the ModelImporter for a model asset (.fbx/.obj/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not a ModelImporter. Returns {animationType, avatarSetup, importAnimation, globalScale, useFileScale, fileScale, materialImportMode, clipAnimations:[{name, takeName, firstFrame, lastFrame, loopTime}], defaultClipAnimations (names), importedTakeInfos (names)} — the FBX import state the dogfood session read by hand-cloning a known-good .fbx.meta.

**Wire command:** `asset.inspect_model_importer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `asset_path` | string | Yes | Model asset path under Assets/ (.fbx/.obj/.dae/etc) |

### unity_asset_configure_model_importer

Configure a model asset's ModelImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not a model. Model reimport re-serializes sub-assets but does NOT compile scripts, so no domain reload occurs and the response is synchronous — rigged-model reimports are still slow, hence the 90s default timeout (tune per call via timeoutMs). clip_overrides edit takes discovered on the model (matched by take_name) — e.g. forcing loopTime on a walk cycle — replacing the hand-edited .fbx.meta clipAnimations block. Combining animation-discovery settings (animation_type/avatar_setup/import_animation) with clip_overrides in one call works but costs TWO internal reimports: the first refreshes take discovery under the new settings, the second applies the overrides. Resulting clip names must be unique (refuses INVALID_PARAMS on collision).

**Wire command:** `asset.configure_model_importer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `asset_path` | string | Yes | Model asset path under Assets/ (.fbx/.obj/.dae/etc) |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 90000; a rigged-FBX SaveAndReimport routinely exceeds the generic 10s fallback, and combining discovery settings with clip_overrides doubles the reimport cost). |
| `animation_type` | string,integer | No | ModelImporterAnimationType: None|Legacy|Generic|Human (or the raw int). avatarSetup+animation=Human is the rigged-clip path. |
| `avatar_setup` | string,integer | No | ModelImporterAvatarSetup: NoAvatar|CreateFromThisModel|CopyFromOther (or raw int). FBX defaults to NoAvatar which yields no Animator/clips; CreateFromThisModel unlocks them. |
| `import_animation` | boolean | No | ModelImporter.importAnimation |
| `global_scale` | number | No | ModelImporter.globalScale (applied when use_file_scale is false) |
| `use_file_scale` | boolean | No | ModelImporter.useFileScale |
| `clip_overrides` | object[] | No | Per-take clip overrides matched by take_name against the model's discovered takes. |

### unity_asset_inspect_audio_importer

Inspect the AudioImporter for an audio asset (.wav/.ogg/.mp3/.aiff/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not an AudioImporter. Returns {force_to_mono, load_in_background, ambisonic, default_sample_settings:{load_type, compression_format, quality, sample_rate_setting, sample_rate_override, preload_audio_data, conversion_mode}, clip:{length, channels, frequency, samples} when the AudioClip is loadable (else null)} — the import state the SFX dogfood tuned by hand-editing .wav.meta. conversion_mode is Unity's undocumented raw int field on AudioImporterSampleSettings (no public enum type exists), reported as-is so inspect is a complete settings dump. Reads the DEFAULT platform sample settings only; per-platform overrides are out of scope.

**Wire command:** `asset.inspect_audio_importer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `asset_path` | string | Yes | Audio asset path under Assets/ (.wav/.ogg/.mp3/.aiff/etc) |

### unity_asset_configure_audio_importer

Configure an audio asset's AudioImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not an audio clip. Writes force_to_mono / load_in_background on the importer and load_type / compression_format / quality / sample_rate_setting / sample_rate_override / preload_audio_data / conversion_mode on the DEFAULT-platform AudioImporterSampleSettings (per-platform overrides are OUT OF SCOPE for this slice). Role-specific import: short critical SFX prefer load_type=DecompressOnLoad + compression_format=PCM|ADPCM; music/long ambience prefer Streaming. Audio reimport re-encodes the clip but does NOT compile scripts, so no domain reload occurs and the response is synchronous — re-encoding a long clip can still exceed the 10s wire fallback, hence the 90s default timeout (tune per call via timeoutMs). Enum params accept the name (load_type: DecompressOnLoad|CompressedInMemory|Streaming; compression_format: PCM|Vorbis|ADPCM; sample_rate_setting: PreserveSampleRate|OptimizeSampleRate|OverrideSampleRate) or the raw int, and refuse INVALID_PARAMS listing the valid values.

**Wire command:** `asset.configure_audio_importer`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `asset_path` | string | Yes | Audio asset path under Assets/ (.wav/.ogg/.mp3/.aiff/etc) |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 90000; re-encoding a long clip can exceed the generic 10s wire fallback). |
| `force_to_mono` | boolean | No | AudioImporter.forceToMono — downmix all channels to one. |
| `load_in_background` | boolean | No | AudioImporter.loadInBackground — load the clip off the main thread without blocking. |
| `preload_audio_data` | boolean | No | AudioImporterSampleSettings.preloadAudioData — preload the clip when the scene/asset loads. Written through the struct: the importer-level AudioImporter.preloadAudioData still exists on 6000.3 but is an ERROR-level [Obsolete] pointing at the sample settings. |
| `load_type` | string,integer | No | AudioClipLoadType: DecompressOnLoad|CompressedInMemory|Streaming (or the raw int). |
| `compression_format` | string,integer | No | AudioCompressionFormat: PCM|Vorbis|ADPCM (or the raw int; other platform formats such as MP3/AAC are also accepted by name where valid on this Unity build). |
| `quality` | number | No | AudioImporterSampleSettings.quality — compression amount 0..1 (refuses INVALID_PARAMS outside [0,1]). |
| `sample_rate_setting` | string,integer | No | AudioSampleRateSetting: PreserveSampleRate|OptimizeSampleRate|OverrideSampleRate (or the raw int). |
| `sample_rate_override` | integer | No | Target sample rate in Hz, used when sample_rate_setting=OverrideSampleRate (refuses INVALID_PARAMS if negative). |
| `conversion_mode` | integer | No | AudioImporterSampleSettings.conversionMode — Unity's undocumented public int field (no public enum type exists in the 6000.3 assembly), passed through as a raw int without name-based validation. Leave unset unless replicating a known .meta value. |

### unity_asset_assign_sprite

Assign a sprite asset to a SpriteRenderer or UI Image component on a GameObject. If no sprite resolves at sprite_path, the NOT_FOUND error DIAGNOSES why (texture is not Sprite type / is Sprite Mode Multiple with zero sliced sub-sprites / named sub-sprite absent) and names the fix — see asset.set_texture_import_settings sprite_mode.

**Wire command:** `asset.assign_sprite`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locator` | object | Yes | Entity locator identifying a GameObject |
| `sprite_path` | string | Yes | Asset path of the sprite to assign |
| `sprite_name` | string | No | Optional named sub-sprite within a multiple-sprite texture |

### unity_asset_picker_open

Open (or refresh) the Loombridge asset picker — a human-in-the-loop EditorWindow that proposes options with thumbnails for the user to confirm or swap. The agent supplies slots of candidate options with its pre-selected pick; the user single-selects per slot and clicks Confirm or Cancel. Resets picker state to 'pending'. This is a generic options-with-thumbnails surface (the agent assembles slots/options); poll unity_asset_picker_state for the outcome. Note: opening does not block — use the poll handshake.

**Wire command:** `asset.picker_open`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | No | Window title shown above the slots (e.g. 'Choose prototype assets') |
| `slots` | object[] | Yes | One entry per choice slot (e.g. one per primitive: player, enemy, ground). |

### unity_asset_picker_state

Poll the Loombridge asset picker handshake state. Returns { status: 'none'|'pending'|'confirmed'|'cancelled', selection: { <slot>: <optionId> } }. 'none' before opening or after close, 'pending' while the user is choosing, 'confirmed' with the chosen ids after the user clicks Confirm, 'cancelled' if the user clicks Cancel or closes the window. The agent polls this (with its own timeout) until confirmed/cancelled.

**Wire command:** `asset.picker_state`

*No parameters.*

### unity_asset_picker_close

Close the Loombridge asset picker window and reset state to 'none'. Use after reading a confirmed/cancelled outcome, or to dismiss the picker.

**Wire command:** `asset.picker_close`

*No parameters.*

### unity_asset_browser_open

Open (or refresh) the Loombridge registry Asset Browser EditorWindow. The agent supplies a generic library payload assembled from the registry/profile (categories, assets, local thumbnail paths, metadata, and seeded inventory/default selections). The browser supports search, category and metadata filters, grid cards, inventory add/remove/swap, and a preview modal. It reuses the existing asset picker poll handshake: this call resets state to 'pending', and unity_asset_picker_state returns the confirmed/cancelled outcome.

**Wire command:** `asset.browser_open`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | No | Window title/chrome label. |
| `registry` | object | No | Registry status metadata shown in the left rail. |
| `categories` | object[] | No | Optional category definitions. Counts are derived from assets. |
| `assets` | object[] | Yes | Library assets to browse. The bridge does not read registry files; the agent supplies this data. |
| `inventory` | string[] | No | Optional seeded inventory/default asset ids. If omitted, the browser seeds one high-priority asset per primitive. |
| `slots` | object[] | No | Optional Phase-1-style slots; selectedId values are also used to seed inventory. |

## Package Operations

| Tool | Description |
|------|-------------|
| `unity_package_list` | List packages installed in the project (Unity Package Manager). Returns each package's name, displayName, version, source, packageId, and resolvedPath. Use this to check whether a dependency is already present before adding it. |
| `unity_package_add` | Add (install) a package dependency via Unity Package Manager — lets a build self-provision a package it needs (e.g. Input System, Cinemachine, TextMeshPro). 'packageId' accepts a registry name ('com.unity.cinemachine'), name@version ('com.unity.inputsystem@1.7.0'), or a git URL. NOTE: a successful add triggers a domain reload / recompile; follow this op with unity_editor_wait_for { compiling: false } before issuing further ops. |
| `unity_package_remove` | Remove (uninstall) a package dependency via Unity Package Manager. Like add, a successful remove triggers a recompile; follow with unity_editor_wait_for { compiling: false }. |
| `unity_package_search` | Search the Unity package registry for a package by name/id and return its available metadata (including versions). Use to discover the exact packageId/version before add when it isn't already known. |

### unity_package_list

List packages installed in the project (Unity Package Manager). Returns each package's name, displayName, version, source, packageId, and resolvedPath. Use this to check whether a dependency is already present before adding it.

**Wire command:** `package.list`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `offlineMode` | boolean | No | Resolve from the local cache without contacting the registry (default: false). |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 60000). |

### unity_package_add

Add (install) a package dependency via Unity Package Manager — lets a build self-provision a package it needs (e.g. Input System, Cinemachine, TextMeshPro). 'packageId' accepts a registry name ('com.unity.cinemachine'), name@version ('com.unity.inputsystem@1.7.0'), or a git URL. NOTE: a successful add triggers a domain reload / recompile; follow this op with unity_editor_wait_for { compiling: false } before issuing further ops.

**Wire command:** `package.add`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `packageId` | string | Yes | Package to add: registry name, name@version, or git URL. |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 120000; network installs can be slow). |

### unity_package_remove

Remove (uninstall) a package dependency via Unity Package Manager. Like add, a successful remove triggers a recompile; follow with unity_editor_wait_for { compiling: false }.

**Wire command:** `package.remove`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `packageName` | string | Yes | Package name to remove (e.g. 'com.unity.cinemachine'). |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 120000). |

### unity_package_search

Search the Unity package registry for a package by name/id and return its available metadata (including versions). Use to discover the exact packageId/version before add when it isn't already known.

**Wire command:** `package.search`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `packageId` | string | Yes | Package name/id to search the registry for (e.g. 'com.unity.cinemachine'). |
| `timeoutMs` | number | No | Max time to wait in milliseconds (default: 120000). |

## Capture Operations

| Tool | Description |
|------|-------------|
| `unity_capture_invoke_static` | Invoke a project-authored STATIC verification-capture method (component + method) so it writes its own gate JSON into outDir from RAW in-editor sampling — never hand-authored. Generic in shape but LOCKED to the project-configurable allowlist (only vetted entry points run): the built-in default is 'GroundTiling.WriteTileCaptures' (writes platform-tiles.json + tile-render.json); add more via staticMethods[] in the project's .loombridge/editor-allowlist.json. The static method must have signature (string outDir). Refuses a non-allowlisted method or a component type not found in any loaded assembly. outDir must resolve under the Unity project's .loombridge/verify/ subtree. Returns { component, method, outDir (absolute), wrote[] (fresh expected filenames only), playMode }. Used by `loombridge capture --slice <id>` for the platformer tiling slice. |

### unity_capture_invoke_static

Invoke a project-authored STATIC verification-capture method (component + method) so it writes its own gate JSON into outDir from RAW in-editor sampling — never hand-authored. Generic in shape but LOCKED to the project-configurable allowlist (only vetted entry points run): the built-in default is 'GroundTiling.WriteTileCaptures' (writes platform-tiles.json + tile-render.json); add more via staticMethods[] in the project's .loombridge/editor-allowlist.json. The static method must have signature (string outDir). Refuses a non-allowlisted method or a component type not found in any loaded assembly. outDir must resolve under the Unity project's .loombridge/verify/ subtree. Returns { component, method, outDir (absolute), wrote[] (fresh expected filenames only), playMode }. Used by `loombridge capture --slice <id>` for the platformer tiling slice.

**Wire command:** `capture.invoke_static`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `component` | string | Yes | Short type name of the component declaring the static method (e.g. 'GroundTiling'). |
| `method` | string | Yes | Public static method name to invoke; must be (string outDir) and on the allowlist (e.g. 'WriteTileCaptures'). |
| `outDir` | string | Yes | Directory the method writes its capture JSON into; must resolve under .loombridge/verify/ (absolute, or relative to the Unity project root). |

## Ops Operations

| Tool | Description |
|------|-------------|
| `unity_ops_batch` | Execute a list of existing Loombridge ops sequentially on Unity's main thread in ONE round-trip, wrapped in a single undo group. Each item is { command, params } using normal op command names (e.g. 'scene.create_object', 'component.set_property'). Returns per-op results. Use for bulk construction (placing/wiring many objects) to collapse many round-trips into one. Only ops that complete synchronously are allowed (no editor.play / wait_for / screenshot / input sessions). |
| `unity_ops_list` | Discover every Loombridge op WITHOUT touching Unity: returns the full catalog grouped by category — each entry is { command, toolName, isAsync, summary } — plus totalOps/totalCategories. Use this FIRST to find the right op instead of guessing tool names (RCL-T07). Pass 'category' (e.g. 'scene', 'runtime', 'editor') to list just that group. Pair with ops.describe for full schemas. |
| `unity_ops_describe` | Full input schema for one or more Loombridge ops WITHOUT touching Unity (RCL-T07). Filter by exact 'command' ('scene.create_object'), exact 'toolName' ('unity_scene_create_object'), or 'category'; with no filter it returns every op's schema. Returns { matched:[{command,toolName,category,isAsync,defaultTimeoutMs,description,inputSchema}], suggestions? }. When a specific command/toolName is unknown, matched is empty and 'suggestions' lists the nearest valid commands (so a typo self-corrects). |

### unity_ops_batch

Execute a list of existing Loombridge ops sequentially on Unity's main thread in ONE round-trip, wrapped in a single undo group. Each item is { command, params } using normal op command names (e.g. 'scene.create_object', 'component.set_property'). Returns per-op results. Use for bulk construction (placing/wiring many objects) to collapse many round-trips into one. Only ops that complete synchronously are allowed (no editor.play / wait_for / screenshot / input sessions).

**Wire command:** `ops.batch`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `operations` | any | Yes | Ops to run in order, as a native array of { command, params? } (preferred) or a JSON string of that array. |
| `stopOnError` | boolean | No | Stop at the first failing op (default true). If false, continue and report each failure with partial-progress results. |
| `undoGroupName` | string | No | Name for the single undo group wrapping the batch (default 'Loombridge Batch'). |

### unity_ops_list

Discover every Loombridge op WITHOUT touching Unity: returns the full catalog grouped by category — each entry is { command, toolName, isAsync, summary } — plus totalOps/totalCategories. Use this FIRST to find the right op instead of guessing tool names (RCL-T07). Pass 'category' (e.g. 'scene', 'runtime', 'editor') to list just that group. Pair with ops.describe for full schemas.

**Wire command:** `ops.list`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `category` | string | No | Optional category filter (e.g. 'scene', 'editor', 'runtime', 'input'). |

### unity_ops_describe

Full input schema for one or more Loombridge ops WITHOUT touching Unity (RCL-T07). Filter by exact 'command' ('scene.create_object'), exact 'toolName' ('unity_scene_create_object'), or 'category'; with no filter it returns every op's schema. Returns { matched:[{command,toolName,category,isAsync,defaultTimeoutMs,description,inputSchema}], suggestions? }. When a specific command/toolName is unknown, matched is empty and 'suggestions' lists the nearest valid commands (so a typo self-corrects).

**Wire command:** `ops.describe`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | string | No | Exact op command to describe (e.g. 'runtime.measure_motion'). |
| `toolName` | string | No | Exact MCP tool name to describe (e.g. 'unity_runtime_measure_motion'). |
| `category` | string | No | Describe every op in this category (e.g. 'runtime'). |

## Replay Operations

| Tool | Description |
|------|-------------|
| `unity_replay_settle_and_capture` | CAPTURE-ALIGNED SETTLE: advance the running game exactly 'settleFrames' player-loop frames at a pinned 1/captureFps game-time step, then screenshot the Game View ON THAT FRAME, inside the same tick loop. Requires Play Mode. Use INSTEAD OF sleep-then-editor.screenshot whenever a frame is going to be pixel-compared: between a sleep and a separate screenshot the game free-runs for an unknown number of frames, so the capture lands at a different animation phase each run and the pixel gate cannot tell that phase skew from real drift. Forces Application.runInBackground=true and restores both it and Time.captureDeltaTime on every exit path (success, wall-deadline, play-exit, domain reload). Returns the editor.screenshot payload (image_base64, width, height, sizeBytes, format) plus framesElapsed, settleFrames, captureFps, settledMs, realtimeDeadlineHit (always false on success) and fixedDeltaTime (the project's real physics step, for the cadence note). framesElapsed is the count of EDITOR UPDATE ticks the settle consumed (one player-loop frame each in Play Mode: the editor.tick advancedFrames precedent), and settledMs is the game time it advanced, measured from BEFORE the first frame so it spans all settleFrames. A WALL-CLOCK DEADLINE (settleFrames/captureFps + 8s, checked every tick) is an ERROR, not a degraded frame: a capture at the wrong game time is not comparable evidence, so a starved editor is reported as a harness fault (capture tier) instead of being returned as pixel drift. TIMEOUT NOTE: the replay driver sends its OWN wire timeout (settleFrames/captureFps*1000 + 15000) rather than relying on defaultTimeoutMs, because a long settle at a low fps outlives any fixed default; a direct caller should do the same for settles beyond a couple of seconds, through the 'timeoutMs' parameter below. It does NOT align what happens OUTSIDE the settle (action round trips, anchor polling), and it cannot fix seed-driven (unseeded Random) or realtime-driven (realtimeSinceStartup, DateTime) nondeterminism. |

### unity_replay_settle_and_capture

CAPTURE-ALIGNED SETTLE: advance the running game exactly 'settleFrames' player-loop frames at a pinned 1/captureFps game-time step, then screenshot the Game View ON THAT FRAME, inside the same tick loop. Requires Play Mode. Use INSTEAD OF sleep-then-editor.screenshot whenever a frame is going to be pixel-compared: between a sleep and a separate screenshot the game free-runs for an unknown number of frames, so the capture lands at a different animation phase each run and the pixel gate cannot tell that phase skew from real drift. Forces Application.runInBackground=true and restores both it and Time.captureDeltaTime on every exit path (success, wall-deadline, play-exit, domain reload). Returns the editor.screenshot payload (image_base64, width, height, sizeBytes, format) plus framesElapsed, settleFrames, captureFps, settledMs, realtimeDeadlineHit (always false on success) and fixedDeltaTime (the project's real physics step, for the cadence note). framesElapsed is the count of EDITOR UPDATE ticks the settle consumed (one player-loop frame each in Play Mode: the editor.tick advancedFrames precedent), and settledMs is the game time it advanced, measured from BEFORE the first frame so it spans all settleFrames. A WALL-CLOCK DEADLINE (settleFrames/captureFps + 8s, checked every tick) is an ERROR, not a degraded frame: a capture at the wrong game time is not comparable evidence, so a starved editor is reported as a harness fault (capture tier) instead of being returned as pixel drift. TIMEOUT NOTE: the replay driver sends its OWN wire timeout (settleFrames/captureFps*1000 + 15000) rather than relying on defaultTimeoutMs, because a long settle at a low fps outlives any fixed default; a direct caller should do the same for settles beyond a couple of seconds, through the 'timeoutMs' parameter below. It does NOT align what happens OUTSIDE the settle (action round trips, anchor polling), and it cannot fix seed-driven (unseeded Random) or realtime-driven (realtimeSinceStartup, DateTime) nondeterminism.

**Wire command:** `replay.settle_and_capture`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `settleFrames` | integer | Yes | Player-loop frames to advance before the capture (at 1/captureFps of game time each), 1 to 7200 (7200 = 2 minutes of game time at 60 fps). The editor is pinned for the whole settle, so a mistyped frame count is a stalled editor, not a slow call. |
| `captureFps` | integer | No | Pin Time.captureDeltaTime to 1/captureFps for the settle (default 60), 10 to 120. Unlike editor.tick, 0 is REFUSED: an unpinned settle is the nondeterminism this op removes. Below 10 a single frame is over 100ms of game time; above 120 a backgrounded editor cannot reliably deliver the ticks inside the wall budget. |
| `format` | "png" \| "jpg" | No | Capture format (default png). |
| `view` | "game" \| "scene" | No | View to capture (default game). |
| `maxWidth` | integer | No | Max capture width in px (default 1024). |
| `quality` | integer | No | JPEG quality (ignored for png). |
| `timeoutMs` | integer | No | Wire timeout for THIS call, overriding defaultTimeoutMs (30000). Set it above the settle's own wall cost plus the bridge's 8s slack (the driver sends settleFrames/captureFps*1000 + 15000), so the BRIDGE's honest deadline decides the outcome instead of this timer turning a measurable harness fault into an anonymous transport timeout. |

## Observe Operations

| Tool | Description |
|------|-------------|
| `unity_observe_start` | Open a PLAY-MODE STATE RECORDING window: from now until observe.drain, a runtime pump samples the declared player's world position plus the declared component's win/score/lives fields EVERY Update, into a ring buffer inside the game. Requires Play Mode. IDEMPOTENT: starting an already-active recorder returns that live session untouched (started:false, alreadyRecording:true) instead of discarding a window someone is mid-drive through. Refuses up front when the player path, the state path, the component or any declared field does not resolve: the recorder never coerces an unreadable field to false/0, so a wrong name is an error here rather than a buffer of zeros. Also reads the scene ONCE at open and echoes what the derivation has to bind to: the player's spawn position, the goal and respawn positions (when named), and the COUNT of collectible objects matching the declared name pattern and/or tag. Returns sessionId, editorSessionId, capacity, fixedTimestep, spawn, initial (the opening sample, taken synchronously) and the collectible count. The recorder does not survive a domain reload or a play-mode exit, by design: a drain afterwards reports recording:false with an empty buffer, which the caller must refuse rather than read as a clean short session. |
| `unity_observe_status` | Counters for the live recording window: recording, sessionId, editorSessionId, sampleCount, totalSampled, droppedSamples (non-zero means the ring wrapped and the window has a hole in it), capacity, fixedTickCount, elapsedMs, effectiveSampleRateHz, and the LATEST sample only. Deliberately cheap: it is polled while an agent drives the game, so no buffer crosses the wire until observe.drain. |
| `unity_observe_drain` | Return the WHOLE recorded window and stop the recorder. DESTRUCTIVE: the buffers are released with the session, so a lost response loses the window (never auto-retry it). Returns the same counters as observe.status plus wasRecording (false means the recorder had already died: play exit or a domain reload, which must never read as a clean short window) and samples as PARALLEL ARRAYS {tMs, frame, fixedTick, x, y, z, win, score, lives}, oldest first, one entry per sampled Update with nothing decimated. A win/score/lives entry is JSON null when that read failed on that sample, and the failing field names are listed in unreadableFields: an unread field is never reported as false or 0. |

### unity_observe_start

Open a PLAY-MODE STATE RECORDING window: from now until observe.drain, a runtime pump samples the declared player's world position plus the declared component's win/score/lives fields EVERY Update, into a ring buffer inside the game. Requires Play Mode. IDEMPOTENT: starting an already-active recorder returns that live session untouched (started:false, alreadyRecording:true) instead of discarding a window someone is mid-drive through. Refuses up front when the player path, the state path, the component or any declared field does not resolve: the recorder never coerces an unreadable field to false/0, so a wrong name is an error here rather than a buffer of zeros. Also reads the scene ONCE at open and echoes what the derivation has to bind to: the player's spawn position, the goal and respawn positions (when named), and the COUNT of collectible objects matching the declared name pattern and/or tag. Returns sessionId, editorSessionId, capacity, fixedTimestep, spawn, initial (the opening sample, taken synchronously) and the collectible count. The recorder does not survive a domain reload or a play-mode exit, by design: a drain afterwards reports recording:false with an empty buffer, which the caller must refuse rather than read as a clean short session.

**Wire command:** `observe.start`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `playerPath` | string | Yes | Hierarchy path of the object whose transform.position is sampled every Update (accepts 'Scene:/Path' or '/Path'). |
| `statePath` | string | Yes | Hierarchy path of the object carrying the win/score/lives component. |
| `stateComponent` | string | Yes | Component type name carrying the fields, e.g. 'GameManager'. |
| `winField` | string | Yes | Public bool field/property that flips when the level is won. |
| `scoreField` | string | Yes | Public numeric score field/property. |
| `livesField` | string | Yes | Public numeric lives field/property. |
| `collectibleNamePattern` | string | No | Case-insensitive name substring the bridge counts as a collectible at window open (the score increments are cross-checked against that count). |
| `collectibleTag` | string | No | Unity tag the bridge counts as a collectible at window open. |
| `goalPath` | string | No | Object whose position is the goal; its position is read at open for the reach-goal rule. |
| `respawnPath` | string | No | Object whose position is the game's own respawn point; a super-kinematic step landing there is classified as a respawn instead of an unexplained teleport. |
| `capacity` | integer | No | Ring size in SAMPLES (0 uses the default 36000, which is 10 minutes at 60Hz). Nothing is decimated: a wrap is counted and refuses downstream. |

### unity_observe_status

Counters for the live recording window: recording, sessionId, editorSessionId, sampleCount, totalSampled, droppedSamples (non-zero means the ring wrapped and the window has a hole in it), capacity, fixedTickCount, elapsedMs, effectiveSampleRateHz, and the LATEST sample only. Deliberately cheap: it is polled while an agent drives the game, so no buffer crosses the wire until observe.drain.

**Wire command:** `observe.status`

*No parameters.*

### unity_observe_drain

Return the WHOLE recorded window and stop the recorder. DESTRUCTIVE: the buffers are released with the session, so a lost response loses the window (never auto-retry it). Returns the same counters as observe.status plus wasRecording (false means the recorder had already died: play exit or a domain reload, which must never read as a clean short window) and samples as PARALLEL ARRAYS {tMs, frame, fixedTick, x, y, z, win, score, lives}, oldest first, one entry per sampled Update with nothing decimated. A win/score/lives entry is JSON null when that read failed on that sample, and the failing field names are listed in unreadableFields: an unread field is never reported as false or 0.

**Wire command:** `observe.drain`

*No parameters.*
