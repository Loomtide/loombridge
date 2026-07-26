import assert from "node:assert/strict";
import test from "node:test";
import { OpRegistry, normalizeBatchOperations } from "../../../surfaces/op-registry.js";

const registry = new OpRegistry();

test("OpRegistry: has expected total op count", () => {
  const allOps = registry.getAll();
  // scene: 26 (added duplicate_object, set_parent, set_sibling_index, set_active, create_primitive, set_layer, set_tag, get_render_settings, set_render_settings, find_references_to, validate_references, snapshot_gameplay_geometry, compare_gameplay_geometry), editor: 19 (added refresh_assets, set_show_work, show_work_pulse, set_game_view_size, focus_game_view, tick, execute_menu_item, get_project_diagnostics, audit_mobile_assets), input: 11 (added observe_start, observe_stop, pointer_tap, pointer_tap_world), runtime: 10 (added measure_motion, probe, capture_sequence, capture_input_motion, capture_pointer_motion, capture_pointer_hold_motion, sample_animator), component: 6, code: 4, animator: 9 (added set_state_motion), ui: 9 (added scan_text_components, get_screen_rects, dispatch_pointer, set_text_style), asset: 19 (added picker_open, picker_state, picker_close, browser_open, create_prefab_variant, replace_with_prefab, set_texture_import_settings, channel_pack, set_renderer_materials, list_sub_assets, inspect_model_importer, configure_model_importer, inspect_audio_importer, configure_audio_importer), package: 4 (add, list, remove, search), capture: 1 (invoke_static), ops: 3 (batch, list, describe)
  // Total: 121
  assert.equal(allOps.length, 121);
});

test("OpRegistry: scene.create_primitive is registered (RCL-T01 gray-box blockout op)", () => {
  const op = registry.getByCommand("scene.create_primitive");
  assert.ok(op, "Should find scene.create_primitive");
  assert.equal(op!.toolName, "unity_scene_create_primitive");
  const props = (op!.inputSchema as { properties: Record<string, unknown>; required: string[] });
  assert.deepEqual(props.required, ["primitive"]);
  const primitive = props.properties.primitive as { enum: string[] };
  assert.deepEqual(primitive.enum, ["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"]);
  assert.ok(props.properties.addCollider, "create_primitive should advertise addCollider");
  assert.equal(registry.getByToolName("unity_scene_create_primitive")!.command, "scene.create_primitive");
});

test("OpRegistry: scene.find_object advertises name + path + locator (RCL-T04 unified resolution)", () => {
  const op = registry.getByCommand("scene.find_object");
  assert.ok(op, "Should find scene.find_object");
  const props = (op!.inputSchema as { properties: Record<string, unknown>; required?: string[] });
  assert.ok(props.properties.name, "find_object should still accept name");
  assert.ok(props.properties.path, "find_object should accept a path (unified with get_snapshot)");
  assert.ok(props.properties.locator, "find_object should accept a full locator");
  assert.ok(!(props.required ?? []).includes("name"), "name must no longer be required");
});

test("OpRegistry: getByCommand returns correct definition for scene.create_object", () => {
  const op = registry.getByCommand("scene.create_object");
  assert.ok(op, "Should find scene.create_object");
  assert.equal(op!.command, "scene.create_object");
  assert.equal(op!.toolName, "unity_scene_create_object");
  assert.ok(op!.description.length > 0, "Should have a description");
});

test("OpRegistry: getByToolName roundtrips with getByCommand", () => {
  const byCommand = registry.getByCommand("scene.create_object");
  assert.ok(byCommand);

  const byTool = registry.getByToolName("unity_scene_create_object");
  assert.ok(byTool);

  assert.equal(byCommand!.command, byTool!.command);
  assert.equal(byCommand!.toolName, byTool!.toolName);
});

test("OpRegistry: toMCPTools returns array with correct shape", () => {
  const tools = registry.toMCPTools();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 0);

  for (const tool of tools) {
    assert.ok(typeof tool.name === "string", `tool.name must be string, got ${typeof tool.name}`);
    assert.ok(typeof tool.description === "string", `tool.description must be string for ${tool.name}`);
    assert.ok(typeof tool.inputSchema === "object", `tool.inputSchema must be object for ${tool.name}`);
  }
});

test("OpRegistry: editor.focus_game_view degrades gracefully instead of hard-blocking (RCL-T09)", () => {
  const op = registry.getByCommand("editor.focus_game_view");
  assert.ok(op, "Missing editor.focus_game_view");
  assert.equal(op!.toolName, "unity_editor_focus_game_view");
  assert.match(op!.description, /world-pointer/i);
  // Focus is now best-effort: the description must advertise the soft-degrade path.
  assert.match(op!.description, /focusDegraded/);
  assert.match(op!.description, /runInBackground/);
  assert.deepEqual(op!.inputSchema, { type: "object", properties: {} });
});

test("OpRegistry: editor.tick is an async deterministic sim-advance (RCL-T09)", () => {
  const op = registry.getByCommand("editor.tick");
  assert.ok(op, "Missing editor.tick");
  assert.equal(op!.toolName, "unity_editor_tick");
  assert.equal(op!.isAsync, true);
  const schema = op!.inputSchema as { properties: Record<string, { type?: string }> };
  assert.equal(schema.properties.frames?.type, "integer");
  assert.equal(schema.properties.durationMs?.type, "number");
  assert.equal(schema.properties.captureFps?.type, "integer");
  assert.match(op!.description, /PLAY_MODE_REQUIRED/);
});

test("OpRegistry: scene.set_layer + scene.set_tag are registered (RCL-T05)", () => {
  const layer = registry.getByCommand("scene.set_layer");
  assert.ok(layer, "Missing scene.set_layer");
  assert.equal(layer!.toolName, "unity_scene_set_layer");
  const layerSchema = layer!.inputSchema as { properties: Record<string, { type?: unknown }>; required?: string[] };
  assert.deepEqual(layerSchema.required, ["locator", "layer"]);
  assert.deepEqual(layerSchema.properties.layer?.type, ["string", "number"]);

  const tag = registry.getByCommand("scene.set_tag");
  assert.ok(tag, "Missing scene.set_tag");
  assert.equal(tag!.toolName, "unity_scene_set_tag");
  const tagSchema = tag!.inputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
  assert.deepEqual(tagSchema.required, ["locator", "tag"]);
  assert.equal(tagSchema.properties.tag?.type, "string");
});

test("OpRegistry: model-importer + sub-asset ops are registered (RLH-W1)", () => {
  const list = registry.getByCommand("asset.list_sub_assets");
  assert.ok(list, "Missing asset.list_sub_assets");
  assert.equal(list!.toolName, "unity_asset_list_sub_assets");
  const listSchema = list!.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(listSchema.required, ["asset_path"]);

  const inspect = registry.getByCommand("asset.inspect_model_importer");
  assert.ok(inspect, "Missing asset.inspect_model_importer");
  assert.equal(inspect!.toolName, "unity_asset_inspect_model_importer");
  const inspectSchema = inspect!.inputSchema as { required: string[] };
  assert.deepEqual(inspectSchema.required, ["asset_path"]);

  const configure = registry.getByCommand("asset.configure_model_importer");
  assert.ok(configure, "Missing asset.configure_model_importer");
  assert.equal(configure!.toolName, "unity_asset_configure_model_importer");
  const configureSchema = configure!.inputSchema as {
    properties: Record<string, { type?: unknown }>;
    required: string[];
  };
  assert.deepEqual(configureSchema.required, ["asset_path"]);
  // animation_type / avatar_setup accept either the enum name or the raw .fbx.meta int.
  assert.deepEqual(configureSchema.properties.animation_type?.type, ["string", "integer"]);
  assert.deepEqual(configureSchema.properties.avatar_setup?.type, ["string", "integer"]);
  assert.ok(configureSchema.properties.clip_overrides, "configure should advertise clip_overrides");

  // A rigged-FBX SaveAndReimport routinely exceeds the generic 10s wire fallback
  // (the motivating dogfood case), and the combined settings+overrides path costs
  // two reimports — the entry must declare a realistic default and a per-call
  // timeoutMs (resolveOpTimeoutMs honors it for every op, sync or async).
  assert.equal(configure!.defaultTimeoutMs, 90000, "configure needs a realistic reimport timeout");
  assert.equal(configureSchema.properties.timeoutMs?.type, "number", "configure should advertise timeoutMs");

  // list/inspect are fast reads — they stay on the generic fallback.
  assert.equal(list!.defaultTimeoutMs, undefined);
  assert.equal(inspect!.defaultTimeoutMs, undefined);
});

test("OpRegistry: audio-importer ops are registered (RLT2 audio substrate)", () => {
  const inspect = registry.getByCommand("asset.inspect_audio_importer");
  assert.ok(inspect, "Missing asset.inspect_audio_importer");
  assert.equal(inspect!.toolName, "unity_asset_inspect_audio_importer");
  const inspectSchema = inspect!.inputSchema as { required: string[] };
  assert.deepEqual(inspectSchema.required, ["asset_path"]);
  assert.equal(registry.getByToolName("unity_asset_inspect_audio_importer")!.command, "asset.inspect_audio_importer");
  // A plain read — stays on the generic wire fallback, no reimport timeout.
  assert.equal(inspect!.defaultTimeoutMs, undefined);

  const configure = registry.getByCommand("asset.configure_audio_importer");
  assert.ok(configure, "Missing asset.configure_audio_importer");
  assert.equal(configure!.toolName, "unity_asset_configure_audio_importer");
  const configureSchema = configure!.inputSchema as {
    properties: Record<string, { type?: unknown }>;
    required: string[];
  };
  assert.deepEqual(configureSchema.required, ["asset_path"]);
  // Enum params accept the name OR the raw .meta int.
  assert.deepEqual(configureSchema.properties.load_type?.type, ["string", "integer"]);
  assert.deepEqual(configureSchema.properties.compression_format?.type, ["string", "integer"]);
  assert.deepEqual(configureSchema.properties.sample_rate_setting?.type, ["string", "integer"]);
  assert.ok(configureSchema.properties.force_to_mono, "configure should advertise force_to_mono");
  assert.ok(configureSchema.properties.preload_audio_data, "configure should advertise preload_audio_data");
  assert.ok(configureSchema.properties.quality, "configure should advertise quality");
  // conversionMode is a public int32 field on AudioImporterSampleSettings in the
  // 6000.3 assembly with NO public enum type — advertised as a raw integer only
  // (never ["string","integer"]: there are no names to parse).
  assert.deepEqual(configureSchema.properties.conversion_mode?.type, "integer");
  assert.match(inspect!.description, /conversion_mode/, "inspect must document the complete settings dump");

  // An audio reimport re-encodes the clip and can exceed the 10s wire fallback,
  // so the entry declares the 90s reimport-op convention + a per-call timeoutMs.
  assert.equal(configure!.defaultTimeoutMs, 90000, "configure needs a realistic reimport timeout");
  assert.equal(configureSchema.properties.timeoutMs?.type, "number", "configure should advertise timeoutMs");
});

test("OpRegistry: scene.find_references_to + scene.validate_references are registered (RLH-W2 reference integrity)", () => {
  const find = registry.getByCommand("scene.find_references_to");
  assert.ok(find, "Missing scene.find_references_to");
  assert.equal(find!.toolName, "unity_scene_find_references_to");
  const findSchema = find!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(findSchema.required, ["locator"]);
  assert.ok(findSchema.properties.max_results, "find_references_to should advertise max_results");
  assert.equal(registry.getByToolName("unity_scene_find_references_to")!.command, "scene.find_references_to");

  const validate = registry.getByCommand("scene.validate_references");
  assert.ok(validate, "Missing scene.validate_references");
  assert.equal(validate!.toolName, "unity_scene_validate_references");
  const validateSchema = validate!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  // scope is optional (default: whole scene) — no required fields.
  assert.ok(!validateSchema.required || validateSchema.required.length === 0);
  assert.ok(validateSchema.properties.include_prefab_defaults, "validate_references should advertise include_prefab_defaults");
  assert.ok(validateSchema.properties.scope, "validate_references should advertise scope");
});

test("OpRegistry: asset.replace_with_prefab advertises remap_references (RLH-W2 reference remap)", () => {
  const op = registry.getByCommand("asset.replace_with_prefab");
  assert.ok(op, "Missing asset.replace_with_prefab");
  const schema = op!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.remap_references, "replace_with_prefab should advertise remap_references");
  assert.ok(schema.properties.remapReferences, "replace_with_prefab should advertise the remapReferences alias");
  assert.ok(schema.properties.allow_cross_scene_remap, "replace_with_prefab should advertise allow_cross_scene_remap");
  assert.ok(schema.properties.allowCrossSceneRemap, "replace_with_prefab should advertise the allowCrossSceneRemap alias");
  // The reference-integrity add is opt-in: it must not become a required param (behavior unchanged by default).
  assert.deepEqual(schema.required, ["path", "locators", "expected_scene_path"]);
});

test("OpRegistry: every tool name follows unity_{category}_{op} pattern", () => {
  const allOps = registry.getAll();
  const pattern = /^unity_[a-z]+_[a-z_]+$/;

  for (const op of allOps) {
    assert.match(
      op.toolName,
      pattern,
      `Tool name "${op.toolName}" does not match pattern unity_{category}_{op}`
    );
  }
});

test("OpRegistry: no duplicate tool names", () => {
  const allOps = registry.getAll();
  const names = new Set<string>();

  for (const op of allOps) {
    assert.ok(
      !names.has(op.toolName),
      `Duplicate tool name: ${op.toolName}`
    );
    names.add(op.toolName);
  }
});

test("OpRegistry: no duplicate commands", () => {
  const allOps = registry.getAll();
  const commands = new Set<string>();

  for (const op of allOps) {
    assert.ok(
      !commands.has(op.command),
      `Duplicate command: ${op.command}`
    );
    commands.add(op.command);
  }
});

test("OpRegistry: all inputSchemas have type 'object' at root", () => {
  const allOps = registry.getAll();

  for (const op of allOps) {
    const schema = op.inputSchema as Record<string, unknown>;
    assert.equal(
      schema.type,
      "object",
      `inputSchema.type must be "object" for ${op.command}, got "${schema.type}"`
    );
  }
});

test("OpRegistry: editor.wait_for is marked async", () => {
  const op = registry.getByCommand("editor.wait_for");
  assert.ok(op, "Should find editor.wait_for");
  assert.equal(op!.isAsync, true);
});

test("OpRegistry: editor.wait_for supports deterministic frames and delayMs parameters", () => {
  const op = registry.getByCommand("editor.wait_for");
  assert.ok(op);

  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string }>;
  };

  assert.equal(schema.properties.frames?.type, "number");
  assert.equal(schema.properties.delayMs?.type, "number");
});

test("OpRegistry: editor.screenshot has view param in schema", () => {
  const op = registry.getByCommand("editor.screenshot");
  assert.ok(op);
  const schema = op!.inputSchema as { properties: Record<string, unknown> };
  assert.ok(schema.properties.view, "Should have view property in schema");
});

test("OpRegistry: editor.screenshot advertises outputPath for named artifacts", () => {
  const op = registry.getByCommand("editor.screenshot");
  assert.ok(op);
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string; description?: string }>;
  };
  assert.equal(schema.properties.outputPath?.type, "string");
  assert.match(schema.properties.outputPath?.description ?? "", /named screenshot artifact|server-side file path/i);
  assert.match(op!.description, /Do not scrape trace\/artifacts/);
});

test("OpRegistry: ui.get_screen_rects advertises optional locators + UI-gate data", () => {
  const op = registry.getByCommand("ui.get_screen_rects");
  assert.ok(op);
  assert.equal(op!.toolName, "unity_ui_get_screen_rects");
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string }>;
    required?: string[];
  };
  assert.equal(schema.properties.locators?.type, "array");
  assert.ok(schema.properties.camera, "should advertise an optional camera hint");
  // locators MUST be optional — omitting it triggers auto-discovery.
  assert.ok(!(schema.required ?? []).includes("locators"));
  assert.match(op!.description, /safe-area/);
  assert.match(op!.description, /viewportRect|visibilityReason/);
});

test("OpRegistry: ui.set_text_style advertises styling fields + requires locator", () => {
  const op = registry.getByCommand("ui.set_text_style");
  assert.ok(op, "Should find ui.set_text_style");
  assert.equal(op!.toolName, "unity_ui_set_text_style");
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
  };
  assert.deepEqual(schema.required, ["locator"]);
  assert.equal(schema.properties.font_size?.type, "number");
  assert.equal(schema.properties.best_fit?.type, "boolean");
  assert.ok(schema.properties.color, "should advertise a color field");
  assert.deepEqual(schema.properties.font_style?.enum, [
    "Normal",
    "Bold",
    "Italic",
    "BoldAndItalic",
  ]);
  assert.ok(schema.properties.alignment?.enum?.includes("MiddleCenter"));
  assert.equal(registry.getByToolName("unity_ui_set_text_style")!.command, "ui.set_text_style");
});

test("OpRegistry: editor.get_project_diagnostics is a no-arg read op (RLH-W2)", () => {
  const op = registry.getByCommand("editor.get_project_diagnostics");
  assert.ok(op, "Missing editor.get_project_diagnostics");
  assert.equal(op!.toolName, "unity_editor_get_project_diagnostics");
  // Read-only diagnostics: never async, no required args.
  assert.notEqual(op!.isAsync, true);
  assert.deepEqual(op!.inputSchema, { type: "object", properties: {} });
  // The payload contract is documented so agents know what to read.
  assert.match(op!.description, /render_pipeline/);
  assert.match(op!.description, /installed_packages/);
  assert.match(op!.description, /disabled_built_in_modules/);
  // D2: a failed package query is null + package_query_failed, never an empty array.
  assert.match(op!.description, /package_query_failed/);
  assert.match(op!.description, /NULL ≠ \[\]/);
  // D3: editor and player assembly sets are separate counts.
  assert.match(op!.description, /editor_assembly_count/);
  assert.match(op!.description, /player_assembly_count/);
  assert.match(op!.description, /last_compile/);
  // D5: results are a call-time snapshot of the package registry.
  assert.match(op!.description, /at call time/);
  assert.equal(registry.getByToolName("unity_editor_get_project_diagnostics")!.command, "editor.get_project_diagnostics");
});

test("OpRegistry: editor.wait_for documents the play-mode compile-deferral hint (RLH-W2)", () => {
  const op = registry.getByCommand("editor.wait_for");
  assert.ok(op);
  assert.match(op!.description, /compileDeferred/);
  assert.match(op!.description, /Play Mode/);
  // D1: the hint is informational + conditional — it fires on the innocent settle wait too,
  // must say what it cannot prove, and must not read as a stop-Play-Mode instruction.
  assert.match(op!.description, /INFORMATIONAL/);
  assert.match(op!.description, /NORMAL outcome/);
  assert.match(op!.description, /CANNOT confirm/);
  assert.match(op!.description, /NOT an instruction to stop Play Mode/);
  assert.doesNotMatch(op!.description, /editor\.stop/);
});

test("OpRegistry: component.set_property documents AudioClip + AudioMixerGroup refs (RLH-W2)", () => {
  const op = registry.getByCommand("component.set_property");
  assert.ok(op);
  assert.match(op!.description, /AudioClip/);
  assert.match(op!.description, /AudioMixerGroup/);
  const schema = op!.inputSchema as { properties: Record<string, { description?: string }> };
  assert.match(schema.properties.value?.description ?? "", /AudioMixerGroup|\.mixer/);
});

test("OpRegistry: editor.set_show_work exposes enabled flag", () => {
  const op = registry.getByCommand("editor.set_show_work");
  assert.ok(op);
  assert.equal(op!.toolName, "unity_editor_set_show_work");
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string }>;
  };
  assert.equal(schema.properties.enabled?.type, "boolean");
});

test("OpRegistry: editor.show_work_pulse exposes locator and demo note fields", () => {
  const op = registry.getByCommand("editor.show_work_pulse");
  assert.ok(op);
  assert.equal(op!.toolName, "unity_editor_show_work_pulse");
  const schema = op!.inputSchema as {
    required?: string[];
    properties: Record<string, { type?: string }>;
  };
  assert.deepEqual(schema.required, ["locator"]);
  assert.equal(schema.properties.locator?.type, "object");
  assert.equal(schema.properties.note?.type, "string");
  assert.equal(schema.properties.frame?.type, "boolean");
  assert.equal(schema.properties.component_type?.type, "string");
});

test("OpRegistry: ui.add_text exposes text_backend enum", () => {
  const op = registry.getByCommand("ui.add_text");
  assert.ok(op);
  const schema = op!.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
  };

  assert.ok(schema.properties.text_backend, "Should have text_backend property");
  assert.deepEqual(
    schema.properties.text_backend.enum,
    ["tmp", "legacy", "auto"],
    "text_backend enum should contain tmp, legacy, auto",
  );
});

test("OpRegistry: asset.create_sprite supports external image inputs", () => {
  const op = registry.getByCommand("asset.create_sprite");
  assert.ok(op);
  const schema = op!.inputSchema as { properties: Record<string, unknown> };

  assert.ok(schema.properties.source_path, "Should have source_path property");
  assert.ok(schema.properties.source_url, "Should have source_url property");
});

test("OpRegistry: component.set_property value accepts arrays (Sprite[] wiring)", () => {
  const op = registry.getByCommand("component.set_property");
  assert.ok(op);
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string[] }>;
  };

  const valueType = schema.properties.value?.type;
  assert.ok(Array.isArray(valueType), "value.type should be a union array");
  assert.ok(
    valueType!.includes("array"),
    "value.type must include 'array' so Sprite[]/list properties can be set",
  );
  assert.ok(
    valueType!.includes("object") && valueType!.includes("string"),
    "value.type must still include object and string for object-reference payloads",
  );
});

test("OpRegistry: animator.apply_spec has higher default timeout", () => {
  const op = registry.getByCommand("animator.apply_spec");
  assert.ok(op);
  assert.ok(
    op!.defaultTimeoutMs! >= 30000,
    `apply_spec timeout should be >= 30000, got ${op!.defaultTimeoutMs}`
  );
});

test("OpRegistry: animator.set_state_motion binds a state motion by asset_path/sub_asset", () => {
  const op = registry.getByCommand("animator.set_state_motion");
  assert.ok(op, "Missing animator.set_state_motion");
  assert.equal(op!.toolName, "unity_animator_set_state_motion");
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: unknown; properties?: Record<string, unknown> }>;
    required?: string[];
  };
  // motion is optional now (speed-only updates allowed); the "at least one of
  // motion/speed" rule is enforced by the handler.
  assert.deepEqual(schema.required, ["controller_path", "state_name"]);
  // motion accepts either a string .anim path or a { asset_path, sub_asset } object.
  assert.deepEqual(schema.properties.motion?.type, ["string", "object"]);
  assert.ok(schema.properties.motion?.properties?.asset_path, "motion should expose asset_path");
  assert.ok(schema.properties.motion?.properties?.sub_asset, "motion should expose sub_asset");
  assert.equal(schema.properties.speed?.type, "number");
  // The refresh-and-retry / not-imported semantics are documented on the op.
  assert.match(op!.description, /not be imported yet/);
  assert.match(op!.description, /type 2|type 3/);
  // D2/D5: unknown motion keys refused; ambiguous multi-clip containers refused.
  assert.match(op!.description, /is refused \(INVALID_PARAMS\)/);
  assert.match(op!.description, /refuses listing the candidates/);
  // D7: speed-only updates + accurate change flags are documented.
  assert.match(op!.description, /speed-only updates allowed/);
  assert.match(op!.description, /motionChanged\/speedChanged/);
});

test("OpRegistry: animator.apply_spec advertises per-state motion + speed binding", () => {
  const op = registry.getByCommand("animator.apply_spec");
  assert.ok(op);
  assert.match(op!.description, /motion/i);
  assert.match(op!.description, /INVALID_PARAMS/);
  // D1/D3: whole-spec refusal surface + atomic validate-then-apply are documented.
  assert.match(op!.description, /ATOMIC/);
  assert.match(op!.description, /leaves the controller untouched/);
  assert.match(op!.description, /any unknown key anywhere in the spec/i);
  assert.match(op!.description, /defaultState naming a missing state refuses/);
  const schema = op!.inputSchema as {
    properties: {
      spec?: {
        properties?: {
          layers?: {
            items?: {
              properties?: {
                states?: { items?: { properties?: Record<string, unknown> } };
                transitions?: { items?: { properties?: Record<string, unknown>; required?: string[] } };
              };
            };
          };
        };
      };
    };
  };
  const layerProps = schema.properties.spec?.properties?.layers?.items?.properties;
  const stateProps = layerProps?.states?.items?.properties;
  assert.ok(stateProps?.motion, "apply_spec state schema should expose motion");
  assert.ok(stateProps?.speed, "apply_spec state schema should expose speed");
  // Transition schema is now fully documented (D1 refusal surface).
  const transItems = layerProps?.transitions?.items;
  assert.ok(transItems?.properties?.from, "transition schema should expose from");
  assert.ok(transItems?.properties?.conditions, "transition schema should expose conditions");
  assert.deepEqual(transItems?.required, ["from", "to"]);
});

test("OpRegistry: component.describe maps to same definition as component.get_properties", () => {
  const describe = registry.getByCommand("component.describe");
  const getProps = registry.getByCommand("component.get_properties");
  assert.ok(describe);
  assert.ok(getProps);
  // They should be separate ops but with similar schemas
  assert.notEqual(describe!.toolName, getProps!.toolName);
});

test("OpRegistry: all categories are covered", () => {
  const allOps = registry.getAll();
  const categories = new Set(allOps.map((op) => op.command.split(".")[0]));

  const expected = ["scene", "editor", "component", "code", "animator", "ui", "asset", "input", "runtime"];
  for (const cat of expected) {
    assert.ok(categories.has(cat), `Category "${cat}" should be present`);
  }
});

test("OpRegistry: runtime tools are registered with comparator schemas", () => {
  const waitOp = registry.getByCommand("runtime.wait_for_condition");
  assert.ok(waitOp, "Missing runtime.wait_for_condition");
  assert.equal(waitOp!.isAsync, true);

  const assertOp = registry.getByCommand("runtime.assert_condition");
  assert.ok(assertOp, "Missing runtime.assert_condition");

  const waitSchema = waitOp!.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
    required?: string[];
  };
  const assertSchema = assertOp!.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
    required?: string[];
  };

  assert.deepEqual(
    assertSchema.properties.operator?.enum,
    ["equals", "not_equals", "greater_than", "less_than", "approx", "contains"],
  );
  assert.ok(assertSchema.required?.includes("expected"), "runtime.assert_condition should require expected");
  assert.ok(waitSchema.required?.includes("expected"), "runtime.wait_for_condition should require expected");
});

test("OpRegistry: input tools are registered with unity_input_* names", () => {
  const expected = [
    ["input.get_capabilities", "unity_input_get_capabilities"],
    ["input.begin_session", "unity_input_begin_session"],
    ["input.key_down", "unity_input_key_down"],
    ["input.key_up", "unity_input_key_up"],
    ["input.key_tap", "unity_input_key_tap"],
    ["input.click_ui", "unity_input_click_ui"],
    ["input.end_session", "unity_input_end_session"],
  ] as const;

  for (const [command, toolName] of expected) {
    const op = registry.getByCommand(command);
    assert.ok(op, `Missing op for ${command}`);
    assert.equal(op!.toolName, toolName);
    assert.ok(registry.getByToolName(toolName), `Missing tool lookup for ${toolName}`);
  }
});

test("OpRegistry: input key ops enforce key string schema", () => {
  const keyOps = ["input.key_down", "input.key_up", "input.key_tap"];
  for (const command of keyOps) {
    const op = registry.getByCommand(command);
    assert.ok(op, `Missing op for ${command}`);
    const schema = op!.inputSchema as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    assert.equal(schema.properties.key?.type, "string", `${command} should require string key`);
    assert.ok(schema.required?.includes("key"), `${command} should mark key as required`);
  }
});

test("OpRegistry: input.pointer_tap_world projects world coordinates through a camera", () => {
  const op = registry.getByCommand("input.pointer_tap_world");
  assert.ok(op, "Missing input.pointer_tap_world");
  assert.equal(op!.toolName, "unity_input_pointer_tap_world");
  assert.match(op!.description, /WORLD coordinate/);
  assert.match(op!.description, /Camera\.main/);

  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string }>;
    required?: string[];
  };
  assert.equal(schema.properties.x?.type, "number");
  assert.equal(schema.properties.y?.type, "number");
  assert.equal(schema.properties.z?.type, "number");
  assert.ok(schema.properties.camera, "should expose optional camera locator");
  assert.deepEqual(schema.required, ["x", "y"]);
});

test("OpRegistry: ui.scan_text_components registered with optional locator scope", () => {
  const op = registry.getByCommand("ui.scan_text_components");
  assert.ok(op, "Missing ui.scan_text_components");
  assert.equal(op!.toolName, "unity_ui_scan_text_components");
  const schema = op!.inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(schema.properties.locator, "Should expose an optional locator scope");
  // locator is optional (scene-wide scan when omitted), so no required entries.
  assert.ok(!schema.required || schema.required.length === 0, "locator should be optional");
});

test("OpRegistry: scene.get_screen_rects requires locators and exposes boundsMode enum", () => {
  const op = registry.getByCommand("scene.get_screen_rects");
  assert.ok(op, "Missing scene.get_screen_rects");
  assert.equal(op!.toolName, "unity_scene_get_screen_rects");
  const schema = op!.inputSchema as {
    properties: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
  };
  assert.equal(schema.properties.locators?.type, "array", "locators should be an array");
  assert.ok(schema.required?.includes("locators"), "locators should be required");
  assert.deepEqual(
    schema.properties.boundsMode?.enum,
    ["opaque", "renderer", "collider"],
    "boundsMode enum should be opaque/renderer/collider",
  );
});

test("OpRegistry: scene.verify_manifest accepts inline manifest or manifestPath", () => {
  const op = registry.getByCommand("scene.verify_manifest");
  assert.ok(op, "Missing scene.verify_manifest");
  assert.equal(op!.toolName, "unity_scene_verify_manifest");
  const schema = op!.inputSchema as { properties: Record<string, { type?: string }> };
  assert.equal(schema.properties.manifest?.type, "array", "Should accept inline manifest array");
  assert.equal(schema.properties.manifestPath?.type, "string", "Should accept manifestPath");
  assert.ok(schema.properties.matching, "Should expose matching options");
  assert.ok(schema.properties.placeholderRule, "Should expose placeholderRule");
});

test("OpRegistry: ops.batch is registered as unity_ops_batch and requires operations", () => {
  const op = registry.getByCommand("ops.batch");
  assert.ok(op, "Missing ops.batch");
  assert.equal(op!.toolName, "unity_ops_batch");
  assert.equal(op!.isAsync, true, "ops.batch should be marked async (long-running)");

  const schema = op!.inputSchema as {
    properties: Record<string, {
      anyOf?: Array<{ type?: string; items?: { properties?: Record<string, unknown>; required?: string[] } }>;
    }>;
    required?: string[];
  };
  // RCL-T11: operations accepts EITHER a native array OR a JSON-encoded string.
  const anyOf = schema.properties.operations?.anyOf;
  assert.ok(Array.isArray(anyOf), "operations should be an anyOf(array|string)");
  const arrayBranch = anyOf!.find((b) => b.type === "array");
  const stringBranch = anyOf!.find((b) => b.type === "string");
  assert.ok(arrayBranch, "operations should accept a native array");
  assert.ok(stringBranch, "operations should accept a JSON string");
  assert.ok(schema.required?.includes("operations"), "operations should be required");

  // The array branch's items carry a required command plus optional params.
  const itemProps = arrayBranch!.items?.properties;
  assert.ok(itemProps?.command, "operation items should expose a 'command' field");
  assert.ok(itemProps?.params, "operation items should expose a 'params' field");
  assert.ok(
    arrayBranch!.items?.required?.includes("command"),
    "operation items should require 'command'",
  );

  // Lookup by tool name round-trips.
  assert.ok(registry.getByToolName("unity_ops_batch"), "Missing tool lookup for unity_ops_batch");
});

test("normalizeBatchOperations: accepts a native array of { command, params }", () => {
  const out = normalizeBatchOperations([
    { command: "scene.create_object", params: { name: "A" } },
    { command: "component.set_property" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, "scene.create_object");
  assert.deepEqual(out[0].params, { name: "A" });
  assert.equal(out[1].command, "component.set_property");
  assert.equal(out[1].params, undefined);
});

test("normalizeBatchOperations: parses a JSON-encoded string payload (RCL-T11)", () => {
  const out = normalizeBatchOperations(
    JSON.stringify([{ command: "scene.create_object", params: { name: "B" } }]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].command, "scene.create_object");
  assert.deepEqual(out[0].params, { name: "B" });
});

test("normalizeBatchOperations: parses per-entry stringified objects", () => {
  const out = normalizeBatchOperations([
    JSON.stringify({ command: "scene.delete_object", params: { locator: { path: "/X" } } }),
  ]);
  assert.equal(out[0].command, "scene.delete_object");
  assert.deepEqual(out[0].params, { locator: { path: "/X" } });
});

test("normalizeBatchOperations: rejects a non-JSON string with a precise message", () => {
  assert.throws(() => normalizeBatchOperations("{not json"), /not valid JSON/);
});

test("normalizeBatchOperations: rejects a non-array payload", () => {
  assert.throws(() => normalizeBatchOperations({ command: "x" }), /must be an array/);
});

test("normalizeBatchOperations: rejects an entry missing a command, naming the index", () => {
  assert.throws(
    () => normalizeBatchOperations([{ params: {} }]),
    /index 0 is missing a non-empty 'command'/,
  );
});

test("normalizeBatchOperations: rejects a non-object params, naming the index and command", () => {
  assert.throws(
    () => normalizeBatchOperations([{ command: "scene.create_object", params: [1, 2] }]),
    /index 0 \('scene.create_object'\) has a 'params' that is not an object/,
  );
});

test("OpRegistry: unity_ops_batch is exposed via toMCPTools", () => {
  const tools = registry.toMCPTools();
  const batchTool = tools.find((t) => t.name === "unity_ops_batch");
  assert.ok(batchTool, "unity_ops_batch should appear in toMCPTools()");
  assert.ok(typeof batchTool!.description === "string" && batchTool!.description.length > 0);
  assert.equal((batchTool!.inputSchema as { type?: string }).type, "object");
});

test("OpRegistry: runtime.probe supports multi-driver phases (phases[].drivers)", () => {
  const op = registry.getByCommand("runtime.probe");
  assert.ok(op, "Missing runtime.probe");
  const schema = op!.inputSchema as {
    properties: {
      phases?: { items?: { properties?: Record<string, unknown> } };
    };
    required?: string[];
  };
  const phaseProps = schema.properties.phases?.items?.properties;
  assert.ok(phaseProps?.drivers, "phases items should support a 'drivers' array for multi-driver phases");
  assert.ok(phaseProps?.value, "phases items should still support single-driver 'value' (back-compat)");
  // driver is now optional (multi-driver form supplies per-phase drivers instead).
  assert.ok(!schema.required?.includes("driver"), "driver should be optional now");
  assert.ok(schema.required?.includes("measure"), "measure should remain required");
  assert.ok(schema.required?.includes("phases"), "phases should remain required");
});

test("OpRegistry: runtime.capture_sequence supports named in-loop screenshots", () => {
  const op = registry.getByCommand("runtime.capture_sequence");
  assert.ok(op, "Missing runtime.capture_sequence");
  assert.equal(op!.toolName, "unity_runtime_capture_sequence");
  assert.equal(op!.isAsync, true);
  assert.ok((op!.defaultTimeoutMs ?? 0) >= 60000);

  const schema = op!.inputSchema as {
    properties: {
      phases?: { items?: { properties?: Record<string, unknown> } };
      captures?: { items?: { properties?: Record<string, { enum?: string[]; type?: string }> } };
    };
    required?: string[];
  };
  assert.ok(schema.required?.includes("measure"), "measure should be required");
  assert.ok(schema.required?.includes("phases"), "phases should be required");
  assert.ok(schema.required?.includes("captures"), "captures should be required");
  assert.ok(schema.properties.phases?.items?.properties?.drivers, "capture_sequence should support multi-driver phases");
  assert.deepEqual(
    schema.properties.captures?.items?.properties?.trigger?.enum,
    ["start", "end", "atMs", "apexY"],
  );
});

test("OpRegistry: runtime.capture_input_motion drives keyed phases in-loop", () => {
  const op = registry.getByCommand("runtime.capture_input_motion");
  assert.ok(op, "Missing runtime.capture_input_motion");
  assert.equal(op!.toolName, "unity_runtime_capture_input_motion");
  assert.equal(op!.isAsync, true);
  assert.ok((op!.defaultTimeoutMs ?? 0) >= 30000);

  const schema = op!.inputSchema as {
    properties: {
      measure?: unknown;
      captureFps?: unknown;
      phases?: {
        items?: {
          properties?: Record<string, { type?: string; items?: { type?: string } }>;
          required?: string[];
          oneOf?: Array<{ required: string[] }>;
        };
      };
    };
    required?: string[];
  };
  assert.ok(schema.required?.includes("measure"), "measure should be required");
  assert.ok(schema.required?.includes("phases"), "phases should be required");
  assert.ok(schema.properties.captureFps, "should expose captureFps (default 0)");

  const phaseProps = schema.properties.phases?.items?.properties;
  assert.equal(phaseProps?.keys?.type, "array", "phase keys should be an array of key names");
  assert.equal(phaseProps?.keys?.items?.type, "string", "phase key entries should be strings");
  assert.equal(phaseProps?.durationMs?.type, "number", "phase durationMs should be a number");
  assert.equal(phaseProps?.fixedTicks?.type, "integer", "phase fixedTicks should be an integer");
  assert.equal(schema.properties.phases?.items?.required, undefined, "duration can be expressed as durationMs or fixedTicks");
  assert.deepEqual(
    schema.properties.phases?.items?.oneOf,
    [{ required: ["durationMs"] }, { required: ["fixedTicks"] }],
    "phase duration should be expressed as exactly one schema branch",
  );
});

test("OpRegistry: runtime.capture_input_motion advertises L3a sampledFields (additive, optional)", () => {
  const op = registry.getByCommand("runtime.capture_input_motion");
  assert.ok(op, "Missing runtime.capture_input_motion");

  const schema = op!.inputSchema as {
    properties: {
      sampledFields?: {
        type?: string;
        items?: { properties?: Record<string, unknown>; required?: string[] };
      };
    };
    required?: string[];
  };

  // Additive: sampledFields must NOT be required, so existing callers are unaffected.
  assert.ok(!schema.required?.includes("sampledFields"), "sampledFields must remain optional");

  const sf = schema.properties.sampledFields;
  assert.ok(sf, "should expose sampledFields");
  assert.equal(sf!.type, "array", "sampledFields should be an array");

  const itemProps = sf!.items?.properties;
  assert.ok(itemProps?.id, "sampledFields item should have id");
  assert.ok(itemProps?.locator, "sampledFields item should have locator");
  assert.ok(itemProps?.type_name, "sampledFields item should have type_name");
  assert.ok(itemProps?.property_path, "sampledFields item should have property_path");
  // L3a.1: a scalar-returning method getter (Animator.GetBool('jumping')) is the alternative
  // to property_path for signals with no readable field.
  assert.ok(itemProps?.method_name, "sampledFields item should expose method_name (L3a.1 method getter)");
  assert.ok(itemProps?.args, "sampledFields item should expose args for the method getter");
  // property_path is now EITHER/OR with method_name, so it is no longer unconditionally required;
  // only id/locator/type_name are structurally required. The schema can't express the XOR, so the
  // field-vs-method choice (exactly one, never both, never neither) is enforced in the bridge's
  // RuntimeFieldSampler.Resolve (the single chokepoint), NOT by this JSON Schema — see the EditMode tests.
  assert.deepEqual(
    sf!.items?.required,
    ["id", "locator", "type_name"],
    "every sampledFields entry requires id/locator/type_name (property_path XOR method_name enforced in RuntimeFieldSampler.Resolve)",
  );

  // The fieldTimeline response shape is documented in the op description.
  assert.match(op!.description, /fieldTimeline/, "description should document the fieldTimeline response");
  assert.match(op!.description, /unresolved/i, "description should document honest-or-omit unresolved fields");
});

test("OpRegistry: runtime.capture_pointer_motion supports uGUI target or world pointer", () => {
  const op = registry.getByCommand("runtime.capture_pointer_motion");
  assert.ok(op, "Missing runtime.capture_pointer_motion");
  assert.equal(op!.toolName, "unity_runtime_capture_pointer_motion");
  assert.equal(op!.isAsync, true);

  const schema = op!.inputSchema as {
    properties: {
      measure?: unknown;
      target?: unknown;
      world?: { properties?: Record<string, unknown>; required?: string[] };
    };
    required?: string[];
  };

  assert.deepEqual(schema.required, ["measure"], "target/world choice is validated by the bridge");
  assert.ok(schema.properties.target, "should expose uGUI target mode");
  assert.ok(schema.properties.world, "should expose world pointer mode");
  assert.deepEqual(schema.properties.world?.required, ["x", "y"]);
  assert.ok(schema.properties.world?.properties?.camera, "world pointer mode should expose optional camera locator");
  assert.match(op!.description, /actuated:null/, "description should not claim world taps prove actuation");
});

test("OpRegistry: runtime.capture_pointer_hold_motion drives a held joystick drag", () => {
  const op = registry.getByCommand("runtime.capture_pointer_hold_motion");
  assert.ok(op, "Missing runtime.capture_pointer_hold_motion");
  assert.equal(op!.toolName, "unity_runtime_capture_pointer_hold_motion");
  assert.equal(op!.isAsync, true, "the held-drag capture is async (it samples over a window)");

  const schema = op!.inputSchema as {
    properties: {
      measure?: unknown;
      target?: unknown;
      dragTo?: { properties?: Record<string, unknown> };
      releaseMs?: unknown;
      releaseFixedTicks?: { type?: string; minimum?: number; description?: string };
      sampledFields?: { type?: string };
    };
    required?: string[];
  };

  // The defining param: a screen-pixel offset that is HELD (vs capture_pointer_motion's tap).
  assert.ok(schema.properties.dragTo, "should expose dragTo");
  assert.ok(schema.properties.dragTo!.properties?.dx, "dragTo should have dx");
  assert.ok(schema.properties.dragTo!.properties?.dy, "dragTo should have dy");
  // dragTo is optional now: present for joystick drags, omitted for button hold/release.
  assert.deepEqual(
    schema.required,
    ["measure", "target"],
    "measure/target are required; dragTo selects joystick drag mode",
  );
  // releaseMs (optional) enables the decel half of the capture.
  assert.ok(schema.properties.releaseMs, "should expose releaseMs for deceleration capture");
  assert.equal(schema.properties.releaseFixedTicks?.type, "integer", "should expose fixed-tick release for button short-hop");
  assert.equal(schema.properties.releaseFixedTicks?.minimum, 1, "fixed-tick release must be positive");
  assert.match(schema.properties.releaseFixedTicks?.description ?? "", /Mutually exclusive with releaseMs/);
  // Reuses the L3a sampledFields contract.
  assert.equal(schema.properties.sampledFields?.type, "array", "should reuse the L3a sampledFields array");

  // The response provenance + honest-or-omit are documented.
  assert.match(op!.description, /holdDispatchMs/, "description should document holdDispatchMs");
  assert.match(op!.description, /releaseMs/, "description should document releaseMs");
  assert.match(op!.description, /actualFixedTicks/, "description should document fixed-tick release evidence");
  assert.match(op!.description, /actuated/, "description should document the dispatch actuated flag (non-engaging joystick visible)");
  assert.match(op!.description, /run\s?[Ss]peed|accel/i, "description should explain the runSpeed/accel intent");
});

// ─── RCL-T07: op discovery (ops.list / ops.describe / near-match suggestions) ───

test("OpRegistry: ops.list and ops.describe are registered discovery ops", () => {
  const list = registry.getByCommand("ops.list");
  const describe = registry.getByCommand("ops.describe");
  assert.ok(list, "ops.list should be registered");
  assert.ok(describe, "ops.describe should be registered");
  assert.equal(list!.toolName, "unity_ops_list");
  assert.equal(describe!.toolName, "unity_ops_describe");
  // Discovery ops are NOT async (answered server-side from the registry).
  assert.notEqual(list!.isAsync, true);
  assert.notEqual(describe!.isAsync, true);
});

test("OpRegistry: buildListing catalogs every op grouped by category", () => {
  const payload = registry.buildListing();
  assert.equal(payload.totalOps, registry.getAll().length, "listing must cover every op");
  assert.ok(payload.totalCategories >= 10, "expected the full category set");
  const scene = payload.categories.find((c) => c.category === "scene");
  assert.ok(scene, "scene category should be present");
  assert.equal(scene!.count, scene!.ops.length);
  const createObject = scene!.ops.find((o) => o.command === "scene.create_object");
  assert.ok(createObject, "scene.create_object should appear in the listing");
  assert.ok(createObject!.summary.length > 0, "each op should carry a one-line summary");
  assert.ok(createObject!.summary.length <= 200, "summary should be capped");
});

test("OpRegistry: buildListing(category) filters to one group", () => {
  const payload = registry.buildListing("editor");
  assert.equal(payload.totalCategories, 1);
  assert.equal(payload.categories[0].category, "editor");
  assert.ok(payload.categories[0].ops.some((o) => o.command === "editor.execute_menu_item"));
});

test("OpRegistry: buildDescribe by exact command returns full schema", () => {
  const out = registry.buildDescribe({ command: "runtime.measure_motion" });
  assert.equal(out.matched.length, 1);
  assert.equal(out.matched[0].command, "runtime.measure_motion");
  assert.equal(out.matched[0].category, "runtime");
  assert.ok(out.matched[0].inputSchema, "describe should include the inputSchema");
  assert.equal(out.suggestions, undefined, "an exact match should not emit suggestions");
});

test("OpRegistry: buildDescribe by category returns the whole group", () => {
  const out = registry.buildDescribe({ category: "package" });
  assert.equal(out.matched.length, 4);
  assert.ok(out.matched.every((m) => m.category === "package"));
});

test("OpRegistry: buildDescribe of an unknown command suggests near-matches in-category", () => {
  const out = registry.buildDescribe({ command: "scene.create_primitiv" });
  assert.equal(out.matched.length, 0, "a typo should not resolve");
  assert.ok(out.suggestions && out.suggestions.length > 0, "should suggest near-matches");
  assert.ok(out.suggestions!.includes("scene.create_primitive"),
    "the intended op should be the top suggestion for a 1-char typo");
});

test("OpRegistry: suggestToolNames maps near-matches to tool names (in-category first)", () => {
  const tools = registry.suggestToolNames("unity_runtime_measure_motio");
  assert.ok(tools.includes("unity_runtime_measure_motion"),
    "a 1-char tool-name typo should surface the real tool");
  // The closest match is in the same (runtime) category.
  assert.match(tools[0], /^unity_runtime_/);
});

test("OpRegistry: runtime.measure_motion advertises the fastForward perf lever (RCL-T07)", () => {
  const op = registry.getByCommand("runtime.measure_motion");
  const schema = op!.inputSchema as { properties: Record<string, { type?: string }> };
  assert.equal(schema.properties.fastForward?.type, "boolean", "fastForward should be an optional boolean");
  assert.match(op!.description, /fastForward/, "description should document the fastForward lever");
});

test("OpRegistry: editor.execute_menu_item advertises a per-call timeoutMs for long PLAYER BUILDS (GRL-C26)", () => {
  const op = registry.getByCommand("editor.execute_menu_item");
  assert.ok(op, "Should find editor.execute_menu_item");
  const schema = op!.inputSchema as { properties: Record<string, { type?: string; description?: string }> };
  // The tunable is advertised so a strict client / the agent can actually pass it.
  assert.equal(schema.properties.timeoutMs?.type, "number", "timeoutMs must be an advertised number param");
  // The description names the concrete PLAYER BUILD failure mode and gives a raised example.
  assert.match(op!.description, /PLAYER BUILD/, "description should call out player builds");
  assert.match(op!.description, /timeoutMs/, "description should tell the agent to raise timeoutMs");
  assert.match(op!.description, /600000/, "description should give a concrete raised-timeout example");
});
