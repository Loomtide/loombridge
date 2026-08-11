---
name: asset-layer
description: Prepare curated art and audio for Loombridge demos through the asset-layer registry, including profile validation, provenance, deterministic project cache reports, attribution, and Unity import routing.
---

# Asset Layer

Use this skill when preparing curated art for Loombridge demos through the asset-layer registry.

## Asset priority: local registry by default (canonical: `Docs/Assets/AssetPriority.md`)

Resolve every required role in this order, the same for 2D and 3D:

1. **Local registry / profile fixtures and generated assets (the default path).**
   `asset-layer/registry/*.json` + `asset-layer/profiles/*.json`, or assets generated from the
   approved hero-shot annotations. No network, no account, no configuration, so an
   **offline** or air-gapped run is the normal case rather than a special mode.
2. **Hosted Loomtide catalog: an OPTIONAL, read-only accelerator** the developer may choose.
   Humans browse + approve candidates at **https://assetstore.loomtide.ai/**; the CLI reads a
   hosted search API via `--catalog-api <baseUrl>` (the CLI appends `/v1/assets/search`). The
   endpoint is configuration: pass `--catalog-api <baseUrl>` for the search API, or set
   `LOOMBRIDGE_ASSET_CATALOG_URL` and pass no source flag at all (it is the no-flag default for
   `--catalog`, a shard directory or `.jsonl` URL). No deployment host is baked into Loombridge; the current base URL
   is published alongside the asset store. The web-store domain serves `/api/...`, not
   `/v1/...`, so do not pass it to `--catalog-api`. When the developer has opted in, query the
   catalog per role, present candidates grouped by role, recommend a cohesive set, and STOP
   for approval before applying.
3. **Online discovery / web search**, only when **no asset in the chosen source fits** the role.
4. **Never** ship placeholder primitives as final assets when an approved registry asset exists
   for that role.

Whichever source is chosen, license policy, checksums, trust tiers, and the human approval
checkpoint are the same code path. Ask the developer which source they want; do not assume
the hosted catalog.

### 3D games (3D shooter, etc.): the registry path

The 3D flow is the same order; only the profile/kind inputs differ. The examples below use
`--registry` (the default path); swap in `--catalog-api <catalog-api-base>` only if the
developer opted into the hosted catalog.

**Precondition:** `registry-plan`/`registry-apply` read an existing draft
`.loombridge/ASSET_MANIFEST.json` and require `--profile`. Scaffold the draft manifest first
(`loombridge plan --asset-mode registry` — or `hybrid`) or both commands error with
`No .loombridge/ASSET_MANIFEST.json — run loombridge plan --asset-mode <mode> first.`
`registry-apply` also requires `--approved-at` and a `--selections` file you write after the
developer picks from the candidate list.

```bash
# 1. Produce candidates per 3D role from the chosen registry source
#    (kind=model for glb). Default: a checked-in pack.
loombridge assets registry-plan \
  --registry asset-layer/registry/<3d-pack>.json \
  --profile <3d-profile.json> \
  --preferred-license CC0-1.0 \
  --output .loombridge/run/reports/registry-selection-plan.json

# 2. Show candidates grouped by role, recommend a cohesive kit, get approval, then apply:
loombridge assets registry-apply \
  --registry asset-layer/registry/<3d-pack>.json \
  --profile <3d-profile.json> \
  --selections .loombridge/run/reports/registry-selections.json \
  --approved-at "<ISO timestamp>"

# Opted into the hosted catalog instead? Swap the source flag on BOTH commands
# (humans browse at https://assetstore.loomtide.ai/):
#   --catalog-api <catalog-api-base>
```

Prefer a single **cohesive kit** over mismatched one-off models (e.g. a military-toon shooter
kit for player + enemies + props). glb models import via glTFast, svg via vectorgraphics; each
record carries its direct asset URL + sha + license. Primitives (player capsule, floor quad,
projectile sphere) are construction scaffolding only: replace each with the approved model. A
role with **no** registry candidate keeps manifest `status: "needed"`/`"placeholder"` with a
"registry-missing" rationale, never shipped as a final primitive. ("registry-missing" is a
rationale note, **not** a `status` value; the status enum is the closed set
`approved|needed|placeholder` and the validator rejects anything else.)

### Web-search fallback: evidence before promotion

When no asset in the chosen source fits a role, a web-discovered asset may be promoted into
the manifest **only after** all of this is captured and shown to the developer for approval:

- **Source URL** + **provider** + **download page**.
- **License** is allowed (CC0-1.0 preferred), license URL recorded; CC-BY requires an explicit
  attribution decision.
- **`sha256` checksum** of the downloaded file, recorded in provenance.
- A **role-binding rationale** naming which role it fills and why no registry candidate fit
  (the "registry-missing" rationale; the role's manifest `status` stays `needed`/`placeholder`
  until the asset is ingested + approved).

Only `loombridge assets registry-apply` / `generated-apply` may write an approved manifest
binding. Never hand-edit `.loombridge/ASSET_MANIFEST.json` to `approved`, and never use
`selectAssets` as the approval source (it is a silent best-match helper).

## Workflow

1. Load the target profile first, then load one or more registry packs.
2. Select entries by `genre`, `primitive`, optional tags, license preference, and priority.
3. Validate license policy, source verification, provenance, checksum declarations, provider metadata, file format, technical metadata, and Unity path before writing a scenario.
4. Prepare files through the provider adapter layer into a deterministic cache and emit a JSON report with source, license, provenance, cache path, cache status, sha256 checksum, provider diagnostics, and Unity destination.
5. Generate attribution markdown from the prepare report and keep it with the run artifacts.
6. Import prepared images with generic Loombridge tools. For sprites, use `unity_asset_create_sprite` with `source_path` and the organized Unity `path`; optional audio metadata is validation-only unless a future task wires it through generic Unity asset operations.
7. After the game writes `build-verdict.json` / `final-verdict.json`, run the handoff consistency check so the reports cannot drift from the prepare report.

For clean-room Unity projects, prefer the repo helper over ad-hoc copying:

```bash
<loombridge-repo>/scripts/prepare-project-assets.sh \
  --project "$PWD" \
  --profile asset-layer/profiles/2d-topdown-arena.json \
  --registry asset-layer/registry/switchyard-2d.json \
  --name switchyard
```

Then read `.loombridge/run/handoff/switchyard-asset-prepare-report.json` and import every accepted `sprite`
asset using its `import.toolArguments`. Audio assets in the report should be copied/imported to the
reported Unity path and wired to gameplay. Do not ship procedural art/audio when the report contains
accepted non-placeholder candidates for the same primitive.

For human-visible demo runs, show the agent-selected prepared assets before importing them:

```bash
cd <loombridge-repo>/mcp-server
npm run build
node dist/capabilities/assets/browser-payload.js \
  --prepare-report "$PROJECT/.loombridge/run/handoff/switchyard-asset-prepare-report.json" \
  --output "$PROJECT/.loombridge/run/handoff/switchyard-asset-browser-payload.json"
```

Open the resulting JSON with `unity_asset_browser_open`, then poll `unity_asset_picker_state`.
Only import the confirmed `selection` asset ids. If the user cancels, stop and ask how to proceed.
This keeps the MCP bridge generic: the agent supplies the registry-derived payload, and Unity only
renders browse/filter/inventory/confirm UI.

Before final handoff, verify the registry accounting against the prepare report:

```bash
cd <loombridge-repo>/mcp-server
npm run build
npm run asset:handoff:check -- \
  --prepare-report "$PROJECT/.loombridge/run/handoff/switchyard-asset-prepare-report.json" \
  --verdict "$PROJECT/.loombridge/run/handoff/build-verdict.json,$PROJECT/.loombridge/run/handoff/final-verdict.json" \
  --text "$PROJECT/.loombridge/run/handoff/SWITCHYARD_HANDOFF.md,$PROJECT/Assets/Scripts/Editor/SwitchyardSceneBuilder.cs" \
  --output "$PROJECT/.loombridge/run/handoff/asset-handoff-consistency.json"
```

This fails if a verdict says `registryAssets.used=false`, if a role lists an id that does not match
the accepted asset at that Unity path, or if handoff/builder text still claims the registry was skipped.

## Boundaries

- Registry/profile/scenario data may be genre-specific.
- MCP tools remain generic: use `unity_*`, `runtime_*`, and screenshot capture operations.
- Do not add game-specific tools such as `platformer.*`.
- Preserve source URL, provider, license, and provenance fields in every prepared report.
- Prefer curated local/CC0 assets when available. Reject assets with disallowed license, source unverified, checksum mismatch, missing provider, or failing audio metadata until the registry/profile/source data is fixed.
- `build-verdict.json`, `final-verdict.json`, and handoff prose must use the exact asset ids from the prepare report. Do not invent friendlier source ids such as `freesound.cc0...` when the prepared asset id is `opengameart...`.
- Future generation providers must implement `AssetProviderAdapter`, emit technical metadata and diagnostics, pass profile validation, and avoid adding game-specific core MCP tools. Until then, `PROVIDER_NOT_CONFIGURED` is the expected deterministic failure.

## References

- `references/2d-platformer.md` for platformer primitive routing and validation expectations.
- `references/2d-topdown-arena.md` for Switchyard/top-down arena primitive routing, import expectations, and polished fallback rules.
