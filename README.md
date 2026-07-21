# Loombridge

**Game-feel engineering for AI-built games**, by [Loomtide](https://loomtide.ai).

Loombridge lets an AI agent **see, drive, and measure** a Unity game the way a QA
engineer would — and then it **refuses to call the game "done" on the agent's word.**
A code-enforced verification supervisor demands a fresh, run-bound, independently
reviewed verdict before it will exit green. Your agent can already build the game.
Loombridge is the layer that proves it's actually good.

It's for two audiences at once:

- **AI agents building Unity games** — a typed tool surface (121 tools) to construct
  scenes, inject real input, wait deterministically, and sample motion/feel from the
  running game.
- **The humans supervising them** — a deterministic CLI (`loombridge`) that owns project
  state, enforces an acceptance contract, and turns "trust me, it's done" into a signed,
  reproducible verdict you can read.

<!-- GIF PLACEHOLDER: replace with a screen recording of the plan → build → verify → doneness
     loop driving a real Unity editor (agent builds a platformer slice, then `loombridge
     doneness` goes green on a fresh, reviewed verdict). ~20s, loop, <5 MB. -->

## Not "another Unity MCP"

There are already several MCP servers that let an agent poke at the Unity Editor. They
stop at *actuation* — move an object, run some C#, take a screenshot. The hard part of
AI-built games isn't building them; it's knowing whether the result feels good and
telling the difference between a real "done" and a confident hallucination.

Loombridge adds a **verification layer** underneath the actuation that other Unity
bridges don't have:

- **Runtime input injection** — inject real Input System key/pointer events into the
  running game, not fake serialized-field pokes.
- **Deterministic waits** — `wait_for(condition)`, never `sleep()`: deterministic waits
  instead of sleeps, so no timing races by construction.
- **Motion / feel measurement** — sample position, velocity, animator state, and derived
  feel metrics (jump height, coyote time, fire cadence, hitstop, screen shake) from the
  running game, on real axes.
- **Record → replay with pixel-diff baselines** — record a human demonstration once,
  replay it deterministically, diff frames against a perceptual baseline.
- **A doneness supervisor that refuses to be lied to** — the `loombridge doneness` gate is
  the product. It binds a verdict to the current build's `runId`, checks the verdict was
  produced *after* the build started, verifies every capture artifact it cites exists on
  disk, and — for a design-targeted build — requires the review to reference the
  sha256-frozen hero shot and to be independent (two-plus reviewers). A self-graded or
  hand-crafted verdict is **refused**, not accepted.

Two design choices set the safety floor:

- **No raw-eval op.** There is no eval / "run this C# or shell string" op — every tool is
  typed and schema-validated. Code can still enter the project the auditable way:
  `code.create_script` writes C# that Unity compiles, and `invoke_static` /
  `execute_menu_item` run project code behind a refuse-by-default allowlist. That's a
  deliberate departure from bridges that expose a raw eval. See
  [`Docs/ThreatModel.md`](Docs/ThreatModel.md).
- **No telemetry.** Loombridge phones home to nothing. It's a local editor tool talking to
  your own Unity Editor over loopback; there is no analytics endpoint, no usage
  beacon, no account required to run it.

"Playwright for Unity" is the *mechanism*. **Provable doneness is the product.**

## The refusal, for real

This is verbatim output from this repository's CLI (`node mcp-server/dist/cli.js`), run in
an empty scratch directory. `plan` scaffolds `.loombridge/`; `doneness` is then asked to
certify the build with no verification run behind it — and refuses, non-zero, with every
reason listed:

```console
$ loombridge plan --genre platformer-2d --name DemoGame --engine unity
[loombridge plan] genre=platformer-2d engine=unity root=/tmp/loombridge-demo.9lkvGK
[loombridge plan] created: .loombridge/FEEL_SPEC.json, .loombridge/ACCEPTANCE.json, .loombridge/GAME_SPEC.md, .loombridge/design/README.md
[loombridge plan] Roadmap: none yet (design phase).
[loombridge plan] design target: missing
[loombridge plan] asset manifest: missing
[loombridge plan] NOT ready — no approved Design Target (annotated hero shot). Establish/re-approve via `loombridge design set/approve` (see commands/loombridge/plan.md §3c), then re-run. (Use --allow-missing-design-target only for early scaffolding — `build` will still block.)
; exit 1

$ loombridge doneness
[loombridge doneness] NOT done:
  - phase is `planned`, not `verified-green`
  - no `currentBuild` in STATE — no build is in flight (run `loombridge build` first)
  - no verdict at .loombridge/reports/build-verdict.json
; exit 1
```

That non-zero exit is the whole point: there is no path to a green `doneness` that a
build can talk its way into. Green requires `STATE.phase === verified-green`, a verdict
whose `runId` matches the in-flight build, a `producedAt` on/after the build's
`startedAt`, and every cited capture artifact present on disk (`loombridge doneness --help`).

## Quickstart

Full setup — both install tracks, transport notes, the fresh-machine bootstrap — is in
[`Docs/Install.md`](Docs/Install.md). The short path below is **from source**, which is how
you install Loombridge today.

> **`get.loomtide.ai` doesn't serve Loombridge yet.** Don't run
> `curl -fsSL https://get.loomtide.ai | sh` today — it currently resolves a different,
> legacy CLI and would *silently* install the wrong binary, not Loombridge. Install from
> source (below) until the first tagged release lands. **From that first release on**, the
> installer at `get.loomtide.ai` will fetch Loombridge and self-update it, and this section
> will switch to the one-liner.

**1. Build the CLI from source** and put `loombridge` on your PATH via the dev bin (it
follows every `npm run build`):

```bash
git clone https://github.com/Loomtide/loombridge.git
cd loombridge/mcp-server
npm ci
npm run build
npm link                                       # `loombridge` now on your PATH
```

Verify it (works on any OS):

```bash
loombridge --version                           # loombridge <version> (<commit>, built <iso>)
```

**2. Pack the bundled bridge tarball.** `install-bridge` and `doctor` need a packed bridge
`.tgz`, which a fresh clone doesn't ship — build it once (re-run after any bridge change).
Skip this and `doctor` exits 1 while `install-bridge` refuses with "no bundled bridge tarball":

```bash
bash ../scripts/loombridge-pack-bridge.sh      # writes dist/bridge/com.loomtide.loombridge-<ver>.tgz
```

**3. Wire the bridge into your Unity project** (added as an immutable `file:` tarball
dependency under `Packages/tarballs/` — no repo copy, no git needed):

```bash
loombridge install-bridge --project /path/to/UnityProject
```

<details>
<summary>No Unity project handy? A minimal one is enough for <code>install-bridge</code> / offline <code>doctor</code>.</summary>

`install-bridge` and offline `doctor` only touch three paths, so a throwaway project works
fully offline (no Unity install needed):

```bash
mkdir -p MyProject/Assets MyProject/Packages MyProject/ProjectSettings
echo '{"dependencies":{}}' > MyProject/Packages/manifest.json
echo 'm_EditorVersion: 6000.3.20f1' > MyProject/ProjectSettings/ProjectVersion.txt   # your installed version
```

`loombridge doctor --project MyProject` reports `healthy` against this without Unity running;
`--live` is the only step that needs the project actually open in Unity.
</details>

**4. Open that project in Unity**, let it finish compiling, then health-check:

```bash
loombridge doctor --project /path/to/UnityProject         # offline install + wiring health
loombridge doctor --project /path/to/UnityProject --live  # also connect to the running bridge
```

`doctor` prints `healthy`, and `--live` reports the transport it settled on
(`live.transport`). Every failed row prints the exact command that fixes it.

**5. Connect your agent (Claude Code / Codex).** Point your MCP client at the server the
CLI ships:

- command: `loombridge`
- args: `["mcp"]`

For multiple open Unity projects and per-session routing, set `LOOMBRIDGE_UNITY_PROJECT`
per session, or switch at runtime with the `loombridge_editor_list` /
`loombridge_editor_use` tools. See [Transport modes](#transport-modes) below.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the agent surface (slash commands + skills),
the test suite, and PR conventions.

## Tool surface

The bridge exposes **121 generic `unity_*` tools across 12 categories** — actuation and
measurement, no game-specific magic. Full auto-generated reference (per-tool args, from
the op registry): [`mcp-server/TOOLS.md`](mcp-server/TOOLS.md).

| Category | Tools | What it covers |
|----------|------:|----------------|
| Scene | 26 | Create/find/transform objects, hierarchy, bounds, references, geometry snapshots |
| Editor | 19 | Play/pause/stop, state, screenshots, menu items, diagnostics, game-view sizing |
| Input | 11 | Real Input System key/pointer sessions, taps, holds, observe/record |
| Runtime | 10 | Motion capture, `measure_motion`, animator sampling, probes, `wait_for_condition` |
| Component | 6 | Add/remove/list, get/set properties, describe |
| Code | 4 | Create/read/modify/attach scripts |
| Animator | 9 | Controllers, states, transitions, parameters, motion binding, apply-spec |
| UI | 9 | Canvas, buttons/images/text, rect transforms, screen rects, pointer dispatch |
| Asset | 19 | Sprites/materials/prefabs, model & audio importers, sub-assets, sprite assignment |
| Package | 4 | Add/remove/list/search UPM packages |
| Capture | 1 | Static-method capture invocation |
| Ops | 3 | List/describe/batch — introspect and batch the op registry itself |

## The verification pipeline

The `loombridge` CLI is a deterministic, agent-agnostic command set. `.loombridge/` is the
single source of truth per project (contract, design target, captures, reports, replays),
and the supervised loop is:

- **`plan`** — scaffold `.loombridge/`, seed the acceptance contract + feel spec from a
  genre pack (`platformer-2d`, `2d-shooter`, `3d-shooter`), and establish/freeze the
  Design Target hero shot. The roadmap won't scaffold without an approved target.
- **`build`** — mint a build `runId` (the §3a supervisor anchor) and gate preconditions;
  the agent then constructs in-engine through the bridge tools.
- **`verify`** — run the Tier-1 **deterministic** gates (asset/manifest, UI conformance,
  framing, playability, feel measurement) against the contract and write the verdict.
- **`doneness`** — the freshness + integrity gate. Exits `0` only on a fresh, run-bound,
  green verdict whose cited captures exist; for an approved Design Target it additionally
  enforces hero-shot fidelity and independent review. This is where "verified-green" is
  distinguished from "done".

The line between the two tracks is deliberate: **gates, exits, and state are
deterministic and live in the CLI; model judgment (VLM design review) is advisory and
never part of the deterministic verdict.** Capture/harness faults exit in their own tier —
never silently passed, never counted as a game bug.

The CLI also carries verify-first entry points that skip plan/build:

- `loombridge verify --profile <precision|classic|momentum>` — feel-grade an existing 2D
  platformer ([`Docs/Profiles/VerifyFirstEntry.md`](Docs/Profiles/VerifyFirstEntry.md)).
- `loombridge verify --minigame` + `loombridge minigame <init|setup|capture|finalize|baseline>`
  — release verification for 2D mini-games with a partner-clean report and a frozen
  `0/1/2` exit contract
  ([quickstart](Docs/Profiles/MiniGameVerifyQuickstart.md) ·
  [CI guide](Docs/Profiles/MiniGameVerifyCI.md)).
- `loombridge trace <record --observe|replay|approve|report>` — replay verification with
  perceptual baseline diffs.

Deeper reading:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — full system design.
- [`Docs/ThreatModel.md`](Docs/ThreatModel.md) — attack surface, what's refused by design.
- [`VALIDATION-2.6.md`](VALIDATION-2.6.md) — a live end-to-end validation run against a real
  Unity editor (verdict: SHIP).

## Security posture

Loombridge is a **local, single-developer editor tool**. An AI agent talks to the MCP
server over stdio; the MCP server talks to a bridge plugin inside *your* Unity Editor over
**loopback only** (localhost WebSocket, or a local named pipe on Windows). There is **no
raw-eval op** — every tool is typed and schema-validated, so no op runs an
attacker-supplied C#/shell string (code enters the project only the auditable way:
`code.create_script` writes C# Unity compiles; `invoke_static` / `execute_menu_item` run
project code behind a refuse-by-default allowlist — see
[`Docs/ThreatModel.md`](Docs/ThreatModel.md)) — and **no telemetry**. Deliberately
exposing the bridge to a network is an unsupported configuration, not a supported feature:
the bridge has no authentication for hostile-local-network use because it isn't meant to
leave loopback. Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md); the full
model is in [`Docs/ThreatModel.md`](Docs/ThreatModel.md).

## Support matrix

| | Supported |
|---|---|
| **Unity** | `2022.3 LTS` (compatibility) → **`6000.x LTS` (primary target)** |
| **Node.js** | `>= 18` |
| **OS** | macOS · Windows · Linux |
| **Transport** | `auto` (default): IPC first, then TCP loopback. IPC is a named pipe on **Windows** (used by default there); on **macOS/Linux** Unity's Mono editor runtime doesn't expose the unix-domain-socket API, so the bridge runs on **TCP loopback** — IPC is Windows-only in practice. `doctor --live` prints the transport it actually used, so a fallback is never silent. |

<a id="transport-modes"></a>
**Transport modes.** `LOOMBRIDGE_UNITY_TRANSPORT_MODE=auto|ipc|tcp` selects the transport
(`auto` is the default; `ipc` fails fast where no IPC endpoint exists, i.e. all
macOS/Linux editors). `LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR` / `_FILE` override where Unity
publishes and MCP reads `endpoint-discovery-latest.json`. Full details in
[`Docs/Install.md`](Docs/Install.md) and [`mcp-server/README.md`](mcp-server/README.md).

## Roadmap & non-goals

Loombridge is pre-1.0 (`0.2.x`). The near-term direction is broader genre packs and feel
coverage on top of the same deterministic contract. Some things are **permanent
non-goals**, not missing features:

- **No arbitrary code-execution op.** The typed op registry is a security boundary; a
  raw-eval / "run this string" op will not be added. Capability gaps are closed by adding
  *typed* ops, not an escape hatch.
- **No telemetry.** No analytics, usage beacons, or phone-home. This will not change.
- **No cloud requirement.** The core CLI and bridge run fully local. The hosted asset
  catalog is an optional, read-only convenience (below), never a dependency for
  plan/build/verify/doneness.

## Asset layer & hosted catalog (optional)

A public, read-only hosted asset catalog is available (66,859 records, predominantly CC0
with a clearly-flagged attribution-required tier — PNG sprites, OGG audio, self-contained
GLB models, SVG vectors) and browsable in-editor via **Window →
Loombridge → Asset Browser**. It's a convenience for sourcing art, not a requirement.
External quickstart (no credentials):
[`Docs/Assets/PublicCatalogQuickstart.md`](Docs/Assets/PublicCatalogQuickstart.md). The
local asset-layer prepare/validate tooling enforces license/provenance policy before any
Unity import; see [`mcp-server/README.md`](mcp-server/README.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off, test suite, PR conventions) and the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License & trademark

Licensed under **Apache-2.0** — see [`LICENSE`](LICENSE).

"Loombridge" and "Loomtide" are trademarks of Loomtide. The Apache-2.0 license grants
rights to the code; it does not grant permission to use the Loombridge or Loomtide names,
logos, or branding except as needed for reasonable and customary descriptive reference.
