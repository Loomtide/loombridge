# Verify the parallax deterministically (the coverage gate, trajectory form)

Two things to verify, by mode:

- **Coverage (all modes)** — the layer still fully covers the camera frame at every sample (no bare camera
  background), and never teleports. For a **static-quad texture-offset layer (AmbientDrift / TargetFollow)
  the quad never moves, so its bounds are constant — the coverage gate is unaffected and keeps passing.**
  CameraFollow re-centers the quad each frame, so its bounds track the camera but still cover.
- **Player-driven motion (TargetFollow)** — that the parallax actually moves *with the player* and is
  *still when the player is idle*. The coverage gate can't see this (bounds are constant either way), so
  you verify it separately by sampling `mainTextureOffset` while driving the player — see the bottom
  section.

A single screenshot **cannot** verify a scrolling backdrop: the broken-parallax failure (snap + exposed
gap) only appears *after* the layer has scrolled, and only at certain points in the cycle. So you verify
across a **full drift cycle** and assert two things at **every sample**:

1. **Coverage** — each backdrop layer still fully covers the camera frame (no bare camera background).
2. **Position continuity** — the layer's world position does not teleport (no `~tile`-sized jump between
   adjacent samples — the "snap").

This maps to the Loomtide **coverage** gate. The single-snapshot "soak" form (`framing-checks.md` in
`/verify-2d-game`) captures one post-drift bounds; the **trajectory form** below samples the *whole*
cycle so it also catches the snap and any mid-cycle gap.

## Recipe

1. **Enter play** — `unity_editor_play`.
2. **Sample across a full cycle with `unity_runtime_probe`** (`includeSamples:true`). Measure the layer
   over at least one full drift cycle (`cycleSeconds` = the time for the texture offset to wrap once;
   for AmbientDrift = `tileWorldWidth / |driftSpeed|`). The probe advances **game time** deterministically,
   so the sampled offsets are reproducible even if the editor is backgrounded (wall-clock waits would
   drift — the sim freezes when backgrounded).
3. For **each sample** capture the layer's world bounds with `unity_scene_get_bounds` (and the camera
   frame once). For a static-quad texture-offset layer the **bounds are constant** across samples — that
   is exactly what PASS looks like: it covers at every sample and never moves.
4. **Save `coverage.json`** in the trajectory shape below.

## `coverage.json` shape (trajectory form)

```json
{
  "cameraFrame": { "minX": -8.9, "maxX": 8.9, "minY": -5.0, "maxY": 5.0 },
  "layers": [
    {
      "name": "Sky",
      "samples": [
        { "tMs": 0,    "minX": -8.9, "maxX": 8.9, "minY": -5.0, "maxY": 5.0 },
        { "tMs": 2000, "minX": -8.9, "maxX": 8.9, "minY": -5.0, "maxY": 5.0 },
        { "tMs": 4000, "minX": -8.9, "maxX": 8.9, "minY": -5.0, "maxY": 5.0 }
      ]
    }
  ],
  "cycleSeconds": 17.07
}
```

- `cameraFrame` — the camera's world bounds (`{minX,maxX,minY,maxY}`), captured once.
- `layers[]` — one entry per backdrop layer, each with `name` and a `samples[]` trajectory.
- `samples[]` — `{tMs, minX, maxX, minY, maxY}` per sample, across a full cycle.
- `cycleSeconds` — the full drift-cycle duration the samples span.

## What the gate asserts

For each layer, at **every** sample:

- **Coverage** — `sample.minX <= cameraFrame.minX` and `sample.maxX >= cameraFrame.maxX` (and likewise
  Y). If any sample fails, a band of bare camera background was exposed → **FAIL**.
- **Continuity** — `|sample[i].minX - sample[i-1].minX|` (and maxX) is small; a jump of order
  `tileWorldWidth` between adjacent samples is the transform-translation **snap** → **FAIL**.

A correct **texture-offset static quad** has identical bounds at every sample (it never moves) → covers
at every sample, perfectly continuous → **PASS**. A **translate-and-snap layer** drifts its bounds open
a gap on one side and/or teleports them by ~one tile when it wraps → **FAIL**.

## Why the trajectory, not a screenshot

A `t=0` capture sees the backdrop before it has scrolled — the gap and the snap don't exist yet. A single
post-soak capture catches a *steady* gap but can miss a snap that only happens at the wrap instant.
Sampling the whole cycle with the probe is the only deterministic way to catch a **time-varying** seam.

> Coverage in `coverage.json` form degrades to **warn** if the capture is missing; supply the trajectory
> above to make it a real PASS/FAIL. The TS gate (`coverage.ts`) owns the evaluation — this doc only
> fixes the JSON shape so the capture and the gate agree.

## Verify player-driven parallax (TargetFollow)

The coverage gate above is **unaffected** by TargetFollow — the quad is static, so its bounds are constant
and coverage keeps passing. What coverage *can't* see is whether the backdrop actually shifts with the
player (and only with the player). Verify that by **driving the player and sampling each layer's texture
offset** — no time advance, because TargetFollow has no time term (offset is a pure function of the
player's position).

This reuses the **probe / transient idioms** in `/verify-2d-game` → `feel-checks.md` (drive the player
with `unity_runtime_probe` forces, not `set_transform`; the sim throttles between MCP calls, so advance
the physics timeline with a probe). Recipe:

1. **Enter play** — `unity_editor_play`. Note each layer's `factorX`/`factorY` and `tileWorldWidth`
   (`tileWorldHeight` if set) — read them off the component, and the player's start X/Y.
2. **Idle check.** Without driving the player, sample each layer's `material.mainTextureOffset` (via
   `unity_component_get_properties` on the `MeshRenderer`'s material, or a `runtime.probe` that reads it)
   across a few steps. It must be **constant** — an idle player drives no motion. (A nonzero-but-constant
   offset is fine; a *changing* offset with an idle player means a stray time term and is a FAIL.)
3. **Drive horizontally.** Probe `forceHorizontal = 1` for a known number of physics steps; measure the
   player's ΔX (player X before vs after) and re-read each layer's `mainTextureOffset.x`. Assert each
   layer's Δ`offsetX ≈ ΔX × factorX / tileWorldWidth` (mod 1 if it wrapped). The **far layer (smallest
   factorX) must change the least**, the near layer the most — proportional to its factor.
4. **Drive vertically.** Probe a jump (`forceJump`, optionally `forceJumpCut`); measure the player's ΔY at
   apex and re-read `mainTextureOffset.y`. Assert Δ`offsetY ≈ ΔY × factorY / tileWorldHeight`, far layer
   least. Confirms **both axes** respond (horizontal on run, vertical on jump/fall).
5. **Return-to-rest (optional).** Drive the player back toward spawn; the offset trends back toward its
   anchor value — it tracks the player's *current* displacement, not an accumulation.

PASS = offset is constant while idle, and changes by `displacement × factor / tileWorldSize` per axis when
driven, far layer least. FAIL = offset drifts while the player is idle (stray time term), doesn't respond
to one axis, or every layer shifts by the same amount (factors not wired / all equal).

## `parallax-motion.json` emitter spec (TargetFollow)

For the parallax slice, write a deterministic `parallax-motion.json` beside the other verify captures.
The emitter emits **raw samples and declared component settings only**; the TypeScript
`parallax-motion` gate owns the verdict.

Sample the live scene in three probe phases:

1. `idle` — read at least two samples while the player is not driven.
2. `run-right` — drive the player horizontally with the controller probe hooks, then read player position
   and each layer's material offset.
3. `at-apex` — drive a jump/apex probe, then read player position and offsets again. For single-screen
   platformers with `factorY: 0`, no vertical texture motion is expected and valid.

For each `ParallaxLayer`, read:

- `mode` — only `TargetFollow` is graded by S4-parallax-a; `AmbientDrift` / `CameraFollow` are explicit
  methodology gaps until their formulas exist. Missing or unknown mode is a capture failure, not a skip.
- `factorX`, `factorY`, `tileWorldWidth`, `tileWorldHeight` — all required for `TargetFollow`.
  If the component's serialized `tileWorldHeight` is `0`, emit the resolved runtime value
  (`tileWorldWidth`) so the gate has positive tile sizes for both axes.
- The renderer material's `mainTextureOffset.x/y` at each phase.
- The target/player world position `x/y` at the same phase.

```json
{
  "layers": [
    {
      "name": "Sky",
      "mode": "TargetFollow",
      "factorX": 0.2,
      "factorY": 0.0,
      "tileWorldWidth": 2.56,
      "tileWorldHeight": 2.56,
      "samples": [
        { "state": "idle", "offsetX": 0.0, "offsetY": 0.0, "playerX": 0.0, "playerY": 0.0 },
        { "state": "idle", "offsetX": 0.0, "offsetY": 0.0, "playerX": 0.0, "playerY": 0.0 },
        { "state": "run-right", "offsetX": 0.078, "offsetY": 0.0, "playerX": 1.0, "playerY": 0.0 },
        { "state": "at-apex", "offsetX": 0.078, "offsetY": 0.0, "playerX": 1.0, "playerY": 0.5 }
      ]
    }
  ]
}
```

The live proof may keep player displacement below one texture tile for easier human audit. The gate is
still wrap-safe: it compares offset deltas with circular texture-space deltas, so a valid sample that
crosses `Mathf.Repeat` (for example `0.95 -> 0.03`) still passes.
