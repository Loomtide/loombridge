# Unity 2D Default Values (Loomtide)

Use these as safe baseline values for demo scenes.

## MCP Tool Parameter Conventions

- **Locators** are objects: `{ "path": "/ObjectName" }` (not plain strings).
- **Property paths** in `unity_component_set_property` accept both friendly names (`freezeRotation`) and serialized paths (`m_Constraints`). Prefer friendly names.
- **Object references** in `unity_component_set_property` use: `{ "locator": { "path": "/Target" } }`.

## 1. Camera Baseline

- Projection: Orthographic
- Static `orthographicSize`: `5`
- Position: `(0, 0, -10)`
- Clear Flags: `SolidColor`
- Background Color: choose from the game brief/contract. If none exists, use a neutral solid color
  only as a temporary editor-readable fallback.

Visible area at 16:9 with size 5:
- Vertical: `y = -5..+5`
- Horizontal: `x ~= -8.9..+8.9`

Optional precision-platformer follow profile:
- Use a dedicated camera controller component instead of baking follow behavior into player/game scripts.
- The game brief chooses the reference feel, tile basis, character target height, zoom, look-ahead,
  damping, and bounds.
- Start from the game's tile size and PPU: tile pixels / PPU = tile world units.
- Choose `orthographicSize` from the desired visible tile rows, not from a fixed demo value.
- Bounds must come from the level extents and camera extents; do not reuse another game's bounds.

Guardrails:
- Keep camera presets as independent scene systems so a workflow can swap static, platformer-follow, room-lock, boss-arena, or cinematic setups.
- Clamp by camera extents when bounds are enabled; clamping the camera center directly will leak past level edges.
- Runtime validation should prove both player movement and camera movement when testing a follow preset.

## 2. Object Scale Baseline

- Player: `(0.8, 0.8, 1)`
- Enemy: `(0.7, 0.7, 1)`
- Coin: `(0.4, 0.4, 1)`
- Ground: `(18, 0.5, 1)`
- Floating platform: `(3, 0.35, 1)`

Guardrails:
- Treat scale as a profile: tile size defines world units, character target height, platform dimensions, and camera zoom.
- For imported sprites, normalize by visible sprite bounds where possible; raw texture size can include transparent padding.
- Avoid collectible scale `< 0.3`.
- Avoid platform Y scale `< 0.3`.

## 3. Physics Baseline

Set via `unity_component_set_property` with `type_name: "Rigidbody2D"`:

| Friendly Name | Serialized Path | Value | Notes |
|---------------|----------------|-------|-------|
| `gravityScale` | `m_GravityScale` | `2.5` | Default 1 feels floaty |
| `mass` | `m_Mass` | `1` | Keep at 1 |
| `collisionDetection` | `m_CollisionDetection` | `1` | Continuous |
| `interpolation` | `m_Interpolate` | `1` | Interpolate |
| `freezeRotation` | `m_Constraints` | `true` (or `4` raw) | Prevents toppling |
| `bodyType` | `m_BodyType` | `0`=Dynamic, `1`=Kinematic | Kinematic for enemies |

Script constants:
- Jump impulse: `12` (with gravityScale=2.5, gives ~2.9 unit jump height)
- Move speed: `6`

Reachability heuristic:
- Practical max jump height: `~2.4`
- Practical horizontal gap during jump: `~4.8`

## 4. Collider Baseline

- Player: `BoxCollider2D` (default size; optional width shrink for forgiving platforming)
- Platform/Ground: `BoxCollider2D`
- Enemy: `BoxCollider2D`
- Coin: `CircleCollider2D` with `isTrigger = true`

## 5. Ground Check Baseline

Use raycast from bottom of player sprite:
- Origin offset: `Vector2.down * 0.4f` (for 0.8-tall player)
- Distance: `0.15f`
- Filter: layer mask + self exclusion

## 6. UI Anchoring Baseline

Canvas:
- Use `unity_ui_create_canvas` with screen overlay mode.
- Set CanvasScaler via `unity_component_set_property` on `CanvasScaler`:
  - `m_UiScaleMode = 1`
  - `m_ReferenceResolution = {"x": 1920, "y": 1080}`
  - `m_MatchWidthOrHeight = 0.5`

HUD anchors (set via `unity_ui_set_rect_transform` or `unity_component_set_property` on `RectTransform`):
- Score top-left: anchor/pivot `(0,1)`, anchored position `(20,-20)`
- Lives top-left below score: anchored position `(20,-70)`
- Center message: anchor/pivot `(0.5,0.5)`, anchored position `(0,0)`

## 7. Sprite Creation

Create sprites with `unity_asset_create_sprite`:
- `path`: e.g. `"Assets/Sprites/PlayerSprite.png"`
- `color`: `{"r": 0.2, "g": 0.6, "b": 1.0, "a": 1.0}`
- `width`/`height`: 64 for characters/platforms, 32 for coins

Assign with `unity_asset_assign_sprite`:
- `locator`: `{"path": "/Player"}`
- `sprite_path`: `"Assets/Sprites/PlayerSprite.png"`

Objects need `SpriteRenderer` component added first via `unity_component_add`.

**Enable Read/Write on textures whose visible (opaque) bounds you need to align** — player feet, the
flag/goal base, grounded props. `unity_scene_get_bounds` can only return `visibleBounds`
(`visibleBottomY`, etc.) when the texture is **CPU-readable**; otherwise it reports *"texture not
CPU-readable"* and you can't fit feet/base to a surface. Set the importer's Read/Write flag on the
texture (`m_IsReadable = 1` / `Read/Write Enabled = true`) and re-import, then read bounds. Slicing/
sheet imports (animation frames) don't need this unless you also align their visible bounds.

## 8. Module Preconditions

Before script creation, verify Unity project has required built-in modules/packages enabled:
- 2D Physics (for `Rigidbody2D`, `Physics2D`)
- UGUI (if using `UnityEngine.UI` based HUD components)
