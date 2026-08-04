# Loombridge Threat Model

This document describes the security posture of Loombridge — the
`com.loomtide.loombridge` Unity package (`packages/com.loomtide.loombridge/`) and
the `loombridge` MCP server + `loombridge` CLI (`mcp-server/`). It is written for public consumption: what the attack surface is, what
the design deliberately refuses to offer an attacker, and what is explicitly out of
scope. Statements below are grounded in the shipped code; file references point at the
enforcing implementation.

**Summary:** Loombridge is a local, single-developer editor tool. An AI agent talks to
an MCP server over stdio; the MCP server talks to a plugin inside your Unity Editor
over loopback-only WebSocket (or, on Windows, a local named pipe). There is no network
service
intended to be reachable from other machines, no arbitrary-code-execution op, and a
verification supervisor whose job is to make "the agent graded its own work" detectable
and refusable.

## Trust boundaries

```
 AI agent (MCP client)  ──stdio──►  MCP server / loombridge CLI  ──loopback ws/ipc──►  Unity Editor bridge plugin
        [semi-trusted]                     [trusted, local]                           [trusted, local]
```

1. **Agent ↔ MCP server.** The MCP server runs as a child process of the agent host
   and communicates over stdio only — it opens no listening port on the client side.
   The agent is *semi-trusted*: it is allowed to drive the editor, but only through the
   typed op surface (below), and its claims about verification results are **not**
   trusted — the CLI supervisor independently re-checks them (see "What the CLI
   supervisor defends against").
2. **MCP server ↔ Unity Editor.** Both processes run as the same local user on the
   same machine. The transport is loopback-only; the boundary here defends against
   *accidents* (wrong editor, stale endpoint, protocol drift) via session discovery
   and an enforced handshake — it does not attempt to defend against a hostile
   same-user local process (see "Non-goals").
3. **Everything ↔ the Unity project.** The Unity project being driven is assumed to be
   one you already trust enough to open in the Unity Editor. Opening a Unity project
   executes that project's editor code by Unity's own design; Loombridge does not (and
   cannot) add a sandbox underneath that.

## Attack surface

### Loopback WebSocket / IPC listener

The bridge listens **only on loopback** (`Editor/Core/BridgeServer.cs`):

- **TCP:** IPv6 loopback (`TcpListener(IPAddress.IPv6Loopback)`, dual-mode) with an
  IPv4 loopback (`IPAddress.Loopback`) fallback — never `IPAddress.Any`. Ports are
  scanned in the fixed range **8200–8210**; the last good port is cached in
  `EditorPrefs`.
- **IPC:** on Windows, a named pipe (`\\.\pipe\loombridge-bridge-<sessionId>`). A Unix
  domain socket code path exists for macOS/Linux, but Unity's Mono editor runtime
  does not expose the required socket API, so in practice **IPC is Windows-only and
  macOS/Linux runs TCP loopback today** (matching `Docs/Install.md`). Both branches
  are loopback-local, so the security posture is unchanged either way. In `auto` mode
  (`LOOMBRIDGE_UNITY_TRANSPORT_MODE`) the editor attempts IPC then TCP; the client
  discovers endpoints via the discovery file, falling back to probing the loopback
  port range.

Consequences: the bridge is not reachable from other machines unless an operator
actively forwards the port (see "Operator guidance"). Any process running as the same
local user *can* connect — that is an accepted risk, not a defended boundary
(see "Non-goals").

The handshake advertises a 5 MB payload limit that well-behaved clients honor; the
listener does not currently enforce it on inbound frames (a same-user local process
that ignores it is outside the defended boundary — see "Non-goals"). All commands
execute on the Unity main thread via a drained queue — there is no side channel that
runs bridge code off the command path.

### Endpoint-discovery file

Each editor session publishes `endpoint-discovery-<sessionId>.json` (plus a
`endpoint-discovery-latest.json` pointer) under a per-user temp directory
(`<temp>/loombridge/unitybridge/`, overridable via `LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR` /
`_FILE`). The file contains endpoint and session/project metadata so the MCP server
can find the right editor among several — it contains **no credentials**, because the
protocol has none to leak. Stale files are swept best-effort.

Threat to be aware of: the discovery file is *trust-on-read*. A local same-user
attacker who can write to that temp directory could point a client at a different
local endpoint. This is within the accepted same-user local risk (Non-goals), but it
is why the discovery path is overridable — CI and multi-editor setups should pin
`LOOMBRIDGE_ENDPOINT_DISCOVERY_FILE` explicitly.

### Enforced handshake (connect and reconnect)

Every new socket must send `bridge.initialize` before any other command; anything else
is refused with `HANDSHAKE_REQUIRED` (`BridgeServer.cs`). The handshake-completed set
is per-connection, cleared on server restart and on disconnect, so **reconnects must
re-handshake** — this is enforced in code, not convention. The handshake carries
`protocolVersion` and `pluginVersion` (`Editor/Core/Handshake.cs`); on the client
side, the deterministic preflight (`preflight/prerequisite-checks.ts`) refuses a
`PROTOCOL_MISMATCH` for the ops it gates — `runtime.*`, `input.*`, and the
capture-critical editor ops (`editor.get_state`/`play`/`wait_for`/`screenshot`) —
and `loombridge doctor --live` runs the same check.

Honest scoping: the handshake is a **protocol and session-integrity gate, not
authentication**. It prevents version-skewed or half-connected clients from issuing
commands; it does not prove *who* is connecting. There are no tokens or secrets in the
protocol — which is precisely why the listener is loopback-only and remote exposure is
out of scope.

## No arbitrary code execution — the typed op surface

This is a deliberate design differentiator. The bridge exposes **only a fixed registry
of typed operations** (121 tools across 12 categories; `mcp-server/src/op-registry.ts`
→ `Editor/Core/OpExecutor.cs` → per-category `IOpHandler`s). There is **no** `eval`,
no "run this C# string", no shell-out op, and no reflection-invoke-anything op. An
agent can only do what a registered op does, with JSON-schema-validated inputs.

Three surfaces deserve honest qualification:

1. **`code.create_script` / `code.modify_script`** write C# source files, which the
   Unity compile pipeline will then compile and run in-editor. This *is* a path for an
   agent to introduce code into your project — by explicit, auditable file writes, not
   by a hidden execution channel. Paths are validated to stay under `Assets/` with a
   separator-boundary path-traversal check (`CodeHandler.ValidateAssetPath`: rejects
   non-`Assets/` prefixes and normalizes to catch `..` escapes and `AssetsEvil/`
   prefix tricks). Operator guidance: review generated scripts like any other diff.
2. **`capture.invoke_static`** (reflection-invoke a project static method) and
   **`editor.execute_menu_item`** (run an editor menu item) are the bridge's two
   guarded code-execution surfaces. Both are gated by a **refuse-by-default,
   project-owner-vetted allowlist** (`Editor/Core/EditorInvokeAllowlist.cs`):
   built-in defaults ∪ `<project>/.loombridge/editor-allowlist.json`, re-read on every
   invocation. Menu items have *no* built-in defaults — every menu item must be opted
   in explicitly; the only built-in static method is a single capture entry point.
   Anything not listed is refused with an error telling the human what to vet.
3. **Ordinary ops mutate the project.** Scene edits, component property writes, asset
   creation, and UPM `package.add` are all typed and scoped, but they are real
   mutations of your project (and `package.add` fetches a package, which can itself
   contain editor code). Use version control; review what a session changed.

## Input injection scope

Input simulation (`Runtime/Input/InputSystemRuntimePump.cs`, compiled only under
`ENABLE_INPUT_SYSTEM`) injects **virtual Input System devices only** — a virtual
keyboard and mouse created for the session. It never mirrors, suppresses, or zeroes
the real hardware keyboard, and it targets the Unity Editor's game view (it applies
editor-scoped Input System settings for the session and restores them on end). It is
an editor-workflow capability, not a general OS input synthesizer: it cannot type into
other applications. Input sessions have an explicit lifecycle with a 30-second idle
watchdog (plus a keepalive lease for long measurements), so an abandoned session tears
itself down. The small `Runtime/` input-pump assembly (all platforms, gated on
`ENABLE_INPUT_SYSTEM`) does compile into player builds, but it is inert there: it has
no `RuntimeInitializeOnLoad` entry point, and only editor-side bridge code ever
invokes its statics.

## What the CLI supervisor defends against

The `loombridge` CLI's verification layer treats the driving agent as an adversary for
one specific goal: **claiming "done" without earning it.** The threat model is a
self-graded or hand-crafted verdict. Defenses (all code, not prose; see
`ARCHITECTURE.md` §"The §3a Supervisor"):

- **Run identity binding.** `build` mints a `runId`; `verify` writes a verdict bound
  to it; `doneness` refuses unless verdict ≡ current build ≡ slice proof runId. A
  pasted-in or replayed verdict from another run does not check out.
- **Refuse-on-absent gates.** A gate predicate whose bound field is *missing* refuses;
  it never silently skips the check. Omitting a binding field from a hand-edited
  verdict is treated as failure, not as "nothing to check".
- **sha256-frozen hero shots.** For an approved Design Target, review findings must
  reference the frozen hero shot by content hash
  (`reference.heroShotSha256 === designTarget.pngSha256`) and come from an
  independent review (`reviewerCount ≥ 2`) — an agent cannot substitute a flattering
  screenshot or vouch for itself.
- **Disk-truth refusals.** Doneness re-reads design-target state from disk and adds
  refusals as a strict union with the verdict's own claims — a verdict cannot launder
  a gate away by omitting the relevant block.
- **Re-derivation of measurements.** Feel metrics are re-derived from their own raw
  captured samples; a tampered in-band value is forced to `fail`, and un-re-derivable
  values are flagged as `reported`, never `verified`.
- **Two-track discipline.** Model (VLM) judgment is advisory and independently
  attested; nothing model-judged enters a deterministic verdict, so there is no prompt
  through which an agent can talk a deterministic gate into passing.

This supervisor defends the *integrity of verification claims*. It does not (and does
not claim to) prevent a hostile agent from making unwanted project edits — that is
what version control and human review are for.

## Non-goals

Explicitly out of scope. These are accepted limitations, not oversights:

- **Multi-tenant / shared-machine isolation.** Everything assumes one developer, one
  user account, one machine. Any process running as the same OS user can connect to
  the loopback listener, read the discovery file, or edit `.loombridge/` state. There is
  no per-client authentication or authorization.
- **Network-exposed bridge.** The protocol has no TLS and no auth tokens because it is
  never meant to leave loopback. Port-forwarding, tunneling, or containerizing the
  bridge with a published port creates an unauthenticated remote editor-control
  channel — an unsupported configuration, not a vulnerability report.
- **Untrusted-project safety.** Opening a Unity project runs that project's editor
  scripts (Unity's design). Loombridge adds no sandbox and must not be used as one:
  do not point it at a project you would not open in the Unity Editor yourself.
- **Sandboxing the agent's intent.** The typed op surface bounds *how* an agent can
  act, and the supervisor bounds what it can *claim* — but an agent authorized to
  build your game can still build it badly or edit files you'd rather it hadn't.
  Human review of diffs remains part of the workflow.

## Operator guidance

- **Never expose the bridge to a network.** Do not port-forward or tunnel ports
  8200–8210, do not publish them from containers, and do not run the editor + bridge
  on a multi-user host expecting user isolation.
- **Review generated C# before relying on it.** Scripts written via `code.*` ops are
  compiled and executed by the Unity Editor. Treat a Loombridge session's file changes
  like any contributor's PR: diff, review, then commit.
- **Keep the editor allowlist minimal.** Every entry in
  `.loombridge/editor-allowlist.json` (static methods and menu items) is vetted code
  execution. Add entries deliberately; remember menu items have no defaults.
- **Run on version-controlled projects.** Ops mutate scenes, assets, settings, and
  packages. Git is your undo and your audit log.
- **Pin discovery in shared/CI environments.** Use `LOOMBRIDGE_ENDPOINT_DISCOVERY_FILE`
  (or `_DIR`) to bind a client to a specific editor session instead of trusting the
  "latest" pointer in a shared temp directory.
- **Treat `package.add` like a dependency change** — it pulls third-party code into
  the editor process. The same scrutiny you'd give a manifest edit applies.
- **Report suspected vulnerabilities privately** — see [SECURITY.md](../SECURITY.md).
