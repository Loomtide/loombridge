# Design: `loombridge setup`, one command from a Unity project

**Status:** IMPLEMENTED. **Date:** 2026-08-06.
Shipped as `loombridge setup` + `loombridge install-mcp`
(`mcp-server/src/capabilities/setup/setup.ts`, `install-mcp.ts`).
Inherits from [Positioning.md](Positioning.md) (the Setup surface group).

## The finding

Onboarding has three steps and ships an installer for only two of them. Observed live: a
developer ran `loombridge install-bridge --project ..` on a fresh project, then opened an agent
session in it and had neither the slash commands nor MCP.

| Piece | Installer today | Result on that project |
|---|---|---|
| Unity bridge package | `install-bridge` | installed, 0.2.0 |
| Slash commands + skills | `install-agent` | NOT installed (`agentSurface: UNSET`) |
| MCP server registration | **none exists** | NOT wired |

The third row is the important one: **nothing in Loombridge writes MCP config.** Confirmed by
grep across the whole source. The README's "Connect your agent: command `loombridge`, args
`["mcp"]`" is prose the developer is expected to translate into their client's config by hand.
It is also the step that matters most, because without it an agent cannot touch Unity at all.
The Unity half and the optional slash-command half each have a one-command installer; the half
that actually connects the agent does not.

The server itself is healthy, so this is purely a wiring gap:

```
$ loombridge mcp     (initialize handshake)
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
 "serverInfo":{"name":"loombridge","version":"0.2.0"}},"jsonrpc":"2.0","id":1}
```

## Why not do it from `npm install -g`

Rejected. An npm lifecycle script runs with its CWD inside the installed package, not the
directory the developer typed the command in, so it cannot reliably learn which project they
meant. Even if it could, a global install silently mutating a Unity project it inferred is the
wrong shape for this repo: it is an unstated inference driving a write, which is the same class
of defect the genre wave just closed. Installing the CLI and wiring a project stay separate
acts, and the second one is explicit.

## The command

```bash
npm install -g loombridge     # or re-run to update; npm owns this half
cd /path/to/UnityProject
loombridge setup              # everything else, idempotent
```

`setup` composes existing verbs rather than reimplementing them. It is the front door; the
individual verbs stay, keep working, and stay documented for anyone who wants one step.

### Order, and what each step does

1. **Resolve the project.** Default to cwd, exactly as `update` already does. Refuse (exit 2)
   when it is not a Unity project, naming `--project <dir>`. Never guess a different directory.
2. **Report CLI currency.** Reuse the `update` machinery to say whether a newer `loombridge` is
   published. REPORT ONLY, never self-update: a self-update has to end the run (the bridge
   tarball ships inside the CLI, so the new binary must be the one to deliver it), and ending
   `setup` halfway through is worse than telling the operator to run `loombridge update`.
3. **Bridge.** Install when absent, reconcile when present. This is `install-bridge` /
   `update`'s existing hash-checked path, including the freshness gate.
4. **MCP.** Write the project's MCP registration. Default ON: this is the step that makes the
   tool work at all, and it is not what the confirmation in step 5 is about.
5. **Agent surface (LAST, and confirmed).** Slash commands and skills are opinionated content
   committed into the developer's repo, so they stay opt-in. Prompt when interactive; skip when
   not. See the rules below.
6. **`doctor`.** Close with the existing health check so the run ends on evidence rather than on
   a claim.

### The confirmation rules

The CLI is driven by agents as often as by humans, so a prompt has to be safe when nothing can
answer it. Follow the precedent already in this repo (`minigame-setup.ts`,
`minigame-declare-background.ts`): gate on `process.stdin.isTTY === true`, offer a `--yes`, and
never block otherwise.

- Interactive and no flag: prompt for the agent surface only.
- **Not a TTY and no flag: SKIP the agent surface**, and say so with the command to add it
  later. Skipping is already the documented default for that surface, so this changes nothing
  about the policy; it only makes it visible.
- `--yes` installs it without asking. `--no-agent-surface` skips it without asking. A recorded
  `agentSurface: declined` in the install metadata is honored and stays silent, as `update`
  already does.

Steps 1 to 4 never prompt.

### `.mcp.json` must MERGE, never clobber

A project may already register other MCP servers, and overwriting that file would silently
break unrelated tooling. So:

- Merge into an existing file, preserving every other key and every other server.
- Refuse rather than overwrite when a DIFFERENT `loombridge` entry is already present and was
  not written by us, the same hand-edit-safe discipline `install-agent` uses for its 84 managed
  files. A developer's edit is theirs.
- Never write outside the project root.
- Malformed JSON is a refusal, not a reason to start fresh: rewriting a file we could not parse
  would discard configuration we never read.

Because Loombridge should own its entry across upgrades but nothing else, record what was
written in the same `ProjectSettings/LoombridgeInstall.json` ledger the agent surface uses, so a
later `setup` can tell "we wrote this" from "a human wrote this".

**The ledger is not the only proof of authorship, because Loombridge writes `.mcp.json` from two
places.** `templates/create-loombridge-game/.mcp.json` shipped `loombridge-mcp` + `[]` while
`install-mcp` writes `loombridge` + `["mcp"]`, so `setup` on a project scaffolded from our own
template hit the foreign-entry refusal and exited 2, telling the developer their config was
theirs. The guard was right; the inputs disagreed. Two fixes, closing two different holes: the
template becomes the canonical entry (bound to `desiredServerEntry()` by a test, so the two can
never describe different servers again), and `install-mcp` carries a CLOSED SET of entry shapes
Loombridge has itself shipped, which it upgrades in place. The set exists for the projects
already scaffolded from the old template, which no template edit can reach. It matches exact
bytes by sha, never a heuristic on the command name: "the command mentions loombridge" would
adopt `/opt/custom/loombridge --port 9999` and defeat the guard.

### `doctor` must grade the MCP registration too

Step 6 closes on evidence, so it has to have evidence about the step `setup` just performed.
Grade the registration by RE-DERIVING it from `.mcp.json` on disk and only then comparing to the
ledger, never by reporting the ledger back: `mcpRegistration: { state: "enabled" }` proves
nothing once the developer has deleted the file or rewritten the entry, the same reason the
tarball sha and the routing doc are recomputed at read.

Absent is a **warn**, not a fail and not an info: an agent cannot drive Unity without it, so it
is not as optional as the slash commands, but a developer who only ever runs the deterministic
CLI never needs it, and doctor's exit code says whether the install is BROKEN. Malformed JSON is
a **fail**: `install-mcp` refuses to rewrite a file it could not parse, so only doctor can tell
the developer to fix it by hand. A hand-edited entry is **info**, reported as the developer's
rather than as damage, matching what `install-agent` does with a managed file whose bytes have
changed.

## Independent verbs stay

`install-bridge`, `install-agent`, `doctor`, and `update` keep working and keep their help.
`setup` is a composition, not a replacement, and the docs say which to reach for: `setup` on a
new project, `update` to keep an existing one current.

MCP wiring also gets its own verb so `setup` composes rather than special-cases it, and so a
developer who wants only that step has it. Name it consistently with the existing pair
(`install-bridge`, `install-agent` -> `install-mcp`).

## Invariants

- **Not a Unity project is a refusal**, never a guess at a nearby directory.
- **No prompt blocks a non-interactive run.** A missing answer resolves to the documented
  default (skip), never to a write.
- **Nothing that was not written by Loombridge is overwritten**, in `.mcp.json` or anywhere.
- `setup` is IDEMPOTENT: running it twice on a wired project changes nothing and still exits 0.
- `setup` reports CLI staleness; it never self-updates mid-run.

## Out of scope

- Configuring MCP for clients other than the project-scoped `.mcp.json` convention. Other
  clients are documented, not written to; their config lives outside the project.
- Any change to what the bridge or the agent surface contain.
- Doing project setup from an npm lifecycle script (rejected above).

## Open questions, resolved on implementation

1. **Should `setup` refuse or warn when the CLI is stale?** **WARN.** The bridge it is about to
   install is the one this CLI shipped with, so the run is internally consistent either way, and
   a refusal would block a first-time setup on an unrelated version check. `setup` passes
   `checkOnly` to `update`'s phase unconditionally, so no flag can make it self-update.
2. **Does `install-mcp` belong in the headline Setup group or the reference list?**
   **HEADLINE**, alongside `setup`. It is a step every new project needs, which is the finding.

Decided alongside them:

3. **Exit codes.** `0` wired and healthy, and an OPTIONAL step that was skipped (the agent
   surface, by flag, by a non-interactive run, or by a recorded "declined") is still `0`, because
   skipping is that surface's documented default. `1` a REQUIRED step failed. `2` usage or
   precondition: bad arguments, not a Unity project, a refused stale bridge bundle, or a
   `.mcp.json` that could not be parsed or holds a foreign entry.
4. **What the ledger records.** An `mcpRegistration` block beside `agentSurface` in
   `ProjectSettings/LoombridgeInstall.json`, carrying the config path, the server key, and the
   sha256 of the CANONICAL JSON of the entry that was written. The sha covers the ENTRY, never
   the whole file: other tooling legitimately adds servers to `.mcp.json`, and a whole-file hash
   would read every unrelated addition as a hand edit and refuse from then on.
5. **An existing entry identical to ours, with no ledger.** Left alone AND not recorded. There is
   nothing to refuse (no bytes would change) and nothing to claim: recording ownership of a line
   a human typed would let a later version rewrite it.
6. **An `--embedded` bridge.** `setup` refuses to reconcile it (exit 1) and names
   `update --force-bridge`. It is a physical folder that may hold local edits, and "one command
   for a new project" must not be the thing that clobbers them.
