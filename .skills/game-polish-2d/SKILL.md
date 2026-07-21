---
name: game-polish-2d
description: Reusable presentation/polish components for 2D games built through Loomtide — locked player feel, camera/background, HUD, animation, juice, end-state, and audio. Use when a 2D game needs verified feel or presentable polish.
---

Use this skill to turn a working 2D game into a polished slice. Prefer locked components over prose and
verify each slice with deterministic captures.

## Manifest Asset Bindings

Before adding polish assets, read `.loomtide/ASSET_MANIFEST.json` and the current slice's
`sliceBindings` entry. Use each bound asset's `resolvedPaths`; do not search the registry or replace a
generated/manual asset inside the slice.

- `player-feel` uses `player_character`.
- `hud` uses `hud_style` and `button_style`.
- `juice` uses `vfx_particle`.
- `end-state` uses `button_style` and `hud_style`.

If a required binding is missing, unapproved, or unresolved, stop and update/approve the manifest first.

## Locked Player-Feel Workflow

For a platformer `player-feel` slice:

Starting params come from the **feel identity**, not hand-picked numbers. Pick a profile
(`precision` / `classic` / `momentum`,
`mcp-server/src/loomtide/genre-packs/platformer-2d/profiles/*.profile.json`) and resolve its starting
params with `resolveStartingParams(profile)`
(`mcp-server/src/loomtide/genre-packs/platformer-2d/solve-params.ts`): it derives `jumpSpeed`,
`gravityScale`, and `moveSpeed` from the profile's band targets and reads `jumpCutMultiplier` /
`fixedTimestep` from the profile's `build` block. The resolved per-profile values are tabulated in
`unity-2d-game/references/feel-presets.md` §2 (generated from the profiles). Then measure → compare →
tune toward the profile's bands.

1. Add `PlatformerPlayerController` from `references/player-controller.md`.
2. Confirm the project uses the new Unity Input System (`com.unity.inputsystem`, `activeInputHandler`
   Input System or Both). The controller template is Input-System-only; do not add legacy `Input.Get*`
   fallbacks.
3. Set project `Time.fixedDeltaTime` to the contract value, usually `0.0166667`, before measuring.
4. Assign a frictionless `PhysicsMaterial2D` to the player body/collider.
5. Measure with `FeelHarness` and `runtime.probe`; final `feel.json` must include
   `provenance.sources[]`.
6. Tune with the reference configs:
   - `references/tuning-run-speed.md`
   - `references/tuning-jump-apex.md`
   - `references/tuning-dash-distance.md`
7. Run `loomtide verify --slice player-feel`.

The player-feel proof is not just numbers. It must pass `feel`, `feel-provenance`,
`physics-timestep`, `playability`, `manifest`, and `console-clean`.

## Components

- `references/player-controller.md` — `PlatformerPlayerController`, a standalone movement/feel controller
  with variable jump, coyote, jump buffer, air dash, and probe hooks.
- `references/camera-2d.md` — `Camera2DSetup`.
- `references/spawn-point.md` — `SpawnPoint` + `SnapToSpawnPoint`.
- `references/hud-kit.md` — TMP HUD kit.
- `references/jump-input.md` — robust jump input pattern.
- `references/character-anim.md` — character animation, pixel-perfect setup, collider fitting.
- `references/juice.md` — dash trail, dust, bursts, hit-stop, shake, fades.
- `references/end-state.md` — modal win/lose state.
- `references/audio.md` — `SfxPlayer` and cue wiring.

## Rules

- Keep components reusable. Gameplay-specific scoring, hazards, pickups, and win logic belong in their
  own slice scripts or event hooks, not inside the player controller.
- Use the new Unity Input System for gameplay input. Do not add `UnityEngine.Input.GetAxis*`,
  `GetButton*`, `GetKey*`, or `GetMouseButton*` to reusable components; Loomtide cannot input-drive
  legacy polling and will classify legacy-only projects as not input-measurable.
- Use generic Loomtide MCP tools only. Do not introduce game-specific bridge operations.
- After changing feel, remeasure and rerun `loomtide verify --slice player-feel`.
- Capture provenance honestly. A numbers-only `feel.json` is refused by `feel-provenance`.
