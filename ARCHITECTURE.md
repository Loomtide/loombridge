# Loombridge Architecture

Loombridge is **the agent layer for building and verifying Unity games** ([loomtide.ai](https://loomtide.ai)) — a production-grade plan → build → verify pipeline that helps AI agents construct games and proves the result against measurable targets (framing, assets, UI, playability, audio, and feel). "Playwright for Unity" describes the *mechanism*, not the product: AI agents see, control, and verify Unity projects through MCP. Unity is the first supported engine; the deterministic CLI core is engine-agnostic. Architecturally there are two major layers:

1. **The bridge** — a two-process MCP system: a Node.js MCP server (stdio) talks to a C# plugin inside the Unity Editor over WebSocket (IPC or TCP), exposing 121 generic `unity_*` tools across 12 op categories.
2. **The `loombridge` CLI product layer** — a deterministic, agent-agnostic command set (`plan` / `build` / `verify` / `doneness` plus `minigame`, `trace`, `feel`, `design`, `assets`, `capture`, `status`, `ask`, and the setup verbs `install-bridge` / `doctor` / `update`) that owns project state in `.loombridge/`, enforces verification contracts, and supervises agent-driven builds so a "done" claim can never be self-graded.

Around these sit two supporting subsystems: the **replay verification** engine (record-by-demonstration → deterministic trace replay → perceptual baseline diff) and the **asset layer** (a local curated registry plus a live public hosted asset catalog on R2 + Postgres with an in-Unity browser).

## Repository Topology

- `packages/com.loomtide.loombridge/` — canonical Unity bridge UPM package (Editor, Runtime, Tests).
- `mcp-server/` — TypeScript: the MCP stdio server, the op registry, **and** the `loombridge` CLI (`src/cli.ts`, `src/capabilities/`).
- `unity-dev-project/` — package development + EditMode test project. **Not a demo** — it is
  what `.github/workflows/unity-editmode.yml` runs CI against, which is why it sits outside
  `demos/`.
- `asset-layer/` — curated registry packs, validation profiles, public catalog seed, fixtures, provenance. **Data, not code** — the asset *code* is `mcp-server/src/capabilities/assets/`.
- `commands/loombridge/` — agent-facing slash-command prose (Claude; Codex wrappers are generator-emitted).
- `.skills/` — the genre and craft skill packs (2D game build, feel/verify, UI polish, SFX, 3D art integration, session retro…). Shipped into a consumer project by `loombridge install-agent` alongside `commands/`.
- `templates/create-loombridge-game/` — the starter project scaffold.
- `demos/` — everything demonstrable, in one place:
  - `unity-platformer/` — demo consumer project (local `file:` package reference).
  - `evidence-bundles/` — frozen evidence bundles and their `generate.mjs` reproducers; the
    substrate proofs referenced from the docs. Each reproducer re-derives its numbers through
    the production calculators, so a bundle cannot drift from the code silently.
  - `scenarios/`, `.artifacts/` — scenario inputs and the local asset-cache/preview artifacts.
- `scripts/` — install/freeze (`loombridge-install-locally.sh`), bridge packaging (`loombridge-pack-bridge.sh`) + legacy embed (`loombridge-embed-bridge.sh`), build stamping, smoke runners, artifact sync.
- `Docs/` — product docs: `Install.md` (new-machine setup) + `BridgeDistribution.md` (bridge install options), `Profiles/` (verify contracts + partner guides), `Assets/` (public hosted-catalog quickstart), `ThreatModel.md`, `UnityAutonomousLaunch.md`.

The hosted asset search API is a company-run service (public endpoint below), not a subtree of this repo.

## Source Layers (`mcp-server/src/`)

Dependencies run in ONE direction, and the rule is enforced by
`src/__tests__/unit/repo/layering.test.ts` — including a litmus that plants a violation and
requires the checker to report it, so the check can never pass vacuously:

```
surfaces  ->  capabilities  ->  { bridge, domain }  ->  shared
```

- **`shared/`** — leaf helpers with no domain knowledge (`build-stamp`, `cli-ui`, `pkg-root`,
  `types`, `arg-validation`, `diagnostics`).
- **`domain/`** — the shared nouns: JSON schemas, capture paths, workspace layout, contract
  presence. Deliberately small.
- **`bridge/`** — Unity transport and editor routing: `unity-client`, `editor-registry`,
  `editor-discovery`, `startup-binding`, the trace recorder, `preflight/`.
- **`capabilities/`** — one directory per area, each owning its CLI verb entrypoint:
  `verification/`, `replay/`, `minigame/`, `feel/`, `genre/`, `assets/`, `sfx/`,
  `telemetry/`, `setup/`, `mobile/`, `scenario/`.
- **`surfaces/`** — the entrypoints: MCP server (`index.ts`), CLI dispatcher (`cli.ts`),
  op registry, tool definitions.

`bridge/` and `domain/` are siblings — neither imports the other, which is what keeps the
wire protocol out of the contract vocabulary.

**Where does new code go?** If it is vocabulary several areas share, `domain/`. If it does
something — grades, drives, captures, installs — it belongs to one `capabilities/<area>/`.
If it talks to Unity, `bridge/`. If it is a leaf utility with no knowledge of any of them,
`shared/`.

Tests mirror the layout under `src/__tests__/unit/<layer>/<area>/`, so a file's tests live
where the file does. `__tests__/integration/` stays separate (it needs a live editor) and
runs via `npm run test:integration`, never `test:unit`.

Three things this reorganisation taught us, worth not re-learning:
- Genre packs and sfx cue-maps *look* like vocabulary but import gate implementations, so
  they are capabilities, not domain.
- Anything that reads data out of the source tree must locate the package root via
  `shared/pkg-root.ts` (and tests via `__tests__/_support/paths.ts`) rather than counting
  `..` segments, which silently encodes how deep a file happens to sit.
- `package.json` `bin` targets are declared paths nothing imports, so a full green suite
  can still hide broken published executables — `package-entrypoints.test.ts` guards them.

Unity targets: `6000.3` LTS primary, `2022.3` compatibility. Unity diagnostics use the `[Loombridge]` log prefix. Node `>= 18`.

## System Diagram

```
 ┌──────────────┐   stdio    ┌───────────────────────────┐    WebSocket     ┌───────────────────────────┐
 │ AI agent      │◄─────────►│   MCP Server (Node.js)     │◄───────────────►│  Unity Bridge Plugin (C#)  │
 │ (MCP client)  │           │                             │  ipc / tcp      │                             │
 └──────────────┘           │  StdioServerTransport       │  :8200-8210     │  BridgeServer               │
                             │  Server (MCP SDK)           │  + endpoint     │   handshake, main-thread    │
 ┌──────────────┐           │   tools/list → OpRegistry   │    discovery    │   queue, send semaphore     │
 │ loombridge CLI  │           │   tools/call → UnityClient  │                 │  OpExecutor                 │
 │ (same dist)   │──────────►│  OpRegistry (121 tools /    │                 │   category → IOpHandler     │
 │  plan/build/  │ UnityClient│   12 categories)           │                 │  Handlers (12): Scene,      │
 │  verify/trace/│  (direct)  │  Editor routing tools       │                 │   Editor, Component, Code,  │
 │  minigame/…   │           │   (loombridge_editor_list/use)│                 │   Animator, UI, Asset,      │
 └──────┬───────┘           │  UnityClient                │                 │   Input, Runtime, Package,  │
        │                    │   discovery, handshake,     │                 │   Capture, Ops              │
        ▼                    │   reconnect + heartbeat     │                 │  TraceCollector             │
 ┌──────────────┐           │  TraceRecorder              │                 │  InputSystemRuntimePump /   │
 │ .loombridge/    │           │   JSONL + artifacts         │                 │   InputObserver (Runtime)   │
 │ state+reports │           └───────────────────────────┘                 └───────────────────────────┘
 └──────────────┘
```

## Communication Flow

A tool call travels through the system in these steps:

1. The MCP client invokes a tool (e.g. `unity_scene_create_object`) via stdio.
2. **Server** looks the tool up in **OpRegistry**, which maps `unity_scene_create_object` → wire command `scene.create_object`.
3. **UnityClient** sends `{ id, command, params }` over the WebSocket.
4. **BridgeServer** (C#) enqueues it on the main-thread queue; `EditorApplication.update` drains the queue (Unity APIs are main-thread-only).
5. **OpExecutor** splits `category.opName`, dispatches to the registered `IOpHandler` (e.g. `SceneHandler`).
6. The handler runs the Unity API call, returns a `JObject`; **BridgeServer** sends the response back; **UnityClient** resolves the pending promise.

Async ops (`editor.wait_for`, `runtime.wait_for_condition`, `runtime.capture_input_motion`, package ops) resolve via callback, polled from `EditorApplication.update`. A per-call `timeoutMs` arg overrides `op.defaultTimeoutMs` (`resolveOpTimeoutMs` in `index.ts`). Ops that trigger a domain reload (package add/remove, recompiles) can lose their response — agents chain `editor.wait_for { compiling: false }`, and `UnityClient.send()` awaits an in-flight reconnect rather than failing.

### Transports, Discovery, and Multi-Editor Routing

- `LOOMBRIDGE_UNITY_TRANSPORT_MODE` selects `auto` (IPC discovery → TCP discovery → legacy port probe 8200–8210), `ipc` (discovery-required), or `tcp`.
- Unity publishes `endpoint-discovery-latest.json` under `<temp>/loombridge/unitybridge/` (overridable via `LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR`/`_FILE`); the MCP server reads the same location.
- **Handshake is enforced in code**: every new connection must send `bridge.initialize` first; everything else gets `HANDSHAKE_REQUIRED`. Reconnects re-handshake.
- **Multi-editor routing**: with several Unity editors open, sessions bind to one project. `loombridge_editor_list` / `loombridge_editor_use` (MCP tools outside the op registry) switch targets; startup binding (`startup-binding.ts`) auto-binds from `LOOMBRIDGE_UNITY_PROJECT` (strict) or nearest-Unity-project cwd inference, so a session never falls through to the wrong editor.
- Heartbeat ping/pong (3s/5s) detects dead sockets; reconnect uses exponential backoff.

## Unity Bridge Plugin

### BridgeServer

- HttpListener + WebSocket inside the editor process; IPC and/or TCP listeners per transport mode; last good TCP port cached in `EditorPrefs`.
- Main-thread `ConcurrentQueue<Action>` drained each frame (up to 10 commands/frame).
- Per-socket `SemaphoreSlim` serializes `SendAsync`.

### Op Handlers (12)

| Category | Handler | Covers |
|----------|---------|--------|
| scene | SceneHandler | Create/delete/duplicate objects, hierarchy, transforms, parenting, selection, framing, bounds, screen rects, manifest verify |
| editor | EditorHandler | Play/pause/stop, screenshots, console, undo groups, `wait_for`, asset refresh, show-work |
| component | ComponentHandler | List/add/remove components, get/set serialized properties, describe |
| code | CodeHandler | Create/read/modify C# scripts, attach MonoBehaviours |
| animator | AnimatorHandler | Controllers, states, transitions, parameters, declarative spec |
| ui | UIHandler | Canvas, Text, Image, Button, RectTransform, screen rects, text scan, pointer dispatch |
| asset | AssetHandler | Sprites, materials, prefabs, instantiation, asset picker/browser windows |
| input | InputHandler | Input sessions, key down/up/tap, pointer tap, click UI, observe start/stop, capabilities |
| runtime | RuntimeHandler | Snapshot, probe, assert/wait conditions, measure motion, capture sequence, capture input motion |
| package | PackageHandler | UPM list/add/remove/search |
| capture | CaptureHandler | Static-method capture invocation (gate evidence emitters) |
| ops | OpsHandler | `unity_ops_batch` — batch multiple ops in one round-trip |

See [mcp-server/TOOLS.md](mcp-server/TOOLS.md) (auto-generated, `npm run docs:tools`) for the full 121-tool reference.

### Entity Locators

GameObjects are addressed by **locators**, not instance IDs (instance IDs die on domain reload):

```json
{ "path": "/Canvas/Panel/Button", "scene": "SampleScene" }
```

### Input Simulation & Observation (Runtime side)

- **`InputSystemRuntimePump`** (`Runtime/Input/`, `#if ENABLE_INPUT_SYSTEM`, execution order −32000): injects a virtual Input System keyboard + mouse — virtual-only, never mirrors/zeroes the real keyboard. Key state injection, two-frame pointer tap pump, and **focus-independent** capture (applies `backgroundBehavior=IgnoreFocus` + `AllDeviceInputAlwaysGoesToGameView` for the session, restores on end) so capture works with the editor OS-backgrounded.
- **`InputService`** (`Editor/Core/Input/`): session lifecycle with a 30s idle watchdog plus a keepalive lease (`input.keepalive`) so long measurements/replays aren't torn down mid-run. Backends: `InputSystemBackend` (autonomous) and `EditorEventInputBackend` (legacy fallback; legacy `UnityEngine.Input` gameplay keys are **not drivable** — a known deferred limitation of the legacy backend).
- **`EventSystemPointerDispatch`**: backend-agnostic uGUI click and drag (down → beginDrag → drag steps → endDrag → **OnDrop** → up), executing handlers directly so legacy `StandaloneInputModule` games work too.
- **`InputObserverRuntimePump`** (`Runtime/Observe/`): record-by-demonstration observer — resolves taps/drags to handler targets at **gesture time**, drops inert taps (no handler; counted, never silent), captures keyboard down/up edges on a timeline.

## MCP Server (`mcp-server/src/`)

- **`index.ts`** — bootstrap: MCP `Server` over stdio, `tools/list` from `OpRegistry.toMCPTools()` + the editor-routing tools, `tools/call` → UnityClient → trace record → response (screenshots as `image` blocks).
- **`unity-client.ts`** — transport selection, endpoint discovery, handshake, pending-op promise map, auto-reconnect with backoff (and send-awaits-reconnect), heartbeat.
- **`op-registry.ts`** — the 121 ops: wire `command` ↔ MCP `toolName`, JSON Schema inputs, `isAsync`/`defaultTimeoutMs`.
- **`trace-recorder.ts`** — JSONL trace per session (`trace/trace-{sessionId}.jsonl`); base64 screenshots are extracted to `trace/artifacts/` and replaced with `artifactRef` paths — no base64 blobs in traces.

## The `loombridge` CLI Product Layer

`loombridge` (bin → `mcp-server/dist/surfaces/cli.js`) is a deterministic, engine-agnostic dispatcher; the MCP stdio server runs as `loombridge mcp` (or the `loombridge-mcp` bin). Intent routing and Unity orchestration live in agent prose (`commands/loombridge/*.md`); the CLI owns state, gates, and verdicts. **Two-track discipline:** deterministic checks live in the CLI; model judgment (VLM review) is advisory and never folded into a deterministic verdict.

| Verb | What it does | Mutates | Needs bridge |
|------|--------------|---------|--------------|
| `plan` | Scaffold `.loombridge/` (contract, slice roadmap, design stubs); `plan --go` approves a verified slice and advances | yes | no |
| `build` | Mint a §3a build runId, gate preconditions (approved Design Target), point `currentBuild` at the current slice | yes | no |
| `verify` | Run Tier-1 deterministic gates → `reports/build-verdict.json`; modes: `--slice <id>`, `--stage <phase>` (diagnostic), `--profile <feel-profile>`, `--minigame`, `--snapshot` (tuning-drift against the approved feel snapshot) | yes | no (grades captures) |
| `capture` | Write slice gate evidence (screen rects, console, tile/parallax captures) from raw bridge ops with provenance | yes | yes |
| `doneness` | The only path to a "done" claim: fresh + green + runId-bound verdict, all slices approved, hero-shot fidelity | no | no |
| `design` | `status` / `set` / `approve` the Design Target (annotated hero shot, frozen by sha256) | set/approve | no |
| `minigame` | `init` (contract scaffold) / `setup` (guided onboarding) / `capture` (drive the recorded trace → capture pack) / `finalize` (fill real locators from captures) / `baseline approve\|status` | some | capture |
| `trace` | Replay verification: `record --observe` / `replay` / `replay-all` / `approve` / `report` | some | record/replay |
| `feel` | Tuning snapshot: `feel snapshot capture` (profile-less live measurement) / `approve` (human freezes the baseline once) / `status`; `verify --snapshot` then grades kinematic drift against it | workspace | capture |
| `assets` | Deterministic Asset Manifest approval: `registry-plan/apply`, `generated-plan/apply` | apply | no |
| `install-bridge` | Install the bridge into a consumer project as a `file:` tarball dependency (`--embedded` fallback); writes `ProjectSettings/LoombridgeInstall.json` | project | no |
| `doctor` | Health-check the local install + a project's bridge wiring (`--project`/`--live`/`--ci`); actionable fix per row; exit `0`/`1`/`2` | no | `--live` only |
| `update` | Reconcile a project's bridge with the CLI-bundled tarball (file-swap + backup), then run `doctor` | project | no |
| `status` / `ask` | Read-only progress / project explanation | no | no |
| `--version` | `loombridge <version> (<commit>, built <iso>)` from `dist/build-info.json` | no | no |

### `.loombridge/` State Contract

`.loombridge/` is the single source of truth per project: `STATE.md` (machine-readable state), `ACCEPTANCE.json`, `SLICES.json` (slice DAG), `FEEL_SPEC.json`, `GAME_SPEC.md`, `ASSET_MANIFEST.json`, `design/` (frozen `design-target.json` + `hero-shot.png`), `verify/` (captures, per-slice subdirs), `reports/` (`build-verdict.json`, `feel-profile.json`, `minigame-verification.json` + `report.html`/`report.md`, `slices/<id>.verdict.json`), and `replays/` (`traces/`, `reports/`, `baseline/`). Layout source of truth: `src/capabilities/state.ts`.

### The §3a Supervisor

The threat model is a self-graded or hand-crafted verdict. The mechanism is code, not prose:

- `build` mints a `runId`; `verify` writes a verdict bound to it; `doneness` refuses unless verdict ≡ `currentBuild` ≡ slice proof runId, each **refused-if-absent** — a gate predicate must refuse when a bound field is missing, never silently skip the check.
- "Verified-green" ≠ "done": for an approved Design Target, `doneness` additionally enforces the **hero-shot fidelity moat** — review findings must reference the frozen hero shot (`reference.heroShotSha256 === designTarget.pngSha256`), be independent (`reviewerCount ≥ 2`), and pass every fidelity criterion. Tier-1 `verify` stays deterministic; the VLM never grades itself into the deterministic status.
- Measured values are **re-derived from their own raw samples** (feel metrics §0 re-derivation, `feel-rederive` gate); a tampered in-band value is forced to `fail`.

### Frozen Runtime Install

`scripts/loombridge-install-locally.sh` freezes the build into `~/.loombridge/runtime/` and links `~/.local/bin/loombridge` (+ `loombridge-mcp`, checkpoint/restore, capture/tune runners) — `npm run build` alone never reaches the installed runtime. It also packs the bridge tarball into `~/.loombridge/runtime/mcp-server/bridge/` so `loombridge install-bridge` resolves it without the dev repo. `scripts/write-build-info.mjs` stamps `dist/build-info.json` (commit + build time, `+dirty`/`(dev)` aware) so `loombridge --version` detects a stale frozen runtime. The installer also syncs the agent command docs; `scripts/sync-loombridge-artifacts.mjs` generates the Codex shim from `plugin.json` (generator-backed T0 parity, drift-checked in CI).

### Bridge Distribution & Install

A consumer project installs the Unity bridge as a **versioned `.tgz` tarball added as a `file:` immutable dependency** in `Packages/manifest.json` — not a physical copy. `loombridge install-bridge --project <p>` drops the CLI-bundled tarball into `<project>/Packages/tarballs/`, writes the `file:` dependency, and records `ProjectSettings/LoombridgeInstall.json` (`installMode`, bridge version, `bridgeProtocol`, tarball `sha256`). Because Unity resolves an immutable dependency read-only into `Library/PackageCache`, the package's `Tests/` **self-exclude** from the consumer compile — an immutable dependency is not a Unity *testable*, so `UNITY_INCLUDE_TESTS` stays undefined and the `nunit`-referencing test asmdef never compiles. The tarball therefore ships `Tests/` unstripped yet cannot break a consumer that lacks `com.unity.test-framework` (the RUN-1 #62 break, which the legacy *embedded* copy had to strip against). Only the packaged bridge bytes ship, inside `@loomtide/loombridge` — a consumer needs no git credentials and no repo clone — and the read-only install removes the "developer edited the embedded bridge" drift.

- **Packaging** — `scripts/loombridge-pack-bridge.sh` produces the one versioned distribution unit (`+ .sha256`), refusing to pack if the Tests asmdef ever loses its `UNITY_INCLUDE_TESTS` guard. Shared metadata/tarball helpers live in `src/capabilities/bridge-install-common.ts` (single source of truth for `install-bridge`, `doctor`, `update`).
- **`doctor`** — offline health of the local install + a project's wiring (metadata, manifest `file:` dep, tarball presence + sha integrity, version drift vs the CLI-bundled bridge, protocol expectation); `--live` pins to `--project` and runs the same `evaluatePrerequisiteChecks` protocol preflight against the running bridge; `--ci` emits JSON. Every failed row prints its fix.
- **`update`** — hash-checked tarball file-swap + `file:` bump (prune old `.tgz`), backs up `LoombridgeInstall.json`, then runs `doctor`. The CLI itself is not self-updated (`npm install -g` is unreliable across nvm/volta/asdf) — `update` detect-and-instructs.
- **Fallbacks** — `install-bridge --embedded` physically copies the package (`Tests/` stripped) for air-gapped consumers; UPM git-URL / scoped registry remain for a public bridge. Steps: `Docs/Install.md`, `Docs/BridgeDistribution.md`.

**Compatibility gates on the bridge protocol integer, not the marketing version.** `Handshake.cs` advertises `protocolVersion` + `pluginVersion` (the latter derived from the resolved package version so it can't drift from what ships), and `preflight/prerequisite-checks.ts` refuses a `REQUIRED_PROTOCOL_VERSION` mismatch (`PROTOCOL_MISMATCH`) before any capture; `install-bridge` stamps that same expected protocol into `LoombridgeInstall.json`.

## Verification Architecture

Verification is Loombridge's core. Three proven verticals share the deterministic-gate engine (`run-gates`, gate specs in `GATE_SPECS`):

### 1. Slice-Pipeline Build Verification (platformer-2d)

`plan` decomposes a game into a slice DAG (framing → ground-tiling → player-feel → parallax → collectibles → hazards → hud → juice → end-state); each slice is built, verified (`verify --slice`), human-approved (`plan --go`), then `doneness` rolls up. Deterministic gates close the known false-green classes, each validated live: `tile-render` (seam judgment from raw per-tile `columnLuma` samples), `feel` + `feel-provenance` + `physics-timestep` (behavioral feel measurement that can't be param-read or timestep-pinned), `parallax-motion` (per-layer texture-offset ratios catch flat cut-outs), plus manifest/placement/framing/playability/console gates.

### 2. Verify-First Feel Profiles (`verify --profile`)

Standalone grading of an **existing** Unity 2D platformer — no contract, no mutation. A declared input map + `runtime.capture_input_motion` (keys injected inside the sampling loop, focus-independent) produce raw trajectories; `feel-derive.ts` derives runSpeed/jumpApex/timeToApex/etc.; profiles (`precision`/`classic`/`momentum`, band-required schema) grade them. Every metric carries `confidence ∈ {verified, reported, rejected, unmeasured}` from §0 re-derivation. Metrics split by gating class: GRAMMAR metrics (coyote time, jump buffer, gravity asymmetry, jump-cut) gate pass/fail in every mode, while TASTE metrics (archetype targets like runSpeed and jumpApex) are descriptive placement against the nearest archetype unless `--enforce-taste` re-arms them; measure-only metrics can never be banded (`BANDED_MEASURE_ONLY`). Proven end-to-end on projects Loombridge did not build (Design Partner Protocol: `Docs/Profiles/DesignPartnerProtocol.md`).

### 3. Mini-Game Release Verification (`verify --minigame`)

CR-style release verification for 2D kids mini-games against a `MinigameContract` (`Docs/Profiles/MiniGameVerificationContract.md`) + a per-state capture pack:

- **Per-state deterministic gates**: required-in-frame, safe-area, tap-target-size (dp via live `canvasScaleFactor`), text-clipping, control-overlap, background-fit. Vacuous checks emit `not_applicable`, never `pass`; a contract enabling object checks with no bindings is refused at the validator.
- **Interaction-flow tier**: the declared `happyPath` graded per transition — actuation honesty (real `ui-dispatch` evidence) + outcome re-derived from the actual `to` capture. Taxonomy: `pass` / `game_fail` / `harness_fault` / `missing_evidence`.
- **Baseline-regression tier**: `minigame baseline approve` freezes a passing pack; later runs compare per state (perceptual PNG diff with masks + object rect drift) and report regressions as their **own tier**, never as game defects.
- **Exit contract** (frozen, partner-facing): `0` READY · `1` NOT READY (game defect or baseline regression — game team) · `2` CAN'T VERIFY (harness/capture gap — QA infra). A harness fault is never laundered into a pass *or* into a game bug. Output: JSON + partner-clean terminal + self-contained `report.html`/`report.md`. CI path: `Docs/Profiles/MiniGameVerifyCI.md` + example GitHub Action.
- **Workflow**: `minigame init` → `trace record --observe` (play it once) → `minigame capture` (replay drives the pack) → `minigame finalize` (real locators) → `verify --minigame --strict` → `baseline approve`. Live-proven end-to-end on two games (CountTheFruits, ShapeMatch).

## Replay Verification Subsystem

Record a human demonstration once, replay it deterministically forever (`src/capabilities/replay/`).

- **Trace format** (`.loombridge/replays/traces/<id>.trace.json`): segments of steps — `tap`, `drag`, `world-tap`, `key-tap`, `key-hold`, `key-down`/`key-up`/`wait` (timed-edge keyboard with concurrent holds), `wait-for-visible` — gated by anchors (`ui-visible`, runtime `condition`) with captures tied to anchors. Outcome assertions (captured end-state, `reachedWhenVisible`-gated so an unreached state can't false-pass) close the "flow ok but outcome wrong" hole. Reset tiers: scene-load / game hook / editor relaunch.
- **Recording** (`trace record --observe`): the observer records what the game *responded to* — gesture-time locator resolution (reparenting drags keep the origin path), inert taps dropped + counted, keyboard edges on a timeline, per-step settle timing from the human's own dwell. Traces are green by construction; an empty observation is refused.
- **Replay** (`trace replay`, `replay-all`): drives the trace through the live bridge (UI dispatch for uGUI, simulated Input System keyboard/pointer for gameplay; keepalive holds the input session), captures actuals, compares to the approved baseline with a perceptual YIQ pixel diff (drift is a warning unless `--strict-visual`), and writes a self-contained HTML report (inline images, first-divergence table) plus a fleet roll-up for `replay-all`.
- **Approve** (`trace approve`): human inspects the HTML report, then promotes the run's captures to the baseline. It refuses a run carrying an unreadable capture (a capture gap is a harness fault, never an anchor) and PRESERVES any approved drift tolerance rather than silently re-tightening it.
- **Tolerate** (`trace tolerance --id <id> --set <fraction>`): stamps the human-approved pixel allowance onto the EXISTING baseline manifest (no frame, no sha touched) for a game that animates under its own clock. A SEPARATE verb from approve on purpose: one command that both widened the gate and re-froze the frames would destroy the anchor it was meant to keep. Capped at `0.02` by one constant enforced at stamp time *and* inside the manifest reader, so a hand-edited value is a broken anchor rather than a wider gate; the stamp, the plan line and the replay summary all print the consent sentence for the size of hole it opens.
- **Mask** (`trace mask --id <id> --set <captureId?>:<x>,<y>,<w>x<h>@<reason>` / `--clear` / `--list`): stamps the human-approved EXCLUDED REGIONS onto the same baseline manifest, for LOCALIZED nondeterminism (an ambient animation layer whose phase drifts against wall-clock). The rects are BLANKED in both images before the perceptual diff, so a masked region cannot differ while the denominator stays the full frame and every stamped tolerance keeps the meaning it was consented to. Same verb split and the same one-predicate discipline as the tolerance: capped at `0.10` of any one frame by `maskRefusal`, enforced at stamp time *and* inside the manifest reader; every rect needs a `@reason`; `--set` restates the WHOLE list so a mask set cannot grow one unnoticed rect at a time; `approve` preserves masks and REFUSES the re-freeze when they no longer fit the new frames rather than reinterpreting them; the ledger records `previousMaskRects` and an append-only `maskedFractionHistory`. A mask is SUGGESTED only after two runs whose drift bitmaps differ in the same region: an identical drift twice is a deterministic change, and a diffuse drift is refused as unmaskable. Full-frame or diffuse nondeterminism stays red; game-time (`timeScale`) alignment is the recorded future path for it.

`minigame capture` converges the two verticals: the recorded trace drives the mini-game capture pack, closing the "capture had no developer surface" gap.

## Asset Layer

The asset layer is data/tooling around Loombridge, not a new core protocol category — import always goes through generic `unity_*` tools.

### Local Curated Layer (`asset-layer/` + `mcp-server/src/asset-layer/`)

Registry packs + validation profiles (`2d-platformer`, `2d-topdown-arena`) with enforced license allow/deny, provenance, checksum, and trust-tier policy (trust is **re-derived locally** from license + review status, never trusted from the catalog's own assertion). Provider adapters (`LocalAssetProvider`, `HttpAssetProvider` with SSRF guard, `StubGenerationProvider`) sit behind a seam for future generation providers. The prepare pipeline (`prepare-cli.ts`) selects, downloads, sha256-verifies, caches deterministically, and emits a prepare report + attribution markdown; `loombridge assets registry-plan/apply` turns approved selections into `.loombridge/ASSET_MANIFEST.json`.

### Public Hosted Asset Catalog (LIVE)

A productionized, public, engine-neutral catalog — **66,859 records**: 55,502 PNG sprites, 1,342 OGG audio, 4,970 GLB models (self-contained; external textures embedded at publish), 5,045 SVG vectors.

- **Storage**: Cloudflare R2 public bucket (sha256-pinned objects, idempotent resumable publish via `mcp-server/src/asset-authoring/r2-publish.ts`); model browse thumbnails from `Previews/*.png`.
- **Database + API**: Railway Postgres (`assets` table, indexed id/primitive/kind/tags + full `record_json`) behind a company-run read-only search API (live at `https://asset-api-production-59d9.up.railway.app`, hosted separately from this repo): `/v1/assets/search`, `/v1/assets/:id`, `/v1/catalog/public/...` shards + index.
- **Publish pipeline**: private mirror registry → `registry-scale-publish.ts` (public transform, per-format routing, validation, exclude-with-reason) → R2 upload → `public-catalog-build.ts` (deterministic shards + `index.json`; byte-identical across runs) → batched DB ingest. This authoring/publish tooling lives in `mcp-server/src/asset-authoring/` (the private side of the OSS seam); `mcp-server/src/asset-layer/` keeps only the export-bound client side (catalog sources, prepare pipeline, validation, registry-plan/apply support).
- **Unity consumption**: the in-editor **Loombridge Asset Browser** (`Editor/UI/LoombridgeAssetBrowser.cs`, Window → Loombridge → Asset Browser) live-searches the hosted API with thumbnails; the picker handshake (`unity_asset_picker_open/state/close`, `unity_asset_browser_open`) lets an agent offer choices to a human. Per-engine import deps are validated, not assumed: GLB needs `com.unity.cloud.gltfast` + `imageconversion`; SVG needs `com.unity.vectorgraphics`; PNG/OGG are native.
- **Agent consumption**: `ApiCatalogSource` / `HttpCatalogSource` / `LocalCatalogSource` feed the same prepare pipeline, so hosted assets get the same checksum/license/provenance enforcement as local ones.

External developer quickstart (browse + prepare against the public catalog, no credentials): `Docs/Assets/PublicCatalogQuickstart.md`.

## Core vs Game-Specific

Loombridge core stays game-agnostic. Core APIs are neutral primitives (`scene.*`, `component.*`, `editor.*`, `input.*`, `runtime.*`, `asset.*`, …). Genre knowledge lives in data and skills: acceptance/slice templates, feel profiles, minigame contracts, registry primitives, and the locked C# components shipped as skill references (`PlatformerPlayerController`, `GroundTiling`, `ParallaxLayer`). If a request can be composed from existing generic ops, do not add a game-specific command to the protocol.

## Key Design Decisions

- **Locators over instance IDs** — hierarchy paths survive domain reloads and are human-readable; replay resolves them at gesture/replay time.
- **Deterministic waits, never sleeps** — `wait_for` / `wait_for_condition` poll real state; replay anchors gate progression.
- **Every tool routes through the op registry**; trace from day 1 (JSONL + artifact files, no base64 blobs).
- **Handshake enforced in code** on connect and reconnect.
- **Main-thread queue** — all bridge commands execute on Unity's main thread via `EditorApplication.update`.
- **Newtonsoft over JsonUtility** — the protocol needs dynamic `JObject` support.
- **Stdio MCP transport** — the server is a child process of the agent; no ports/auth for the client side.
- **Refuse-on-absent gates** — a verification predicate with a missing bound field refuses; it never skips the check (the §3a / P0.1 lesson).
- **Harness fault ≠ game defect** — capture/harness gaps exit `2` and are reported in their own tier; they are never a pass and never a game bug.
- **Deterministic CLI vs agent judgment** — the CLI owns gates, state, and exits; VLM/model review is advisory and independently attested; nothing model-judged enters a deterministic verdict.
- **Honest measurement** — values are re-derived from raw captured samples; "reported" (un-re-derivable) values are flagged, and self-grades are rejected.
- **Frozen runtime** — partners and dogfood runs execute a stamped, immutable install, so "which build graded this" is always answerable.
- **Bridge ships as an immutable tarball dependency** — a `file:` `.tgz` in the consumer manifest (not a physical embed): its `Tests/` self-exclude (immutable ⇒ not a *testable*), it ships only packaged bytes with no consumer git credentials or repo clone, and Unity's read-only `PackageCache` copy can't be edited into drift. Compatibility is gated on the bridge protocol integer, not the marketing version.
