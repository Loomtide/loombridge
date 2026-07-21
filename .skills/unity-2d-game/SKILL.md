---
name: unity-2d-game
description: Build, modify, and playtest Unity 2D games through Loomtide MCP tools, with locked 2D project structure, slice-friendly construction, and verified player feel.
---

Use this skill for Loomtide-driven Unity 2D implementation. For polish components, especially player
feel, pair it with `game-polish-2d`.

## Hard Rules

1. Use MCP tool names exactly in plans and execution.
2. Keep scripts Unity 6000.3 and 2022.3 compatible.
3. Keep Loomtide core generic; game-specific behavior lives in authored scripts.
4. Use the **new Unity Input System** for every Loomtide-built 2D game or fixture:
   - `Packages/manifest.json` must include `com.unity.inputsystem`.
   - `ProjectSettings/ProjectSettings.asset` `activeInputHandler` must be Input System (`1`) or Both (`2`).
   - Gameplay scripts must not use legacy `UnityEngine.Input` polling (`Input.GetAxis*`,
     `Input.GetButton*`, `Input.GetKey*`, `Input.GetMouseButton*`).
   - Use `InputAction`, `PlayerInput`, `Keyboard.current`, `Mouse.current`, or a small Input System wrapper.
   - Rationale: Loomtide input-driven verification cannot drive legacy `UnityEngine.Input`; legacy-only
     projects are reported as `LEGACY_INPUT_UNSUPPORTED` / not input-measurable.
5. Build in organized folders:
   - `Assets/Scripts/Core`
   - `Assets/Scripts/Player`
   - `Assets/Scripts/Interactables`
   - `Assets/Scripts/FX`
   - `Assets/Scripts/Camera`
   - `Assets/Scripts/Verification`
   - `Assets/Art`, `Assets/Audio`, `Assets/Fonts`, `Assets/Scenes`
6. Verify after each major slice with compile checks, screenshots, and the relevant `loomtide verify`
   command.

## Input-System Preflight

Before writing gameplay code or handing a project to verification:

- Confirm `Packages/manifest.json` contains `com.unity.inputsystem`.
- Confirm `ProjectSettings/ProjectSettings.asset` has `activeInputHandler: 1` or `activeInputHandler: 2`.
- Scan authored gameplay scripts for legacy `Input.Get*` / `Input.GetMouseButton*` calls; replace them.
- In live verification, `unity_input_get_capabilities` should select `InputSystem` and report
  `requiresGameViewFocus: false` for input-driven capture.
- If a third-party project is legacy-only, do not fake zero-motion captures. Classify it as not
  input-measurable unless the developer approves migration to the new Input System.

## Construction Rhythm

1. Batch repetitive object/component/property operations with `unity_ops_batch`.
2. Use generated editor scripts for bounded setup work such as asset slicing, scene layout, and wiring.
3. Observe after each chunk with screenshots, bounds, state, and console checks.
4. Do not use fast construction to bypass verification.

## Player-Feel Slice

When building platformer movement:

1. Load `game-polish-2d/references/player-controller.md`.
2. Create `PlatformerPlayerController` under `Assets/Scripts/Player/`.
3. Configure `Rigidbody2D`, collider, frictionless `PhysicsMaterial2D`, and project
   `fixedDeltaTime` from the acceptance contract.
4. Measure with `FeelHarness` plus `runtime.probe`; final `feel.json` must include
   `provenance.sources[]`.
5. Tune using the `game-polish-2d` tuning templates for run speed, jump apex, and dash distance.
6. Run `loomtide verify --slice player-feel`.

Expected player-feel gates:
`manifest`, `feel`, `feel-provenance`, `physics-timestep`, `playability`, `console-clean`.

## References

- `references/default-values.md` — camera, scale, physics, collider setup, UI anchoring.
- `references/scripts.md` — legacy general templates; prefer locked skill references when available.
- `references/build-checklist.md` — end-to-end MCP build/playtest sequence.
- `references/feel-presets.md` — the feel identity (precision/classic/momentum profiles) → resolved
  starting params (generated from the profiles) + the measure→tune loop.
