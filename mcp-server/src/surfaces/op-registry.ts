/**
 * OpRegistry — operation definitions with MCP tool schema generation.
 *
 * Defines all Unity ops extracted from the handler switch statements,
 * with JSON Schema input definitions for MCP tool registration.
 *
 * Naming convention: tool names use `unity_{category}_{op_name}`.
 * Commands use `{category}.{op_name}`.
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface OpDef {
  command: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isAsync?: boolean;
  defaultTimeoutMs?: number;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const INPUT_CAPABILITY_BLOCKER_CODE = "INPUT_CAPABILITY_BLOCKED";

export interface InputCapabilityBlockedPayload {
  deterministic: true;
  blockerType: "input capability";
  blockerCode: typeof INPUT_CAPABILITY_BLOCKER_CODE;
  command: string;
  supported: false;
  reason: string;
}

export function buildInputCapabilityBlockedPayload(
  command: string,
  reason: string,
): InputCapabilityBlockedPayload {
  return {
    deterministic: true,
    blockerType: "input capability",
    blockerCode: INPUT_CAPABILITY_BLOCKER_CODE,
    command,
    supported: false,
    reason,
  };
}

// ─────────────────────────────────────────────
// Shared Schema Fragments
// ─────────────────────────────────────────────

const locatorSchema = {
  type: "object" as const,
  description: "Entity locator identifying a GameObject",
  properties: {
    scene: { type: "string", description: "Scene name" },
    path: { type: "string", description: "Hierarchy path to the object" },
    globalObjectId: { type: "string", description: "Global object ID" },
    instanceId: { type: "string", description: "Instance ID" },
  },
  required: ["path"],
};

const vector3Schema = {
  type: "object" as const,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    z: { type: "number" },
  },
};

const vector2Schema = {
  type: "object" as const,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
};

const colorSchema = {
  type: "object" as const,
  properties: {
    r: { type: "number", description: "Red (0-1)" },
    g: { type: "number", description: "Green (0-1)" },
    b: { type: "number", description: "Blue (0-1)" },
    a: { type: "number", description: "Alpha (0-1)" },
  },
};

const routingProjectSchema = {
  type: "string" as const,
  description:
    "Optional Loombridge routing target. Use a projectPathCanonical/full project path or unique projectName from loombridge_editor_list. This field is consumed by the MCP server and is not sent to Unity.",
};

function withInputCapabilityGateNote(description: string): string {
  return `${description} Fails fast with deterministic blocker [${INPUT_CAPABILITY_BLOCKER_CODE}] `
    + "when input capability is unsupported; run unity_input_get_capabilities first.";
}

// ─────────────────────────────────────────────
// Op Definitions
// ─────────────────────────────────────────────

function buildOps(): OpDef[] {
  const ops: OpDef[] = [];

  // ───── scene ─────

  ops.push({
    command: "scene.new_scene",
    toolName: "unity_scene_new_scene",
    description: "Create a new empty scene with default GameObjects. Replaces the current scene.",
    inputSchema: { type: "object", properties: {}, required: [] },
  });

  ops.push({
    command: "scene.open_scene",
    toolName: "unity_scene_open_scene",
    description: "Open an existing scene file from disk. Defaults to Single mode (replaces current scene); use Additive to load alongside. Cannot be called in Play Mode.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path to the scene file (e.g. Assets/Scenes/Main.unity)" },
        mode: { type: "string", enum: ["Single", "Additive"], description: "Load mode (default: Single)" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "scene.save_scene",
    toolName: "unity_scene_save_scene",
    description: "Save the active scene to disk at the specified path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path to save the scene (e.g. Assets/Scenes/Main.unity)" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "scene.create_object",
    toolName: "unity_scene_create_object",
    description: "Create a new GameObject in the active scene. Returns locator for the created object.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new GameObject (default: 'GameObject')" },
        parent: { ...locatorSchema, description: "Optional parent object locator" },
        position: { ...vector3Schema, description: "Local position (relative to parent when parent is set)" },
        worldPosition: { ...vector3Schema, description: "World-space position. Applied after 'position'; takes precedence when both are set. Use this to place a child without computing parent-relative coordinates." },
        rotation: { ...vector3Schema, description: "Local euler angles" },
        scale: { ...vector3Schema, description: "Local scale" },
      },
    },
  });

  ops.push({
    command: "scene.create_primitive",
    toolName: "unity_scene_create_primitive",
    description:
      "Create a primitive GameObject (Cube/Sphere/Capsule/Cylinder/Plane/Quad) in one call — " +
      "mesh, renderer, and (by default) a matching collider, like GameObject.CreatePrimitive. " +
      "Use this for gray-box / blockout geometry instead of hand-assembling an empty GameObject " +
      "with MeshFilter+MeshRenderer. Returns the locator for the created object.",
    inputSchema: {
      type: "object",
      properties: {
        primitive: {
          type: "string",
          enum: ["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"],
          description: "Primitive type (PrimitiveType). Required.",
        },
        name: { type: "string", description: "Name for the new GameObject (default: the primitive type, e.g. 'Cube')" },
        parent: { ...locatorSchema, description: "Optional parent object locator" },
        position: { ...vector3Schema, description: "Local position (relative to parent when parent is set)" },
        worldPosition: { ...vector3Schema, description: "World-space position. Applied after 'position'; takes precedence when both are set." },
        rotation: { ...vector3Schema, description: "Local euler angles" },
        scale: { ...vector3Schema, description: "Local scale" },
        addCollider: { type: "boolean", description: "Keep the auto-added Collider (default: true). Set false to remove it (e.g. a pure visual decoration)." },
      },
      required: ["primitive"],
    },
  });

  ops.push({
    command: "scene.set_layer",
    toolName: "unity_scene_set_layer",
    description:
      "Set a GameObject's layer by NAME or INDEX (RCL-T05). Layers drive raycast masks, " +
      "line-of-sight, and cover checks in a shooter. 'layer' accepts a defined layer name " +
      "(e.g. 'Enemy') or an integer index 0-31. Pass includeChildren:true to apply it to the " +
      "whole hierarchy (a common need for an arena piece). Errors NOT_FOUND if the layer is " +
      "undefined. Returns the resolved { layer, layerName }.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        layer: {
          type: ["string", "number"],
          description: "Layer name (e.g. 'Enemy') or integer index 0-31. Must be an existing layer.",
        },
        includeChildren: {
          type: "boolean",
          description: "Also set the layer on every descendant (default false).",
        },
      },
      required: ["locator", "layer"],
    },
  });

  ops.push({
    command: "scene.set_tag",
    toolName: "unity_scene_set_tag",
    description:
      "Set a GameObject's tag (RCL-T05). The tag must already exist — Unity throws on an " +
      "undefined tag, so this returns a clear NOT_FOUND instead. Creating a missing tag is out " +
      "of scope. Returns the applied { tag }.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        tag: { type: "string", description: "An existing tag name (e.g. 'Player', 'Enemy')." },
      },
      required: ["locator", "tag"],
    },
  });

  ops.push({
    command: "scene.delete_object",
    toolName: "unity_scene_delete_object",
    description: "Delete a GameObject from the scene. Supports undo.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.duplicate_object",
    toolName: "unity_scene_duplicate_object",
    description: "Duplicate a GameObject (with its components and child hierarchy), preserving the source's local transform. The clone is parented under the source's parent by default; pass 'parent' to reparent it. Returns the locator of the new object.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Locator of the object to duplicate" },
        name: { type: "string", description: "Optional name for the clone (default: same as the source, without Unity's '(Clone)' suffix)" },
        parent: { ...locatorSchema, description: "Optional parent for the clone (default: same parent as the source)" },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.set_parent",
    toolName: "unity_scene_set_parent",
    description: "Reparent a GameObject. Omit 'parent' to unparent it to the scene root. World position is kept by default (worldPositionStays=true); set it false to preserve local transform values instead. Returns the updated locator.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Locator of the object to reparent" },
        parent: { ...locatorSchema, description: "Optional new parent locator. Omit/null = unparent to scene root." },
        worldPositionStays: { type: "boolean", description: "Keep world position when reparenting (default: true). False preserves local position/rotation/scale." },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.set_sibling_index",
    toolName: "unity_scene_set_sibling_index",
    description:
      "Reorder a GameObject among its siblings (same-parent child/draw order). A same-parent " +
      "scene.set_parent is a NO-OP for reordering, but sibling order is load-bearing for uGUI " +
      "draw order — a LATER sibling paints OVER an earlier one — so this is how you fix e.g. a " +
      "Filled bar covering its label WITHOUT hand-editing the scene YAML. Provide EXACTLY ONE of " +
      "'index' (absolute 0-based), 'before', or 'after' (a sibling locator OR a bare name string); " +
      "supplying more than one (ambiguous) or none is refused. An out-of-range 'index' is refused " +
      "with the valid range (never silently clamped); before/after refuse a reference that is the " +
      "object itself or lives under a different parent. Undo-recorded for parented objects (a " +
      "scene-ROOT reorder may not be undo-restorable — root order lives in the scene, not the " +
      "object hierarchy); marks the scene dirty. " +
      "Returns the resolved parentPath plus oldIndex -> newIndex and siblingCount.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Locator of the object to reorder" },
        index: { type: "number", description: "Absolute target sibling index (0-based; 0 = first, drawn first / behind later siblings). Valid range 0..siblingCount-1; out of range is refused, not clamped. Mutually exclusive with before/after." },
        before: { description: "Position the object immediately BEFORE this sibling — a locator object OR a bare sibling-name string. Must share the same parent. Mutually exclusive with index/after." },
        after: { description: "Position the object immediately AFTER this sibling — a locator object OR a bare sibling-name string. Must share the same parent. Mutually exclusive with index/before." },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.find_object",
    toolName: "unity_scene_find_object",
    description:
      "Find a single GameObject and return its locator + transform. Resolve by 'name' (first " +
      "match across all loaded scenes) OR by a 'locator' / 'path' that resolves exactly like " +
      "runtime.get_snapshot — including index-0 selection when sibling names collide " +
      "(e.g. path '/Enemy_Chaser' resolves the first of two same-named siblings). On a benign " +
      "miss it returns { found: false, locator: null } (no error, no error screenshot artifact). " +
      "The return is always a single object, never an array.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the GameObject to find (first match wins). Provide this OR a locator/path." },
        path: { type: "string", description: "Hierarchy path to resolve (e.g. '/Enemy_Chaser' or '/Root/Enemy[2]'). Resolves like get_snapshot (index-0 on duplicate names). Convenience shorthand for locator.path." },
        locator: { ...locatorSchema, description: "Full locator to resolve (path/scene/globalObjectId/instanceId), same resolution as runtime.get_snapshot. Provide this OR a name." },
      },
    },
  });

  ops.push({
    command: "scene.set_transform",
    toolName: "unity_scene_set_transform",
    description: "Set the world-space position, rotation, and/or scale of a GameObject.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        position: { ...vector3Schema, description: "World position" },
        rotation: { ...vector3Schema, description: "World euler angles" },
        scale: { ...vector3Schema, description: "Local scale" },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.get_hierarchy",
    toolName: "unity_scene_get_hierarchy",
    description: "Get the full scene hierarchy tree. Optionally limit depth.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "number", description: "Maximum hierarchy depth (-1 for unlimited)" },
      },
    },
  });

  ops.push({
    command: "scene.select_object",
    toolName: "unity_scene_select_object",
    description: "Select a GameObject in the Unity Editor (updates Inspector).",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.set_active",
    toolName: "unity_scene_set_active",
    description:
      "Set a GameObject's active self-state (GameObject.SetActive). Enable an inactive-by-default " +
      "object so it can be driven/verified — e.g. a mobile-controls canvas a desktop default leaves " +
      "off — WITHOUT modifying the game. Works in Edit or Play Mode. Returns the locator plus " +
      "activeSelf and activeInHierarchy (so you can tell whether an inactive ANCESTOR still keeps it " +
      "hidden even after you set it active).",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        active: { type: "boolean", description: "Desired active self-state (true = enable)." },
      },
      required: ["locator", "active"],
    },
  });

  // ───── editor ─────

  ops.push({
    command: "editor.screenshot",
    toolName: "unity_editor_screenshot",
    description:
      "Take a screenshot of the Scene or Game view. Returns base64-encoded image. " +
      "For named artifacts, pass outputPath (for example captures/start.png or " +
      ".loombridge/captures/start.png); the server writes the screenshot there and returns " +
      "JSON with path/width/height/format/sizeBytes/sha256. Do not scrape trace/artifacts " +
      "for agent-facing screenshots. " +
      "For debugging: pass focusLocator to render a deterministic close-up framed on one " +
      "object (independent of the live camera), and/or annotateBounds to draw objects' " +
      "collider (green), full sprite quad (magenta), and visible/opaque pixels (yellow) " +
      "world bounds onto the image so collider-vs-feet-vs-ground alignment is visible. " +
      "Annotated captures also return the numeric bounds as a text block. " +
      "Note: the game view is captured via Camera.Render, which composites Screen Space-Camera " +
      "UI but NOT Screen Space-Overlay UI — use a Camera-mode HUD canvas if you need the HUD to " +
      "appear in the screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["scene", "game"], description: "Which editor view to capture (default: scene)" },
        maxWidth: { type: "number", description: "Maximum width in pixels (default: 1024)" },
        format: { type: "string", enum: ["jpeg", "png"], description: "Image format (default: jpeg)" },
        quality: { type: "number", description: "JPEG quality 1-100 (default: 75)" },
        outputPath: {
          type: "string",
          description:
            "Optional server-side file path for a named screenshot artifact. Relative paths must be under " +
            ".loombridge/ or captures/ from the MCP server cwd; absolute paths must stay under " +
            "~/loombridge-runs or /tmp.",
        },
        focusLocator: {
          ...locatorSchema,
          description: "Optional: frame a temp camera tightly on this object for a close-up.",
        },
        annotateBounds: {
          type: "array",
          description:
            "Optional: locators whose collider (green), full sprite quad (magenta), and " +
            "visible/opaque pixels (yellow) world bounds are drawn onto the image. Use to " +
            "see alignment (e.g. visible feet vs collider vs ground).",
          items: locatorSchema,
        },
      },
    },
  });

  ops.push({
    command: "editor.set_game_view_size",
    toolName: "unity_editor_set_game_view_size",
    description:
      "Set the Unity Game View render resolution to a fixed width x height in pixels, so a " +
      "'Scale With Screen Size' uGUI canvas genuinely RE-LAYS-OUT at that aspect (CanvasScaler " +
      "re-evaluates) — not just a cropped screenshot. Use to capture/verify a UI across multiple " +
      "device aspects (e.g. 1280x720 landscape then 2400x1080 tall): after setting the size, the " +
      "existing unity_editor_screenshot and unity_ui_get_screen_rects ops read the new size " +
      "automatically (viewport + canvasScaleFactor change). Returns the applied {width,height,aspect} " +
      "plus {previousWidth,previousHeight}. The op is idempotent — to RESTORE the prior size, call " +
      "again with the returned previousWidth/previousHeight.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Game View render width in pixels (integer, 16-8192)." },
        height: { type: "number", description: "Game View render height in pixels (integer, 16-8192)." },
      },
      required: ["width", "height"],
    },
    defaultTimeoutMs: 30000,
  });

  ops.push({
    command: "editor.focus_game_view",
    toolName: "unity_editor_focus_game_view",
    description:
      "Best-effort focus of the Unity Game View so simulated Input-System pointer events can route " +
      "to world-space game code. Use before world-pointer input capture. Returns " +
      "gameViewAvailable/gameViewFocused. RCL-T09: focus is never a hard block — when the editor " +
      "cannot acquire OS focus (the headless/background norm) it DEGRADES gracefully: returns " +
      "focusDegraded:true and (in Play Mode) enables Application.runInBackground so the player loop " +
      "still ticks unfocused, instead of failing FOCUS_REQUIRED. For a deterministic sim-advance " +
      "without focus, use editor.tick.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "scene.get_bounds",
    toolName: "unity_scene_get_bounds",
    description:
      "Get world-space bounds for a GameObject: every collider and renderer as a world AABB " +
      "(min/max/center/size). For sprites also reports visibleBounds — the opaque (visible) " +
      "pixels of the current animation frame, not the padded quad. Convenience fields: " +
      "colliderBottomY, visibleBottomY, and visibleFeetAboveColliderBottom (>0 means the " +
      "visible feet sit above the collider bottom, so a grounded character will float). The " +
      "numeric counterpart to a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        debug: {
          type: "boolean",
          description:
            "Include verbose per-sprite scan details (rect/textureRect/pivot/ppu/pixel min-max) " +
            "in a visibleDebug field. Default false.",
        },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.frame_object",
    toolName: "unity_scene_frame_object",
    description:
      "Select and frame a GameObject in the live Scene View (like selecting it and pressing F), " +
      "so a subsequent scene-view look is centered on it. For a deterministic close-up capture " +
      "regardless of editor focus, prefer unity_editor_screenshot with focusLocator.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        select: { type: "boolean", description: "Also select the object in the editor (default: true)" },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.get_screen_rects",
    toolName: "unity_scene_get_screen_rects",
    description:
      "Project each object's world bounds into SCREEN space through a camera (default Camera.main) " +
      "to answer the framing/composition question: is the visible character fully inside the frame, " +
      "where is it horizontally (the 40%-anchor check via centerXFraction), and which edge it is " +
      "clipped against. boundsMode (default opaque) picks the primary bounds: opaque = visible sprite " +
      "pixels (the 'is the CHARACTER clipped' question), renderer = full sprite quad, collider. " +
      "Per object returns screenRect{x,y,width,height}, isFullyVisible, isPartiallyClipped, isOffScreen, " +
      "clipSide[], centerXFraction/centerYFraction, plus rendererRect/colliderRect/opaqueRect as debug, " +
      "and camera + viewport (width/height/aspect) info. The numeric counterpart to eyeballing a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        locators: {
          type: "array",
          description: "Objects to project into screen space.",
          items: locatorSchema,
        },
        camera: { ...locatorSchema, description: "Optional camera locator. Defaults to Camera.main." },
        boundsMode: {
          type: "string",
          enum: ["opaque", "renderer", "collider"],
          description: "Which bounds drives screenRect/clip flags (default opaque = visible sprite pixels).",
        },
      },
      required: ["locators"],
    },
  });

  ops.push({
    command: "scene.verify_manifest",
    toolName: "unity_scene_verify_manifest",
    description:
      "Game-agnostic check that the scene contains the assets a contract requires, with no leftover " +
      "placeholders. Provide an inline 'manifest' array OR a 'manifestPath' to a JSON file (bare array, " +
      "or an object with a manifest/assets array). Each entry: { name | nameRegex, type (GameObject|Sprite|" +
      "Prefab), primitive?, minCount?, required? }. 'matching' controls how name resolves (mode exact|prefix|" +
      "regex, caseSensitive). 'placeholderRule' detects placeholders by sprite-name substring (default " +
      "'placeholder') and/or an asset-path folder. Extras (unmatched placeholder objects) are a warning " +
      "unless extrasAsFailure=true. Returns { missing[], placeholders[], extras[], all_ok }.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: {
          type: "array",
          description: "Inline manifest entries. Alternative to manifestPath.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Exact/prefix object name to require (per matching.mode)." },
              nameRegex: { type: "string", description: "Regex pattern for object name (overrides name)." },
              type: { type: "string", enum: ["GameObject", "Sprite", "Prefab"], description: "Expected entry type (default GameObject)." },
              primitive: { type: "string", description: "Optional registry primitive label (informational)." },
              minCount: { type: "number", description: "Minimum number of matches required (default 1)." },
              required: { type: "boolean", description: "Whether absence is a failure (default true)." },
            },
          },
        },
        manifestPath: { type: "string", description: "Path to a JSON manifest file. Alternative to inline manifest." },
        matching: {
          type: "object",
          description: "How manifest names resolve to scene objects.",
          properties: {
            mode: { type: "string", enum: ["exact", "prefix", "regex"], description: "Match mode (default exact)." },
            caseSensitive: { type: "boolean", description: "Case-sensitive matching (default false)." },
          },
        },
        placeholderRule: {
          type: "object",
          description: "How a placeholder sprite is detected.",
          properties: {
            nameSubstring: { type: "string", description: "Sprite-name substring marking a placeholder (default 'placeholder')." },
            assetPathFolder: { type: "string", description: "Asset-path folder substring marking placeholders." },
          },
        },
        extrasAsFailure: { type: "boolean", description: "Treat unmatched placeholder extras as a failure (default false → warning)." },
      },
    },
  });

  ops.push({
    command: "scene.get_render_settings",
    toolName: "unity_scene_get_render_settings",
    description:
      "Read the ACTIVE scene's global lighting/environment RenderSettings (per-scene state): " +
      "ambientMode (Skybox|Trilight|Flat|Custom), ambientColor + ambientSkyColor/ambientEquatorColor/" +
      "ambientGroundColor (all as {r,g,b,a}; ambientColor and ambientSkyColor MIRROR each other — they are " +
      "the same underlying Unity property exposed under two names), ambientIntensity, fog (bool) + fogColor + " +
      "fogMode (Linear|Exponential|ExponentialSquared) + fogDensity/fogStartDistance/fogEndDistance, " +
      "skyboxMaterial (asset path or null), sun (a GameObject locator or null) + sunEnabled (the sun Light's " +
      "enabled state, null when no sun — a disabled sun is visible instead of a lit-but-dark mystery), and " +
      "subtractiveShadowColor. Read-only. SCOPE: scene-level UnityEngine.RenderSettings only — it does NOT " +
      "read the URP asset or Volume-framework post-processing (a separate slice). The round-trip counterpart " +
      "to set_render_settings.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });

  ops.push({
    command: "scene.find_references_to",
    toolName: "unity_scene_find_references_to",
    description:
      "Find every serialized ObjectReference in the loaded scenes that points at the target GameObject, " +
      "at any Component on it, or at ANY of its DESCENDANTS (and their components) — the scan surface " +
      "equals the destroy surface. This is the PRE-FLIGHT for a destructive prefab swap: run it BEFORE " +
      "asset.replace_with_prefab (which DESTROYS the replaced object's whole hierarchy and silently NULLs " +
      "external references into it — in a real incident a minimap component's cached extract-point reference pointed at a transform " +
      "on a CHILD under the beacon) to see exactly what would be severed. Scans SerializedObject " +
      "properties across all components (including nested/array refs) and is bounded + deterministically " +
      "ordered. Returns { target, references: [ { referencing: { locator, scene_path, component, " +
      "component_index }, property_path, relative_path ('' = the target root, else the referenced " +
      "descendant's path under the target), references: 'gameobject' | '<ComponentType>' } ], " +
      "count, truncated }. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "The GameObject whose inbound references to find." },
        max_results: { type: "integer", description: "Cap on reported references (default 500). Alias: maxResults." },
        maxResults: { type: "integer", description: "Alias for max_results." },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "scene.set_render_settings",
    toolName: "unity_scene_set_render_settings",
    description:
      "Set any subset of the ACTIVE scene's global RenderSettings (lighting/environment). Every field is " +
      "optional and only PROVIDED fields are applied — a partial update leaves the rest untouched. ATOMIC: " +
      "validate-then-apply — all params are parsed and the skybox material / sun locator resolved BEFORE the " +
      "first write, so a failed call leaves render settings completely untouched. Colors use the same {r,g,b,a} " +
      "float format as create_material/ui.add_image (missing channels default to 1). NOTE ambient_color and " +
      "ambient_sky_color are ALIASES of the same underlying Unity property (ambientLight == ambientSkyColor); " +
      "supplying both with different values is refused. Drives scene lighting through the bridge instead of " +
      "hand-patching scene YAML + reloading (which clobbers unsaved in-memory scene state). Marks the active " +
      "scene dirty only when a value actually changed (RenderSettings edits are not captured by Undo); pass " +
      "save:true to also write the scene to disk (refused with INVALID_PARAMS on an untitled scene — save it " +
      "via scene.save_scene first). Unknown ambient_mode/fog_mode values fail with INVALID_PARAMS listing the " +
      "valid values; ambient_mode 'Custom' is refused (this op cannot populate the ambient probe Custom reads " +
      "from). Returns the resulting get_render_settings payload. SCOPE: scene-level UnityEngine.RenderSettings " +
      "only — NO URP-asset or Volume post-processing mutation (a separate slice).",
    inputSchema: {
      type: "object",
      properties: {
        ambient_mode: {
          type: "string",
          enum: ["Skybox", "Trilight", "Flat"],
          description:
            "Ambient/environment lighting source. Trilight = the gradient (sky/equator/ground) mode; Flat = a " +
            "single ambient color. 'Custom' is intentionally NOT settable (the op cannot populate the ambient " +
            "probe it reads from), though get_render_settings still reports it when a scene already uses it.",
        },
        ambient_color: {
          ...colorSchema,
          description:
            "Flat ambient color (RenderSettings.ambientLight). ALIAS of ambient_sky_color — both names write " +
            "the same underlying per-scene property; supplying both with different values is refused.",
        },
        ambient_sky_color: {
          ...colorSchema,
          description:
            "Trilight gradient sky color (RenderSettings.ambientSkyColor). ALIAS of ambient_color — same " +
            "underlying property.",
        },
        ambient_equator_color: { ...colorSchema, description: "Trilight gradient equator color." },
        ambient_ground_color: { ...colorSchema, description: "Trilight gradient ground color." },
        ambient_intensity: { type: "number", description: "Ambient intensity multiplier (used in Skybox mode)." },
        fog: { type: "boolean", description: "Enable/disable fog." },
        fog_color: { ...colorSchema, description: "Fog color." },
        fog_mode: {
          type: "string",
          enum: ["Linear", "Exponential", "ExponentialSquared"],
          description: "Fog falloff mode. Linear uses fog_start_distance/fog_end_distance; Exponential(Squared) use fog_density.",
        },
        fog_density: { type: "number", description: "Fog density (Exponential / ExponentialSquared modes)." },
        fog_start_distance: { type: "number", description: "Fog start distance (Linear mode)." },
        fog_end_distance: { type: "number", description: "Fog end distance (Linear mode)." },
        skybox_material: { type: "string", description: "Asset path to a skybox Material (e.g. 'Assets/Art/Sky.mat'). Empty string or null clears the skybox. A path to a non-Material asset is INVALID_PARAMS; a missing asset is NOT_FOUND." },
        sun: { ...locatorSchema, description: "GameObject locator for the light to use as the sun (must carry a Light). Null clears the sun override." },
        subtractive_shadow_color: { ...colorSchema, description: "Shadow color used by the Subtractive shadow mixing mode." },
        save: { type: "boolean", description: "Also save the active scene to disk after applying (default false). Refused on an untitled scene — save it once via scene.save_scene first. The scene is marked dirty whenever a value actually changed." },
      },
    },
  });

  ops.push({
    command: "scene.validate_references",
    toolName: "unity_scene_validate_references",
    description:
      "Report every NULL serialized ObjectReference property in scope (a locator subtree, or ALL " +
      "loaded scenes by default), grouped-by-component via deterministic ordering. Honest + simple — a " +
      "reference is reported purely because it is null, with no heuristic guessing intent beyond nullness. " +
      "A SEVERED reference (null value but a non-zero instanceID, i.e. a Unity 'Missing' ref — exactly what " +
      "a destructive prefab swap leaves behind) is flagged missing:true so a broken wiring is distinguishable " +
      "from a never-assigned optional field. Pass include_prefab_defaults:true to additionally annotate each " +
      "null with prefab_source_non_null (whether the component's prefab source had a value there). Returns " +
      "{ scope, include_prefab_defaults, null_references: [ { object, component, component_index, property_path, " +
      "missing } ], count, truncated }. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { ...locatorSchema, description: "Optional subtree to scan. Omit to scan all loaded scenes." },
        include_prefab_defaults: { type: "boolean", description: "Annotate each null with whether the prefab source had a value (default false). Alias: includePrefabDefaults." },
        includePrefabDefaults: { type: "boolean", description: "Alias for include_prefab_defaults." },
        max_results: { type: "integer", description: "Cap on reported null references (default 500). Alias: maxResults." },
        maxResults: { type: "integer", description: "Alias for max_results." },
      },
    },
  });

  ops.push({
    command: "scene.snapshot_gameplay_geometry",
    toolName: "unity_scene_snapshot_gameplay_geometry",
    description:
      "Serialize the GAMEPLAY GEOMETRY of ALL loaded scenes to a deterministic, diffable JSON file — " +
      "the baseline half of the 'art scene safety profile' (art-integration dogfood, 'Art Is A Parallel " +
      "Vertical'): an art pass must be VISUAL-ONLY, so graybox colliders, triggers, LOS blockers, and " +
      "serialized gameplay tuning must survive it UNCHANGED. Take this snapshot BEFORE the art pass, " +
      "then run scene.compare_gameplay_geometry after to PROVE nothing gameplay-relevant moved. For " +
      "every GameObject carrying a Collider/Collider2D it records: each collider's type, is_trigger, " +
      "enabled, and LOCAL-space geometry (center/size/radius/height/offset/points per collider type), " +
      "plus the object's layer, tag, active_self/active_in_hierarchy, hierarchy path, and the owning " +
      "transform's WORLD position/rotation(quaternion)/scale. MeshColliders carry a mesh FINGERPRINT " +
      "(shared_mesh name + vertex_count + triangle_count + local bounds) so an in-place mesh edit or a " +
      "same-named mesh swap cannot read unchanged. Renderers and all visual-only data are EXCLUDED by " +
      "design. Objects are keyed and sorted by a stable SCENE-ASSET-PATH-qualified key (scene NAME is " +
      "not unique across additively-loaded scenes; untitled scenes disambiguate by load index), so " +
      "two snapshots of an unchanged scene are BYTE-IDENTICAL (no timestamps/instance IDs emitted). " +
      "output_path is PROJECT-RELATIVE and written by the bridge (refused if it escapes the project " +
      "root); the file carries schema_version (currently 2) + counts. Returns { output_path, " +
      "absolute_path, schema_version, counts, scenes, filters, bytes_written }.",
    inputSchema: {
      type: "object",
      properties: {
        output_path: {
          type: "string",
          description:
            "Project-relative path for the snapshot JSON (e.g. '.loombridge/art/gameplay-geometry.json'). " +
            "Absolute paths or paths escaping the project root are refused. Alias: outputPath.",
        },
        outputPath: { type: "string", description: "Alias for output_path." },
        include_tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tag allowlist — only objects whose tag is in this set are snapshotted. Omit " +
            "(or empty) to include every collider-bearing object. Alias: includeTags. STORED in the " +
            "file so compare_gameplay_geometry re-walks the identical surface.",
        },
        includeTags: { type: "array", items: { type: "string" }, description: "Alias for include_tags." },
        layers: {
          type: "array",
          items: { type: ["string", "integer"] },
          description:
            "Optional layer allowlist — only objects on these layers are snapshotted. Each element is " +
            "a layer NAME (resolved via LayerMask; an unknown name is refused, never silently ignored) " +
            "or a 0-31 index. Omit to include all layers. STORED in the file (as indices) so compare " +
            "re-walks the identical surface.",
        },
      },
      required: ["output_path"],
    },
  });

  ops.push({
    command: "scene.compare_gameplay_geometry",
    toolName: "unity_scene_compare_gameplay_geometry",
    description:
      "Re-walk the LIVE loaded scenes and diff them against a baseline snapshot (from " +
      "scene.snapshot_gameplay_geometry) — the verify half of the 'art scene safety profile'. The " +
      "live walk reuses the baseline's OWN stored filters (include_tags/layers) so both cover the same " +
      "surface. HONEST BY DESIGN: a MISSING baseline is NOT_FOUND; an unreadable / unparseable / " +
      "schema-mismatched baseline (including an OLDER schema_version — an old baseline cannot prove " +
      "the current invariants; re-snapshot) is INVALID_PARAMS; a snapshot with DUPLICATE identity keys " +
      "on either side is INVALID_PARAMS (colliding identities cannot honestly diff) — NEVER a silent " +
      "empty diff. Returns { verdict: 'unchanged' | 'changed', unchanged_count, added: [{path, scene, " +
      "colliders}], removed: [...], modified: [{path, scene, field, baseline, current}], tolerance, " +
      "filters, baseline_path }. verdict is 'changed' WHENEVER added, removed, or modified is " +
      "non-empty. Floats are compared with BOUNDED tolerances: position/size max 0.1, rotation max 5 " +
      "degrees — generous for float noise, refused above the cap (INVALID_PARAMS) so the knob can " +
      "never launder a real move; negatives also refused. Exact-match fields (type, layer, tag, " +
      "active_self, active_in_hierarchy — so deactivating a collider-less ANCESTOR still reads as " +
      "changed — is_trigger, enabled, direction, point_count, vertex_count, triangle_count, " +
      "shared_mesh) refuse any drift. A RENAMED-but-identical object shows as removed + added — " +
      "identity is the scene-asset-path-qualified hierarchy path; there is NO fuzzy matching. " +
      "Read-only (the live scene is not mutated).",
    inputSchema: {
      type: "object",
      properties: {
        baseline_path: {
          type: "string",
          description:
            "Project-relative path to a snapshot JSON previously written by " +
            "scene.snapshot_gameplay_geometry. Missing → NOT_FOUND; corrupt/mismatched → INVALID_PARAMS. " +
            "Alias: baselinePath.",
        },
        baselinePath: { type: "string", description: "Alias for baseline_path." },
        tolerance: {
          type: "object",
          description:
            "Optional float tolerances. Any omitted field falls back to its default. BOUNDED: values " +
            "outside [0, max] are refused with INVALID_PARAMS — the knob absorbs float noise only and " +
            "cannot be used to launder a real geometry change into 'unchanged'.",
          properties: {
            position: { type: "number", description: "Max abs per-axis difference for local centers/offsets and world position (default 0.001, max 0.1)." },
            rotation: { type: "number", description: "Max quaternion angle difference in DEGREES for world rotation (default 0.1, max 5)." },
            size: { type: "number", description: "Max abs difference for collider extents/radii/heights, mesh bounds, and world scale (default 0.001, max 0.1)." },
          },
        },
      },
      required: ["baseline_path"],
    },
  });

  ops.push({
    command: "editor.get_state",
    toolName: "unity_editor_get_state",
    description:
      "Get the current editor state: play_mode, compile status, selected object, and " +
      "show_work_enabled plus error_count + last_error (console errors/exceptions since the last clear_console). " +
      "Clear the console before entering Play Mode, then check error_count > 0 here to catch a " +
      "thrown exception instead of mistaking it for 'play mode not working'; pull console_logs for the full stack.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.get_project_diagnostics",
    toolName: "unity_editor_get_project_diagnostics",
    description:
      "Project-level capability diagnostics — the 'why does a symbol/module look missing while " +
      "error_count stays 0?' probe (the late-polish dogfood learnings §10, where ParticleSystem + " +
      "ScreenCapture modules were disabled yet the console read clean). Returns: " +
      "{ unity_version, render_pipeline: { mode: 'URP'|'HDRP'|'built-in'|'custom', asset_type }, " +
      "installed_packages: [{ name, version }] (from PackageManager.GetAllRegisteredPackages — direct " +
      "AND indirect/built-in deps), package_query_failed: boolean, disabled_built_in_modules: string[] | null " +
      "(BEST-EFFORT: a known optional com.unity.modules.* that is NOT in the registered-package set reads " +
      "as disabled/removed; enabled built-in modules are registered packages, so absence is a real signal — " +
      "but the checked set is a curated list of gameplay/FX/import modules, not exhaustive. NULL ≠ []: when " +
      "the package query fails this is null with package_query_failed:true, so a broken query can never " +
      "read as 'nothing disabled'; [] is the positive claim that every checked module is enabled), " +
      "editor_assembly_count + player_assembly_count (the two script-assembly sets, reported separately), " +
      "last_compile: the CompileWatcher's latest result or null }. Read-only. Results reflect the package " +
      "registry at call time — immediately after a domain reload the registry may still be resolving.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.audit_mobile_assets",
    toolName: "unity_editor_audit_mobile_assets",
    defaultTimeoutMs: 90000,
    description:
      "Mobile-optimization WEIGHT audit — measure before you optimize (the late-polish dogfood learnings §9, " +
      "where a 30.7k-tri T-wall mesh instanced 57× was the real per-frame cost, not the textures that took " +
      "the blame). Walks the CURRENTLY-LOADED scenes (NOT a full-project AssetDatabase scan — the honest, " +
      "bounded gameplay working set) and returns: { payload_kind: 'mobile_asset_audit', payload_version: 1 " +
      "(the discriminator `loombridge mobile-audit` requires — save this response verbatim), textures: { " +
      "entries:[{ path, name, width, height, format, " +
      "compression, estimated_bytes }] (shared-material + SpriteRenderer textures, deduped, sorted by estimated " +
      "bytes desc), total_count, truncated }, audio: { entries:[{ path, name, length_seconds, channels, frequency, " +
      "load_type, compression_format, file_bytes }] (AudioSource clips, sorted by file bytes desc), total_count, " +
      "truncated }, meshes: { entries:[{ path, name, vertex_count, triangle_count, instance_count, triangle_load, " +
      "reason? }] " +
      "(MeshFilter/SkinnedMeshRenderer shared meshes; instance_count = references across loaded scenes; " +
      "triangle_load = triangle_count × instance_count; sorted by triangle_load desc — the 57× wall surfaces at " +
      "the top; counted via Mesh.GetIndexCount submesh metadata so NON-READABLE meshes — imported FBX defaults " +
      "Read/Write OFF — are still counted correctly, never a false zero; when a count is unobtainable the entry " +
      "carries triangle_count: null + a reason), total_count, truncated, unreadable_count (entries with null " +
      "triangle_count — a visible blind spot, the report flags it) }, quality_settings: { level_name, shadow_distance, shadow_resolution, " +
      "shadow_cascades, msaa, vsync_count, pixel_light_count }, render_pipeline_settings: URP-only reflected " +
      "{ asset_type, shadow_distance, msaa_sample_count, render_scale, supports_hdr, main_light_shadow_resolution, " +
      "shadow_cascade_count } | null (null + render_pipeline_settings_unavailable_reason when no scriptable " +
      "pipeline is active or it is not URP — reflection-safe, never throws), build_scenes:[{ path, enabled }], " +
      "loaded_scene_count, loaded_scenes:[path] }. BOUNDED: each category is truncated to max_entries (default 50) " +
      "with total_count + truncated flags. Read-only (no AssetDatabase.Refresh, no scene mutation). Feed the output " +
      "to `loombridge mobile-audit` for advisory findings — always stamped hardware_unvalidated until a device build " +
      "proves frame rate/memory/post-processing cost.",
    inputSchema: {
      type: "object",
      properties: {
        max_entries: {
          type: "integer",
          minimum: 1,
          description:
            "Max entries returned per category (textures/audio/meshes), each sorted by its weight. Default 50. " +
            "total_count + truncated report what was cut. (alias: maxEntries)",
        },
      },
    },
  });

  ops.push({
    command: "editor.set_show_work",
    toolName: "unity_editor_set_show_work",
    description:
      "Enable or disable Loombridge Show Work Mode for demo recordings. When enabled, high-signal " +
      "bridge ops select/ping the GameObject or asset they just changed so the Unity Hierarchy, " +
      "Project window, Inspector, and Scene view visibly follow the agent's work. Disabled by default.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Whether Show Work Mode should be enabled (default true)." },
      },
    },
  });

  ops.push({
    command: "editor.show_work_pulse",
    toolName: "unity_editor_show_work_pulse",
    description:
      "Make a single important Show Work beat visible without slowing a bulk/generated editor-script build: " +
      "select/ping a GameObject, optionally frame it in Scene view, optionally expand one component, and log a " +
      "[ShowWork] note. Use for high-signal milestones such as camera, player, manager, HUD, hazards, collectibles, and end-card.",
    inputSchema: {
      type: "object",
      required: ["locator"],
      properties: {
        locator: { type: "object", description: "Locator for the GameObject to select/ping." },
        note: { type: "string", description: "Short visible note for the Console, e.g. 'Building Player'." },
        frame: { type: "boolean", description: "Whether to frame the object in Scene view (default false)." },
        component_type: { type: "string", description: "Optional component type name to expand in Inspector." },
      },
    },
  });

  ops.push({
    command: "editor.play",
    toolName: "unity_editor_play",
    description: "Enter Play Mode in the Unity Editor.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.stop",
    toolName: "unity_editor_stop",
    description: "Exit Play Mode and return to Edit Mode.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.pause",
    toolName: "unity_editor_pause",
    description: "Toggle pause in Play Mode.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.console_logs",
    toolName: "unity_editor_console_logs",
    description:
      "Get recent Unity Console log entries, NEWEST-LAST (chronological; 'count' takes the most " +
      "recent N). Optional guards, all BACKWARD-COMPATIBLE (omit for the original behavior): " +
      "'severity' (error|warning|log) or 'errors_only' filters to that level BEFORE the count cap " +
      "(so errors_only returns the last N ERRORS, not errors within the last N of any type); " +
      "'max_chars' truncates each entry's message + stackTrace to that length, stamping the entry " +
      "truncated:true + original_message_length so an over-budget blob (a single 61k-char log line " +
      "once exceeded the client token budget) is cut HONESTLY server-side. Returns " +
      "{ logs, returned } plus severity / max_chars / truncated_count when those guards are set.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of most-recent entries to return (default: 50). Applied AFTER any severity filter." },
        severity: { type: "string", enum: ["error", "warning", "log"], description: "Only return entries at this level. Contradicting errors_only is refused." },
        errors_only: { type: "boolean", description: "Shorthand for severity:'error' (only errors/exceptions/asserts)." },
        max_chars: { type: "number", description: "Truncate each entry's message and stackTrace to at most this many characters (>= 0). A truncated entry gains truncated:true + original_message_length/original_stackTrace_length so the cut is explicit. Omit for no truncation." },
      },
    },
  });

  ops.push({
    command: "editor.clear_console",
    toolName: "unity_editor_clear_console",
    description: "Clear all Unity Console log entries.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.refresh_assets",
    toolName: "unity_editor_refresh_assets",
    description: "Trigger AssetDatabase.Refresh() to detect external file changes (newly added scripts, sprites, etc.) without requiring the Unity window to receive focus. Returns compile/update state so caller can decide whether to wait_for.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.execute_menu_item",
    toolName: "unity_editor_execute_menu_item",
    description:
      "Run an Editor menu item by path via EditorApplication.ExecuteMenuItem — the re-runnable " +
      "Editor-builder-script pattern (a [MenuItem] that regenerates a blockout / runs a project tool), " +
      "without the ops.batch round-trip fragility. SECURITY: STRICTLY gated by the project-configurable " +
      "allowlist; menu items have NO built-in default, so a path must be opted in via menuItems[] in the " +
      "project's .loombridge/editor-allowlist.json or the call is REFUSED (INVALID_PARAMS) — never invoked. " +
      "Returns { menuPath, executed }: executed=false means the gate passed but Unity found no enabled " +
      "menu item at that path (wrong path, or disabled by its validate function) — distinct from a refusal. " +
      "LONG BUILDS: this op runs SYNCHRONOUSLY and defaults to the generic 10s wire timeout, but a menu " +
      "item that triggers a PLAYER BUILD (a [MenuItem] wrapping BuildPipeline.BuildPlayer — iOS/Android/" +
      "standalone) takes MINUTES and will otherwise time out mid-build (GRL-C26: three such timeouts in one " +
      "session). RAISE timeoutMs per call for those, e.g. { \"menuPath\": \"MyGame/Build iOS\", " +
      "\"timeoutMs\": 600000 }.",
    inputSchema: {
      type: "object",
      properties: {
        menuPath: { type: "string", description: "Menu item path to execute (e.g. 'Tools/MyGame/Generate Blockout'); must be listed in menuItems[] of .loombridge/editor-allowlist.json." },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 10000). A menu item that triggers a PLAYER BUILD (BuildPipeline.BuildPlayer) runs for minutes — raise this well above the default (e.g. 600000 for a full iOS/Android/standalone build) or the call times out mid-build." },
      },
      required: ["menuPath"],
    },
  });

  ops.push({
    command: "editor.begin_undo_group",
    toolName: "unity_editor_begin_undo_group",
    description: "Begin a named undo group. All subsequent operations will be grouped under this name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the undo group" },
      },
    },
  });

  ops.push({
    command: "editor.end_undo_group",
    toolName: "unity_editor_end_undo_group",
    description: "End and collapse the current undo group.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "editor.wait_for",
    toolName: "unity_editor_wait_for",
    description:
      "Wait for editor conditions to be met: compilation complete, not updating, specific play mode, frame countdown, or delay window. Deterministic wait for input automation (for example { frames: 8 } after key_tap). Never use sleep. " +
      "RETURNS { waited_ms } and — WHEN a compilation FINISHED at or after this wait started — a compileResult: " +
      "{ compileId, finishedAtMs, succeeded, errorCount, errors: [{ file, line, column, message }] }. This is the AUTHORITATIVE compiler-error report (a flat errors[] aggregated across assemblies; each error's file locates its assembly): after a script change, chain unity_editor_wait_for { compiling: false } and read compileResult.succeeded / compileResult.errors[] instead of scraping Editor.log or grepping compiled DLLs (`strings *.dll | grep` sentinels are brittle and stale). " +
      "Attribution rule: compileResult is attached ONLY when the latest compilation finished at/after this wait's start (finishedAtMs >= waitStart), so an earlier stale compile is never reported as this wait's result; when no compilation occurred in the wait window, compileResult is omitted entirely (its absence means 'no compile happened here', not 'compile succeeded'). " +
      "PLAY-MODE DEFERRAL (INFORMATIONAL): a { compiling: false } wait that completes IN PLAY MODE without an attributed compile carries compileDeferred:true + compileDeferredMessage. This fires on ANY such wait — including the innocent play-mode settle where nothing was edited, which is the NORMAL outcome — because Unity exposes no cheap pending-recompile flag, so pending script edits cannot be detected. Read it conditionally: IF you edited scripts during Play Mode, Unity defers their compilation until Play Mode stops, so this wait CANNOT confirm those edits compiled (after you eventually exit Play Mode, wait for { compiling: false } again and read compileResult); if you did not edit scripts, ignore the hint. It is NOT an instruction to stop Play Mode.",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        compiling: { type: "boolean", description: "Wait until compiling matches this value" },
        updating: { type: "boolean", description: "Wait until updating matches this value" },
        playMode: { type: "string", enum: ["playing", "paused", "stopped"], description: "Wait until play mode matches" },
        frames: { type: "number", description: "Wait this many editor frames before completion checks" },
        delayMs: { type: "number", description: "Wait at least this many milliseconds before completion checks" },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds" },
      },
    },
  });

  ops.push({
    command: "editor.tick",
    toolName: "unity_editor_tick",
    description:
      "Deterministically ADVANCE the running simulation by a number of frames or a duration, with " +
      "NO screenshot/sampling overhead (unlike runtime.measure_motion) — RCL-T09. Forces " +
      "Application.runInBackground=true so the player loop ticks while the editor is unfocused " +
      "(the headless/background norm), optionally pins Time.captureDeltaTime (captureFps) so each " +
      "tick is a fixed game-time step, steps the player loop, then restores both. Use to let game " +
      "logic settle after wiring or input WITHOUT a sleep and WITHOUT needing editor.focus_game_view. " +
      "Requires Play Mode (a stopped editor does not run game Update) — returns PLAY_MODE_REQUIRED " +
      "otherwise. Provide EXACTLY ONE of 'frames' or 'durationMs'. Returns { advancedFrames, advancedMs }.",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        frames: { type: "integer", minimum: 1, description: "Number of player-loop frames to advance. Provide this OR durationMs." },
        durationMs: { type: "number", minimum: 1, description: "Game-time milliseconds to advance. Provide this OR frames." },
        captureFps: {
          type: "integer",
          minimum: 0,
          description: "Pin Time.captureDeltaTime to 1/captureFps for a fixed game-time step per tick (default 60). 0 disables pinning (live rate).",
        },
      },
    },
  });

  // ───── input ─────

  ops.push({
    command: "input.get_capabilities",
    toolName: "unity_input_get_capabilities",
    description: "Get deterministic input capability status (supported/unsupported + reason), backend availability, focus status, play mode requirement, and limitations.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "input.begin_session",
    toolName: "unity_input_begin_session",
    description: withInputCapabilityGateNote(
      "Begin an input automation session. Selects the first available backend unless one is explicitly requested.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        backend: { type: "string", enum: ["InputSystem", "EditorEvent"], description: "Optional explicit backend preference" },
        sessionId: { type: "string", description: "Optional deterministic session identifier" },
        allowEditMode: { type: "boolean", description: "Allow input while not in Play Mode (default: false)" },
      },
    },
  });

  ops.push({
    command: "input.key_down",
    toolName: "unity_input_key_down",
    description: withInputCapabilityGateNote(
      "Press and hold a key in the active input session.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unity KeyCode name (for example Space, LeftArrow, A)" },
      },
      required: ["key"],
    },
  });

  ops.push({
    command: "input.key_up",
    toolName: "unity_input_key_up",
    description: withInputCapabilityGateNote(
      "Release a held key in the active input session.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unity KeyCode name (for example Space, LeftArrow, A)" },
      },
      required: ["key"],
    },
  });

  ops.push({
    command: "input.key_tap",
    toolName: "unity_input_key_tap",
    description: withInputCapabilityGateNote(
      "Tap a key (key_down + key_up) in the active input session.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unity KeyCode name (for example Space, LeftArrow, A)" },
      },
      required: ["key"],
    },
  });

  ops.push({
    command: "input.click_ui",
    toolName: "unity_input_click_ui",
    description: withInputCapabilityGateNote(
      "Dispatch a UI click through the active input backend.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Mouse X coordinate relative to Game View" },
        y: { type: "number", description: "Mouse Y coordinate relative to Game View" },
        button: { type: "number", description: "Mouse button index (default: 0)" },
      },
    },
  });

  ops.push({
    command: "input.observe_start",
    toolName: "unity_input_observe_start",
    description:
      "Begin OBSERVING the developer's real left-clicks during manual Play (the observe-a-human-session " +
      "recorder). Unlike the input-driving ops, this does not inject input and needs no input session — it " +
      "reads legacy UnityEngine.Input + the uGUI EventSystem in the game's Update loop. Requires Play Mode. " +
      "Pair with input.observe_stop to collect the recorded clicks (each resolved to a locator).",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "input.pointer_tap",
    toolName: "unity_input_pointer_tap",
    description:
      "Tap a SIMULATED Input System pointer (left button, press→release) at a Game-View screen point " +
      "(x, y in pixels, origin BOTTOM-LEFT — matching Camera.WorldToScreenPoint / get_screen_rects). Drives " +
      "NON-uGUI / world-space targets a game resolves from `Pointer.current` (e.g. a Physics2D.OverlapPoint " +
      "sprite hit) — what the EventSystem dispatch can't reach. Requires Play Mode + the Input System " +
      "(ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a legacy-only project. Editor should be focused.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Screen X in Game-View pixels (origin bottom-left)." },
        y: { type: "number", description: "Screen Y in Game-View pixels (origin bottom-left)." },
        button: { type: "number", description: "Reserved; only the left button (0) is simulated in v1." },
      },
      required: ["x", "y"],
    },
  });

  ops.push({
    command: "input.pointer_tap_world",
    toolName: "unity_input_pointer_tap_world",
    description:
      "Tap a SIMULATED Input System pointer at a WORLD coordinate. Projects {x,y,z?} through Camera.main " +
      "(or an explicit camera locator) to Game-View screen pixels, then uses the same pointer path as " +
      "input.pointer_tap. Drives NON-uGUI / world-space targets a game resolves from `Pointer.current`. " +
      "Requires Play Mode + the Input System (ENABLE_INPUT_SYSTEM); errors INPUT_BACKEND_UNAVAILABLE on a " +
      "legacy-only project. Refuses if the world point cannot project into the camera pixel rect.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "World X coordinate." },
        y: { type: "number", description: "World Y coordinate." },
        z: { type: "number", description: "World Z coordinate (default 0)." },
        camera: { ...locatorSchema, description: "Optional Camera locator. Defaults to Camera.main." },
        button: { type: "number", description: "Reserved; only the left button (0) is simulated in v1." },
      },
      required: ["x", "y"],
    },
  });

  ops.push({
    command: "input.observe_stop",
    toolName: "unity_input_observe_stop",
    description:
      "Stop observing and return { clicks: [{ tMs, locator, button }], keyEdges: [{ key, edge, tMs }], observed, droppedNoTarget }, each click resolved to a " +
      "locator. `observed:false` means the recorder was not live at stop (never started, or Play Mode was " +
      "restarted after observe_start) — an empty clicks then is 'observation died', NOT 'clicked nothing', so " +
      "refuse it. MUST be called while Play Mode is still active (runtime objects are destroyed on stop). " +
      "Feed the clicks to the replay recorder to mint a trace.",
    inputSchema: { type: "object", properties: {} },
  });

  ops.push({
    command: "input.end_session",
    toolName: "unity_input_end_session",
    description: "End the active input session and release pressed keys.",
    inputSchema: { type: "object", properties: {} },
  });

  // ───── runtime ─────

  ops.push({
    command: "runtime.get_snapshot",
    toolName: "unity_runtime_get_snapshot",
    description: "Get a generic runtime snapshot for a scene object: identity, active flags, transform values, and optional component property values.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        components: { type: "array", items: { type: "string" }, description: "Optional component type filters (name or full type name)" },
        include_paths: { type: "array", items: { type: "string" }, description: "Optional serialized property paths to include per selected component" },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "runtime.assert_condition",
    toolName: "unity_runtime_assert_condition",
    description: "Evaluate a comparator against runtime state and return a deterministic pass/fail result.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        component: { type: "string", description: "Optional component type name when asserting component properties" },
        property_path: { type: "string", description: "Runtime property path (or component property path when component is set)" },
        operator: { type: "string", enum: ["equals", "not_equals", "greater_than", "less_than", "approx", "contains"] },
        expected: {
          type: ["string", "object", "number", "boolean", "null"],
          description: "Expected value for comparison (preserves JSON shape; do not pre-stringify).",
        },
        tolerance: { type: "number", description: "Tolerance used by operator=approx (default: 0.001)" },
      },
      required: ["locator", "property_path", "operator", "expected"],
    },
  });

  ops.push({
    command: "runtime.wait_for_condition",
    toolName: "unity_runtime_wait_for_condition",
    description: "Wait deterministically until a runtime condition passes or timeout is reached. Supports comparator semantics with frames/delay/timeout controls.",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        component: { type: "string", description: "Optional component type name when asserting component properties" },
        property_path: { type: "string", description: "Runtime property path (or component property path when component is set)" },
        operator: { type: "string", enum: ["equals", "not_equals", "greater_than", "less_than", "approx", "contains"] },
        expected: {
          type: ["string", "object", "number", "boolean", "null"],
          description: "Expected value for comparison (preserves JSON shape; do not pre-stringify).",
        },
        tolerance: { type: "number", description: "Tolerance used by operator=approx (default: 0.001)" },
        compiling: { type: "boolean", description: "Optional editor compiling predicate while polling" },
        updating: { type: "boolean", description: "Optional editor updating predicate while polling" },
        playMode: { type: "string", enum: ["playing", "paused", "stopped"], description: "Optional play mode predicate while polling" },
        frames: { type: "number", description: "Wait this many editor frames before polling completion" },
        delayMs: { type: "number", description: "Wait at least this many milliseconds before polling completion" },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds" },
      },
      required: ["locator", "property_path", "operator", "expected"],
    },
  });

  ops.push({
    command: "runtime.measure_motion",
    toolName: "unity_runtime_measure_motion",
    description: "Measure a GameObject's motion over a game-time window during Play Mode and return game-feel metrics: peakY/deltaY (jump apex height), timeToApexMs, deltaX/avgRunSpeed (run speed), plus minY/durationMs/sampleCount. Sampling is keyed off GAME TIME (not editor frame count) so it is robust to editor frame-rate swings. captureFps pins Time.captureDeltaTime during sampling for deterministic, high-resolution, focus-independent capture. Generic primitive — issue input (e.g. hold RightArrow, or set the jump just before) so the window captures the resulting motion. Requires Play Mode (and an active input session for input-driven motion). Set includeSamples=true to also return the raw trajectory (samples[]: tMs/x/y/z relative to start; z is present once the bridge emits a 3D trajectory) plus projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance, so feel metrics can be re-derived from the raw samples (verify-first re-derivation). measure_motion observes the project's real physics rate (never pins Time.fixedDeltaTime), so the two timestep fields are equal. PERF (RCL-T07): a measure's wall-clock cost is ~ (durationMs/1000 * captureFps) editor ticks at the backgrounded editor's slow rate (the ~10s/call overhead the dogfood saw); set fastForward=true to pump the player loop and finish the SAME game-time window in less wall-clock (best-effort ITERATION speed-up — samples stay honest/re-derivable, but the sampling cadence and thus derived peakY/timeToApexMs may differ from a non-fastForward run, so do NOT use it for a gate-bound feel capture). The op stays in Play Mode, so also AMORTIZE by issuing several measure windows back-to-back in one play session instead of re-entering play per measure.",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        durationMs: { type: "number", description: "Game-time window to sample, in milliseconds (default 1200). A full jump arc fits in ~800-1200ms." },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps during sampling for deterministic high-res capture (default 120). Set 0 to disable pinning and sample at the live frame rate." },
        includeSamples: { type: "boolean", description: "Also return the raw trajectory (samples[]: {tMs,x,y} relative to start) + projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance, for offline re-derivation of feel metrics. Default false." },
        fastForward: { type: "boolean", description: "RCL-T07: pump the player loop (QueuePlayerLoopUpdate) each tick so the same game-time window finishes in less wall-clock. Best-effort ITERATION speed-up — the returned samples stay honest and re-derivable, but pumping an extra tick can coarsen/shift the sampling cadence so the DERIVED feel values may differ from a non-fastForward run; do NOT use it for a gate-bound feel capture. Default false. The response echoes fastForward." },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "runtime.probe",
    toolName: "unity_runtime_probe",
    description:
      "Deterministically drive one component property/field through a sequence of timed phases " +
      "WHILE sampling a target object's transform position — all inside a single focus-independent " +
      "loop (forces runInBackground + pins Time.captureDeltaTime). Use to measure TRANSIENT game-feel " +
      "reproducibly (camera follow on stop, recoil, knockback, dash): driving input across separate " +
      "MCP calls is unreliable because the editor ticks the sim during inter-call gaps. Game-agnostic — " +
      "'driver' and 'measure' are any objects. Two forms: SINGLE-driver — a top-level 'driver' plus " +
      "phases[].value (one property over the phases); or MULTI-driver — each phase supplies its own " +
      "phases[].drivers[] (set SEVERAL properties simultaneously at a phase boundary, e.g. run + jump). " +
      "Both forms share one sampling loop and are back-compatible. Returns per-phase startX/endX/deltaX, " +
      "minX/maxX (overshoot), Y equivalents, and durationMs; optionally the full trajectory. Requires Play Mode.",
    isAsync: true,
    defaultTimeoutMs: 60000,
    inputSchema: {
      type: "object",
      properties: {
        measure: { ...locatorSchema, description: "Locator of the object whose transform.position is sampled (e.g. the camera)." },
        driver: {
          type: "object",
          description: "SINGLE-driver form: the property/field set at each phase boundary via phases[].value. Optional when each phase supplies its own phases[].drivers[].",
          properties: {
            locator: locatorSchema,
            type_name: { type: "string", description: "Component type name (e.g. PlayerController)." },
            property_path: { type: "string", description: "Public property or field name to set (e.g. forceHorizontal)." },
          },
          required: ["locator", "type_name", "property_path"],
        },
        phases: {
          type: "array",
          description: "Ordered phases. Single-driver: each is { value, durationMs }. Multi-driver: each is { durationMs, drivers:[{locator,type_name,property_path,value}] } — all drivers set simultaneously at the boundary (e.g. simultaneous run + jump).",
          items: {
            type: "object",
            properties: {
              value: { type: ["number", "boolean"], description: "Single-driver: value to set on the top-level driver this phase." },
              durationMs: { type: "number", description: "Game-time duration of this phase in ms." },
              drivers: {
                type: "array",
                description: "Multi-driver: properties to set simultaneously at this phase boundary. When present, overrides the single-driver value for this phase.",
                items: {
                  type: "object",
                  properties: {
                    locator: locatorSchema,
                    type_name: { type: "string", description: "Component type name (e.g. PlayerController)." },
                    property_path: { type: "string", description: "Public property or field name to set." },
                    value: { type: ["number", "boolean"], description: "Value to set on this driver for this phase." },
                  },
                  required: ["locator", "type_name", "property_path", "value"],
                },
              },
            },
            required: ["durationMs"],
          },
        },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps (default 120). 0 disables pinning." },
        includeSamples: { type: "boolean", description: "Return the full per-tick trajectory (tMs/x/y/phase). Default false." },
        resetDriversOnEnd: { type: "boolean", description: "Zero every driven force*/value field when the probe ends so a left-set driver does not keep moving the object during the inter-call gap (default: true). Set false to leave the last value applied." },
      },
      required: ["measure", "phases"],
    },
  });

  ops.push({
    command: "runtime.capture_sequence",
    toolName: "unity_runtime_capture_sequence",
    description:
      "Single-shot deterministic runtime capture for verification. Drives phased component inputs like unity_runtime_probe, " +
      "samples the measured object's motion, and captures named Game-view frames inside the same pinned simulation loop " +
      "(start/end/atMs/apexY triggers). Use this instead of probe-then-screenshot when verifying jump/dash/camera/artifact states; " +
      "it avoids extra MCP turns and screenshot timing races. Requires Play Mode.",
    isAsync: true,
    defaultTimeoutMs: 90000,
    inputSchema: {
      type: "object",
      properties: {
        measure: { ...locatorSchema, description: "Locator of the object whose transform.position is sampled and used for apexY capture." },
        driver: {
          type: "object",
          description: "SINGLE-driver form: the property/field set at each phase boundary via phases[].value. Optional when phases supply drivers[].",
          properties: {
            locator: locatorSchema,
            type_name: { type: "string", description: "Component type name (e.g. PlayerController)." },
            property_path: { type: "string", description: "Public property or field name to set." },
          },
          required: ["locator", "type_name", "property_path"],
        },
        phases: {
          type: "array",
          description: "Ordered runtime phases. Same shape as unity_runtime_probe phases.",
          items: {
            type: "object",
            properties: {
              value: { type: ["number", "boolean"], description: "Single-driver value for this phase." },
              durationMs: { type: "number", description: "Game-time duration of this phase in ms." },
              drivers: {
                type: "array",
                description: "Multi-driver values applied simultaneously at phase start.",
                items: {
                  type: "object",
                  properties: {
                    locator: locatorSchema,
                    type_name: { type: "string", description: "Component type name." },
                    property_path: { type: "string", description: "Public property or field name." },
                    value: { type: ["number", "boolean"], description: "Value to set." },
                  },
                  required: ["locator", "type_name", "property_path", "value"],
                },
              },
            },
            required: ["durationMs"],
          },
        },
        captures: {
          type: "array",
          description: "Named screenshots to capture inside the runtime loop.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Frame id, e.g. spawn, jump-apex, dash-mid, win." },
              trigger: { type: "string", enum: ["start", "end", "atMs", "apexY"], description: "When to capture. Default is start, or atMs when atMs is supplied." },
              atMs: { type: "number", description: "Capture on the first tick at/after this elapsed game-time ms." },
              view: { type: "string", enum: ["scene", "game"], description: "Editor view to capture (default: game)." },
              maxWidth: { type: "number", description: "Maximum width in pixels (default: 1024)." },
              format: { type: "string", enum: ["jpeg", "png"], description: "Image format (default: png)." },
              quality: { type: "number", description: "JPEG quality 1-100 (default: 75)." },
            },
            required: ["id"],
          },
        },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps (default 120). 0 disables pinning." },
        includeSamples: { type: "boolean", description: "Return full per-tick trajectory. Default false." },
        resetDriversOnEnd: { type: "boolean", description: "Zero every driven force*/value field at the end (default true)." },
      },
      required: ["measure", "phases", "captures"],
    },
  });

  ops.push({
    command: "runtime.capture_input_motion",
    toolName: "unity_runtime_capture_input_motion",
    description:
      "Capture an INPUT-DRIVEN trajectory (run, jump, ...) in ONE call by injecting the declared keys INSIDE the sampling loop. " +
      "Use this instead of a separate input.key_down then runtime.measure_motion: those are two MCP calls with a ~150-250ms latency gap, " +
      "during which a fast controller can traverse the whole runway and be walled before the measure window even opens (every run window reads deltaX=0). " +
      "Here the keys are driven from sample t=0 on the same ticks that sample the target, so there is no key_down->measure gap. " +
      "Pass 'phases' as an ordered list of { keys:[KeyCode names], durationMs } or { keys, fixedTicks } (empty keys = a settle phase with no keys held); each phase's keys " +
      "are diffed tick-to-tick and only the changes are injected (idempotent). captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the " +
      "game loop runs at its live rate and injected input reaches the controller; set captureFps>0 to pin the timestep like measure_motion (still injecting in-loop). " +
      "Requires Play Mode and an active input session (input.begin_session) — keys are driven through the same input pipeline as the input.* ops (Game-view focus + virtual-only injection apply). " +
      "All held keys are released when the capture ends. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, " +
      "samples[]:{tMs,x,y,z}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance) plus a per-phase breakdown (index/keys/requestedDurationMs/sampleCount/startX/endX/deltaX/startY/endY/deltaY/minY/maxY). " +
      "When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit).",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        measure: { ...locatorSchema, description: "Locator of the object whose transform.position is sampled (e.g. the player)." },
        phases: {
          type: "array",
          description: "Ordered timed input phases. Each is { keys:[KeyCode names], durationMs } or { keys, fixedTicks }. Empty keys = a settle phase (no keys held). fixedTicks is converted by the bridge using the live project Time.fixedDeltaTime, for stimulus-sensitive recipes such as canonical short-hop.",
          items: {
            type: "object",
            properties: {
              keys: {
                type: "array",
                description: "KeyCode names held during this phase (e.g. ['RightArrow'], ['RightArrow','Space'], or [] for a settle phase). Resolved via Unity KeyCode names (Space, LeftArrow, RightArrow, A, ...).",
                items: { type: "string" },
              },
              durationMs: { type: "number", description: "Game-time duration of this phase in ms (> 0). Mutually exclusive with fixedTicks." },
              fixedTicks: { type: "integer", description: "Game-time duration in project fixed physics ticks (> 0), converted using Time.fixedDeltaTime. Mutually exclusive with durationMs." },
            },
            oneOf: [
              { required: ["durationMs"] },
              { required: ["fixedTicks"] },
            ],
          },
        },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = do NOT pin; sample at the live frame rate so injected input runs normally). Set >0 for deterministic pinned capture (still injects in-loop)." },
        includeSamples: { type: "boolean", description: "Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true." },
        sampledFields: {
          type: "array",
          description:
            "L3a: optional per-tick runtime-member sampling. Each entry samples a NON-transform runtime signal " +
            "(e.g. AudioSource.isPlaying for a jump SFX, ParticleSystem.particleCount/isEmitting for landing dust) " +
            "on the SAME tick clock as the position samples, so cross-modal sync (input->SFX, contact->dust, input->anim-state) can be derived. " +
            "Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('jumping')) — " +
            "on the live component (NOT serialized fields); only JSON-scalar " +
            "members are supported (bool, integer, float, enum->underlying number). A field that cannot be resolved (no GameObject / " +
            "no component / no such member or method / non-scalar member) is reported in fieldTimeline with an 'unresolved' reason and is never " +
            "sampled (honest-or-omit — never a fabricated 0/false). Adds a fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] to the response; " +
            "existing callers that omit sampledFields see an unchanged response (no fieldTimeline).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Caller id echoed back in fieldTimeline (e.g. 'jump-sfx', 'land-dust', 'anim-jumping'). Defaults to property_path or method_name if omitted." },
              locator: locatorSchema,
              type_name: { type: "string", description: "Component type name owning the member (e.g. AudioSource, ParticleSystem, Animator, or a custom MonoBehaviour). The FIRST matching component on the GameObject is used (GetComponent) — disambiguate by targeting a child if a GameObject has several." },
              property_path: { type: "string", description: "Public instance property or field name to read each tick (e.g. isPlaying, particleCount). Must be a JSON scalar (bool/integer/float/enum). Supply EITHER property_path OR method_name+args." },
              method_name: { type: "string", description: "L3a.1: read a scalar-returning public method each tick instead of a field — for signals with no readable field, e.g. a Unity Animator parameter ('Animator' + method_name 'GetBool' + args ['jumping']). MUST be a pure read-only getter: it is invoked EVERY tick, so a side-effecting method would corrupt the capture (the void/non-scalar-return guard only rejects obvious mutators like SetBool). Overload resolution is by arg count + JSON-token kind; if more than one overload binds the same args the spec is refused as ambiguous. Supply EITHER property_path OR method_name+args (supplying both is refused)." },
              args: { type: "array", description: "Literal arguments for method_name, bound once at capture start (e.g. ['jumping'] for Animator.GetBool). Matched to the parameter by JSON kind: string→string, bool→bool, integer→integral/float/enum, float→float. Omit/empty for a zero-arg method." },
            },
            required: ["id", "locator", "type_name"],
          },
        },
      },
      required: ["measure", "phases"],
    },
  });

  ops.push({
    command: "runtime.capture_pointer_motion",
    toolName: "unity_runtime_capture_pointer_motion",
    description:
      "Capture a POINTER-DRIVEN trajectory (a launch-aligned jump arc, ...) in ONE call by dispatching a pointer tap INSIDE the sampling loop. " +
      "Use target:{locator} for games driven by on-screen uGUI buttons, or world:{x,y,z?,camera?} for Input-System world-space pointer reads. This is the pointer analog of runtime.capture_input_motion. " +
      "Instead of firing an async runtime.measure_motion and a separate ui.dispatch_pointer (two MCP calls with a ~450ms WS round-trip gap between the tap and sample-0, which made timeToApex measured from the first sample wrong and forced trimming the launch by hand), " +
      "this samples a baseline for 'settleMs', then dispatches the tap on a tick, latches the dispatch elapsedMs, and keeps sampling for 'captureMs'. The capture is therefore launch-aligned. " +
      "captureFps defaults to 0 — Time.captureDeltaTime is NOT pinned, so the EventSystem + game run at their live rate and the tap is processed; set captureFps>0 to pin the timestep like measure_motion (still dispatching in-loop). " +
      "Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/timeToApexMs/deltaX/avgRunSpeed/minY/durationMs/sampleCount, samples[]:{tMs,x,y}, and projectFixedTimestepBeforeMeasurement/measurementFixedTimestep provenance — deltaY is the true jumpApex since 'settleMs' established the ground baseline) PLUS " +
      "pointerDispatchMs (the elapsedMs the FIRST tap fired, the launch reference; null if never dispatched), timeToApexFromDispatchMs (apex elapsedMs minus pointerDispatchMs — the launch-aligned timeToApex; null if not dispatched or no rise), taps:[{ atMs, dispatchedMs, actuated, raycastHit, handlersFired, world?, screen?, camera?, mode? }] (per scheduled tap — see the 'taps' param for multi-tap), and dispatch:{...} = the first tap's outcome. " +
      "Honest: uGUI target taps report actuation from EventSystem handlers; world Input-System taps report dispatch/projection only (actuated:null), so callers must require motion or another response signal before grading. " +
      "When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] recording each declared NON-transform runtime member on the same tick clock as the position samples (unresolvable fields carry an 'unresolved' reason and are never sampled — honest-or-omit).",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        measure: { ...locatorSchema, description: "Locator of the object whose transform.position is sampled (e.g. the player)." },
        target: { ...locatorSchema, description: "Locator of the uGUI element to tap (e.g. /ControllesMobiles/ButtonJump). Tapped via EventSystemPointerDispatch.Click at its rect center. Mutually exclusive with world." },
        world: {
          type: "object",
          description:
            "Input-System world-space pointer tap. Projects {x,y,z?} through Camera.main or world.camera to Game-View screen pixels, then dispatches the simulated pointer in-loop. Mutually exclusive with target.",
          properties: {
            x: { type: "number", description: "World X coordinate." },
            y: { type: "number", description: "World Y coordinate." },
            z: { type: "number", description: "World Z coordinate (default 0)." },
            camera: { ...locatorSchema, description: "Optional Camera locator. Defaults to Camera.main." },
          },
          required: ["x", "y"],
        },
        settleMs: { type: "number", description: "Baseline sampling window before the tap, establishing the ground reference (>= 0, default 300). The (single) tap is dispatched on the first tick at/after settleMs. Ignored when 'taps' is supplied." },
        captureMs: { type: "number", description: "Sampling window after the LAST tap (the arc), in ms (> 0, default 1000). Capture finishes at (last tap atMs) + captureMs." },
        taps: {
          type: "array",
          description:
            "Optional MULTI-TAP schedule: an ASCENDING array of { atMs } (elapsedMs from capture start). Each tap is dispatched on 'target' IN-LOOP at its scheduled time, so a multi-tap mechanism — e.g. a double-jump = a 2nd tap while AIRBORNE — is driven with precise, loop-controlled timing rather than the jitter of separate MCP calls (which made the harness land the 2nd tap after touchdown). Supersedes 'settleMs' (the first tap's atMs IS the settle). Each tap's outcome is returned in the response 'taps[]': { atMs, dispatchedMs, actuated, raycastHit, handlersFired }. Omit for the default single tap at settleMs.",
          items: {
            type: "object",
            properties: {
              atMs: { type: "number", description: "Elapsed ms from capture start to dispatch this tap (>= 0; ascending across the array)." },
            },
            required: ["atMs"],
          },
        },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = do NOT pin; sample at the live frame rate so the EventSystem + dispatched tap run normally). Set >0 for deterministic pinned capture (still dispatches in-loop)." },
        includeSamples: { type: "boolean", description: "Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true." },
        sampledFields: {
          type: "array",
          description:
            "L3a: optional per-tick runtime-member sampling. Each entry samples a NON-transform runtime signal " +
            "(e.g. AudioSource.isPlaying for a jump SFX, ParticleSystem.particleCount/isEmitting for landing dust) " +
            "on the SAME tick clock as the position samples, so cross-modal sync (tap->SFX, contact->dust, tap->anim-state) can be derived. " +
            "Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('jumping')) — " +
            "on the live component (NOT serialized fields); only JSON-scalar " +
            "members are supported (bool, integer, float, enum->underlying number). A field that cannot be resolved (no GameObject / " +
            "no component / no such member or method / non-scalar member) is reported in fieldTimeline with an 'unresolved' reason and is never " +
            "sampled (honest-or-omit — never a fabricated 0/false). Adds a fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] to the response; " +
            "existing callers that omit sampledFields see an unchanged response (no fieldTimeline).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Caller id echoed back in fieldTimeline (e.g. 'jump-sfx', 'land-dust', 'anim-jumping'). Defaults to property_path or method_name if omitted." },
              locator: locatorSchema,
              type_name: { type: "string", description: "Component type name owning the member (e.g. AudioSource, ParticleSystem, Animator, or a custom MonoBehaviour). The FIRST matching component on the GameObject is used (GetComponent) — disambiguate by targeting a child if a GameObject has several." },
              property_path: { type: "string", description: "Public instance property or field name to read each tick (e.g. isPlaying, particleCount). Must be a JSON scalar (bool/integer/float/enum). Supply EITHER property_path OR method_name+args." },
              method_name: { type: "string", description: "L3a.1: read a scalar-returning public method each tick instead of a field — for signals with no readable field, e.g. a Unity Animator parameter ('Animator' + method_name 'GetBool' + args ['jumping']). MUST be a pure read-only getter: it is invoked EVERY tick, so a side-effecting method would corrupt the capture (the void/non-scalar-return guard only rejects obvious mutators like SetBool). Overload resolution is by arg count + JSON-token kind; if more than one overload binds the same args the spec is refused as ambiguous. Supply EITHER property_path OR method_name+args (supplying both is refused)." },
              args: { type: "array", description: "Literal arguments for method_name, bound once at capture start (e.g. ['jumping'] for Animator.GetBool). Matched to the parameter by JSON kind: string→string, bool→bool, integer→integral/float/enum, float→float. Omit/empty for a zero-arg method." },
            },
            required: ["id", "locator", "type_name"],
          },
        },
      },
      required: ["measure"],
    },
  });

  ops.push({
    command: "runtime.capture_pointer_hold_motion",
    toolName: "unity_runtime_capture_pointer_hold_motion",
    description:
      "Capture motion while a uGUI control is driven by a SUSTAINED pointer hold. With 'dragTo', this is the joystick-hold analog of capture_pointer_motion's tap; without 'dragTo', it is a button press/hold/release. " +
      "Use drag mode for games whose locomotion is driven by an on-screen JOYSTICK (legacy-Input mobile titles, e.g. a Fixed Joystick → run speed) where a single tap can't elicit continuous movement. " +
      "It samples a baseline for 'settleMs', then ONCE presses 'target' and optionally drags to 'dragTo' ({dx,dy} screen px from the target center — a magnitude past the joystick radius clamps to FULL deflection), HOLDS, and at 'releaseMs'/'releaseFixedTicks' (or the window end) RELEASES the pointer. " +
      "The bridge captures the trajectory; the caller derives runSpeed/accel/decel from samples[] (deterministic-CLI-vs-bridge split — same as the keyed capture_input_motion run metrics). captureFps defaults to 0 (live rate so the EventSystem + game run normally); set >0 to pin the timestep. " +
      "Requires Play Mode. Returns the SAME shape as measure_motion (peakY/deltaY/deltaX/avgRunSpeed/durationMs/sampleCount, samples[]:{tMs,x,y}, timestep provenance) PLUS holdDispatchMs (the elapsedMs the hold began; null if never dispatched), releaseMs (the elapsedMs the pointer released; null if held to the window end), optional requestedFixedTicks/actualFixedTicks for fixed-tick release, and dispatch:{ actuated, raycastHit, handlersFired }. In drag mode actuated=true means 'drag' fired; in button mode actuated=true means pointerDown and pointerUp fired. " +
      "Honest: if the hold does not actuate, the flat capture is STILL returned with dispatch.actuated:false so the caller sees WHY there was no motion (not an error). " +
      "When 'sampledFields' is supplied (L3a), also returns fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }] on the same tick clock as the position samples (honest-or-omit; unresolvable fields carry a reason and are never sampled).",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        measure: { ...locatorSchema, description: "Locator of the object whose transform.position is sampled (e.g. the player)." },
        target: { ...locatorSchema, description: "Locator of the uGUI control to hold (e.g. /ControllesMobiles/ButtonJump or /ControllesMobiles/Fixed Joystick). Pressed from its rect center." },
        dragTo: {
          type: "object",
          description: "Optional held deflection as a screen-pixel offset from the target center. Omit for button hold/release. When present, at least one of dx/dy must be non-zero. For a horizontal run, set dx (e.g. { dx: 200 } for full right, { dx: -200 } for left); a magnitude beyond the joystick radius clamps to full deflection.",
          properties: {
            dx: { type: "number", description: "Horizontal offset in screen pixels (+right / -left)." },
            dy: { type: "number", description: "Vertical offset in screen pixels (+up / -down)." },
          },
        },
        settleMs: { type: "number", description: "Baseline sampling window before the hold begins (>= 0, default 300). The press/hold is dispatched on the first tick at/after settleMs." },
        captureMs: { type: "number", description: "Sampling window after settleMs, in ms (> 0, default 1500). Capture finishes at settleMs + captureMs." },
        releaseMs: { type: "number", description: "Optional: release the hold this many ms AFTER the hold begins, then keep sampling to the window end so deceleration or jump response is captured. Must be > 0 and <= captureMs. Omit to hold for the whole window (released at the end)." },
        releaseFixedTicks: { type: "integer", minimum: 1, description: "Optional: release this many project fixed physics ticks after the hold begins. Must be positive. Mutually exclusive with releaseMs. Emits requestedFixedTicks/actualFixedTicks for stimulus-sensitive metrics such as shortHopApex." },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps during sampling (default 0 = live rate so the EventSystem + dragged control run normally). Set >0 for deterministic pinned capture." },
        includeSamples: { type: "boolean", description: "Return the raw trajectory (samples[]: {tMs,x,y} relative to start) + timestep provenance, for offline re-derivation. Default true." },
        sampledFields: {
          type: "array",
          description:
            "L3a: optional per-tick runtime-member sampling on the SAME tick clock as the position samples (e.g. a run-loop SFX or dust), so cross-modal sync can be derived. " +
            "Read via a reflected public property/field getter — OR a scalar-returning method getter (method_name+args, e.g. Animator.GetBool('moving')) — on the live component (NOT serialized fields); only JSON-scalar members are supported. " +
            "A field that cannot be resolved (no GameObject / no component / no such member or method / non-scalar member) is reported with an 'unresolved' reason and is never sampled (honest-or-omit — never a fabricated 0/false). " +
            "Adds fieldTimeline:[{ id, samples:[{tMs,value}], unresolved?, readError? }]; callers that omit sampledFields see an unchanged response.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Caller id echoed back in fieldTimeline (e.g. 'run-sfx', 'anim-moving'). Defaults to property_path or method_name if omitted." },
              locator: locatorSchema,
              type_name: { type: "string", description: "Component type name owning the member (e.g. AudioSource, ParticleSystem, Animator, or a custom MonoBehaviour). The FIRST matching component on the GameObject is used (GetComponent) — disambiguate by targeting a child if a GameObject has several." },
              property_path: { type: "string", description: "Public instance property or field name to read each tick. Must be a JSON scalar (bool/integer/float/enum). Supply EITHER property_path OR method_name+args." },
              method_name: { type: "string", description: "L3a.1: read a scalar-returning public method each tick instead of a field — for signals with no readable field, e.g. a Unity Animator parameter ('Animator' + method_name 'GetBool' + args ['moving']). MUST be a pure read-only getter (invoked every tick); a void/non-scalar return is refused (rejects mutators), and if more than one overload binds the same args the spec is refused as ambiguous. Supply EITHER property_path OR method_name+args (supplying both is refused)." },
              args: { type: "array", description: "Literal arguments for method_name, bound once at capture start. Matched to the parameter by JSON kind: string→string, bool→bool, integer→integral/float/enum, float→float. Omit/empty for a zero-arg method." },
            },
            required: ["id", "locator", "type_name"],
          },
        },
      },
      required: ["measure", "target"],
    },
  });

  ops.push({
    command: "runtime.sample_animator",
    toolName: "unity_runtime_sample_animator",
    description:
      "HONEST animation-progress verification for an Animator. Motivating incident: an unfocused/headless editor advances physics but NOT Animator time even with runInBackground, so an agent could 'verify' an animation from a STATIC pose that was actually FROZEN. " +
      "This op resolves the GameObject (refuses NOT_FOUND if it has no Animator), samples layer-0 state (fullPathHash/normalizedTime/speed), animator.playableGraph.IsPlaying()/animator.speed, and each requested bone's LOCAL pose (localRotation+localPosition) across a window, then computes verdict fields HONESTLY: " +
      "time_advancing (normalizedTime strictly increased — judged PER STATE between CONSECUTIVE same-fullPathHash samples, because Unity's normalizedTime is MONOTONIC within a looping state (integer part = loop count) and a cross-state comparison proves nothing), " +
      "bones_moving (any requested bone's LOCAL rotation/position delta above epsilon — SKELETAL-local motion only, never root motion: a physics-driven root moving under a frozen animator must not read as animation), and a status that NAMES the frozen case instead of laundering it into a pass. " +
      "status is one of: 'ok' (sampled a real window), 'blocked_culled' (cullingMode=CullCompletely and animator time did not advance — the offscreen-culled freeze; focus-INDEPENDENT and checked BEFORE any focus diagnosis so a focused editor cannot launder it into ok), " +
      "'blocked_unfocused' (the animator was EXPECTED to advance — enabled + controller + speed != 0 + activeInHierarchy + isInitialized — but animator time did NOT advance across the window AND the editor application is inactive: the physics-advances-but-Animator-frozen defect. NOTE: under -batchmode isApplicationActive is ALWAYS false, so there this status simply means 'editor app inactive'; the sampling loop pins Time.captureDeltaTime so game time DID advance across the window, which makes the frozen animator strong evidence of the Animator-update throttle regardless of the focus flag), " +
      "'insufficient_samples' (the window produced <2 distinct-timestamp samples, so advancement can never be established — refuse, not skip), or 'edit_mode_static' (paused-scene single-shot pose read; never time_advancing). " +
      "It NEVER reports time_advancing:true from a single sample or identical timestamps (at most one sample is recorded per tick, each with a distinct game-time stamp). " +
      "Works in BOTH play mode (samples across real frames using measure_motion's focus-independent machinery: forces runInBackground + pins Time.captureDeltaTime; play-mode exit / domain reload mid-window restores pinned time and errors cleanly instead of leaking capture state) and edit mode (single-shot pose + status edit_mode_static). " +
      "Focus signal: UnityEditorInternal.InternalEditorUtility.isApplicationActive. Returns { status, status_note? (present for blocked_* — names the cause and the fix), time_advancing, bones_moving, playMode, editorHasFocus, animatorPlaying, animatorSpeed, culling_mode, active_in_hierarchy, is_initialized, graphPlaying, currentState, sampleCount, distinctTimeSamples, durationMs, bones:[{path,resolved}], samples:[{tMs,normalizedTime,fullPathHash,stateSpeed,graphPlaying,bones:[{path,resolved,localRotation,localPosition}]}] }.",
    isAsync: true,
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Locator of the GameObject carrying the Animator (refuses NOT_FOUND if it has no Animator component)." },
        durationMs: { type: "number", description: "Play-mode sampling window in milliseconds (default 500, max 28000 — the op's 30000ms transport timeout minus a response margin; a longer window is refused). Ignored in edit mode (single-shot). 'duration_ms' is accepted as a back-compat alias." },
        samples: { type: "integer", minimum: 2, description: "Play-mode target sample count across the window (default 8, minimum 2 — a single sample can never establish time_advancing). At most one sample is recorded per tick." },
        captureFps: { type: "number", description: "Pin Time.captureDeltaTime to 1/captureFps during play-mode sampling so game time advances deterministically per tick regardless of focus (default 60). 0 disables pinning (live rate)." },
        bones: {
          type: "array",
          description: "Optional child-transform paths (relative to the Animator GameObject, e.g. 'Armature/Spine/RightHand') whose LOCAL pose (localRotation + localPosition) is recorded each sample; drives bones_moving. Local-space on purpose: bones_moving measures skeletal animation, NOT root motion — a physics-moved root never counts. Unresolved paths are reported honestly (resolved:false) and never fabricated.",
          items: { type: "string" },
        },
      },
      required: ["locator"],
    },
  });

  // ───── component ─────

  ops.push({
    command: "component.list",
    toolName: "unity_component_list",
    description: "List all components attached to a GameObject.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "component.add",
    toolName: "unity_component_add",
    description: "Add a component to a GameObject by type name. Optionally set initial properties.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        type_name: { type: "string", description: "Component type name (e.g. 'Rigidbody', 'BoxCollider2D')" },
        properties: { type: "object", description: "Optional initial property values to set" },
      },
      required: ["locator", "type_name"],
    },
  });

  ops.push({
    command: "component.remove",
    toolName: "unity_component_remove",
    description: "Remove a component from a GameObject by type name.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        type_name: { type: "string", description: "Component type name to remove" },
      },
      required: ["locator", "type_name"],
    },
  });

  ops.push({
    command: "component.get_properties",
    toolName: "unity_component_get_properties",
    description: "Get all serialized properties of a component with their current values. Supports search filtering and path inclusion.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        type_name: { type: "string", description: "Component type name" },
        search: { type: "string", description: "Optional search filter for property names" },
        include_paths: { type: "array", items: { type: "string" }, description: "Optional list of specific property paths to include" },
      },
      required: ["locator", "type_name"],
    },
  });

  ops.push({
    command: "component.describe",
    toolName: "unity_component_describe",
    description: "Describe a component's properties (alias for get_properties). Returns property descriptors with types and current values.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        type_name: { type: "string", description: "Component type name" },
        search: { type: "string", description: "Optional search filter for property names" },
        include_paths: { type: "array", items: { type: "string" }, description: "Optional list of specific property paths to include" },
      },
      required: ["locator", "type_name"],
    },
  });

  ops.push({
    command: "component.set_property",
    toolName: "unity_component_set_property",
    description: "Set a serialized property value on a component. Supports friendly names and object-reference payloads (asset_path/locator/null). Object refs are resolved by the field's own type, so AUDIO refs bind the same way as Sprites: an AudioSource.clip / AudioClip field takes a string .wav/.ogg asset path, and an AudioMixerGroup field (e.g. AudioSource.outputAudioMixerGroup) takes { asset_path: '<mixer>.mixer', sub_asset: '<group name>' } to pick one group sub-asset out of the .mixer.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        type_name: { type: "string", description: "Component type name" },
        property_path: { type: "string", description: "Property path or friendly name" },
        value: {
          type: ["string", "object", "number", "boolean", "array", "null"],
          description: "Value to set. For object references: a string asset path (e.g. an AudioClip .wav/.ogg or a Sprite), { asset_path, sub_asset? } (sub_asset picks one named sub-asset — a sliced Sprite from a sheet, or an AudioMixerGroup from a .mixer), { locator }, null, or { clear: true }. For array/list fields (e.g. Sprite[] animation frames): a JSON array of the above. JSON shape is preserved — do not pre-stringify.",
        },
      },
      required: ["locator", "type_name", "property_path", "value"],
    },
  });

  // ───── code ─────

  ops.push({
    command: "code.create_script",
    toolName: "unity_code_create_script",
    description: "Create a new C# script file under Assets/. Triggers compilation. Use if_exists to control re-run behavior.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path for the script (e.g. Assets/Scripts/MyScript.cs)" },
        content: { type: "string", description: "Full C# source code content" },
        if_exists: {
          type: "string",
          enum: ["error", "replace", "skip"],
          description: "Behavior when the target path already exists: 'error' (default, current behavior), 'replace' (overwrite content), 'skip' (no-op).",
        },
      },
      required: ["path", "content"],
    },
  });

  ops.push({
    command: "code.read_script",
    toolName: "unity_code_read_script",
    description: "Read the contents of a C# script file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the script to read" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "code.modify_script",
    toolName: "unity_code_modify_script",
    description: "Replace the full contents of an existing C# script file. Triggers recompilation.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the script to modify" },
        content: { type: "string", description: "New full C# source code content" },
      },
      required: ["path", "content"],
    },
  });

  ops.push({
    command: "code.attach_script",
    toolName: "unity_code_attach_script",
    description: "Attach a compiled MonoBehaviour script to a GameObject by script name.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        script_name: { type: "string", description: "Name of the MonoBehaviour script (without .cs)" },
      },
      required: ["locator", "script_name"],
    },
  });

  // ───── animator ─────

  ops.push({
    command: "animator.create_controller",
    toolName: "unity_animator_create_controller",
    description: "Create a new AnimatorController asset at the specified path. Replaces existing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path for the controller (e.g. Assets/Animations/Player.controller)" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "animator.add_parameter",
    toolName: "unity_animator_add_parameter",
    description: "Add a parameter to an AnimatorController.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
        name: { type: "string", description: "Parameter name" },
        type: { type: "string", enum: ["Float", "Int", "Bool", "Trigger"], description: "Parameter type (default: Float)" },
        defaultValue: { description: "Default value for the parameter" },
      },
      required: ["path", "name"],
    },
  });

  ops.push({
    command: "animator.add_state",
    toolName: "unity_animator_add_state",
    description: "Add a state to an AnimatorController layer.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
        state_name: { type: "string", description: "Name of the new state" },
        layer: { type: "number", description: "Layer index (default: 0)" },
        position: { ...vector2Schema, description: "Visual position in the Animator window" },
      },
      required: ["path", "state_name"],
    },
  });

  ops.push({
    command: "animator.set_default_state",
    toolName: "unity_animator_set_default_state",
    description: "Set the default (entry) state for an AnimatorController layer.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
        state_name: { type: "string", description: "Name of the state to set as default" },
        layer: { type: "number", description: "Layer index (default: 0)" },
      },
      required: ["path", "state_name"],
    },
  });

  ops.push({
    command: "animator.add_transition",
    toolName: "unity_animator_add_transition",
    description: "Add a transition between states in an AnimatorController. Use '*' as from for AnyState transitions.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
        from: { type: "string", description: "Source state name ('*' for AnyState)" },
        to: { type: "string", description: "Destination state name" },
        layer: { type: "number", description: "Layer index (default: 0)" },
        hasExitTime: { type: "boolean", description: "Whether transition has exit time (default: false)" },
        exitTime: { type: "number", description: "Exit time if hasExitTime is true (default: 0.9)" },
        duration: { type: "number", description: "Transition duration in seconds (default: 0.1)" },
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              parameter: { type: "string" },
              mode: { type: "string", enum: ["If", "IfNot", "Greater", "Less", "Equals", "NotEqual"] },
              threshold: { type: "number" },
            },
            required: ["parameter", "mode"],
          },
          description: "Transition conditions",
        },
      },
      required: ["path", "from", "to"],
    },
  });

  ops.push({
    command: "animator.assign_controller",
    toolName: "unity_animator_assign_controller",
    description: "Assign an AnimatorController to a GameObject's Animator component. Adds Animator if missing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
        locator: locatorSchema,
      },
      required: ["path", "locator"],
    },
  });

  ops.push({
    command: "animator.get_state_machine",
    toolName: "unity_animator_get_state_machine",
    description: "Get the full state machine definition of an AnimatorController: parameters, layers, states, and transitions.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "animator.set_state_motion",
    toolName: "unity_animator_set_state_motion",
    description:
      "Bind (or re-bind) the motion clip and/or playback speed of an EXISTING state in an " +
      "AnimatorController — at least one of motion/speed is required (speed-only updates allowed). " +
      "motion accepts a string asset path (native .anim) or { asset_path, sub_asset? } to select a " +
      "named clip sub-asset out of an imported FBX/GLB — resolution goes through the AssetDatabase so " +
      "both native (.anim, motion ref type 2) and imported clip sub-assets (type 3) bind correctly " +
      "without hand-editing controller YAML. Any key in the motion object other than " +
      "asset_path/sub_asset/clear is refused (INVALID_PARAMS), and when no sub_asset is given and the " +
      "container holds more than one clip the op refuses listing the candidates instead of silently " +
      "binding the first. If the sub-asset is not found the AssetDatabase is refreshed and resolution " +
      "retried once; a persistent miss returns a distinguishable NOT_FOUND noting the asset may not " +
      "be imported yet (e.g. an FBX whose avatar/clip sub-assets need the ModelImporter configured). " +
      "Returns motionBound + the bound motion name, plus accurate motionChanged/speedChanged flags " +
      "(a no-op re-bind reports false and skips the asset write).",
    inputSchema: {
      type: "object",
      properties: {
        controller_path: { type: "string", description: "Asset path of the AnimatorController" },
        state_name: { type: "string", description: "Name of the existing state to bind" },
        layer: { type: "number", description: "Layer index (default: 0)" },
        motion: {
          description:
            "The motion clip to bind: a string asset path to a native .anim, or " +
            "{ asset_path, sub_asset? } to select a named clip out of an imported FBX/GLB " +
            "(take names may look like 'Armature|Armature|...|baselayer'). { clear: true } unbinds. " +
            "Optional when speed is provided.",
          type: ["string", "object"],
          properties: {
            asset_path: { type: "string", description: "Path to the .anim or FBX/GLB asset" },
            sub_asset: { type: "string", description: "Name of the clip sub-asset inside an imported model" },
            clear: { type: "boolean", description: "Set true to unbind the motion (m_Motion = null)" },
          },
        },
        speed: { type: "number", description: "Playback speed multiplier for the state (may be sent without motion)" },
      },
      required: ["controller_path", "state_name"],
    },
  });

  ops.push({
    command: "animator.apply_spec",
    toolName: "unity_animator_apply_spec",
    description:
      "Apply a declarative spec to an AnimatorController. Creates or updates parameters, states, " +
      "transitions idempotently. A state may carry a 'motion' (string .anim path, or { asset_path, " +
      "sub_asset? } for an imported FBX/GLB clip sub-asset) and a 'speed' — these are BOUND onto the " +
      "state (m_Motion / speed), not ignored. ATOMIC: the ENTIRE spec is validated and every motion " +
      "resolved before any mutation, so a refused spec leaves the controller untouched. Refuse-not-" +
      "skip: any unknown key anywhere in the spec (top level, parameter, layer, state, transition, " +
      "condition, motion selector) is a hard INVALID_PARAMS refusal naming the key and location, and " +
      "a transition from/to or defaultState naming a missing state refuses instead of being skipped.",
    defaultTimeoutMs: 30000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the AnimatorController (created if missing)" },
        spec: {
          type: "object",
          description: "Declarative spec with parameters, layers, states, and transitions",
          properties: {
            parameters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["Float", "Int", "Bool", "Trigger"] },
                  defaultValue: {},
                },
                required: ["name", "type"],
              },
            },
            layers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  defaultState: { type: "string" },
                  states: {
                    type: "array",
                    items: {
                      type: "object",
                      description:
                        "A state. Supported fields ONLY: name, position, motion, speed. " +
                        "Any other field is refused with INVALID_PARAMS.",
                      properties: {
                        name: { type: "string" },
                        position: vector2Schema,
                        motion: {
                          description:
                            "Motion clip to bind onto the state: a string .anim path, or " +
                            "{ asset_path, sub_asset? } to pick a clip sub-asset from an imported FBX/GLB.",
                          type: ["string", "object"],
                          properties: {
                            asset_path: { type: "string" },
                            sub_asset: { type: "string" },
                            clear: { type: "boolean" },
                          },
                        },
                        speed: { type: "number", description: "Playback speed multiplier for the state" },
                      },
                      required: ["name"],
                    },
                  },
                  transitions: {
                    type: "array",
                    items: {
                      type: "object",
                      description:
                        "A transition. Supported fields ONLY: from, to, hasExitTime, exitTime, " +
                        "duration, conditions — any other field is refused with INVALID_PARAMS. " +
                        "from/to must name an existing or spec-defined state ('*' = AnyState source); " +
                        "a missing endpoint refuses instead of being skipped.",
                      properties: {
                        from: { type: "string", description: "Source state name ('*' for AnyState)" },
                        to: { type: "string", description: "Destination state name" },
                        hasExitTime: { type: "boolean" },
                        exitTime: { type: "number" },
                        duration: { type: "number" },
                        conditions: {
                          type: "array",
                          items: {
                            type: "object",
                            description:
                              "A condition. Supported fields ONLY: parameter, mode, threshold — " +
                              "any other field is refused with INVALID_PARAMS.",
                            properties: {
                              parameter: { type: "string" },
                              mode: { type: "string", enum: ["If", "IfNot", "Greater", "Less", "Equals", "NotEqual"] },
                              threshold: { type: "number" },
                            },
                            required: ["parameter", "mode"],
                          },
                        },
                      },
                      required: ["from", "to"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      required: ["path", "spec"],
    },
  });

  // ───── ui ─────

  ops.push({
    command: "ui.create_canvas",
    toolName: "unity_ui_create_canvas",
    description:
      "Create a new Canvas GameObject with CanvasScaler and GraphicRaycaster. Also ensures the scene " +
      "has an EventSystem (with InputSystemUIInputModule for new-Input-System projects, else " +
      "StandaloneInputModule) so uGUI buttons/touch controls actually receive input — an existing " +
      "EventSystem is reused. Returns the canvas locator plus an eventSystem { locator, created, inputModule }.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Canvas name (default: 'Canvas')" },
        render_mode: { type: "string", enum: ["overlay", "camera", "worldSpace"], description: "Canvas render mode (default: overlay)" },
      },
    },
  });

  ops.push({
    command: "ui.add_text",
    toolName: "unity_ui_add_text",
    description: "Add a UI text element (TextMeshPro-first, legacy fallback) as a child of a parent.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { ...locatorSchema, description: "Parent object locator (Canvas or UI element)" },
        name: { type: "string", description: "Text element name (default: 'Text')" },
        text: { type: "string", description: "Text content" },
        text_backend: {
          type: "string",
          enum: ["tmp", "legacy", "auto"],
          description: "Text rendering backend (default: tmp). Uses legacy uGUI Text when requested or TMP unavailable.",
        },
        font_size: { type: "number", description: "Font size in pixels (default: 14)" },
        color: { ...colorSchema, description: "Text color" },
        alignment: {
          type: "string",
          enum: [
            "UpperLeft", "UpperCenter", "UpperRight",
            "MiddleLeft", "MiddleCenter", "MiddleRight",
            "LowerLeft", "LowerCenter", "LowerRight",
          ],
          description: "Text alignment",
        },
        anchored_position: { ...vector2Schema, description: "Anchored position" },
        size_delta: { ...vector2Schema, description: "Size delta (width/height)" },
      },
      required: ["parent"],
    },
  });

  ops.push({
    command: "ui.add_image",
    toolName: "unity_ui_add_image",
    description: "Add a UI Image element as a child of a parent.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { ...locatorSchema, description: "Parent object locator" },
        name: { type: "string", description: "Image element name (default: 'Image')" },
        color: { ...colorSchema, description: "Image tint color" },
        sprite_path: { type: "string", description: "Asset path to a sprite to display" },
        anchored_position: { ...vector2Schema, description: "Anchored position" },
        size_delta: { ...vector2Schema, description: "Size delta (width/height)" },
      },
      required: ["parent"],
    },
  });

  ops.push({
    command: "ui.add_button",
    toolName: "unity_ui_add_button",
    description: "Add a UI Button with child label text (TextMeshPro-first, legacy fallback).",
    inputSchema: {
      type: "object",
      properties: {
        parent: { ...locatorSchema, description: "Parent object locator" },
        name: { type: "string", description: "Button name (default: 'Button')" },
        text: { type: "string", description: "Button label text (default: 'Button')" },
        text_backend: {
          type: "string",
          enum: ["tmp", "legacy", "auto"],
          description: "Label text backend (default: tmp).",
        },
        font_size: { type: "number", description: "Label font size (default: 14)" },
        color: { ...colorSchema, description: "Button background color" },
        anchored_position: { ...vector2Schema, description: "Anchored position" },
        size_delta: { ...vector2Schema, description: "Size delta (width/height)" },
      },
      required: ["parent"],
    },
  });

  ops.push({
    command: "ui.set_rect_transform",
    toolName: "unity_ui_set_rect_transform",
    description: "Set RectTransform properties on a UI element: anchors, position, size, pivot.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        anchor_min: { ...vector2Schema, description: "Anchor min (0-1)" },
        anchor_max: { ...vector2Schema, description: "Anchor max (0-1)" },
        anchored_position: { ...vector2Schema, description: "Anchored position" },
        size_delta: { ...vector2Schema, description: "Size delta" },
        pivot: { ...vector2Schema, description: "Pivot point (0-1)" },
      },
      required: ["locator"],
    },
  });

  ops.push({
    command: "ui.scan_text_components",
    toolName: "unity_ui_scan_text_components",
    description:
      "Enumerate text components (TextMeshPro + UnityEngine.UI.Text) in a Canvas/subtree (when 'locator' " +
      "is given) or scene-wide (when omitted) — the data the UI-conformance gate checks against the mock's " +
      "font and palette spec. Per component returns { locator, name, type, fontAssetPath, fontName, " +
      "color{r,g,b,a}, fontSize, alignment, anchor, text }. TMP is read via reflection (no hard TextMeshPro " +
      "dependency); the font asset path is resolved from the serialized font ObjectReference. " +
      "Inactive objects are included so a disabled HUD element is still reported.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Optional Canvas/subtree root to scan. Omit to scan all loaded scenes." },
      },
    },
  });

  ops.push({
    command: "ui.dispatch_pointer",
    toolName: "unity_ui_dispatch_pointer",
    description:
      "Actuate a uGUI control by dispatching a synthetic pointer event through the EventSystem " +
      "(ExecuteEvents), independent of the active input module. Unlike unity_input_click_ui (which goes " +
      "through the editor/input backend), this drives uGUI on BOTH the legacy StandaloneInputModule and the " +
      "new InputSystemUIInputModule with no game-code change — the mechanism behind backend-agnostic action " +
      "traces. Target either a 'locator' (dispatches to the element's handler; screen point computed from its " +
      "rect center) or explicit 'x'/'y' screen coordinates (raycast finds the element). action='click' fires " +
      "pointerDown→Up→Click; action='drag' fires down→(initializePotentialDrag)→beginDrag→drag→endDrag→up " +
      "toward 'to_locator' or 'to_x'/'to_y'. Returns { handlerTarget, screenPoint, raycastHit, handlersFired[], " +
      "actuated }, where actuated means ≥1 handler in the sequence accepted the event — NOT that the widget's " +
      "value necessarily changed; confirm real effects with unity_runtime_assert_condition. " +
      "Requires an active EventSystem in the scene (Play Mode for runtime modules). " +
      "For a HELD press that must span game frames (an On-Screen Button/Stick that polls IsPressed() " +
      "in Update — an instant click is down+up in one synchronous call and is missed by the next " +
      "frame's poll): action='press' dispatches pointerDown and LEAVES the pointer down, returning a " +
      "'holdId'; the press persists across frames (let the game tick, e.g. via a runtime capture/measure " +
      "in between) until action='release' { hold_id } dispatches the matching pointerUp.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Target uGUI element. Provide this or x/y." },
        x: { type: "number", description: "Screen X (omit when locator is given)" },
        y: { type: "number", description: "Screen Y (omit when locator is given)" },
        action: {
          type: "string",
          enum: ["click", "drag", "press", "release"],
          description:
            "Pointer action (default: click). 'press' = pointerDown held across frames → returns holdId; " +
            "'release' = pointerUp for a prior press (requires hold_id).",
        },
        button: { type: "number", description: "Pointer button: 0=left, 1=right, 2=middle (default: 0)" },
        to_locator: { ...locatorSchema, description: "Drag destination element (action=drag)" },
        to_x: { type: "number", description: "Drag destination screen X (action=drag)" },
        to_y: { type: "number", description: "Drag destination screen Y (action=drag)" },
        hold_id: {
          type: "string",
          description: "Held-press token from a prior action='press'; required by action='release'.",
        },
      },
    },
  });

  ops.push({
    command: "ui.get_screen_rects",
    toolName: "unity_ui_get_screen_rects",
    description:
      "Project uGUI elements (RectTransform under a Canvas) into SCREEN space — the Canvas-aware " +
      "counterpart to scene.get_screen_rects (which only handles world SpriteRenderers/colliders). " +
      "This is the data source for the deterministic UI gates: safe-area, required-in-frame, " +
      "tap-target-size, text-clipping, control-overlap. 'locators' is OPTIONAL: pass it to project " +
      "exactly those elements; OMIT it to auto-discover every Graphic (Image/Text/RawImage, including " +
      "Button graphics) under Canvases in the loaded scene(s), inactive ones included. Per element returns " +
      "screenRect{x,y,width,height} (pixels, origin bottom-left), viewportRect{...} (normalized 0..1), " +
      "active, isVisible + visibilityReason (inactive | canvas-disabled | canvasgroup-alpha-zero | " +
      "graphic-disabled | graphic-transparent | no-canvas | no-camera | no-rect-transform | off-screen), " +
      "descendantVisible (only on graphic-disabled/graphic-transparent entries: true when active child " +
      "art renders, i.e. the invisible-hit-target pattern where the CONTROL is visible but its own " +
      "Graphic is not), isFullyVisible/isPartiallyClipped/" +
      "isOffScreen/clipSide, centerXFraction/centerYFraction, raycastTarget, role (button|text|image|rawimage|" +
      "graphic|container), canvasRenderMode/canvasLocator, plus identity extras (text/fontSize, spriteName, " +
      "interactable). Pixel→dp conversion for tap-target floors is the gate layer's job; this op returns pixel " +
      "and normalized rects.",
    inputSchema: {
      type: "object",
      properties: {
        locators: {
          type: "array",
          description:
            "Optional UI elements to project. Omit (or pass empty) to auto-discover all Graphics under Canvases.",
          items: locatorSchema,
        },
        camera: {
          ...locatorSchema,
          description:
            "Optional camera locator used as a pixel-rect hint for ScreenSpaceCamera/WorldSpace canvases. " +
            "Overlay canvases need no camera.",
        },
      },
    },
  });

  ops.push({
    command: "ui.set_text_style",
    toolName: "unity_ui_set_text_style",
    description:
      "Set font/layout styling on an existing UI text element — uGUI Text OR TextMeshProUGUI (TMP read via " +
      "reflection, no hard dependency). uGUI Text's font fields (fontSize/alignment/…) serialize under the " +
      "nested m_FontData block, so this is the front door for them rather than component.set_property. Only " +
      "the fields you pass are changed; the rest are left as-is. Unknown alignment/font_style strings REFUSE " +
      "with INVALID_PARAMS before anything is mutated (enforced op-side, not just this schema). Returns " +
      "{ locator, text_backend (legacy|tmp), applied, skipped }: 'applied' lists only fields whose write " +
      "actually happened; a field the backend could not write lands in 'skipped' [{field, reason}] instead. " +
      "best_fit=true always bounds the auto-sizer so it cannot shrink text toward invisible: with font_size " +
      "given, max=font_size and min=max(10, font_size/2) (font_size becomes the UPPER bound, reported as " +
      "applied.best_fit_bounds); without font_size, min is floored to 10 only when the current min is < 1. " +
      "best_fit=false disables auto-sizing and leaves bounds untouched.",
    inputSchema: {
      type: "object",
      properties: {
        locator: { ...locatorSchema, description: "Target UI element carrying a Text or TextMeshProUGUI component" },
        font_size: {
          type: "number",
          description:
            "Font size in pixels (rounded to int for uGUI Text). With best_fit=true this becomes the auto-sizer's max.",
        },
        color: { ...colorSchema, description: "Text color" },
        font_style: {
          type: "string",
          enum: ["Normal", "Bold", "Italic", "BoldAndItalic"],
          description: "Font style. BoldAndItalic maps to the TMP Bold|Italic flag combo. Unknown values refuse.",
        },
        alignment: {
          type: "string",
          enum: [
            "UpperLeft", "UpperCenter", "UpperRight",
            "MiddleLeft", "MiddleCenter", "MiddleRight",
            "LowerLeft", "LowerCenter", "LowerRight",
          ],
          description: "Text alignment (mapped to the TMP alignment enum for TMP components). Unknown values refuse.",
        },
        best_fit: {
          type: "boolean",
          description:
            "Auto-resize text to fit its rect (uGUI resizeTextForBestFit / TMP enableAutoSizing). " +
            "true always establishes min/max bounds — see the op description for the exact semantics.",
        },
      },
      required: ["locator"],
    },
  });

  // ───── asset ─────

  ops.push({
    command: "asset.create_sprite",
    toolName: "unity_asset_create_sprite",
    description: "Create a sprite texture at the specified asset path from external image input or generated solid color.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path for the sprite PNG (e.g. Assets/Sprites/Square.png)" },
        source_path: { type: "string", description: "Optional external local image file path (.png/.jpg/.jpeg)" },
        source_url: { type: "string", description: "Optional external image URL (.png/.jpg/.jpeg)" },
        width: { type: "number", description: "Texture width in pixels (default: 32)" },
        height: { type: "number", description: "Texture height in pixels (default: 32)" },
        color: { ...colorSchema, description: "Fill color for generated textures (default: white)" },
        pixels_per_unit: { type: "number", description: "Sprite pixels per unit (default: 100)" },
        sprite_mode: { type: "string", enum: ["single", "multiple"], description: "Sprite import mode (default: single)" },
        filter_mode: { type: "string", enum: ["Point", "Bilinear"], description: "Texture filter mode" },
        readable: { type: "boolean", description: "Enable Read/Write on the imported texture so scene.get_bounds can compute alpha-trimmed visibleBounds (default: true)" },
        default_sprite_name: { type: "string", description: "Default named sub-sprite for multiple imports" },
        slicing: {
          type: "object",
          description: "Named sprite slicing metadata for sprite_mode=multiple. Supports grid or explicit rects.",
        },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "asset.create_material",
    toolName: "unity_asset_create_material",
    description: "Create a new Material asset with the specified shader, including optional URP/PBR texture slots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path for the material (e.g. Assets/Materials/Red.mat)" },
        shader: { type: "string", description: "Shader name (default: 'Standard'). Alias: 'URP/Lit' maps to 'Universal Render Pipeline/Lit'." },
        color: { ...colorSchema, description: "Material color" },
        texture: { type: "string", description: "Optional asset path of a texture to assign as the material's main texture (alias: mainTexture)" },
        mainTexture: { type: "string", description: "Alias for texture" },
        base_map: { type: "string", description: "Optional base color texture path (alias: baseMap)" },
        baseMap: { type: "string", description: "Alias for base_map" },
        normal_map: { type: "string", description: "Optional normal map texture path (alias: normalMap)" },
        normalMap: { type: "string", description: "Alias for normal_map" },
        normal_scale: { type: "number", description: "Normal map scale (default: 1)" },
        metallic_map: { type: "string", description: "Optional metallic/smoothness texture path (alias: metallicMap)" },
        metallicMap: { type: "string", description: "Alias for metallic_map" },
        metallic: { type: "number", description: "Metallic scalar used with metallic maps (default: 1)" },
        smoothness: { type: "number", description: "Smoothness scalar used with metallic maps (default: 0.5)" },
        emission_map: { type: "string", description: "Optional emission texture path (alias: emissionMap)" },
        emissionMap: { type: "string", description: "Alias for emission_map" },
        emission_color: { ...colorSchema, description: "Optional emission color (alias: emissionColor)" },
        emissionColor: { ...colorSchema, description: "Alias for emission_color" },
        emission_intensity: { type: "number", description: "Emission intensity multiplier (default: 1; alias: emissionIntensity)" },
        emissionIntensity: { type: "number", description: "Alias for emission_intensity" },
        surface: {
          type: "string",
          enum: ["opaque", "transparent"],
          description:
            "URP Lit surface type. 'transparent' sets _Surface=1, _ZWrite=0, queue=Transparent(3000), and the _SURFACE_TYPE_TRANSPARENT keyword; 'opaque' restores queue=Geometry(2000). Refuses if the shader has no _Surface property.",
        },
        blend: {
          type: "string",
          enum: ["alpha", "additive"],
          description:
            "Transparent blend mode (implies a transparent surface). 'alpha' = SrcAlpha/OneMinusSrcAlpha; 'additive' = One/One.",
        },
        render_queue: { type: "number", description: "Explicit renderQueue override; wins over the surface-type default (alias: renderQueue)" },
        renderQueue: { type: "number", description: "Alias for render_queue" },
        specular_highlights: { type: "boolean", description: "Decal-safe: set false to disable specular highlights (_SpecularHighlights + _SPECULARHIGHLIGHTS_OFF). Refuses if the shader lacks the property (alias: specularHighlights)" },
        specularHighlights: { type: "boolean", description: "Alias for specular_highlights" },
        environment_reflections: { type: "boolean", description: "Decal-safe: set false to disable environment reflections (_EnvironmentReflections + _ENVIRONMENTREFLECTIONS_OFF). Refuses if the shader lacks the property (alias: environmentReflections)" },
        environmentReflections: { type: "boolean", description: "Alias for environment_reflections" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "asset.create_prefab",
    toolName: "unity_asset_create_prefab",
    description: "Save a scene GameObject as a prefab asset. Pass connect_source:true to keep the source instance connected to the created prefab.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path for the prefab (e.g. Assets/Prefabs/Enemy.prefab)" },
        locator: locatorSchema,
        connect_source: { type: "boolean", description: "Use SaveAsPrefabAssetAndConnect so the source scene instance becomes a connected prefab instance (default: false)" },
        expected_scene_path: { type: "string", description: "Optional active scene guard. Refuses if the active scene path differs." },
        allow_dirty_scene: { type: "boolean", description: "Allow mutation when the guarded active scene is dirty (default: false)" },
      },
      required: ["path", "locator"],
    },
  });

  ops.push({
    command: "asset.create_prefab_variant",
    toolName: "unity_asset_create_prefab_variant",
    description:
      "Create a prefab variant asset from a base prefab, with optional transform, mesh, material, and collider overrides.  NOTE: child paths resolve by name (transform.Find) — same-named siblings are unaddressable beyond the first; root-level component overrides search children for the first matching component (back-compat) — use overrides_by_path for precise targeting." +
      "Root-level renderer_materials/mesh_filter_mesh/collider_size target the first matching component in the hierarchy; " +
      "use overrides_by_path to target a specific child precisely.",
    inputSchema: {
      type: "object",
      properties: {
        base_prefab_path: { type: "string", description: "Asset path of the base prefab (alias: basePrefabPath)" },
        basePrefabPath: { type: "string", description: "Alias for base_prefab_path" },
        path: { type: "string", description: "Asset path for the prefab variant (aliases: variant_path, variantPath)" },
        variant_path: { type: "string", description: "Alias for path" },
        variantPath: { type: "string", description: "Alias for path" },
        overrides: {
          type: "object",
          description:
            "Optional overrides applied to the variant root. Transform: local_position/localPosition/position, " +
            "local_rotation_euler/localRotationEuler/rotation_euler, local_scale/localScale/scale. " +
            "Components (target the first matching component in the hierarchy): renderer_materials/rendererMaterials " +
            "(array of material asset paths), mesh_filter_mesh/meshFilterMesh ({ asset_path, sub_asset? } — refuses an " +
            "ambiguous multi-mesh asset unless sub_asset disambiguates), collider_size/colliderSize " +
            "(BoxCollider { size, center }, SphereCollider { radius, center }, CapsuleCollider { radius, height, center } — " +
            "refuses when the given fields do not match the target collider type). " +
            "overrides_by_path/overridesByPath: a { \"Child/Path\": { renderer_materials?, mesh_filter_mesh?, collider_size? } } " +
            "map that targets specific children precisely (the precise form); an unknown child path refuses with the available child paths.",
          properties: {
            local_position: { ...vector3Schema, description: "Root local position override" },
            local_rotation_euler: { ...vector3Schema, description: "Root local euler-angle rotation override" },
            local_scale: { ...vector3Schema, description: "Root local scale override" },
            renderer_materials: { type: "array", items: { type: "string" }, description: "Material asset paths for the first child Renderer" },
            mesh_filter_mesh: {
              type: "object",
              description: "Mesh override for the first child MeshFilter",
              properties: {
                asset_path: { type: "string", description: "Asset path holding the mesh (alias: assetPath)" },
                sub_asset: { type: "string", description: "Named mesh sub-asset; required to disambiguate a multi-mesh asset (alias: subAsset)" },
              },
            },
            collider_size: {
              type: "object",
              description: "Collider size override, typed per collider (Box: size/center; Sphere: radius/center; Capsule: radius/height/center)",
              properties: {
                size: { ...vector3Schema, description: "BoxCollider size" },
                center: { ...vector3Schema, description: "Collider center" },
                radius: { type: "number", description: "Sphere/Capsule radius" },
                height: { type: "number", description: "Capsule height" },
              },
            },
            overrides_by_path: {
              type: "object",
              description: "Map of relative child path -> { renderer_materials?, mesh_filter_mesh?, collider_size? }. Unknown path refuses with available child paths.",
            },
          },
        },
      },
      required: ["base_prefab_path", "path"],
    },
  });

  ops.push({
    command: "asset.replace_with_prefab",
    toolName: "unity_asset_replace_with_prefab",
    description:
      "Replace scene objects with a prefab while preserving parent, sibling index, local position, rotation, and scale. " +
      "Requires expected_scene_path to guard against mutating the wrong active scene. " +
      "Pass remap_references:true to preserve serialized-reference integrity across the swap: BEFORE destroying " +
      "each source, EVERY external serialized reference into its hierarchy is found (root, components, and all " +
      "DESCENDANTS — the scan is UNBOUNDED so the destroy surface is fully known); AFTER instantiating the " +
      "replacement each is re-pointed to the corresponding object on the new instance: the referenced object's " +
      "relative path under the source is resolved on the replacement, then components matched by type + index on " +
      "that child. A reference whose child path or component type is absent on the replacement is reported as " +
      "unmapped with a reason (NOT silently dropped) — it still nulls on destroy, but it is surfaced. Each " +
      "replacement entry then carries remapped[] and unmapped[]. With dry_run:true, mappability is evaluated " +
      "against the prefab ASSET's hierarchy so would-be-unmapped references are reported honestly without " +
      "mutating. External references may live in loaded scenes OUTSIDE the guarded active scene: a live remap " +
      "REFUSES up front (before any mutation) listing the affected scene paths unless allow_cross_scene_remap:true " +
      "explicitly permits those writes; every reported reference carries its referencing scene_path. " +
      "Default false (behavior unchanged). Pair with scene.find_references_to to pre-flight the swap.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the prefab to instantiate for each replacement" },
        locators: { type: "array", items: locatorSchema, description: "Scene objects to replace" },
        expected_scene_path: { type: "string", description: "Required active scene guard" },
        allow_dirty_scene: { type: "boolean", description: "Allow mutation when the guarded active scene is dirty (default: false)" },
        dry_run: { type: "boolean", description: "Return the replacement plan without mutating the scene (default: false)" },
        remap_references: { type: "boolean", description: "Re-point external serialized references from each destroyed source's hierarchy (root + descendants) to the new instance, reporting remapped[]/unmapped[] (default: false). Alias: remapReferences." },
        remapReferences: { type: "boolean", description: "Alias for remap_references." },
        allow_cross_scene_remap: { type: "boolean", description: "Permit remap_references to write serialized references in loaded scenes OTHER than the guarded active scene (default: false → the op refuses before any mutation, listing the affected scenes). Alias: allowCrossSceneRemap." },
        allowCrossSceneRemap: { type: "boolean", description: "Alias for allow_cross_scene_remap." },
      },
      required: ["path", "locators", "expected_scene_path"],
    },
  });

  ops.push({
    command: "asset.instantiate_prefab",
    toolName: "unity_asset_instantiate_prefab",
    description: "Instantiate a prefab into the active scene.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Asset path of the prefab to instantiate" },
        parent: { ...locatorSchema, description: "Optional parent object locator" },
        position: { ...vector3Schema, description: "Local position for the instance" },
        expected_scene_path: { type: "string", description: "Optional active scene guard. Refuses if the active scene path differs." },
        allow_dirty_scene: { type: "boolean", description: "Allow mutation when the guarded active scene is dirty (default: false)" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "asset.set_texture_import_settings",
    toolName: "unity_asset_set_texture_import_settings",
    description:
      "Set deterministic TextureImporter settings such as NormalMap, sRGB, mipmaps, readability, alpha source, and sprite import mode. " +
      "IMPORTANT for 2D: setting texture_type:'Sprite' WITHOUT sprite_mode defaults the importer to Single, which produces exactly one usable sprite. A texture left in Multiple mode but never sliced yields ZERO sprite sub-assets (so a later asset.assign_sprite fails 'Sprite not found'); pass sprite_mode:'multiple' only when you will also slice it (see asset.create_sprite slicing). An already-sliced Multiple sheet is left untouched by the default (its slices are never wiped). " +
      "Returns the resolved texture_type, sRGB, mipmaps, readable, alpha_source, and sprite_import_mode.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Texture asset path" },
        texture_type: { type: "string", enum: ["Default", "NormalMap", "Sprite"], description: "Texture importer type" },
        sprite_mode: {
          type: "string",
          enum: ["single", "multiple"],
          description:
            "Sprite import mode → TextureImporter.spriteImportMode. When texture_type is 'Sprite' and sprite_mode is omitted, the importer defaults to Single (a texture left Multiple/unsliced yields zero usable sprites). Use 'multiple' only when slicing the sheet (alias: spriteMode).",
        },
        spriteMode: { type: "string", enum: ["single", "multiple"], description: "Alias for sprite_mode" },
        sRGB: { type: "boolean", description: "sRGB sampling flag (alias: srgb)" },
        srgb: { type: "boolean", description: "Alias for sRGB" },
        mipmaps: { type: "boolean", description: "Enable mipmaps (alias: mipmapEnabled)" },
        mipmapEnabled: { type: "boolean", description: "Alias for mipmaps" },
        readable: { type: "boolean", description: "Read/Write enabled flag" },
        alpha_source: { type: "string", enum: ["None", "FromInput", "FromGrayScale"], description: "Texture alpha source" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "asset.channel_pack",
    toolName: "unity_asset_channel_pack",
    description:
      "Pack generator texture maps into a Unity-ready texture. Default preset 'metallic_smoothness' writes R=metallic, A=smoothness (1-roughness). " +
      "Preset 'mask_map' writes the HDRP-style R=metallic, G=occlusion, B=detail, A=smoothness layout.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Output texture asset path (.png/.jpg/.jpeg under Assets/)" },
        preset: { type: "string", enum: ["metallic_smoothness", "mask_map"], description: "Channel layout preset (default: metallic_smoothness)" },
        metallic_path: { type: "string", description: "Optional metallic grayscale texture path (alias: metallicPath). R channel." },
        metallicPath: { type: "string", description: "Alias for metallic_path" },
        roughness_path: { type: "string", description: "Optional roughness grayscale texture path (alias: roughnessPath). Alpha stores 1-roughness as smoothness." },
        roughnessPath: { type: "string", description: "Alias for roughness_path" },
        smoothness_path: { type: "string", description: "mask_map only: direct smoothness grayscale texture path (alternative to roughness_path). Alpha channel (alias: smoothnessPath)." },
        smoothnessPath: { type: "string", description: "Alias for smoothness_path" },
        occlusion_path: { type: "string", description: "mask_map only: occlusion/AO grayscale texture path. G channel (aliases: occlusionPath, ao_path, aoPath). Default 1 (no occlusion)." },
        occlusionPath: { type: "string", description: "Alias for occlusion_path" },
        ao_path: { type: "string", description: "Alias for occlusion_path" },
        aoPath: { type: "string", description: "Alias for occlusion_path" },
        detail_path: { type: "string", description: "mask_map only: detail-mask grayscale texture path. B channel (aliases: detailPath, detail_mask_path, detailMaskPath). Default 0." },
        detailPath: { type: "string", description: "Alias for detail_path" },
        detail_mask_path: { type: "string", description: "Alias for detail_path" },
        detailMaskPath: { type: "string", description: "Alias for detail_path" },
        mipmaps: { type: "boolean", description: "Enable mipmaps on the packed texture (default: true)" },
        readable: { type: "boolean", description: "Keep the packed texture CPU-readable for channel diagnostics (default: true)" },
      },
      required: ["path"],
    },
  });

  ops.push({
    command: "asset.set_renderer_materials",
    toolName: "unity_asset_set_renderer_materials",
    description: "Assign a Renderer.sharedMaterials array by material asset paths, with optional submesh-count validation.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        materials: {
          type: "array",
          items: { type: "string" },
          description: "Material asset paths to assign to Renderer.sharedMaterials",
        },
        strict_submesh_count: { type: "boolean", description: "Refuse when the material count differs from the renderer mesh submesh count (default: false)" },
      },
      required: ["locator", "materials"],
    },
  });

  ops.push({
    command: "asset.list_sub_assets",
    toolName: "unity_asset_list_sub_assets",
    description:
      "List every asset object at an asset path via AssetDatabase.LoadAllAssetsAtPath (includes representations and hidden sub-assets such as FBX clips/avatars). Returns per object {name, type, fileID, guid, isMainAsset}, plus length/isLooping for AnimationClips and isHuman/isValid for Avatars. Eliminates the manual grep-a-temp-prefab-for-m_Animation trick used to discover FBX clip fileIDs. If nothing loads, force-imports just that asset synchronously (never a global Refresh, which could recompile unrelated dirty scripts) and retries once; distinguishes 'no such asset' / 'path is a folder' / 'asset exists but not yet imported'.",
    inputSchema: {
      type: "object",
      properties: {
        asset_path: { type: "string", description: "Asset path under Assets/ (e.g. an .fbx, .glb, or .controller)" },
      },
      required: ["asset_path"],
    },
  });

  ops.push({
    command: "asset.inspect_model_importer",
    toolName: "unity_asset_inspect_model_importer",
    description:
      "Inspect the ModelImporter for a model asset (.fbx/.obj/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not a ModelImporter. Returns {animationType, avatarSetup, importAnimation, globalScale, useFileScale, fileScale, materialImportMode, clipAnimations:[{name, takeName, firstFrame, lastFrame, loopTime}], defaultClipAnimations (names), importedTakeInfos (names)} — the FBX import state the dogfood session read by hand-cloning a known-good .fbx.meta.",
    inputSchema: {
      type: "object",
      properties: {
        asset_path: { type: "string", description: "Model asset path under Assets/ (.fbx/.obj/.dae/etc)" },
      },
      required: ["asset_path"],
    },
  });

  ops.push({
    command: "asset.configure_model_importer",
    toolName: "unity_asset_configure_model_importer",
    description:
      "Configure a model asset's ModelImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not a model. Model reimport re-serializes sub-assets but does NOT compile scripts, so no domain reload occurs and the response is synchronous — rigged-model reimports are still slow, hence the 90s default timeout (tune per call via timeoutMs). clip_overrides edit takes discovered on the model (matched by take_name) — e.g. forcing loopTime on a walk cycle — replacing the hand-edited .fbx.meta clipAnimations block. Combining animation-discovery settings (animation_type/avatar_setup/import_animation) with clip_overrides in one call works but costs TWO internal reimports: the first refreshes take discovery under the new settings, the second applies the overrides. Resulting clip names must be unique (refuses INVALID_PARAMS on collision).",
    defaultTimeoutMs: 90000,
    inputSchema: {
      type: "object",
      properties: {
        asset_path: { type: "string", description: "Model asset path under Assets/ (.fbx/.obj/.dae/etc)" },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 90000; a rigged-FBX SaveAndReimport routinely exceeds the generic 10s fallback, and combining discovery settings with clip_overrides doubles the reimport cost)." },
        animation_type: {
          type: ["string", "integer"],
          description: "ModelImporterAnimationType: None|Legacy|Generic|Human (or the raw int). avatarSetup+animation=Human is the rigged-clip path.",
        },
        avatar_setup: {
          type: ["string", "integer"],
          description: "ModelImporterAvatarSetup: NoAvatar|CreateFromThisModel|CopyFromOther (or raw int). FBX defaults to NoAvatar which yields no Animator/clips; CreateFromThisModel unlocks them.",
        },
        import_animation: { type: "boolean", description: "ModelImporter.importAnimation" },
        global_scale: { type: "number", description: "ModelImporter.globalScale (applied when use_file_scale is false)" },
        use_file_scale: { type: "boolean", description: "ModelImporter.useFileScale" },
        clip_overrides: {
          type: "array",
          description: "Per-take clip overrides matched by take_name against the model's discovered takes.",
          items: {
            type: "object",
            properties: {
              take_name: { type: "string", description: "Take to override (must exist on the model; refuses otherwise, listing available takes)" },
              name: { type: "string", description: "Rename the resulting clip (keeps the take mapping)" },
              loop_time: { type: "boolean", description: "ModelImporterClipAnimation.loopTime — set true so a walk cycle loops instead of playing once" },
              first_frame: { type: "number", description: "ModelImporterClipAnimation.firstFrame" },
              last_frame: { type: "number", description: "ModelImporterClipAnimation.lastFrame" },
            },
            required: ["take_name"],
          },
        },
      },
      required: ["asset_path"],
    },
  });

  ops.push({
    command: "asset.inspect_audio_importer",
    toolName: "unity_asset_inspect_audio_importer",
    description:
      "Inspect the AudioImporter for an audio asset (.wav/.ogg/.mp3/.aiff/etc). Refuses cleanly (INVALID_TYPE) when the path's importer is not an AudioImporter. Returns {force_to_mono, load_in_background, ambisonic, default_sample_settings:{load_type, compression_format, quality, sample_rate_setting, sample_rate_override, preload_audio_data, conversion_mode}, clip:{length, channels, frequency, samples} when the AudioClip is loadable (else null)} — the import state the SFX dogfood tuned by hand-editing .wav.meta. conversion_mode is Unity's undocumented raw int field on AudioImporterSampleSettings (no public enum type exists), reported as-is so inspect is a complete settings dump. Reads the DEFAULT platform sample settings only; per-platform overrides are out of scope.",
    inputSchema: {
      type: "object",
      properties: {
        asset_path: { type: "string", description: "Audio asset path under Assets/ (.wav/.ogg/.mp3/.aiff/etc)" },
      },
      required: ["asset_path"],
    },
  });

  ops.push({
    command: "asset.configure_audio_importer",
    toolName: "unity_asset_configure_audio_importer",
    description:
      "Configure an audio asset's AudioImporter then SaveAndReimport, returning the resulting inspect payload. Refuses (INVALID_TYPE) if the path is not an audio clip. Writes force_to_mono / load_in_background on the importer and load_type / compression_format / quality / sample_rate_setting / sample_rate_override / preload_audio_data / conversion_mode on the DEFAULT-platform AudioImporterSampleSettings (per-platform overrides are OUT OF SCOPE for this slice). Role-specific import: short critical SFX prefer load_type=DecompressOnLoad + compression_format=PCM|ADPCM; music/long ambience prefer Streaming. Audio reimport re-encodes the clip but does NOT compile scripts, so no domain reload occurs and the response is synchronous — re-encoding a long clip can still exceed the 10s wire fallback, hence the 90s default timeout (tune per call via timeoutMs). Enum params accept the name (load_type: DecompressOnLoad|CompressedInMemory|Streaming; compression_format: PCM|Vorbis|ADPCM; sample_rate_setting: PreserveSampleRate|OptimizeSampleRate|OverrideSampleRate) or the raw int, and refuse INVALID_PARAMS listing the valid values.",
    defaultTimeoutMs: 90000,
    inputSchema: {
      type: "object",
      properties: {
        asset_path: { type: "string", description: "Audio asset path under Assets/ (.wav/.ogg/.mp3/.aiff/etc)" },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 90000; re-encoding a long clip can exceed the generic 10s wire fallback)." },
        force_to_mono: { type: "boolean", description: "AudioImporter.forceToMono — downmix all channels to one." },
        load_in_background: { type: "boolean", description: "AudioImporter.loadInBackground — load the clip off the main thread without blocking." },
        preload_audio_data: { type: "boolean", description: "AudioImporterSampleSettings.preloadAudioData — preload the clip when the scene/asset loads. Written through the struct: the importer-level AudioImporter.preloadAudioData still exists on 6000.3 but is an ERROR-level [Obsolete] pointing at the sample settings." },
        load_type: {
          type: ["string", "integer"],
          description: "AudioClipLoadType: DecompressOnLoad|CompressedInMemory|Streaming (or the raw int).",
        },
        compression_format: {
          type: ["string", "integer"],
          description: "AudioCompressionFormat: PCM|Vorbis|ADPCM (or the raw int; other platform formats such as MP3/AAC are also accepted by name where valid on this Unity build).",
        },
        quality: { type: "number", description: "AudioImporterSampleSettings.quality — compression amount 0..1 (refuses INVALID_PARAMS outside [0,1])." },
        sample_rate_setting: {
          type: ["string", "integer"],
          description: "AudioSampleRateSetting: PreserveSampleRate|OptimizeSampleRate|OverrideSampleRate (or the raw int).",
        },
        sample_rate_override: { type: "integer", description: "Target sample rate in Hz, used when sample_rate_setting=OverrideSampleRate (refuses INVALID_PARAMS if negative)." },
        conversion_mode: { type: "integer", description: "AudioImporterSampleSettings.conversionMode — Unity's undocumented public int field (no public enum type exists in the 6000.3 assembly), passed through as a raw int without name-based validation. Leave unset unless replicating a known .meta value." },
      },
      required: ["asset_path"],
    },
  });

  ops.push({
    command: "asset.assign_sprite",
    toolName: "unity_asset_assign_sprite",
    description:
      "Assign a sprite asset to a SpriteRenderer or UI Image component on a GameObject. If no sprite resolves at sprite_path, the NOT_FOUND error DIAGNOSES why (texture is not Sprite type / is Sprite Mode Multiple with zero sliced sub-sprites / named sub-sprite absent) and names the fix — see asset.set_texture_import_settings sprite_mode.",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        sprite_path: { type: "string", description: "Asset path of the sprite to assign" },
        sprite_name: { type: "string", description: "Optional named sub-sprite within a multiple-sprite texture" },
      },
      required: ["locator", "sprite_path"],
    },
  });

  ops.push({
    command: "asset.picker_open",
    toolName: "unity_asset_picker_open",
    description:
      "Open (or refresh) the Loombridge asset picker — a human-in-the-loop EditorWindow that proposes options with thumbnails for the user to confirm or swap. The agent supplies slots of candidate options with its pre-selected pick; the user single-selects per slot and clicks Confirm or Cancel. Resets picker state to 'pending'. This is a generic options-with-thumbnails surface (the agent assembles slots/options); poll unity_asset_picker_state for the outcome. Note: opening does not block — use the poll handshake.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Window title shown above the slots (e.g. 'Choose prototype assets')" },
        slots: {
          type: "array",
          description: "One entry per choice slot (e.g. one per primitive: player, enemy, ground).",
          items: {
            type: "object",
            properties: {
              slot: { type: "string", description: "Stable slot id, used as the key in the returned selection map (e.g. 'player')" },
              label: { type: "string", description: "Human-readable slot label (defaults to slot id)" },
              selectedId: { type: "string", description: "Option id to pre-highlight as the agent's pick (defaults to the first option)" },
              options: {
                type: "array",
                description: "Candidate options shown as thumbnail cards for this slot.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Stable option id returned in the selection when chosen" },
                    label: { type: "string", description: "Human-readable option label (defaults to id)" },
                    imagePath: { type: "string", description: "Absolute path to a local thumbnail image (PNG/JPG); missing/unreadable renders a neutral box" },
                    badges: {
                      type: "array",
                      description: "Short tags shown on the card (e.g. license 'CC0-1.0', or 'PLACEHOLDER').",
                      items: { type: "string" },
                    },
                  },
                  required: ["id"],
                },
              },
            },
            required: ["slot", "options"],
          },
        },
      },
      required: ["slots"],
    },
  });

  ops.push({
    command: "asset.picker_state",
    toolName: "unity_asset_picker_state",
    description:
      "Poll the Loombridge asset picker handshake state. Returns { status: 'none'|'pending'|'confirmed'|'cancelled', selection: { <slot>: <optionId> } }. 'none' before opening or after close, 'pending' while the user is choosing, 'confirmed' with the chosen ids after the user clicks Confirm, 'cancelled' if the user clicks Cancel or closes the window. The agent polls this (with its own timeout) until confirmed/cancelled.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });

  ops.push({
    command: "asset.picker_close",
    toolName: "unity_asset_picker_close",
    description:
      "Close the Loombridge asset picker window and reset state to 'none'. Use after reading a confirmed/cancelled outcome, or to dismiss the picker.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });

  ops.push({
    command: "asset.browser_open",
    toolName: "unity_asset_browser_open",
    description:
      "Open (or refresh) the Loombridge registry Asset Browser EditorWindow. The agent supplies a generic library payload assembled from the registry/profile (categories, assets, local thumbnail paths, metadata, and seeded inventory/default selections). The browser supports search, category and metadata filters, grid cards, inventory add/remove/swap, and a preview modal. It reuses the existing asset picker poll handshake: this call resets state to 'pending', and unity_asset_picker_state returns the confirmed/cancelled outcome.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Window title/chrome label." },
        registry: {
          type: "object",
          description: "Registry status metadata shown in the left rail.",
          properties: {
            name: { type: "string", description: "Registry or pack display name." },
            status: { type: "string", description: "Short status label, e.g. loaded/synced/offline." },
            syncedLabel: { type: "string", description: "Human-readable freshness/source label." },
          },
        },
        categories: {
          type: "array",
          description: "Optional category definitions. Counts are derived from assets.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable category id, e.g. characters/environments/audio." },
              label: { type: "string", description: "Human-readable category label." },
            },
            required: ["id"],
          },
        },
        assets: {
          type: "array",
          description: "Library assets to browse. The bridge does not read registry files; the agent supplies this data.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable asset id returned in the confirmed selection." },
              name: { type: "string", description: "Display name." },
              category: { type: "string", description: "Browser category id." },
              categoryLabel: { type: "string", description: "Optional browser category label." },
              primitive: { type: "string", description: "Registry primitive, e.g. player/tile/collectible." },
              kind: { type: "string", description: "Asset kind, e.g. sprite/audio/model." },
              imagePath: { type: "string", description: "Absolute local PNG/JPG thumbnail or source image path. Missing/unreadable renders a neutral placeholder." },
              license: { type: "string", description: "License SPDX or short label." },
              licenseName: { type: "string", description: "Full license name when available." },
              placeholder: { type: "boolean", description: "Whether to show a PLACEHOLDER badge." },
              tags: { type: "array", items: { type: "string" }, description: "Registry tags." },
              badges: { type: "array", items: { type: "string" }, description: "Extra short badges to show on cards." },
              author: { type: "string", description: "Source author." },
              sourceTitle: { type: "string", description: "Source title." },
              sourceUrl: { type: "string", description: "Source URL." },
              provider: { type: "string", description: "Provider name." },
              providerType: { type: "string", description: "Provider type, e.g. local/http/generation." },
              unityPath: { type: "string", description: "Planned Unity asset path." },
              fileRole: { type: "string", description: "Primary file role." },
              fileFormat: { type: "string", description: "Primary file format." },
              fileSize: { type: "string", description: "Known local file size. Omit when unknown." },
              width: { type: "number", description: "Known pixel width." },
              height: { type: "number", description: "Known pixel height." },
              pixelsPerUnit: { type: "number", description: "Known Unity pixels-per-unit value." },
              priority: { type: "number", description: "Registry priority for default sorting." },
              style: { type: "string", description: "Optional style metadata. Omit when the registry lacks it." },
              color: { type: "string", description: "Optional color/palette metadata. Omit when the registry lacks it." },
              rating: { type: "number", description: "Optional rating. Omit when the registry lacks it." },
              downloads: { type: "number", description: "Optional download count. Omit when the registry lacks it." },
              version: { type: "string", description: "Optional version. Omit when the registry lacks it." },
            },
            required: ["id"],
          },
        },
        inventory: {
          type: "array",
          description: "Optional seeded inventory/default asset ids. If omitted, the browser seeds one high-priority asset per primitive.",
          items: { type: "string" },
        },
        slots: {
          type: "array",
          description: "Optional Phase-1-style slots; selectedId values are also used to seed inventory.",
          items: {
            type: "object",
            properties: {
              slot: { type: "string" },
              selectedId: { type: "string" },
            },
          },
        },
      },
      required: ["assets"],
    },
  });

  // ───── ops (meta) ─────

  // ───── package ─────

  ops.push({
    command: "package.list",
    toolName: "unity_package_list",
    description: "List packages installed in the project (Unity Package Manager). Returns each package's name, displayName, version, source, packageId, and resolvedPath. Use this to check whether a dependency is already present before adding it.",
    isAsync: true,
    defaultTimeoutMs: 60000,
    inputSchema: {
      type: "object",
      properties: {
        offlineMode: { type: "boolean", description: "Resolve from the local cache without contacting the registry (default: false)." },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 60000)." },
      },
    },
  });

  ops.push({
    command: "package.add",
    toolName: "unity_package_add",
    description: "Add (install) a package dependency via Unity Package Manager — lets a build self-provision a package it needs (e.g. Input System, Cinemachine, TextMeshPro). 'packageId' accepts a registry name ('com.unity.cinemachine'), name@version ('com.unity.inputsystem@1.7.0'), or a git URL. NOTE: a successful add triggers a domain reload / recompile; follow this op with unity_editor_wait_for { compiling: false } before issuing further ops.",
    isAsync: true,
    defaultTimeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        packageId: { type: "string", description: "Package to add: registry name, name@version, or git URL." },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 120000; network installs can be slow)." },
      },
      required: ["packageId"],
    },
  });

  ops.push({
    command: "capture.invoke_static",
    toolName: "unity_capture_invoke_static",
    description:
      "Invoke a project-authored STATIC verification-capture method (component + method) so it writes its " +
      "own gate JSON into outDir from RAW in-editor sampling — never hand-authored. Generic in shape but " +
      "LOCKED to the project-configurable allowlist (only vetted entry points run): the built-in default is " +
      "'GroundTiling.WriteTileCaptures' (writes platform-tiles.json + tile-render.json); add more via " +
      "staticMethods[] in the project's .loombridge/editor-allowlist.json. The static method must have " +
      "signature (string outDir). Refuses a non-allowlisted method or a component type not found in any " +
      "loaded assembly. outDir must resolve under the Unity project's .loombridge/verify/ subtree. " +
      "Returns { component, method, outDir (absolute), wrote[] (fresh expected filenames only), playMode }. " +
      "Used by `loombridge capture --slice <id>` for the platformer tiling slice.",
    inputSchema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Short type name of the component declaring the static method (e.g. 'GroundTiling')." },
        method: { type: "string", description: "Public static method name to invoke; must be (string outDir) and on the allowlist (e.g. 'WriteTileCaptures')." },
        outDir: { type: "string", description: "Directory the method writes its capture JSON into; must resolve under .loombridge/verify/ (absolute, or relative to the Unity project root)." },
      },
      required: ["component", "method", "outDir"],
    },
  });

  ops.push({
    command: "package.remove",
    toolName: "unity_package_remove",
    description: "Remove (uninstall) a package dependency via Unity Package Manager. Like add, a successful remove triggers a recompile; follow with unity_editor_wait_for { compiling: false }.",
    isAsync: true,
    defaultTimeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        packageName: { type: "string", description: "Package name to remove (e.g. 'com.unity.cinemachine')." },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 120000)." },
      },
      required: ["packageName"],
    },
  });

  ops.push({
    command: "package.search",
    toolName: "unity_package_search",
    description: "Search the Unity package registry for a package by name/id and return its available metadata (including versions). Use to discover the exact packageId/version before add when it isn't already known.",
    isAsync: true,
    defaultTimeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        packageId: { type: "string", description: "Package name/id to search the registry for (e.g. 'com.unity.cinemachine')." },
        timeoutMs: { type: "number", description: "Max time to wait in milliseconds (default: 120000)." },
      },
      required: ["packageId"],
    },
  });

  ops.push({
    command: "ops.batch",
    toolName: "unity_ops_batch",
    description:
      "Execute a list of existing Loombridge ops sequentially on Unity's main thread in ONE round-trip, " +
      "wrapped in a single undo group. Each item is { command, params } using normal op command names " +
      "(e.g. 'scene.create_object', 'component.set_property'). Returns per-op results. Use for bulk " +
      "construction (placing/wiring many objects) to collapse many round-trips into one. Only ops that " +
      "complete synchronously are allowed (no editor.play / wait_for / screenshot / input sessions).",
    isAsync: true,
    defaultTimeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          // RCL-T11: accept a NATIVE ARRAY (preferred) OR a JSON-encoded string of that array.
          // Some MCP clients pre-stringify a large nested array argument; without the string
          // branch the host rejects the call with "could not be parsed as JSON" before it ever
          // reaches the server. normalizeBatchOperations() coerces + validates field-by-field.
          anyOf: [
            {
              type: "array",
              description: "Ops to run in order. Each: { command: string, params?: object }.",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", description: "Op command name, e.g. 'scene.create_object'." },
                  params: { type: "object", description: "Parameters for that op." },
                },
                required: ["command"],
              },
            },
            {
              type: "string",
              description: "JSON-encoded array of { command, params? } (accepted for clients that stringify nested arrays).",
            },
          ],
          description: "Ops to run in order, as a native array of { command, params? } (preferred) or a JSON string of that array.",
        },
        stopOnError: { type: "boolean", description: "Stop at the first failing op (default true). If false, continue and report each failure with partial-progress results." },
        undoGroupName: { type: "string", description: "Name for the single undo group wrapping the batch (default 'Loombridge Batch')." },
      },
      required: ["operations"],
    },
  });

  // ───── ops discovery (RCL-T07) ─────
  // Handled SERVER-SIDE (never routed to Unity): they read the op registry so an agent can
  // enumerate what exists instead of probing by firing deliberately-wrong ops.

  ops.push({
    command: "ops.list",
    toolName: "unity_ops_list",
    description:
      "Discover every Loombridge op WITHOUT touching Unity: returns the full catalog grouped by " +
      "category — each entry is { command, toolName, isAsync, summary } — plus totalOps/totalCategories. " +
      "Use this FIRST to find the right op instead of guessing tool names (RCL-T07). Pass 'category' " +
      "(e.g. 'scene', 'runtime', 'editor') to list just that group. Pair with ops.describe for full schemas.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category filter (e.g. 'scene', 'editor', 'runtime', 'input')." },
      },
    },
  });

  ops.push({
    command: "ops.describe",
    toolName: "unity_ops_describe",
    description:
      "Full input schema for one or more Loombridge ops WITHOUT touching Unity (RCL-T07). Filter by exact " +
      "'command' ('scene.create_object'), exact 'toolName' ('unity_scene_create_object'), or 'category'; " +
      "with no filter it returns every op's schema. Returns { matched:[{command,toolName,category,isAsync," +
      "defaultTimeoutMs,description,inputSchema}], suggestions? }. When a specific command/toolName is " +
      "unknown, matched is empty and 'suggestions' lists the nearest valid commands (so a typo self-corrects).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Exact op command to describe (e.g. 'runtime.measure_motion')." },
        toolName: { type: "string", description: "Exact MCP tool name to describe (e.g. 'unity_runtime_measure_motion')." },
        category: { type: "string", description: "Describe every op in this category (e.g. 'runtime')." },
      },
    },
  });

  return ops;
}

/** A single validated batch entry destined for ops.batch. */
export interface BatchOperation {
  command: string;
  params?: Record<string, unknown>;
}

/**
 * RCL-T11: coerce + validate the ops.batch `operations` argument into a native array of
 * { command, params? }. Accepts:
 *   - a native array (the preferred form),
 *   - a JSON-encoded string of that array (clients that stringify nested array args),
 *   - per-entry stringified JSON objects (defense in depth).
 * Each entry is validated FIELD BY FIELD (command must be a non-empty string; params, when present,
 * must be an object) so a malformed payload fails with a precise, indexed message instead of an
 * opaque "could not be parsed as JSON". Per-op EXECUTION failures are not handled here — the bridge
 * returns those as partial-progress results; this only rejects a structurally-invalid request.
 */
export function normalizeBatchOperations(raw: unknown): BatchOperation[] {
  let arr: unknown = raw;

  if (typeof arr === "string") {
    const trimmed = arr.trim();
    if (trimmed === "") {
      throw new Error("ops.batch 'operations' is an empty string; expected a JSON array of { command, params? }.");
    }
    try {
      arr = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `ops.batch 'operations' is a string but not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!Array.isArray(arr)) {
    throw new Error("ops.batch 'operations' must be an array of { command, params? } (or a JSON string of one).");
  }

  return arr.map((entry, i) => {
    let obj: unknown = entry;
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch (err) {
        throw new Error(
          `ops.batch operation at index ${i} is a string but not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new Error(`ops.batch operation at index ${i} must be an object with a 'command' string.`);
    }
    const record = obj as Record<string, unknown>;
    const command = record.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`ops.batch operation at index ${i} is missing a non-empty 'command' string.`);
    }
    const params = record.params;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      throw new Error(`ops.batch operation at index ${i} ('${command}') has a 'params' that is not an object.`);
    }
    const normalized: BatchOperation = { command };
    if (params !== undefined) normalized.params = params as Record<string, unknown>;
    return normalized;
  });
}

// ─────────────────────────────────────────────
// Op discovery (RCL-T07): ops.list / ops.describe / near-match suggestions
// ─────────────────────────────────────────────

export interface OpListItem {
  command: string;
  toolName: string;
  isAsync: boolean;
  summary: string;
}

export interface OpCategoryGroup {
  category: string;
  count: number;
  ops: OpListItem[];
}

export interface OpsListPayload {
  totalOps: number;
  totalCategories: number;
  categories: OpCategoryGroup[];
}

export interface OpDescription {
  command: string;
  toolName: string;
  category: string;
  isAsync: boolean;
  defaultTimeoutMs?: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface OpsDescribePayload {
  matched: OpDescription[];
  /** Present only when a specific command/toolName was requested but did not resolve. */
  suggestions?: string[];
}

/** Category is the segment before the first '.' in a command (e.g. "scene" in "scene.create_object"). */
export function categoryOfCommand(command: string): string {
  const i = command.indexOf(".");
  return i >= 0 ? command.slice(0, i) : command;
}

/** Category embedded in a tool name "unity_<category>_<op>" (best-effort; "" if not the convention). */
function categoryOfToolName(toolName: string): string {
  const m = toolName.match(/^unity_([a-z0-9]+)_/i);
  return m ? m[1] : "";
}

/** First sentence of a description, capped, for a compact catalog listing. */
export function summarizeDescription(description: string): string {
  const trimmed = (description ?? "").trim();
  if (!trimmed) return "";
  const m = trimmed.match(/^[\s\S]*?[.!?](?:\s|$)/);
  let s = (m ? m[0] : trimmed).trim();
  if (s.length > 200) s = s.slice(0, 197).trimEnd() + "...";
  return s;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ─────────────────────────────────────────────
// OpRegistry Class
// ─────────────────────────────────────────────

export class OpRegistry {
  private _ops: OpDef[];
  private _byCommand: Map<string, OpDef>;
  private _byToolName: Map<string, OpDef>;

  constructor() {
    this._ops = buildOps();
    this._byCommand = new Map();
    this._byToolName = new Map();

    for (const op of this._ops) {
      this._byCommand.set(op.command, op);
      this._byToolName.set(op.toolName, op);
    }
  }

  /** Returns all op definitions. */
  getAll(): OpDef[] {
    return this._ops;
  }

  /** Lookup by wire command (e.g. "scene.create_object"). */
  getByCommand(command: string): OpDef | undefined {
    return this._byCommand.get(command);
  }

  /** Lookup by MCP tool name (e.g. "unity_scene_create_object"). */
  getByToolName(toolName: string): OpDef | undefined {
    return this._byToolName.get(toolName);
  }

  /**
   * RCL-T07: a discoverable catalog of every registered op grouped by category, so an
   * agent can enumerate what exists instead of firing deliberately-wrong ops to read the
   * error. Lightweight (command + toolName + one-line summary). Optional category filter.
   */
  buildListing(category?: string): OpsListPayload {
    const wanted = category ? category.trim().toLowerCase() : undefined;
    const groups = new Map<string, OpListItem[]>();
    for (const op of this._ops) {
      const cat = categoryOfCommand(op.command);
      if (wanted && cat.toLowerCase() !== wanted) continue;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push({
        command: op.command,
        toolName: op.toolName,
        isAsync: op.isAsync === true,
        summary: summarizeDescription(op.description),
      });
    }
    const categories: OpCategoryGroup[] = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, ops]) => ({
        category: cat,
        count: ops.length,
        ops: ops.sort((a, b) => a.command.localeCompare(b.command)),
      }));
    return {
      totalOps: categories.reduce((n, c) => n + c.count, 0),
      totalCategories: categories.length,
      categories,
    };
  }

  private toDescription(op: OpDef): OpDescription {
    return {
      command: op.command,
      toolName: op.toolName,
      category: categoryOfCommand(op.command),
      isAsync: op.isAsync === true,
      defaultTimeoutMs: op.defaultTimeoutMs,
      description: op.description,
      inputSchema: op.inputSchema,
    };
  }

  /**
   * RCL-T07: full schema for specific ops. Filter by exact `command`, exact `toolName`, or
   * `category`; with no filter, returns every op's full schema. When a specific command/
   * toolName is requested but unknown, `matched` is empty and `suggestions` lists the
   * nearest valid commands (so a typo self-corrects instead of becoming a wrong-op probe).
   */
  buildDescribe(filter: { command?: string; toolName?: string; category?: string }): OpsDescribePayload {
    const { command, toolName, category } = filter ?? {};

    if (command && command.trim()) {
      const op = this._byCommand.get(command.trim());
      if (op) return { matched: [this.toDescription(op)] };
      return { matched: [], suggestions: this.suggestCommands(command.trim()) };
    }
    if (toolName && toolName.trim()) {
      const op = this._byToolName.get(toolName.trim());
      if (op) return { matched: [this.toDescription(op)] };
      return { matched: [], suggestions: this.suggestCommands(toolName.trim()) };
    }
    if (category && category.trim()) {
      const wanted = category.trim().toLowerCase();
      const matched = this._ops
        .filter((op) => categoryOfCommand(op.command).toLowerCase() === wanted)
        .map((op) => this.toDescription(op));
      return { matched };
    }
    return { matched: this._ops.map((op) => this.toDescription(op)) };
  }

  /**
   * Nearest valid op commands to an unknown command or tool name. Same-category candidates
   * are ranked first; ties broken by edit distance to the op-name segment. Used by
   * ops.describe and by the server's "Unknown tool" error to suggest in-category matches.
   */
  suggestCommands(query: string, limit = 5): string[] {
    const q = (query ?? "").trim();
    if (!q) return [];
    // Derive the (category, leaf) from either a command "cat.op" or a tool "unity_cat_op".
    const cat = q.includes(".") ? categoryOfCommand(q) : categoryOfToolName(q);
    const leaf = q.includes(".")
      ? q.slice(q.indexOf(".") + 1)
      : q.replace(/^unity_[a-z0-9]+_/i, "").replace(/^unity_/i, "");
    const ql = q.toLowerCase();

    const scored = this._ops.map((op) => {
      const opCat = categoryOfCommand(op.command);
      const opLeaf = op.command.slice(op.command.indexOf(".") + 1);
      const sameCat = cat && opCat.toLowerCase() === cat.toLowerCase() ? 0 : 1;
      const leafDist = levenshtein(leaf.toLowerCase(), opLeaf.toLowerCase());
      const fullDist = Math.min(
        levenshtein(ql, op.command.toLowerCase()),
        levenshtein(ql, op.toolName.toLowerCase()),
      );
      return { command: op.command, sameCat, leafDist, fullDist };
    });

    return scored
      .sort((a, b) =>
        a.sameCat - b.sameCat ||
        a.leafDist - b.leafDist ||
        a.fullDist - b.fullDist ||
        a.command.localeCompare(b.command),
      )
      .slice(0, limit)
      .map((s) => s.command);
  }

  /** Nearest valid TOOL names to an unknown tool name (for the server's "Unknown tool" error). */
  suggestToolNames(query: string, limit = 5): string[] {
    return this.suggestCommands(query, limit)
      .map((command) => this._byCommand.get(command)?.toolName)
      .filter((t): t is string => typeof t === "string");
  }

  /** Convert all ops to MCP SDK Tool format. */
  toMCPTools(): MCPTool[] {
    return this._ops.map((op) => ({
      name: op.toolName,
      description: op.description,
      inputSchema: withRoutingProjectParameter(op.inputSchema),
    }));
  }
}

function withRoutingProjectParameter(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== "object") {
    return schema;
  }

  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};

  return {
    ...schema,
    properties: {
      ...properties,
      project: routingProjectSchema,
    },
  };
}
