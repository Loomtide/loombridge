# Loombridge MCP Server

Loombridge is game-feel engineering for AI-built games, by [Loomtide](https://loomtide.ai). This package is its Unity bridge — the "Playwright for Unity" mechanism: an MCP server that exposes Unity editor operations as tools over stdio, enabling Claude Code (or any MCP-compatible client) to create objects, write scripts, capture screenshots, drive input, and verify running games without touching the Unity GUI.

## Prerequisites

- **Node.js** >= 18
- **Unity 6000.3 LTS (primary target)** with Loombridge package project(s):  
  `unity-projects/loombridge-dev` for package validation and `unity-projects/demo-platformer` for demo playtesting  
  (Unity 2022.3 LTS is also supported as a compatibility target)
- **Claude Code** (or any MCP-compatible client)

## Quick Start

1. **Build the server:**
   ```bash
   cd mcp-server && npm install && npm run build
   ```

2. **Configure Claude Code** -- add the MCP server to your settings (see below).

3. **Open your Unity project**:
   - `unity-projects/loombridge-dev` for package/EditMode validation
   - `unity-projects/demo-platformer` for demo playtesting
   The bridge starts a WebSocket server on ports 8200-8210.

4. **Use Claude Code** -- Unity tools appear automatically. Ask it to create objects, write scripts, or build entire scenes.

## Transport Modes and Endpoint Discovery

The Unity client uses transport-aware discovery before legacy port probing.

- `LOOMBRIDGE_UNITY_TRANSPORT_MODE=auto|ipc|tcp`
  - `auto` (default): endpoint discovery (`ipc` first, then discovered `tcp`), then legacy TCP probe (`8200-8210`)
  - `ipc`: requires endpoint discovery with IPC endpoint(s); fails fast if missing
  - `tcp`: discovered TCP endpoints first, then legacy TCP probe fallback
- `LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR`: override directory for discovery files
- `LOOMBRIDGE_ENDPOINT_DISCOVERY_FILE`: override explicit discovery file path

Default discovery location:
- `<os-temp>/loombridge/unitybridge/endpoint-discovery-latest.json`

Unity writes this file from BridgeServer and logs `[Loombridge] Published endpoint discovery (...)`.

## Bridge Startup Checklist

Use this same checklist on both Unity `6000.3 LTS` (primary) and `2022.3 LTS` (compatibility):

1. Open the Unity project and wait for bridge startup logs:
   - `[Loombridge] Bootstrap initializing`
   - `[Loombridge] Server started on ws://localhost:82xx`
   - `[Loombridge] Network intent: loopback only via ws://localhost:82xx, ws://127.0.0.1:82xx, ws://[::1]:82xx`
   - `[Loombridge] Published endpoint discovery (sessionId: ..., expiresAtUnixMs: ...)`
2. Run a disconnected baseline first when validating reliability:
   ```bash
   npm run smoke:phase3:disconnected
   ```
   This should return deterministic `CONNECTION_ERROR` results.
3. With Unity running, run connected smoke:
   ```bash
   npm run smoke:phase3:connected
   ```
4. For release checks, include compile cleanliness:
   ```bash
   node ../scripts/phase3-mcp-smoke.mjs --expect-connected --assert-compile-clean
   npm run check:unity-meta
   ```

5. Canonical baseline gate from `mcp-server/`:
   ```bash
   npm run verify:phase3:baseline
   ```

6. v0.11.0 reliability matrix evidence (from `mcp-server/`):
   ```bash
   npm run verify:phase3:baseline
   npm run matrix:phase3:6000.3
   npm run matrix:phase3:2022.3
   ```
   The v0.11.0 Phase 3 closeout ran this matrix across both supported Unity versions (6000.3 and
   2022.3) and archived the resulting evidence internally; the commands above reproduce the same
   matrix on demand.

## Claude Code Configuration

Add this to your Claude Code MCP settings (replace the path with your actual install location):

```json
{
  "mcpServers": {
    "loombridge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

## Available Tools

**121 tools across 12 categories** — see [`TOOLS.md`](TOOLS.md) (auto-generated; regenerate with `npm run docs:tools`) for the complete reference with parameters.

| Category | Count | Covers |
|----------|-------|--------|
| Scene     | 15 | objects, hierarchy, transforms, parenting, framing, bounds, screen rects, manifest verify |
| Editor    | 13 | play mode, screenshots, console, undo groups, wait_for, asset refresh, show-work |
| Input     | 7  | sessions, key down/up/tap, pointer tap, click UI, observe, capabilities |
| Runtime   | 7  | snapshot, probe, assert/wait conditions, measure motion, capture sequence/input motion |
| Component | 6  | list, add, remove, get/set properties, describe |
| Code      | 4  | create/read/modify scripts, attach |
| Animator  | 8  | controllers, states, transitions, parameters, declarative spec |
| UI        | 8  | canvas, text, image, button, rect transform, screen rects, text scan, pointer dispatch |
| Asset     | 9  | sprites, materials, prefabs, instantiation, asset picker/browser |
| Package   | 4  | UPM list/add/remove/search |
| Capture   | 1  | static-method capture invocation (gate evidence) |
| Ops       | 1  | `unity_ops_batch` — batch multiple ops in one round-trip |

All op tool names are prefixed with `unity_` (e.g., `unity_scene_create_object`). Two additional session-routing tools sit outside the op registry: `loombridge_editor_list` / `loombridge_editor_use` (multi-editor targeting; auto-binding via `LOOMBRIDGE_UNITY_PROJECT`).

## Input Playtesting Flow

Use this deterministic sequence for in-process gameplay input automation:

1. `unity_editor_play`
2. `unity_editor_wait_for` with `{ "playMode": "playing" }`
3. `unity_input_get_capabilities`
4. `unity_input_begin_session`
5. `unity_input_key_tap` with `{ "key": "Space" }`
6. `unity_editor_wait_for` with `{ "frames": 12 }`
7. `unity_input_key_down` with `{ "key": "RightArrow" }`
8. `unity_editor_wait_for` with `{ "frames": 8 }`
9. `unity_input_key_up` with `{ "key": "RightArrow" }`
10. `unity_input_end_session`

If an input tool fails, check structured protocol codes in the response and trace:
- `FOCUS_REQUIRED`
- `INVALID_KEY`
- `INPUT_BACKEND_UNAVAILABLE`
- `INPUT_SYSTEM_NOT_INSTALLED`
- `INPUT_SESSION_REQUIRED`
- `INPUT_CAPABILITY_BLOCKED`

Notes:
- Always evaluate input capability before gameplay input: `unity_input_get_capabilities` now returns `inputCapability.supported` plus a deterministic blocker reason/code when unsupported.
- Deterministic gameplay key injection requires the Unity Input System backend (`backend.selected = InputSystem` from `unity_input_get_capabilities`).
- For gameplay scripts, use Input System edge detection based on `isPressed` + previous-state caching instead of relying only on `wasPressedThisFrame` for injected taps.
- `EditorEvent` remains a legacy fallback for environments where Input System is unavailable, but it is best-effort and may not drive all gameplay input polling paths.

## Generic Runtime Verification Flow

Use runtime primitives for game-agnostic validation instead of game-specific commands:

1. `unity_runtime_get_snapshot` for object/component state inspection.
2. `unity_runtime_assert_condition` for comparator-based pass/fail checks (`equals`, `not_equals`, `greater_than`, `less_than`, `approx`, `contains`).
3. `unity_runtime_wait_for_condition` for deterministic polling with `frames`, `delayMs`, and `timeoutMs`.

Guardrail:
- Keep core automation generic. Demo/game-specific behavior should be composed in playbooks/scripts using existing `unity_*` primitives, not added as new bespoke core tools.

## Scenario Runner (Generic Orchestration)

Run reusable scenario documents from `demo/scenarios/` to validate tool composition with deterministic preflight-first pass/fail/blocked reports.

From `mcp-server/`:

```bash
npm run scenario:validate
npm run scenario:run
```

- `scenario:validate` runs `generic-smoke.json` in `--dry-run` mode and writes `demo/.artifacts/scenario-validate.json`.
- `scenario:run` executes `generic-playtest.json` against a connected Unity editor, gates scenario steps with deterministic preflight checks, and writes `demo/.artifacts/scenario-run.json`.

Direct CLI usage:

```bash
node dist/scenario-cli.js --scenario ../demo/scenarios/generic-smoke.json --dry-run --output ../demo/.artifacts/scenario-report.json
```

Report contract highlights:
- `status`: `pass`, `fail`, or `blocked`
- `steps[]`: deterministic per-step outcomes (index, id, tool, duration, status, error/response)
- `failedStepIndex` / `failedStepId` / `failedStepStatus` when execution stops on first non-pass
- `diagnostics`: includes `passedSteps`, `failedSteps`, and `blockedSteps`
- `artifactMetadata`: normalized artifact count for repeatable machine comparison
- `artifacts[]` references for captured outputs
- Normal demo execution should not depend on manual editor actions; if manual editor intervention is needed, treat the run as non-repeatable.

## Asset Layer Platformer Scenario

The v0.11.0 asset layer prepares curated CC0 platformer sprites into a local cache and generates a scenario that imports them with generic Loombridge tools.

From `mcp-server/`:

```bash
npm run verify:phase3:asset-layer
```

Equivalent expanded sequence:

```bash
npm run build
npm run test:unit
npm run test:integration
npm run asset:platformer:validate
npm run asset:platformer:prepare
npm run asset:platformer:attribution
npm run scenario:platformer:assets:validate
```

Generated outputs:
- `../demo/.artifacts/platformer-assets.json`: report with `cachePath`, `cacheStatus`, `sha256` checksum, `unityPath`, `source`, `license`, provenance, provider diagnostics, validation status, and rejection diagnostics
- `../demo/.artifacts/platformer-assets-attribution.md`: markdown attribution/provenance output for accepted assets
- `../demo/.artifacts/asset-cache/`: deterministic local asset cache
- `../demo/scenarios/build-platformer-with-assets.json`: scenario using `unity_asset_create_sprite` `source_path` and `Assets/Art/...` import paths

The asset prepare CLI validates registry policy before selection. It rejects disallowed license values, source unverified entries, invalid checksum declarations or checksum mismatch, unsupported primitive/kind pairings, and audio metadata failures. Acquisition uses a provider adapter interface for local fixtures, HTTP downloads, and unconfigured generation providers; generation entries return `PROVIDER_NOT_CONFIGURED` until a real adapter is implemented and configured.

Connected execution after UnityBridge is running in `unity-projects/demo-platformer`:

```bash
node dist/scenario-cli.js --scenario ../demo/scenarios/build-platformer-with-assets.json --output ../demo/.artifacts/platformer-assets-run.json
```

Boundary rule: registry/profile/scenario data can be genre-specific, but the MCP surface remains generic. Do not add `platformer.*` tools; compose `unity_*`, runtime, input, and screenshot steps instead.

## Hosted Asset Registry

The hosted catalog is **live at scale** (66,859 records — PNG sprites / OGG audio / self-contained GLB
models / SVG vectors — on Cloudflare R2 + Railway Postgres behind a read-only search API, with an
in-Unity asset browser). The local registry remains supported; new asset-registry work targets the
hosted catalog boundary. As-built state, operations, and pending work:
`../Docs/Assets/HostedAssetRegistry.md` ("Live Status & Handoff"); external quickstart:
`../Docs/Assets/PublicCatalogQuickstart.md`.

Private mirror seed (publish-pipeline input):

- Repo: `https://github.com/Loomtide/LoomtideAssetRegistry`
- Provider/source: `kenney` / `kenney-all-in-one-3.5.0`
- Asset bytes: `assets/providers/kenney/all-in-one/3.5.0/`
- Sharded catalog: `catalog/assets/kenney-all-in-one-3.5.0/part-*.jsonl`
- Source metadata: `catalog/sources/kenney-all-in-one-3.5.0.json`

Catalog records include `localPath`, `githubRawUrl`, `githubBlobUrl`, checksum/size metadata,
license policy, acquisition lane, trust tier, and `review.status`. Treat `review.status === "verified"`
as the product-owned verification signal; the `verified` tag is only a search/facet convenience.

Local command support:

```bash
node dist/asset-layer/browser-payload.js --profile ../asset-layer/profiles/2d-platformer.json --catalog ../asset-layer/catalog-fixtures/platformer-catalog.json --output ../demo/.artifacts/asset-browser-payload.json
node dist/asset-layer/prepare-cli.js --profile ../asset-layer/profiles/2d-platformer.json --catalog ../asset-layer/catalog-fixtures/platformer-catalog.json --output ../demo/.artifacts/platformer-assets.json --cache ../demo/.artifacts/asset-cache
node dist/loombridge/assets.js registry-plan --catalog ../asset-layer/catalog-fixtures/platformer-catalog.json --profile ../asset-layer/profiles/2d-platformer.json
node dist/loombridge/assets.js registry-apply --catalog ../asset-layer/catalog-fixtures/platformer-catalog.json --profile ../asset-layer/profiles/2d-platformer.json --selections <json> --approved-at <iso>
node dist/loombridge/assets.js registry-apply --catalog-api <hosted-catalog-url> --profile ../asset-layer/profiles/2d-platformer.json --from-selection <web-selection.json> --approved-at <iso>
```

Implementation rules:

- Keep tests deterministic and offline by using fixture JSON/JSONL shards or stubbed fetch.
- Query the registry/backend, present choices to the user, and write `.loombridge/ASSET_MANIFEST.json`
  only through project-local approval flow.
- Web asset-browser exports are read-only inputs. `registry-apply --from-selection` maps them to
  manifest slots by exact role first, then primitive fallback; it refuses ambiguous mappings,
  duplicate slot bindings, unknown `registryId`s, invalid candidates, unmatched items, and
  unfilled slots before writing.
- Do not let slices silently search the registry or substitute assets outside the approved manifest.
- Prefer GitHub raw/local cache for the current private seed; later hosted storage/CDN URLs can be added
  without changing asset ids or checksums.
- Use `LOOMBRIDGE_ASSET_CATALOG_URL` to point hosted catalog reads at a private GitHub raw shard or
  later backend endpoint without changing deterministic fixture tests.
- Use `LOOMBRIDGE_ASSET_REGISTRY_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN` for private GitHub catalog/file
  reads. Loombridge attaches the bearer token only to GitHub hosts, not arbitrary provider downloads.

## Cross-Project Scenario Matrix

Cross-project closeout for `v0.11.0` is profile-driven and keeps core APIs game-agnostic.

Profile registry:
- `demo/scenarios/cross-project/profiles.json`

Project profiles:
- `loombridge-dev` -> `unity-projects/loombridge-dev`
- `demo-platformer` -> `unity-projects/demo-platformer`

Commands from `mcp-server/`:

```bash
npm run matrix:cross-project:loombridge-dev
npm run matrix:cross-project:demo-platformer
```

Direct script form:

```bash
node ../scripts/phase3-cross-project-matrix.mjs --mode both --unity-version 6000.3 --profile loombridge-dev --output ../demo/.artifacts/03-matrix-loombridge-dev.json
node ../scripts/phase3-cross-project-matrix.mjs --mode both --unity-version 6000.3 --profile demo-platformer --output ../demo/.artifacts/03-matrix-demo-platformer.json
```

The v0.11.0 closeout ran this matrix across both supported Unity versions and both project
profiles, archiving the resulting evidence + summary internally; the commands above reproduce
the same matrix artifacts on demand.

Artifact interpretation:
- `status=pass`: disconnected baseline + connected scenario run succeeded.
- `status=blocked`: deterministic environmental blocker (for example `EPERM_LOOPBACK`, `ECONNREFUSED_NO_LISTENER`, `TIMEOUT_CONNECT`); blocked connected output is preserved as evidence but is not a product pass when offline gates pass.
- `status=fail`: unexpected regression in scenario execution/tooling.

## Development

```bash
npm run build          # Compile TypeScript
npm run test:unit      # Run unit tests
npm run test:integration  # Run integration tests (spawns server over stdio)
npm test               # Build + all tests
npm run typecheck      # Type-check without emitting
npm run smoke:phase3:disconnected  # MCP smoke check without Unity
npm run smoke:phase3:connected     # MCP smoke check with Unity running
npm run matrix:phase3:6000.3       # disconnected+connected reliability matrix for Unity 6000.3
npm run matrix:phase3:2022.3       # disconnected+connected reliability matrix for Unity 2022.3
npm run matrix:cross-project:loombridge-dev  # profile-based cross-project matrix (package-dev project)
npm run matrix:cross-project:demo-platformer   # profile-based cross-project matrix (demo consumer project)
npm run verify:phase3:asset-layer     # v0.11.0 build + tests + asset-layer offline gate
npm run asset:platformer:prepare          # prepare/cache curated platformer assets
npm run asset:platformer:attribution      # emit attribution markdown from the prepare report
npm run scenario:platformer:assets:validate  # generate and dry-run curated asset scenario
npm run check:unity-meta           # Unity .meta integrity check
npm run verify:phase3:baseline     # test:all + disconnected smoke + meta check
```

Matrix status interpretation:
- `pass`: disconnected and connected runs succeeded for the target Unity version.
- `blocked`: deterministic environmental blocker (for example `EPERM_LOOPBACK`) with remediation guidance.
- `fail`: unexpected runtime/tooling failure that must be investigated before closeout.

Connected blocker interpretation:
- `ECONNREFUSED_NO_LISTENER`: UnityBridge listener is not running/reachable (open Unity and wait for `[Loombridge] Server started ...`).
- `EPERM_LOOPBACK`: host policy blocks loopback sockets; rerun on a host where loopback probing is allowed.

## Troubleshooting

- **CONNECTION_ERROR**: run `npm run verify:phase3:baseline`, then run `npm run matrix:phase3:6000.3` and `npm run matrix:phase3:2022.3` to capture blocker signatures/remediation hints (`EPERM_LOOPBACK`, `ECONNREFUSED_NO_LISTENER`, `TIMEOUT_CONNECT`) for both `6000.3` and `2022.3`.
- **Bridge startup logs missing**: verify Unity console shows `[Loombridge] Bootstrap initializing` and `[Loombridge] Server started on ws://...`.
- **Port conflicts**: the plugin scans ports 8200-8210. Ensure no other process is bound to those ports.
- **Build errors**: Verify Node.js >= 18 with `node --version`.
- **Compilation wait**: After creating/modifying scripts, use `unity_editor_wait_for` with `compiling: false` before attaching or testing.
- **Asset layer prepare failures**: inspect `../demo/.artifacts/platformer-assets.json`; invalid license/provenance, unsupported format, oversized dimensions, and invalid `Assets/Art` paths are reported as rejection codes.
