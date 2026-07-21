# Multi-layer parallax: depth from stacked ParallaxLayer quads

Depth comes from **several** `ParallaxLayer` quads, each a frame-covering quad (built per
`setup-recipe.md`) with its own scroll factor and its own sort order/z. Farther layers scroll **slower**
and render **behind** nearer ones. All three modes (`TargetFollow`, `AmbientDrift`, `CameraFollow`) stack
the same way.

## The depth rule

- **Far = slow + behind. Near = fast + in front.**
- In **TargetFollow** (player-driven, static camera), "slow" is a small `factorX`/`factorY` (the fraction
  of the player's displacement the layer shifts). 0 = the layer ignores the player (farthest, never moves);
  ~1 = it tracks the player almost 1:1 (nearest). A distant sky barely shifts as the player runs; a
  foreground band shifts almost with the player. Both axes are independent — see below.
- In **CameraFollow**, "slow" is a small `parallaxFactor` (0 = locked to the camera, the farthest
  possible; 1 = moves 1:1 with the world, the nearest). A distant sky barely shifts; a foreground band
  shifts almost with the world.
- In **AmbientDrift**, "slow" is a small `|driftSpeed|`. The far sky creeps; the foreground drifts
  faster. (Keep signs consistent — all negative for a leftward drift.)
- Each layer gets a **distinct sortingOrder/z**: far layers more-negative `sortingOrder` (or larger z
  for an ortho camera looking down +Z) than near layers, and the whole set behind the gameplay layer.

## Example: 3-layer night backdrop

For a **static one-screen camera** the recommended mode is **TargetFollow** (player-driven). Per-layer
factors for both axes — `factorY < factorX` keeps the sky from sliding too much on a jump (a grounded
feel), far layers shift least:

| Layer       | TargetFollow `factorX` / `factorY` | CameraFollow `parallaxFactor` | AmbientDrift `driftSpeed` | sortingOrder | Notes |
|-------------|------------------------------------|-------------------------------|---------------------------|--------------|-------|
| Sky / stars | `0.20` / `0.12`  (far, nearly still)| `0.1`                         | `-0.05`                   | `-30`        | farthest, slowest |
| Hills       | `0.50` / `0.30`                     | `0.4`                         | `-0.12`                   | `-20`        | mid silhouette |
| Foreground  | `0.95` / `0.70`  (near, fast)       | `0.7`                         | `-0.20`                   | `-10`        | nearest, fastest |

TargetFollow factor ranges to aim for on a 3-layer night sky: **Sky ≈ 0.15–0.3**, **Hills ≈ 0.4–0.6**,
**Foreground ≈ 0.9–1.0** — and keep each layer's `factorY` smaller than its `factorX` so vertical motion
(jump/fall) shifts the backdrop less than running does. Depth ordering is the same as the sortingOrder
column: Sky behind Hills behind Foreground behind gameplay.

All three are frame-covering quads centered on the camera. Each has its own Repeat/Point material and its
own `tileWorldWidth` (the foreground's tile is usually narrower so it tiles more often). Gameplay sprites
sit at sortingOrder ≥ `0`, in front of the whole stack.

## Static-camera player-driven vs ambient drift vs camera-follow

- **TargetFollow — static one-screen player-driven parallax.** The camera is a fixed one-screen view
  (pixel-perfect, no scroll), but the backdrop must feel alive *and motivated*. Each layer shifts with the
  player's displacement from spawn by its `factorX`/`factorY`; the camera never moves, so the only motion
  is the layered texture scroll — and it happens **only when the player moves** (horizontal on run,
  vertical on jump/fall). Set `mode = TargetFollow` on every layer, point `target` at the player (or leave
  null to auto-resolve the `Player` tag), and give each layer its own factor pair so the slow far sky
  separates from the faster foreground (depth even with a static camera). **This is the recommended
  default for a static one-screen level** — depth that reads as in-world, not motiveless drift.

- **AmbientDrift — title / ambient scenes only.** Each layer drifts on its own at `driftSpeed`, on a clock,
  regardless of gameplay. Use it where a slow creep IS the intent (title screens, menus, no-player ambient
  scenes). **Don't use it on a static gameplay level** — the constant slide with no in-world cause reads
  worse than a truly static backdrop.

- **CameraFollow — scrolling levels.** The camera tracks the player across a wide level; each layer
  parallaxes against the camera by its `parallaxFactor`. Set `mode = CameraFollow`, point
  `targetCamera` at the follow camera (defaults to `Camera.main`), and let each layer re-center on the
  camera every frame. Use this for runners, side-scrollers, and any level wider than one screen.

You can even mix modes per layer (the mode is per-component), but keep it simple unless you need it. Each
layer is independent.

## Wiring each layer over MCP

Per layer (loop the `setup-recipe.md` steps), then set the serialized fields with
`unity_component_set_property`:

- `mode` — `TargetFollow`, `AmbientDrift`, or `CameraFollow` (enum index or name).
- `factorX` / `factorY` + `target` (TargetFollow) **or** `driftSpeed` (AmbientDrift) **or**
  `parallaxFactor` + `targetCamera` (CameraFollow) — per the table above.
- `tileWorldWidth` — the world width of one texture tile (must match the material's
  `mainTextureScale.x = quadWorldWidth / tileWorldWidth`). `tileWorldHeight` only if the vertical tile
  differs (TargetFollow's Y mapping; else it reuses `tileWorldWidth`).
- `target` — the player Transform reference (TargetFollow); leave null to auto-resolve the `Player` tag.
- `targetCamera` — the camera object reference (CameraFollow); leave null to default to `Camera.main`.

Then set each `MeshRenderer.sortingOrder` (and/or z) so far sits behind near, and the whole stack behind
gameplay. Verify the stack with `references/verification.md` — every layer must cover the frame at every
sample.
