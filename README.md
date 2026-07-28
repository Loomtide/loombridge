# Loombridge

**Your agent builds the Unity game. Loombridge decides whether it is actually done.**

[![CI](https://github.com/Loomtide/loombridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Loomtide/loombridge/actions/workflows/ci.yml)
[![Unity EditMode](https://github.com/Loomtide/loombridge/actions/workflows/unity-editmode.yml/badge.svg)](https://github.com/Loomtide/loombridge/actions/workflows/unity-editmode.yml)
[![Unity](https://img.shields.io/badge/unity-2022.3%20LTS%20to%206000.x-black?logo=unity)](#support-matrix)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](#support-matrix)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Quickstart](#quickstart) · [Verification](#the-verification-flow) · [Skills & commands](#what-your-agent-gets-skills-and-commands) · [Tools](#tool-surface) · [Architecture](ARCHITECTURE.md) · [Threat model](Docs/ThreatModel.md)

An AI agent can already build a Unity game. What it cannot do is tell you honestly whether
the result is any good, because the same model that wrote the code writes the report card.
Loombridge gives the agent a typed MCP tool surface to construct scenes, inject real input,
and measure motion from the running game, and then takes the verdict away from it:
`loombridge doneness` exits green only on a fresh, run-bound verdict whose cited evidence
exists on disk. A self-graded "done" is refused, not accepted.

"Playwright for Unity" is the mechanism. **Provable doneness is the product.**

<!-- HERO DEMO GIF: agent builds a slice through the bridge, `loombridge doneness` REFUSES
     (red, exit 1), the agent fixes and re-verifies, doneness goes green. The refusal must
     be on screen before the green. ~20-30s, loop, <5 MB.
     Caption under it: "The agent built this. It did not decide it was done." -->

## The refusal, in ten seconds

Verbatim output from this repo's CLI in an empty scratch directory. `plan` scaffolds
`.loombridge/`; `doneness` is then asked to certify a build that has no verification run
behind it, and refuses, non-zero, with every reason listed:

```console
$ loombridge plan --genre platformer-2d --name DemoGame --engine unity
[loombridge plan] genre=platformer-2d engine=unity root=/tmp/loombridge-demo.9lkvGK
[loombridge plan] created: .loombridge/FEEL_SPEC.json, .loombridge/ACCEPTANCE.json, .loombridge/GAME_SPEC.md, .loombridge/design/README.md
[loombridge plan] Roadmap: none yet (design phase).
[loombridge plan] design target: missing
[loombridge plan] asset manifest: missing
[loombridge plan] NOT ready — no approved Design Target (annotated hero shot). Establish/re-approve via `loombridge target set/approve` (see commands/loombridge/plan.md §3c), then re-run. (Use --allow-missing-design-target only for early scaffolding — `build` will still block.)
; exit 1

$ loombridge doneness
[loombridge doneness] NOT done:
  - phase is `planned`, not `verified-green`
  - no `currentBuild` in STATE — no build is in flight (run `loombridge build` first)
  - no verdict at .loombridge/reports/build-verdict.json
; exit 1
```

There is no path to a green `doneness` that a build can talk its way into. Green requires
`STATE.phase === verified-green`, a verdict whose `runId` matches the in-flight build, a
`producedAt` on or after the build's `startedAt`, and every cited capture artifact present
on disk.

## What's in the box

| Capability | Status |
|---|---|
| Unity editor bridge + MCP server (typed `unity_*` ops, 12 categories) | Shipped |
| Deterministic verification CLI: `plan` / `build` / `verify` / `doneness` | Shipped |
| Runtime input injection (real Input System key/pointer events, not field pokes) | Shipped |
| Feel measurement (jump height, coyote time, fire cadence, hitstop, screen shake) | Shipped (kinematic tier; deeper feel tiers on the roadmap) |
| Record and replay with perceptual pixel-diff baselines (`loombridge trace`) | Shipped |
| Tuning snapshot: freeze human-approved measured behavior, verify kinematic drift (`loombridge feel snapshot` + `verify --snapshot`) | Shipped |
| Genre packs (`platformer-2d`, `2d-shooter`, `3d-shooter`, `3d-topdown-arena`) plus any-genre contracts with honest coverage grading | Shipped |
| Agent surface: 14 skills + slash commands, installable into your repo | Shipped |
| Hosted CC0-heavy asset catalog, browsable in-editor (optional, read-only) | Shipped |
| Unity Test Runner results as a bound verification gate | Planned |
| Player-build (target platform) gate | Planned |

## Quickstart

```bash
# 1. Install the CLI (macOS / Linux / Windows; needs Node >= 18 and the GitHub CLI)
gh release download -R Loomtide/loombridge -p install.sh && sh install.sh

# 2. Wire the bridge into your Unity project (an immutable file: tarball dependency)
loombridge install-bridge --project /path/to/UnityProject

# 3. Open the project in Unity, let it compile, then health-check
loombridge doctor --project /path/to/UnityProject --live
```

`doctor` prints `healthy`, and every failed row prints the exact command that fixes it.

**4. Connect your agent** (Claude Code, Codex, Cursor, any MCP client):

- command: `loombridge`
- args: `["mcp"]`

**5. Optional:** install the agent surface (slash commands + skills) into your project repo
with `loombridge install-agent --project <p>`.

Full setup, transport notes, and the fresh-machine bootstrap: [`Docs/Install.md`](Docs/Install.md).

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/Loomtide/loombridge.git
cd loombridge/mcp-server
npm ci
npm run build
npm link                                  # `loombridge` now on your PATH
bash ../scripts/loombridge-pack-bridge.sh # pack the bridge tarball install-bridge ships
```
</details>

## Two doors in

| Your situation | The door | What happens |
|---|---|---|
| **New game**, built by an agent | `loombridge plan` | Contract and hero shot are frozen before the first line of code; the agent builds slice by slice against a target it cannot redefine; `doneness` certifies with run-bound evidence. |
| **Existing game**, about to let an agent in | `loombridge trace record --observe` | You play once and approve once. From then on, `loombridge verify` checks every agent change against what you approved: replay, pixel drift, feel drift. |

The split of labor is the point: **a human plays and approves exactly once; the agent gets
`verify` forever after.** Full positioning: [`Docs/Design/Positioning.md`](Docs/Design/Positioning.md).

<details>
<summary>Advanced entry points</summary>

| I want to... | Start with | Needs |
|---|---|---|
| Feel-grade a 2D platformer I already have | `loombridge verify --profile precision\|classic\|momentum` | Just the project; no contract, no mutation ([guide](Docs/Profiles/VerifyFirstEntry.md)) |
| Lock my game's feel and catch tuning drift in CI | `loombridge feel snapshot` then `verify --snapshot` | A reviewed capture contract; a human approves the baseline once ([guide](Docs/Profiles/TuningSnapshotVerification.md)) |
| Release-verify a 2D mini-game in CI | `loombridge verify --minigame` | A recorded trace + capture pack, frozen `0/1/2` exit contract ([quickstart](Docs/Profiles/MiniGameVerifyQuickstart.md) · [CI guide](Docs/Profiles/MiniGameVerifyCI.md)) |
| Adopt an already-built project into the contract | `loombridge adopt` | The project + its design docs (proposes a contract, never green on its own) |
</details>

## The verification flow

<!-- VIDEO: plan -> build -> verify -> doneness against a live Unity editor. Show the
     design target getting frozen, the agent building through the bridge, Tier-1 gates
     running, and doneness refusing then passing. Embed here when recorded. -->

`.loombridge/` is the single source of truth per project (contract, design target,
captures, reports, replays). The supervised loop is four verbs:

- **`plan`**: scaffold `.loombridge/`, seed the acceptance contract and feel spec from a
  genre pack, and freeze the Design Target hero shot. No approved target, no roadmap.
- **`build`**: mint a build `runId` and gate preconditions; the agent then constructs
  in-engine through the bridge tools.
- **`verify`**: run the Tier-1 deterministic gates (asset/manifest, UI conformance,
  framing, playability, feel measurement) against the contract and write the verdict.
- **`doneness`**: the freshness and integrity gate. Exit `0` only on a fresh, run-bound,
  green verdict whose cited captures exist on disk.

The binding is the product:

```
plan          build              verify                    doneness
 |             |                  |                         |
 contract      mints runId -----> verdict bound to runId --> exit 0 only if:
 + frozen                         + producedAt                verdict.runId == build.runId
 design                           + cited captures            producedAt >= build.startedAt
 target                                                       every cited capture on disk
                                                              hero-shot fidelity + review
```

Four invariants keep the gate honest:

- **Refuse on absent, never skip.** A gate predicate with a missing bound field refuses
  the verdict; it never silently skips the check. The threat model is a hand-crafted or
  self-graded verdict.
- **Two tracks, one line.** Gates, exits, and state are deterministic and live in the CLI.
  Model judgment (VLM design review) is advisory and never enters a deterministic verdict.
- **Harness fault is not a game defect.** Capture and harness gaps exit `2` in their own
  report tier: never a pass, never a game bug.
- **Only a frozen, sha256-pinned rendered Unity frame can certify doneness.** A flat 2D
  mock is a style reference; freezing it would certify against a fiction, so it is refused.

### Record once, replay deterministically

`loombridge trace record --observe` captures a human demonstration as an action trace.
`trace replay` drives it back against the editor deterministically and diffs frames
against a perceptual baseline; `trace approve` freezes the baseline, `trace report` writes
a self-contained HTML report. Regressions show up as pixels, not opinions.

### Feel is measured, not vibed

The bridge samples position, velocity, and animator state from the running game on real
axes, with input injection and motion capture launch-aligned in a single op so MCP
round-trip latency cannot corrupt the measurement. Feel specs make "the jump feels
floaty" a number: jump height, apex time, coyote time, run speed, fire cadence, hitstop,
screen shake.

## What your agent gets: skills and commands

Verification answers "is it done?". Skills answer "how does the agent know what good
looks like?". Loombridge ships an agent surface you install into your own repo with
`loombridge install-agent` (works with Claude Code and Codex):

| Slash command | What it does |
|---|---|
| `/loombridge:plan` | Interview the human, produce the acceptance contract + frozen design target |
| `/loombridge:build` | Drive a supervised build slice through the bridge under the minted `runId` |
| `/loombridge:verify` | Run the Tier-1 gates, triage failures, loop until green |
| `/loombridge:status` | Read-only progress, next command, and proof/capture warnings |

The 14 skills are the distilled build knowledge, grouped by phase:

| Phase | Skills |
|---|---|
| Build | `unity-2d-game`, `platformer-level-design`, `new-unity-test-project` |
| Polish | `game-polish-2d`, `parallax-2d`, `ui-polish-pack`, `sfx-integration-pack`, `generated-3d-art-integration` |
| Verify & tune | `verify-2d-game`, `graybox-greed-loop-tuning-pack`, `mobile-device-perf` |
| Author & operate | `genre-pack-authoring`, `asset-layer`, `session-retro` |

Each skill carries verified, gotcha-level knowledge (locked project structure, collider
alignment rules, anti-fatigue SFX grammar, real-device frame-time pipelines) so the agent
spends tokens building, not rediscovering.

## Tool surface

The bridge exposes generic `unity_*` tools across 12 categories: actuation and
measurement, no game-specific magic. Full auto-generated reference:
[`mcp-server/TOOLS.md`](mcp-server/TOOLS.md).

| Category | What it covers |
|---|---|
| Scene | Create/find/transform objects, hierarchy, bounds, references, geometry snapshots |
| Editor | Play/pause/stop, state, screenshots, menu items, diagnostics, game-view sizing |
| Input | Real Input System key/pointer sessions, taps, holds, observe/record |
| Runtime | Motion capture, `measure_motion`, animator sampling, probes, `wait_for_condition` |
| Component | Add/remove/list, get/set properties, describe |
| Code | Create/read/modify/attach C# scripts |
| Animator | Controllers, states, transitions, parameters, motion binding, apply-spec |
| UI | Canvas, buttons/images/text, rect transforms, screen rects, pointer dispatch |
| Asset | Sprites/materials/prefabs, model & audio importers, sub-assets, sprite assignment |
| Package | Add/remove/list/search UPM packages |
| Capture | Static-method capture invocation |
| Ops | List, describe, and batch ops; introspect the registry itself |

Locators, not instance IDs (`SceneName:/Path/To/Object[index]`). Deterministic waits via
`wait_for()`, never sleeps. Every tool routes through the op registry.

## Not another Unity MCP

There are more than a dozen Unity MCP servers, including a first-party one from Unity.
They are actuation layers: move an object, edit a script, take a screenshot, and let the
calling model decide subjectively whether the result looks right. The hard part of
AI-built games is not building them; it is telling a real "done" from a confident
hallucination. That layer does not exist anywhere else:

| Capability | Typical Unity MCP | Loombridge |
|---|---|---|
| Create scenes, objects, components, C# scripts | Yes | Yes |
| Real Input System injection into the running game | Rare | Yes |
| Deterministic waits instead of sleeps | No | `wait_for()`, never `sleep()` |
| Measure motion and feel from the running game | No | Jump apex, coyote time, hitstop, cadence |
| Record gameplay once, replay it, pixel-diff against a baseline | No | `loombridge trace` |
| A verdict bound to the build run that produced it | No | `runId` binding; refused if absent |
| A "done" claim the agent cannot self-grade | No | `loombridge doneness` |
| Harness fault separated from game defect | No | Its own exit tier (`2`) |
| Raw code-eval op ("run this C#/shell string") | Common | **Refused by design** |
| Telemetry | Varies | **None** |

The last two rows are deliberate. There is no eval escape hatch: every tool is typed and
schema-validated, and code enters the project only the auditable way (`code.create_script`
writes C# that Unity compiles; `invoke_static` / `execute_menu_item` run project code
behind a refuse-by-default allowlist). And Loombridge phones home to nothing: no
analytics, no usage beacon, no account. See [`Docs/ThreatModel.md`](Docs/ThreatModel.md).

## Support matrix

| | Supported |
|---|---|
| **Unity** | `2022.3 LTS` (compatibility) to **`6000.x LTS` (primary target)** |
| **Node.js** | `>= 18` |
| **OS** | macOS · Windows · Linux |
| **Transport** | `auto` (default): IPC first, then TCP loopback. IPC is a named pipe on Windows; on macOS/Linux the bridge runs on TCP loopback. `doctor --live` prints the transport it actually used, so a fallback is never silent. Details: [`Docs/Install.md`](Docs/Install.md). |

## Security posture

Loombridge is a local, single-developer editor tool. The agent talks to the MCP server
over stdio; the MCP server talks to a bridge inside your Unity Editor over loopback only.
No raw-eval op, no telemetry, no cloud requirement. Exposing the bridge to a network is an
unsupported configuration, not a feature. Report vulnerabilities privately per
[`SECURITY.md`](SECURITY.md); the full model is in [`Docs/ThreatModel.md`](Docs/ThreatModel.md).

## Roadmap and non-goals

The full, current roadmap lives in [`ROADMAP.md`](ROADMAP.md). Loombridge is pre-1.0.
Near-term: one unified `verify` front door over every verification asset, Unity Test
Runner results as a bound gate, a player-build gate, CI-headless robustness, and
N-capture averaging for snapshot baselines. Two recent additions worth knowing: feel profiles split grammar
from taste (universal feel-grammar checks gate pass/fail; archetype targets are
descriptive placement unless you opt in with `--enforce-taste`), and the tuning snapshot
(freeze how the game measurably plays once a human accepts it, then catch kinematic
drift the way `trace` catches pixel drift). Some things are permanent non-goals, not missing features:

- **No arbitrary code-execution op.** The typed op registry is a security boundary.
  Capability gaps are closed by adding typed ops, not an escape hatch.
- **No telemetry.** No analytics, usage beacons, or phone-home. This will not change.
- **No cloud requirement.** The core CLI and bridge run fully local. The hosted asset
  catalog is an optional, read-only convenience, never a dependency for
  plan/build/verify/doneness.
- **Not a game factory.** Loombridge carries no opinion about what a good game is. It is
  the machinery for stating yours once (a human approval) and enforcing it forever (a
  deterministic gate). See [`Docs/Design/Positioning.md`](Docs/Design/Positioning.md).

## Asset catalog (optional)

A public, read-only hosted catalog (66,000+ records, predominantly CC0 with a
clearly-flagged attribution-required tier: PNG sprites, OGG audio, GLB models, SVG
vectors), browsable in-editor via **Window → Loombridge → Asset Browser**. License and
provenance policy is enforced before any Unity import. Quickstart:
[`Docs/Assets/PublicCatalogQuickstart.md`](Docs/Assets/PublicCatalogQuickstart.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off, test suite, PR conventions) and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License and trademark

Licensed under **Apache-2.0**: see [`LICENSE`](LICENSE).

"Loombridge" and "Loomtide" are trademarks of Loomtide. The Apache-2.0 license grants
rights to the code; it does not grant permission to use the Loombridge or Loomtide names,
logos, or branding except as needed for reasonable and customary descriptive reference.
