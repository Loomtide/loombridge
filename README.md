# Loombridge

### Agent layer to build and verify what was build along with feel. ###

It enables agents to operate Unity via typed commands, deterministic CLI to record and replay the game. It can take snapshot and verify gameplay against it to detect the drift.

[![CI](https://github.com/Loomtide/loombridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Loomtide/loombridge/actions/workflows/ci.yml)
[![Unity EditMode](https://github.com/Loomtide/loombridge/actions/workflows/unity-editmode.yml/badge.svg)](https://github.com/Loomtide/loombridge/actions/workflows/unity-editmode.yml)
[![Unity](https://img.shields.io/badge/unity-2022.3%20LTS%20to%206000.x-black?logo=unity)](#support-matrix)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](#support-matrix)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<!-- ═══════════════════════════════════════════════════════════════════
     VIDEO TRAILER placeholder (60-90s).
     Storyboard: (1) agent builds a slice live through the bridge in the
     Unity editor, (2) `loombridge verify` gates it, (3) `loombridge
     doneness` REFUSES with reasons on screen, (4) fix, re-verify,
     doneness goes green. The refusal appears BEFORE the green.
     Embed: [![Loombridge trailer](thumbnail.png)](video-url)
     ═══════════════════════════════════════════════════════════════════ -->

## Install

Needs Node >= 18. macOS, Linux, and Windows, in any shell:

```bash
npm install -g loombridge
```

Then wire your Unity project and health-check it:

```bash
loombridge install-bridge --project /path/to/UnityProject   # adds the bridge (a file: tarball dependency)
loombridge doctor --project /path/to/UnityProject           # every failed row prints its fix
```

To update later, run this from anywhere. Inside a Unity project it also reconciles that
project's bridge, so the CLI and the bridge never drift apart:

```bash
loombridge update          # add --check to see what would change without installing
```

**Connect your agent** (Claude Code, Codex, Cursor, any MCP client): command `loombridge`.

<details>
<summary>Install from source / full setup notes</summary>

```bash
git clone https://github.com/Loomtide/loombridge.git
cd loombridge/mcp-server
npm ci && npm run build && npm link          # `loombridge` now on your PATH
bash ../scripts/loombridge-pack-bridge.sh    # pack the bridge tarball install-bridge ships
```

Full setup, transports, fresh-machine bootstrap: [`Docs/Install.md`](Docs/Install.md).
Unity Personal and license-less CI: [`Docs/Licensing-and-CI.md`](Docs/Licensing-and-CI.md).
Optional agent surface (slash commands + skills, committed into your repo):
`loombridge install-agent --project <p>`.
</details>

## What is Loombridge?

An AI agent can already build a Unity game. What it cannot do is tell you honestly whether the result is any good, because the same model that wrote the code writes the report card. Loombridge splits those roles:

- **The hands**: a typed MCP tool surface (125+ ops, 14 categories) to construct scenes, write C#, inject real Input System events, and measure motion from the running game. No raw code-eval op, ever.
- **The judge**: a deterministic CLI that gates every claim against ground truth a human approved once: contracts, frozen hero shots, recorded demonstrations, measured feel baselines.
- **The rule**: a self-graded "done" is refused. `loombridge doneness` exits green only on a fresh, run-bound verdict whose cited evidence exists on disk and re-derives.
- **Evidence is produced or observed, never typed**: the CLI drives feel measurements itself and records playability from inside the game loop; a teleported win cannot claim it was played.
- **A human plays and approves exactly once**; the agent gets the deterministic gates forever after.
- **Local and quiet**: no telemetry, no cloud requirement, loopback-only bridge.

"Playwright for Unity" is the mechanism. **Provable doneness is the product.**

## The three workflows

| Workflow | You start with | Commands | You get |
|---|---|---|---|
| **Build** a new game | An idea (or a design doc) | `plan` → `build` → agent constructs → `verify --slice` → `plan --go` | A game built slice by slice against a contract the agent cannot redefine |
| **Verify** an existing game | A playable game | `trace record --observe` → `trace approve` → `verify` | Play once, approve once; deterministic pixel + flow + feel gates forever after |
| **Certify** it is done | Green gates | `doneness` | A certificate bound to the run, the evidence, and the frozen design target: or a refusal naming exactly why not |

## Build: the supervised loop

<!-- GIF placeholder: `plan` scaffolding + the agent building a slice through the
     bridge in the editor + `verify --slice` going green + `plan --go`. ~20s. -->

```bash
loombridge plan --genre platformer-2d --name MyGame   # contract + design target, frozen first
loombridge build                                      # mints a run and gates preconditions
# your agent constructs the slice through the MCP bridge
loombridge capture --slice player-feel                # the CLI produces the evidence itself
loombridge verify --slice player-feel --strict        # deterministic gates over that evidence
loombridge plan --go                                  # human checkpoint: approve, next slice
```

`plan` refuses to scaffold without an approved Design Target, and `build` refuses without an approved asset manifest: the contract exists before the first line of code. Genre packs ship for `platformer-2d`, `2d-shooter`, `3d-shooter`, `3d-topdown-arena`, and any-genre contracts grade with their coverage stated honestly.

## Verify: record once, replay deterministically

<!-- GIF placeholder: a human plays ~15s (`trace record --observe`), then `trace
     replay` drives the game by itself and the report shows green flow + pixel rows. -->

```bash
loombridge trace record --observe --id happy-path     # you play; Loombridge watches
loombridge trace replay --id happy-path               # it replays your run deterministically
loombridge trace approve --id happy-path              # you approve the baseline once
loombridge verify                                     # from now on: one command, exit by worst tier
```

Replays drive real input through the game (focus-independent, no field pokes) and diff every capture against your approved baseline perceptually. Animated games get honest levers, each human-consented and printed with the hole it opens: bounded pixel tolerances, region masks with a structural reproduced-drift detector, replay pacing, and capture-aligned settles inside a pinned tick loop. A verify that measured nothing refuses (exit 2): it never passes by default.

## Doneness: the certificate that cannot be talked into green

<!-- GIF placeholder: `doneness` refusing with reasons listed, then (after fixes)
     the green certificate. The refusal must be on screen before the green. ~15s. -->

Verbatim, from an empty scratch project:

```console
$ loombridge doneness
[loombridge doneness] NOT done:
  - phase is `planned`, not `verified-green`
  - no `currentBuild` in STATE — no build is in flight (run `loombridge build` first)
  - no verdict at .loombridge/reports/build-verdict.json
; exit 1
```

Green requires: a verdict whose `runId` matches the in-flight build, `producedAt` on or after the build started, every cited capture present on disk with its recorded sha, every slice re-graded from its own evidence, hero-shot fidelity against the frozen, sha256-pinned design target, and an independent multi-reviewer design review. Nine green gates once met a certificate that still said no, because the design review withheld: that is the product working, and the [156-finding engineering ledger](Docs/Design/TideRunnerDoorOneLedger.md) from proving it live ships in this repo.

Four invariants keep every gate honest:

- **Refuse on absent, never skip.** A missing bound field refuses the verdict, never skips the check.
- **Deterministic decides; advisory advises.** Model judgment (VLM review) never enters a deterministic exit code.
- **Harness fault is not a game defect.** Capture gaps exit `2` in their own tier: never a pass, never a game bug.
- **Evidence binds to its run.** Files from another run, another editor session, or no provenance at all cannot certify this one.

## Not another Unity MCP

There are more than a dozen Unity MCP servers, including a first-party one. They are actuation layers: move an object, take a screenshot, let the calling model decide subjectively whether it looks right. The hard part of AI-built games is telling a real "done" from a confident hallucination, and that layer exists only here:

| Capability | Typical Unity MCP | Loombridge |
|---|---|---|
| Create scenes, objects, components, C# scripts | Yes | Yes |
| Real Input System injection into the running game | Rare | Yes |
| Deterministic waits instead of sleeps | No | `wait_for()`, never `sleep()` |
| Measure motion and feel from the running game | No | Jump apex, coyote time, hitstop, cadence |
| Record gameplay once, replay it, pixel-diff against a baseline | No | `loombridge trace` |
| Playability observed from inside the game loop | No | A teleported win cannot say "played" |
| A "done" claim the agent cannot self-grade | No | `loombridge doneness` |
| Raw code-eval op ("run this C#/shell string") | Common | **Refused by design** |
| Telemetry | Varies | **None** |

## Reference

- **Tool surface**: 125+ typed `unity_*` ops across scene, editor, input, runtime measurement, components, code, animator, UI, assets, packages, capture, observe, and registry introspection. Auto-generated reference: [`mcp-server/TOOLS.md`](mcp-server/TOOLS.md).
- **Agent surface**: 4 slash commands (`/loombridge:plan|build|verify|status`) and 14 skills of gotcha-level build knowledge, installable into your repo with `loombridge install-agent`.
- **Architecture**: [`ARCHITECTURE.md`](ARCHITECTURE.md) · **Roadmap**: [`ROADMAP.md`](ROADMAP.md) · **Findings ledger and open backlog**: [`Docs/Design/TideRunnerDoorOneLedger.md`](Docs/Design/TideRunnerDoorOneLedger.md) · **Positioning**: [`Docs/Design/Positioning.md`](Docs/Design/Positioning.md)
- **Asset catalog (optional)**: a public, read-only hosted catalog (66,000+ records, predominantly CC0), browsable via **Window → Loombridge → Asset Browser**; license and provenance enforced before any import. [`Docs/Assets/PublicCatalogQuickstart.md`](Docs/Assets/PublicCatalogQuickstart.md)

## Support matrix

| | Supported |
|---|---|
| **Unity** | `2022.3 LTS` (compatibility) to **`6000.x LTS` (primary target)** |
| **Node.js** | `>= 18` |
| **OS** | macOS · Windows · Linux |
| **Transport** | `auto`: IPC first, then TCP loopback; `doctor --live` prints the transport it actually used. Details: [`Docs/Install.md`](Docs/Install.md) |

## Security posture

Loombridge is a local, single-developer editor tool. The agent talks to the MCP server over stdio; the MCP server talks to a bridge inside your Unity Editor over loopback only. No raw-eval op, no telemetry, no cloud requirement. Exposing the bridge to a network is an unsupported configuration, not a feature. Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md); the full model is in [`Docs/ThreatModel.md`](Docs/ThreatModel.md).

## Non-goals (permanent, not missing features)

- **No arbitrary code-execution op.** The typed op registry is a security boundary; gaps are closed with typed ops, never an eval escape hatch.
- **No telemetry.** No analytics, usage beacons, or phone-home. This will not change.
- **No cloud requirement.** Core CLI and bridge run fully local.
- **Not a game factory.** Loombridge carries no opinion about what a good game is; it is the machinery for stating yours once and enforcing it forever.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off, test suite, PR conventions) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License and trademark

Licensed under **Apache-2.0**: see [`LICENSE`](LICENSE).

"Loombridge" and "Loomtide" are trademarks of Loomtide. The Apache-2.0 license grants rights to the code; it does not grant permission to use the Loombridge or Loomtide names, logos, or branding except as needed for reasonable and customary descriptive reference.
