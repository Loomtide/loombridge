# Setup recipe: build a parallax layer over MCP

How to assemble one `ParallaxLayer` quad through Loombridge MCP. Repeat this per depth layer (see
`multi-layer.md` for stacking). The load-bearing rule: the quad must **cover the whole camera frame**
and the texture must be a **Repeat** wrap, so the scroll is edge-safe and seamless.

## Mode first (which one for this camera)

- **Static one-screen camera (no scroll)** → **`TargetFollow`** — the recommended default. The backdrop
  shifts with the player's displacement on both axes (per-layer factor), and is still when the player is
  idle. (Or leave the layer truly static.) Do **NOT** use `AmbientDrift` on a static gameplay level — its
  motiveless time-based creep reads worse than a static backdrop.
- **Title / ambient scene (static camera, no player)** → `AmbientDrift`.
- **Scrolling / following camera** → `CameraFollow`.

The quad build (steps 1–5) is identical for all three; only the serialized driver fields differ (step 6).

## 0. Author the component (once)

`unity_code_create_script` → `Assets/Scripts/ParallaxLayer.cs` (paste the source from
`parallax-layer.md`, `if_exists: skip`).

## 1. Create the quad GameObject

A backdrop layer is a flat textured quad, not a `SpriteRenderer`:

1. `unity_scene_create_object` → e.g. `Sky` (parent it under a `Backdrop` empty if you like).
2. `unity_component_add` → `MeshFilter`; set its mesh to the **built-in Quad** mesh
   (`unity_component_set_property` `sharedMesh` / `mesh` → the built-in `Quad`).
3. `unity_component_add` → `MeshRenderer`.

(The built-in Quad is a 1×1 unit plane facing +Z, so the quad's world size = its `localScale`.)

## 2. Import the texture: wrapMode = Repeat, filterMode = Point

This is what makes the wrap **seamless** and keeps **pixel art** crisp. Set both on the texture importer
**before** the material samples it:

- **wrapMode = Repeat** — REQUIRED. The `Mathf.Repeat(offsetX, 1f)` wrap in `ParallaxLayer` only reads
  as seamless if the texture repeats; with Clamp you get a smeared edge instead of a loop.
- **filterMode = Point** — for pixel art, so the texture is not bilinear-blurred.
- mipmaps off, and (if you sliced it) ppu 100, matching the rest of the pixel-art pipeline.

Set these via the importer when bringing the art in (`unity_asset_create_sprite` for sliced art applies
Point/no-mips; for a raw backdrop texture set the importer's `wrapMode`/`filterMode` and
`unity_editor_refresh_assets`). The texture must tile horizontally seamlessly (its left edge matches its
right edge) for the loop to be invisible.

## 3. Create the material

`unity_asset_create_material` → e.g. `Assets/Materials/SkyParallax.mat`, with the layer texture as its
main texture (an unlit shader is fine for a flat backdrop). Then tile it the right number of times:

- `material.mainTextureScale.x = quadWorldWidth / tileWorldWidth`
  (e.g. a quad 16u wide showing a 2.56u tile → `mainTextureScale.x = 6.25`).
- `mainTextureScale.y` similarly if the art is meant to tile vertically; usually `1` for a sky band.

`mainTextureScale` controls **how many tiles** are visible across the quad; `ParallaxLayer` then scrolls
`mainTextureOffset` to move them. Set the same `tileWorldWidth` on the `ParallaxLayer` component so its
world-unit scroll speed matches the on-screen tiling.

## 4. Size the quad to cover the camera frame

The quad must cover the **full frame** so no bare camera background is ever visible. For an orthographic /
PixelPerfect camera:

- **frame world height = `orthoSize * 2`**
- **frame world width  = `orthoSize * 2 * aspect`**  (aspect = `Screen.width / Screen.height`, e.g. 16/9)

Set the quad's `localScale` to `(frameWidth, frameHeight, 1)` via `unity_scene_set_transform` (or
`unity_component_set_property` on the transform). Read the live ortho size / aspect from
`unity_runtime_get_snapshot` or `unity_scene_get_bounds` on the camera frame rather than hard-coding.

**Margin is optional for the static-quad modes (AmbientDrift / TargetFollow)** — not required: the quad
is static and only the texture moves (TargetFollow scrolls both axes, but still only the texture), so a
frame-exact quad never exposes an edge. (This is the key advantage over the old `BackdropDrift`, which
needed an over-wide sprite because the *transform* moved.) For **CameraFollow** the quad is re-centered on
the camera every frame, so a frame-exact quad also always covers.

## 5. Center it on the camera and place it behind gameplay

- **Center**: set the quad's X/Y to the camera center (`unity_scene_set_transform`). In CameraFollow the
  component re-centers it each frame anyway; in AmbientDrift / TargetFollow center it once at build time
  (the quad stays put — TargetFollow only scrolls the texture, never the transform).
- **Depth / sort order**: push the layer behind gameplay. Either set the `MeshRenderer.sortingOrder` to a
  negative value (farther layers more negative than nearer ones) and/or set the quad's **z** further from
  the camera (larger z for an ortho camera looking down +Z). Far layers behind near layers — see
  `multi-layer.md`.

## 6. Wire the driver fields (per mode)

Set the serialized `ParallaxLayer` fields with `unity_component_set_property`:

- **All modes** — `mode` (enum index/name) and `tileWorldWidth` (must equal `quadWorldWidth /
  mainTextureScale.x` so tiling and scroll speed agree).
- **TargetFollow** — `factorX` / `factorY` (per-axis fraction of the player's displacement the layer
  shifts; far = small, near = ~1 — see `multi-layer.md`), and `target` (the player Transform reference).
  Leave `target` null to auto-resolve to the `Player`-tagged object (then an object named `Player`). Set
  `tileWorldHeight` only if the art's vertical tile differs from its horizontal tile (else it reuses
  `tileWorldWidth`). The component caches the target's start position on enable as the anchor, so the
  backdrop is at rest at spawn and shifts only as the player moves away from it.
- **AmbientDrift** — `driftSpeed` (world u/s; negative scrolls left).
- **CameraFollow** — `parallaxFactor` (0 = locked/farthest, 1 = 1:1/nearest) and `targetCamera` (the
  follow camera; null defaults to `Camera.main`).

## Edge-safety checklist (the whole point)

- [ ] Texture importer **wrapMode = Repeat** (else the wrap smears instead of looping).
- [ ] Quad `localScale` ≥ the camera frame (`orthoSize*2*aspect` × `orthoSize*2`) — covers at start.
- [ ] Quad **centered** on the camera; in CameraFollow it re-centers each frame so it covers **always**.
- [ ] `mainTextureScale.x = quadWorldWidth / tileWorldWidth`, and the same `tileWorldWidth` on the
      component, so tiling and scroll speed agree.
- [ ] **Mode + driver wired** (step 6): TargetFollow → `factorX`/`factorY` + `target`; AmbientDrift →
      `driftSpeed`; CameraFollow → `parallaxFactor` + `targetCamera`.
- [ ] Layer sits on a **back** sortingOrder/z (behind gameplay; far behind near).

If all five hold, the texture's start/end is never inside the frame and the loop has no seam.
