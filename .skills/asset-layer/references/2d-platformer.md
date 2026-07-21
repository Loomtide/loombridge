# 2D Platformer Asset Profile

The platformer profile maps registry primitives to deterministic Unity folders:

- `player` -> `Assets/Art/Sprites/Characters`
- `tile` -> `Assets/Art/Sprites/Tiles`
- `collectible` -> `Assets/Art/Sprites/Collectibles`
- `background` -> `Assets/Art/Backgrounds`
- `decor` -> `Assets/Art/Sprites/Decor`
- `sfx_collectible` -> `Assets/Audio/SFX` (audio metadata validation only)

## Validation

Sprite entries must use `png`, `jpg`, or `jpeg`; stay within the configured maximum dimensions; use `100` pixels-per-unit; and keep Unity import paths under `Assets/Art`.

Optional audio metadata entries must use WAV fixtures that satisfy the profile's `sampleRate`, `channels`, bit depth, duration, license, source verification, and provenance requirements. Do not wire audio into gameplay from this profile unless a later task explicitly asks for it.

Every registry entry must preserve license and provenance metadata:

- license name, SPDX identifier, URL, and attribution requirement
- provider name and URL
- source title, URL, author, source verified status, and provenance fields
- fixture or remote file origin used by the deterministic prepare pipeline

Reject entries with disallowed license, source unverified, missing provider/provenance, invalid checksum declaration, checksum mismatch, or `PROVIDER_NOT_CONFIGURED` generation-provider diagnostics.

## Unity Import

Prepared organization output must provide the exact generic tool argument pair expected by `unity_asset_create_sprite`:

- `source_path`: local prepared cache file
- `path`: Unity asset destination such as `Assets/Art/Sprites/Tiles/grass-tile.png`

The prepare report also includes checksum, cache status, provider diagnostics, selected-vs-rejected counts, accepted import arguments, and the attribution/provenance for each accepted asset. Run the prepare step via `loombridge-asset-prep --project <path>` (or `node dist/asset-layer/prepare-cli.js`), which emits both the prepare report and the attribution markdown into the project handoff dir.

## Platform Surface Rendering

Do not stretch `tile` primitives across wide ground/platform objects. For platform surfaces:

- keep the GameObject transform scale at `1,1,1`
- set `SpriteRenderer.m_DrawMode` to `Tiled`
- set `SpriteRenderer.m_Size` to the intended world-space surface size
- set `BoxCollider2D.m_Size` to the same size

For sliced tile assets, derive `SpriteRenderer.m_Size` and `BoxCollider2D.m_Size` from the selected slice size and whole tile counts. The registry owns slice pixel dimensions and pixels-per-unit; the platformer layout owns tile counts. Example: a 32x32 tile at 100 PPU is `0.32 x 0.32` world units, so a 57x2 ground surface should be `18.24 x 0.64`, while a 10x1 floating platform should be `3.2 x 0.32`.

Character, collectible, decor, and background primitives may use normal sprite scaling. Tile spritesheets are not directly assignable scene sprites: import them with `spriteMode: "multiple"`, declare named slices in registry `unity.slicing`, and assign the intended tile through `sprite_name` such as `tile.simple.block`. Do not use a whole spritesheet as the platform surface fallback unless an explicit prototype override asks for it.
