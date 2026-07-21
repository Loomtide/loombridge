# Loombridge

**Game-feel engineering for AI-built games** — [loomtide.ai](https://loomtide.ai)

Loombridge helps AI agents build games with feel and polish: a production-grade pipeline that turns an idea into measurable slices with feel targets and gates (**plan**), authors gameplay in-engine with reusable, genre-aware skills (**build**), and measures the running game against its targets — proof, not vibes (**verify**). Unity is the first supported engine; the deterministic CLI core is engine-agnostic.

The mechanism is two layers:

- **The bridge** — Loombridge's "Playwright for Unity" layer: an MCP (stdio) server + a C# Unity Editor plugin, exposing 121 generic `unity_*` tools (scene, editor, component, code, animator, UI, asset, input, runtime, package, capture, batch).
- **The `loombridge` CLI**: a deterministic, agent-agnostic command set (`plan` / `build` / `verify` / `doneness`, plus `minigame`, `trace`, `design`, `assets`, `status`, `ask`) that owns project state in `.loombridge/` and enforces verification contracts so a "done" claim can never be self-graded.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full system design.

## Repository Layout

- `packages/com.loomtide.loombridge/`: canonical UPM package source (Editor, Runtime, Tests).
- `mcp-server/`: TypeScript MCP server (stdio) **and** the `loombridge` CLI (`src/cli.ts`, `src/loombridge/`).
- `unity-projects/loombridge-dev/`: primary Unity project for package development and EditMode tests.
- `unity-projects/demo-platformer/`: demo Unity project consuming the package via local `file:` dependency.
- `apps/asset-api/`: read-only hosted asset search API (Railway-deployed).
- `asset-layer/`: curated registry, profiles, public catalog seed, license/provenance metadata.
- `commands/loombridge/`: agent-facing slash-command prose (Codex wrappers are generator-emitted).
- `scripts/`: install/freeze, build stamping, smoke and reliability scripts.
- `Docs/`: product docs — `Profiles/` (verify contracts + partner guides), `Assets/` (hosted asset registry), `FutureIdeas/ReplayVerification.md` (replay design + status).
- `demo/`: demo playbook content.
- `unity-plugin/`: legacy archive only — do not use for active validation or new work.

## Requirements

- Node.js `>= 18`
- Unity `6000.3 LTS` (primary target); Unity `2022.3 LTS` (compatibility target)

## Quick Start (MCP bridge)

For a complete setup guide, including multiple open Unity projects and per-session routing, see
[`Docs/GettingStarted.md`](Docs/GettingStarted.md).

1. Install and build the MCP server:

```bash
cd mcp-server
npm install
npm run build
```

2. Open a Unity project based on your workflow:
   - package tests/development: `unity-projects/loombridge-dev`
   - demo playtesting: `unity-projects/demo-platformer`
3. Wait for Unity console logs with the `[Loombridge]` prefix:
   - `[Loombridge] Bootstrap initializing`
   - `[Loombridge] Server started on ws://localhost:82xx`
4. Configure your MCP client to run the server. With the installed CLI (the usual way):
   - command: `loombridge`, args: `["mcp"]`

   or straight from this repo's build:
   - command: `node`, args: `["/absolute/path/to/mcp-server/dist/index.js"]`

For multi-project workflows, configure each MCP session with `LOOMBRIDGE_UNITY_PROJECT` so it binds
strictly to the intended Unity project and never falls through to another open editor. Sessions can
also switch targets at runtime via the `loombridge_editor_list` / `loombridge_editor_use` tools.

## The `loombridge` CLI

The CLI is delivered through GitHub Releases on the private **distribution repo**
(`Loomtide/loombridge` — release assets only, so partners never need access to this source
monorepo). Everyone (partners *and* contributors) installs and updates it with **one command**, no npm
account (see [`Docs/Install.md`](Docs/Install.md)):

**Fresh machine (recommended)** — the bootstrap installs the missing prerequisites (Node.js + GitHub CLI)
too, then the CLI. The Windows one is PowerShell-native and needs **no Git Bash**:

```powershell
irm https://get.loomtide.ai/win | iex                     # Windows (PowerShell 5.1 or 7)
```
```bash
curl -fsSL https://get.loomtide.ai/setup | sh             # macOS / Linux
```

On Windows, if Node.js or the GitHub CLI is **missing**, winget installs them machine-wide (MSI) and
needs elevation — run the line in an **elevated PowerShell**, or expect a UAC prompt. Once both are
present, the bootstrap needs no elevation and is safe to re-run as an updater.

**Already have Node + gh** — the raw installer:

```bash
gh auth login                                             # one-time (GitHub account you already have)
curl -fsSL https://get.loomtide.ai | sh                   # install the CLI; re-run to update
loombridge --version                                        # loombridge <version> (<commit>, built <iso>)
```

Then wire and health-check any Unity project (no repo clone):

```bash
loombridge install-bridge --project /path/to/UnityProject   # adds the bridge as a file: tarball dependency
loombridge install-agent  --project /path/to/UnityProject   # OPTIONAL: commit the agent commands + skills into the repo (team-wide; --remove opts out)
loombridge doctor         --project /path/to/UnityProject   # health check (--live also probes the running bridge)
loombridge update         --project /path/to/UnityProject   # swap in this CLI's bundled bridge, then re-check
```

Working **from this repo** (contributor paths):

```bash
# agent surface (slash commands, skills, aux harness wrappers -> ~/.local/bin/loombridge-*):
./scripts/loombridge-install-locally.sh     # deliberately does NOT install a `loombridge` bin —
                                          # that would shadow the released CLI on PATH

# test UNRELEASED CLI changes: link the dev bin (follows every `npm run build`):
cd mcp-server && npm link                 # `loombridge --version` shows your local commit (+dirty)

# push THIS checkout's bridge into a consumer project without cutting a release:
scripts/loombridge-dev-update.sh --project /path/to/UnityProject

# cut a release (maintainers) — partners pick it up via the same curl one-liner:
scripts/loombridge-release.sh
```

Main verbs (see `ARCHITECTURE.md` § "The `loombridge` CLI Product Layer"):

- `loombridge plan` / `build` / `verify` / `doneness` — the supervised build loop (slice roadmap → Tier-1 deterministic gates → runId-bound doneness with hero-shot fidelity).
- `loombridge verify --profile <precision|classic|momentum>` — verify-first feel grading of an existing 2D platformer ([`Docs/Profiles/VerifyFirstEntry.md`](Docs/Profiles/VerifyFirstEntry.md)).
- `loombridge verify --minigame` + `loombridge minigame <init|setup|capture|finalize|baseline …>` — release verification for 2D mini-games with a partner-clean HTML/MD report and a frozen `0/1/2` exit contract ([`Docs/Profiles/MiniGameVerifyQuickstart.md`](Docs/Profiles/MiniGameVerifyQuickstart.md), CI guide: [`Docs/Profiles/MiniGameVerifyCI.md`](Docs/Profiles/MiniGameVerifyCI.md)).
- `loombridge trace <record --observe|replay|replay-all|approve|report>` — replay verification: record a human demonstration once, replay it deterministically with perceptual baseline diffs ([`Docs/FutureIdeas/ReplayVerification.md`](Docs/FutureIdeas/ReplayVerification.md)).
- `loombridge assets <registry-plan|registry-apply|generated-plan|generated-apply>` — deterministic Asset Manifest approval, including `registry-apply --from-selection <web-selection.json>` for asset-web exports.
- `loombridge mcp` — runs the MCP stdio server (same dist as the `loombridge-mcp` bin).

## Asset Layer & Hosted Catalog

The local asset layer prepares curated, license/provenance-enforced art before Unity import; registry/profile data is genre-specific but import happens only through generic `unity_*` tools.

A **public hosted asset catalog is live**: 66,859 records (PNG sprites, OGG audio, self-contained GLB models, SVG vectors) on Cloudflare R2 + Railway Postgres behind a read-only search API, browsable inside Unity via **Window → Loombridge → Asset Browser**. As-built state and operations: [`Docs/Assets/HostedAssetRegistry.md`](Docs/Assets/HostedAssetRegistry.md); external quickstart: [`Docs/Assets/PublicCatalogQuickstart.md`](Docs/Assets/PublicCatalogQuickstart.md).

From `mcp-server/`:

```bash
npm run verify:phase3:asset-layer        # offline asset-layer quality gate
npm run asset:platformer:validate
npm run asset:platformer:prepare
npm run asset:platformer:attribution
npm run scenario:platformer:assets:validate
```

Outputs land under `demo/.artifacts/` (prepare report, attribution markdown, deterministic cache) and `demo/scenarios/` (generated offline-valid scenario). The prepare step enforces registry policy before selection: kind/primitive compatibility, checksum declarations, license allow/deny rules, source verification, and minimum provenance fields.

## How To Test

Run from `mcp-server/` unless noted.

```bash
npm run ci                        # build + typecheck + unit + integration (the pre-commit bar)
npm run test:all                  # tests only
npm run smoke:phase3:disconnected # smoke test, Unity closed
npm run smoke:phase3:connected    # smoke test, Unity open
npm run verify:phase3:baseline    # full baseline verification
```

Cross-project matrix runs (profile-driven, both Unity projects):

```bash
npm run matrix:cross-project:loombridge-dev      # with unity-projects/loombridge-dev open
npm run matrix:cross-project:demo-platformer   # with unity-projects/demo-platformer open
```

Status interpretation: `pass` = baseline + connected scenario succeeded; `blocked` = deterministic environment blocker (e.g. `EPERM_LOOPBACK`, `TIMEOUT_CONNECT`) preserved as evidence, not a product pass; `fail` = real regression.

EditMode tests run headless from `unity-projects/loombridge-dev` (see `TESTING.md` for the batchmode command and gotchas).

## Transport Modes and Endpoint Discovery

- `LOOMBRIDGE_UNITY_TRANSPORT_MODE`:
  - `auto` (default): endpoint discovery (`ipc` first, then discovered `tcp`), then legacy TCP port probe (`8200-8210`).
  - `ipc`: require endpoint discovery with an IPC endpoint; no TCP fallback.
  - `tcp`: discovered TCP endpoints first, then legacy port probe.
- IPC is a unix domain socket on macOS/Linux and a named pipe on Windows; both are reached with a
  `ws+unix:<path>:/` URL (ws ignores a `socketPath` option, so that URL form is the only one that works).
- `doctor --live` reports the transport it settled on (`live.transport`, also in `--ci` JSON) — an
  `auto` run that silently degrades from `ipc` to `tcp` is therefore visible rather than invisible.
- `LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR` / `LOOMBRIDGE_ENDPOINT_DISCOVERY_FILE`: optional overrides for where Unity publishes / MCP reads `endpoint-discovery-latest.json` (default: `<temp>/loombridge/unitybridge/`).

## Notes

- Unity APIs must run on the main thread (`EditorApplication.update` queue).
- JSON in Unity uses Newtonsoft (not `JsonUtility`).
- See `TESTING.md` for validation policy and troubleshooting.
- See `mcp-server/README.md` for tool-level MCP usage and `mcp-server/TOOLS.md` for the auto-generated 121-tool reference.
