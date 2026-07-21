# 2D Top-Down Arena Asset Profile

Use this profile for one-room top-down games such as delivery, dodge, arena survival, twin-stick,
stealth, or small action prototypes.

## Registry And Profile

The current curated Switchyard seed data lives at:

- profile: `asset-layer/profiles/2d-topdown-arena.json`
- registry: `asset-layer/registry/switchyard-2d.json`

The profile maps primitives to deterministic Unity folders:

- `player` -> `Assets/Art/Sprites/Characters`
- `battery` -> `Assets/Art/Sprites/Pickups`
- `terminal` -> `Assets/Art/Sprites/Objectives`
- `arena` -> `Assets/Art/Sprites/Arena`
- `hazard` -> `Assets/Art/Sprites/Hazards`
- `vfx` -> `Assets/Art/Sprites/VFX`
- `sfx_pickup`, `sfx_deposit`, `sfx_dodge`, `sfx_hit`, `sfx_win`, `sfx_lose` -> `Assets/Audio/SFX`

## Clean Project Workflow

From a clean Unity project folder, prepare the curated assets into the project handoff directory:

```bash
<loombridge-repo>/scripts/prepare-project-assets.sh \
  --project "$PWD" \
  --profile asset-layer/profiles/2d-topdown-arena.json \
  --registry asset-layer/registry/switchyard-2d.json \
  --name switchyard
```

This creates:

- `.loombridge/handoff/switchyard-asset-prepare-report.json`
- `.loombridge/handoff/switchyard-asset-attribution.md`
- `.loombridge/handoff/asset-cache/`

Read the prepare report before authoring final sprites. Each accepted prepared asset includes:

- `id`, `primitive`, `kind`, `placeholder`
- source, provider, license, provenance, and checksum data
- `cachePath`
- `import.toolArguments.source_path`
- `import.toolArguments.path`

For each accepted `kind: "sprite"` entry, call the generic sprite import tool with the provided
`source_path` and `path`. For accepted `kind: "audio"` entries, copy/import the WAV to the provided
Unity path and wire it to the SFX player.

## Selection Rules

- Prefer accepted `placeholder:false` assets for every primitive they cover.
- Procedural art is allowed only for roles missing an accepted non-placeholder candidate, or as
  invisible composition glue such as collider-only trigger shapes.
- If a registry asset is used only as a base and substantially edited, record that in the handoff and
  preserve the original source metadata.
- Do not claim the registry was unavailable unless the prepare helper fails and the failure is recorded.
- Do not present placeholder entries as polished final art.

## Top-Down Composition

Avoid stretching small sprites into blurry rectangles. For arena floors or boundaries, tile or repeat
sprites at whole-unit counts where possible. Keep scale and collider dimensions explicit in scene
construction so the player, pickups, terminals, hazards, and HUD remain readable at the chosen camera
orthographic size.

For spritesheets such as the tech-lab arena sheet, a first pass may use the whole sheet as a source
texture for selected crop/slice sprites, but final scene objects should use readable individual tiles
or composed floor panels rather than showing a raw spritesheet as a world object.

## Handoff Requirements

The final handoff should include:

- the prepare report and attribution markdown
- a list of registry asset ids used per role
- explicit note for any role that fell back to procedural art and why
- screenshots proving the final scene does not look like placeholder geometry
- `.loombridge/handoff/asset-handoff-consistency.json` from `npm run asset:handoff:check`

Run the consistency check after final verdict files are written:

```bash
cd <loombridge-repo>/mcp-server
npm run asset:handoff:check -- \
  --prepare-report "$PROJECT/.loombridge/handoff/switchyard-asset-prepare-report.json" \
  --verdict "$PROJECT/.loombridge/handoff/build-verdict.json,$PROJECT/.loombridge/handoff/final-verdict.json" \
  --text "$PROJECT/.loombridge/handoff/SWITCHYARD_HANDOFF.md,$PROJECT/Assets/Scripts/Editor/SwitchyardSceneBuilder.cs" \
  --output "$PROJECT/.loombridge/handoff/asset-handoff-consistency.json"
```

Fix every reported issue before claiming final. In particular, audio roles must use the exact ids from
the prepare report (`opengameart.fupi...`, `opengameart.moxiecat...`, etc. for the current Switchyard
pack), and generated builder/handoff prose must not keep stale "registry skipped" or "self-authored
procedural assets" language once accepted registry assets are present.
