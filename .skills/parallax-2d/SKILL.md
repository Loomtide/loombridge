---
name: parallax-2d
description: >-
  Use when adding scrolling/parallax backgrounds to a 2D game (platformer,
  runner, shmup, top-down) — seamless, edge-safe, multi-layer. Three modes:
  static-camera PLAYER-DRIVEN parallax (TargetFollow — the recommended default
  for a one-screen level: the backdrop shifts with the player's displacement on
  both axes, per-layer relative speed, and is still when the player is idle),
  static-camera time-based ambient drift (AmbientDrift — for title/ambient
  scenes only), and camera-follow (for a scrolling camera). The technique is
  texture-offset scrolling on a STATIC frame-covering quad (the quad never
  moves, so a texture start/end edge is never exposed and the loop is perfectly
  seamless), authored as a drop-in `ParallaxLayer` C# component and wired via
  generic Loomtide MCP tools. Supersedes the transform-translation
  `BackdropDrift` approach (which snapped the backdrop sideways and exposed a
  gap of bare camera background).
---

Use this skill to add a scrolling or parallax background to any 2D game and have it be **seamless** (no visible loop point) and **edge-safe** (you never see the texture's start/end, even after it has scrolled for minutes). It is the presentation counterpart for the *backdrop* of a 2D scene — the layer set that sits behind gameplay.

## Manifest Asset Bindings

Before importing or assigning background art, read `.loomtide/ASSET_MANIFEST.json` and the current
slice's `sliceBindings` entry. The `parallax` slice uses `parallax_background` and `foreground_prop`;
the `framing` slice may also reference those IDs for composition. Use each bound asset's
`resolvedPaths` and provenance exactly as recorded. Do not search the registry or swap in a different
background pack inside the slice. If a required binding is missing, unapproved, or unresolved, stop and
update/approve the manifest first.

## Why this skill exists (the failure it fixes)

A clean-room build produced a broken parallax background. The `BackdropDrift` component **translated the sprite transform** and used `Mathf.Repeat` on the world-space offset to "wrap". Two failure modes followed:

1. **Snap.** When the accumulated offset wrapped, the whole backdrop teleported ~8 world units sideways in a single frame — a visible jump, not a seamless loop.
2. **Gap.** A translating layer slides its own edges across the frame. The moment one edge passed the camera bound it exposed a band of bare camera background (the skybox/clear color) on that side.

The robust fix the user chose: **texture-offset scrolling on a static quad.** A single, frame-covering quad whose material is set to **Repeat** wrap. Instead of moving the quad, you scroll `material.mainTextureOffset`. The quad never moves, so **no texture start/end edge is ever inside the frame** → edge-safe. The offset wraps in `[0,1)` texture space, which maps onto the same repeating pixels → **seamless, no snap**.

## Which mode when (decide this first)

- **Static one-screen camera (no scroll)** → **`TargetFollow`** (player-driven). The backdrop shifts with
  the player's displacement, at a per-layer relative speed (far = slowest), and is **still when the player
  is idle**. For one-screen/static-camera platformers, default `factorY = 0` unless the contract explicitly
  wants vertical parallax; vertical target-driven UV offset can create jump-only horizontal seams unless the
  textures are oversized/edge-padded and verified at jump/apex. This is the recommended default — it gives
  depth that's motivated by gameplay without introducing airborne backdrop seams.
  Or leave the layer truly **static**. Do **NOT** use `AmbientDrift` on a static gameplay level: it slides
  forever with no in-world motivation, which reads worse than a static backdrop.
- **Title screen / ambient scene (static camera, no player)** → **`AmbientDrift`** is fine here — a slow
  motiveless creep is the intent.
- **Scrolling / following camera (level wider than one screen)** → **`CameraFollow`**.

## Principles

1. **Move the texture, not the transform.** Scroll `material.mainTextureOffset`; keep the quad static (AmbientDrift / TargetFollow) or pinned to the camera center (CameraFollow). A moving transform exposes edges; a moving texture-offset on a Repeat material does not.
2. **The quad covers the frame, always.** Size each layer quad to the full camera frame and keep it covering — at start AND every subsequent frame (CameraFollow repositions it each `LateUpdate`). If it ever fails to cover, you see bare camera background.
3. **Reusable component, not bespoke edits.** One `ParallaxLayer` C# component, three modes, drops onto any 2D game. Authored via `unity_code_create_script`, wired with generic `unity_*` tools.
4. **Player-driven, not motiveless, on a static level.** `TargetFollow` ties the offset to the player's displacement (a pure function of position, both axes, per-layer factor) so the parallax moves only when the player moves. `AmbientDrift`'s time-based creep is for ambient/title scenes, not gameplay.
5. **Deterministic under `runtime.probe`.** AmbientDrift/CameraFollow scroll on `Time.deltaTime` in `LateUpdate` (advance game-time to reproduce the offset); TargetFollow has no time term (drive the player to a known displacement to reproduce the offset). Either way the verification gate can sample it.

## References (load the one you need)

- `references/parallax-layer.md` — **`ParallaxLayer`**: the full C# component source (texture-offset scroll on a static quad), all three modes (`AmbientDrift` / `TargetFollow` / `CameraFollow`), the TargetFollow world→texture-offset mapping, and *why* it is edge-safe and seamless. Start here.
- `references/setup-recipe.md` — the MCP build recipe: create the quad + material per layer, import the texture with **wrapMode = Repeat / filterMode = Point**, set `mainTextureScale` to tile it, **size the quad to cover the camera frame**, and place it on a back sorting order / z.
- `references/multi-layer.md` — stacking several `ParallaxLayer` quads for depth: far/slow → near/fast factors (per-layer, both axes), distinct sortingOrder/z (far behind near). Static-camera **player-driven** (TargetFollow) vs ambient drift vs camera-follow.
- `references/verification.md` — verify it deterministically: the Loomtide **coverage** gate is unaffected (static quad → constant bounds). The **parallax-motion** gate verifies TargetFollow depth by driving the player with `runtime.probe` and checking each layer's `mainTextureOffset` changes proportionally to player displacement × its factor (far layer least), is constant when the player is idle, and has distinct active-axis motion across layers.

## Workflow

1. Decide the mode (see "Which mode when" above): **TargetFollow** (static one-screen camera, player-driven depth), **AmbientDrift** (static camera, ambient/title only), or **CameraFollow** (the camera moves and each layer parallaxes against it).
2. Author `ParallaxLayer.cs` from `references/parallax-layer.md` (`unity_code_create_script`).
3. For each depth layer, follow `references/setup-recipe.md`: build a frame-covering quad + a Repeat/Point material, attach `ParallaxLayer`, set its serialized fields — `mode`; per mode `factorX`/`factorY` + `target` (TargetFollow), `driftSpeed` (AmbientDrift), or `parallaxFactor` + `targetCamera` (CameraFollow); plus `tileWorldWidth` — via `unity_component_set_property`.
4. Stack the layers per `references/multi-layer.md` (far/slow behind near/fast).
5. Verify per `references/verification.md` — coverage is constant (static quad); for TargetFollow, emit `parallax-motion.json` and run the `parallax-motion` gate so each layer's offset tracks displacement × factor, stays still when idle, and proves distinct depth ordering across layers.
   For static platformers, include a jump/apex screenshot in `visual-artifacts.json`; if `factorY` is nonzero,
   prove no long horizontal seam appears while airborne.
