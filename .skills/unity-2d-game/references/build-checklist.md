# End-to-End Build Checklist (Loombridge MCP)

Use these tool names exactly.

## 0. Preflight Sanity (run first, fail fast)

Run these before any build steps. If any fails, surface the deterministic blocker code to the user and stop.

1. `unity_editor_get_state` — confirms bridge handshake succeeded.
   - Failure: `CONNECTION_ERROR` / `PREFLIGHT_BLOCKED` → ask user to open Unity on a project that references `com.loomtide.loombridge` and wait for `[Loombridge] Server started`.
2. `unity_input_get_capabilities` — confirms input automation is available.
   - Failure: `INPUT_CAPABILITY_BLOCKED` → report `blockerCode` and stop. Common causes: required package missing, headless mode.
3. `unity_editor_wait_for { "playMode": "stopped" }` — confirms not in play mode (scene mutations are unreliable during play).
   - Timeout: ask user to stop play mode manually before proceeding.

Skip step 3 if the user explicitly wants to drive input on an already-running play session.

## 1. Scene Foundation

1. `unity_scene_new_scene`
2. Configure camera from `references/default-values.md`:
   - `unity_component_set_property` on Camera: `orthographic = true`, `orthographicSize = 5`
   - `unity_scene_set_transform` on Main Camera: position `(0, 0, -10)`
3. Create ground object with `unity_scene_create_object`.
4. Add components with `unity_component_add` (locator must be `{ "path": "/ObjectName" }`, type via `type_name`).
5. Apply properties with `unity_component_set_property` (uses `property_path` not `property_name`).
6. Check with `unity_editor_screenshot`.

## 2. Platforms and Gameplay Objects

1. Create platforms with reachable spacing (max height diff ~2.4, max horizontal gap ~4.8).
2. Create player and enemy objects.
3. Add `SpriteRenderer` before assigning sprites via `unity_asset_assign_sprite`.
4. Add required colliders/rigidbodies.
5. Validate hierarchy with `unity_scene_get_hierarchy`.
6. Capture screenshot.

## 3. Script Creation and Attach

1. `unity_code_create_script` for each script (params: `path`, `content`, optional `if_exists`).
   - For re-runnable scenarios, pass `if_exists: "skip"` (no-op if same file exists) or `"replace"` (overwrite). Default `"error"` preserves original behavior.
2. `unity_editor_wait_for` with `{ "compiling": false }` after each script (domain reload may drop WebSocket — reconnect is automatic).
3. `unity_code_attach_script` to target objects (params: `locator`, `script_path`).
4. Re-run `unity_editor_wait_for` and screenshot.

## 4. UI Setup

1. `unity_ui_create_canvas`
2. `unity_ui_add_text` for score/lives/message (params: `parent` as locator, `name`, `text`, `text_backend`, `anchored_position`, `font_size`)
3. `unity_ui_set_rect_transform` using anchor presets from defaults.
4. Wire UI Text references into GameManager via `unity_component_set_property` with `{ "locator": { "path": "/Canvas/TextName" } }`.
5. Screenshot validation.

## 5. Playtest and Input Validation

1. Enter play mode: `unity_editor_play`
2. Wait: `unity_editor_wait_for` with `{ "playMode": "playing" }`
   - Note: domain reload during play entry may cause CONNECTION_LOST — the MCP server retries automatically.
3. Read input backend: `unity_input_get_capabilities`
4. Start input session: `unity_input_begin_session`
5. Apply input: `unity_input_key_tap` with keys `Space`, `LeftArrow`, `RightArrow` (PascalCase)
6. Wait: prefer `unity_editor_wait_for` with `{ "delayMs": 200 }` for in-play-mode timing — Play Mode runs simulation uncapped, so `frames: N` may advance many physics steps per editor tick (observed: 30 frames advanced player ~80 units instead of expected ~3). Use `frames: N` only for editor-update gates (compile, asset import).
7. Inspect motion: `unity_runtime_get_snapshot` or `unity_runtime_wait_for_condition`
8. End session: `unity_input_end_session`
9. Capture running screenshot: `unity_editor_screenshot` with `{ "view": "game" }`
10. Exit play mode: `unity_editor_stop`

## 6. Save and Evidence

1. Save scene: `unity_scene_save_scene` (param: `path`, e.g. `"Assets/DemoPlatformer.unity"`)
2. Collect screenshots and runtime snapshots into artifacts.
3. Record blockers with exact error code (`PREFLIGHT_BLOCKED`, `CONNECTION_ERROR`, `INPUT_CAPABILITY_BLOCKED`).
