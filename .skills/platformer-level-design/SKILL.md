---
name: platformer-level-design
description: Design playable 2D platformer levels through Loomtide MCP — one-way platforms, locked ground tiling, reachable spacing, and colliders that match visible surfaces. Use whenever placing ground/platforms in a 2D platformer.
---

# Platformer Level Design (2D)

Use this skill whenever a slice places terrain, floating platforms, pits, hazards, collectibles, or a
goal route. The default terrain recipe is now locked: drop the `GroundTiling` component from
`references/ground-tiling.md`, configure whole-tile spans, capture the gate JSON through the bridge, and
verify before approval.

Adding interactables (collectibles, hazards, bounce pads/launchers, optional goal triggers, score/lives
glue)? Use `references/interactables.md`. The game brief or acceptance contract chooses the primary win
rule: reach a goal, collect required items, survive a timer, defeat enemies, or a combination.

## 0. Manifest Asset Bindings

Before placing terrain or interactables, read `.loomtide/ASSET_MANIFEST.json` and the current
slice's `sliceBindings` entry. Use the bound asset IDs and their `resolvedPaths`; never search the
registry as a substitute inside the slice.

- `ground-tiling` uses `platform_tiles` and `one_way_platform`.
- `collectibles` uses `collectible`.
- `hazards` uses `hazard`.
- `framing` may reference `player_character`, `parallax_background`, and `foreground_prop` for scale
  and composition anchors.

If any bound asset is missing, unapproved, or lacks `resolvedPaths`, stop and update/approve the asset
manifest before constructing the slice.

## 1. Ground and Platforms Use `GroundTiling`

Do not build terrain as repeated per-tile GameObjects. Do not stretch a capped tile. Do not manually
stack repeated cap rows. Create each ground/platform span with `GroundTiling`:

- One `SpriteRenderer` per visible span, `drawMode = Tiled`, `size.x = widthTiles × tileWidth`,
  `size.y = exactly one tile`.
- Thick ground uses the component's cap/body stack: cap row on top, body row below. That is at most two
  renderers for a platform, never one renderer per tile.
- Collider top is fitted to the visible walkable surface. Reuse `FitBoxColliderToSprite` from
  `game-polish-2d` when trimming transparent padding matters.
- Capture metadata comes from `GroundTiling.WriteTileCaptures(outDir)`: it writes `platform-tiles.json`
  and `tile-render.json`. The capture contains raw sprite luminance samples; the TypeScript gate judges
  seams.

### Pick a tile sprite whose body tiles seamlessly

`GroundTiling` guarantees the right *structure* (one `Tiled` renderer, X-only, no per-tile objects), but
a seamless band ALSO needs a seamless *sprite*: its left/right edge columns must be continuous with the
interior, or you get a dark line at every tile boundary. **A `_center` tile is not automatically
seamless.** Validated on real Kenney art (S3b, live through the bridge):

- `ground_grass_center` (the common default) has a baked ~2px dark **left-shadow column** (luma ≈ 0.29 vs
  interior ≈ 0.50). Tiled Continuously it shows a visible seam band at every junction — the exact RUN-2
  defect. The `tile-render.seam` gate FAILS it (`edgeInterior` ≫ `interiorDelta × tolerance`). This seam
  is easy to miss by eye at downscaled review and was a real false-green; the deterministic gate catches it.
- A continuous-body tile (e.g. `ground_grass_right`'s body, no edge shadow) tiles as one unbroken band and
  PASSES. Prefer it for the center span.
- The fix for a seaming tile is a continuous-body sprite (or strip the baked edge shadow) — **never loosen
  the gate.** If only an edge-shadowed tile is available, that is a real asset gap, not a gate problem.

## 2. Floating Platforms Are One-Way

A plain `BoxCollider2D` is solid on all sides, so the player cannot jump through from below. Floating
platforms should use:

- `BoxCollider2D.usedByEffector = true`
- `PlatformEffector2D.useOneWay = true`
- `surfaceArc` around `140` to `170`
- `useOneWayGrouping = true`

Keep ground solid unless the design explicitly wants drop-through floors.

## 3. Boundary Grounds Run Off-Screen

The outermost ground spans must extend beyond the real camera frame so the floor never visibly starts or
ends mid-screen.

- Leftmost ground left edge <= camera frame left edge.
- Rightmost ground right edge >= camera frame right edge.
- Prefer 1-2 tiles of overrun for margin.
- Account for PixelPerfectCamera overscan; measure the real frame instead of trusting a nominal 16:9
  world width.
- Interior pits are allowed. Only the outer boundary ends must be hidden.

## 4. Reachability Is Verified

Place platforms within the player controller's actual motion envelope, then prove it:

- Measure jump apex, time-to-apex, run speed, short-hop, dash, coyote time, and jump buffer.
- Keep vertical gaps below the measured apex with margin.
- Keep horizontal gaps within measured jump/run reach.
- Use runtime probes to land on each platform; a route that cannot be landed is not acceptable.
- Capture annotated bounds so collider tops and visible surfaces can be inspected.

## Verify Checklist

- [ ] `GroundTiling` owns each ground/platform span; no terrain is composed from per-tile GameObjects.
- [ ] `platform-tiles.json` passes: integer tile spans, `top_cap` only on row 0, `body_fill` below, and
      collider top aligned with visible top.
- [ ] `tile-render.json` passes: wide spans use `drawMode = Tiled`, renderer count does not scale with
      tile count, and sampled sprite edge columns are seamless against the interior.
- [ ] Floating platforms can be jumped through from below and landed on from above.
- [ ] Boundary grounds overrun the overscan-aware camera frame.
- [ ] Every required route platform is reachable by probe, not eyeballing.
- [ ] Interactables are wired per `references/interactables.md` and match the contract's win/fail rules.
- [ ] After `loomtide verify --slice <id>` is green, approve with an operator artifact when available:
      `loomtide plan --go --note "ground tiling inspected; no repeated seam band" --signoff path/to/frame.png`.

## References

- `references/ground-tiling.md` — locked `GroundTiling` component spec and `WriteTileCaptures` JSON
  contract for `platform-tiles` + `tile-render`.
- `references/interactables.md` — reusable source + MCP wiring for hazards, trampolines, collectibles,
  level goals, and game-manager glue.
