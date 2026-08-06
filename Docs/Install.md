# Install Loombridge on a new machine

The simplest end-to-end setup is npm:

```bash
npm install -g loombridge
```

Then wire a project with one command, run from inside it:

```bash
cd /path/to/UnityProject
loombridge setup
```

**Which verb do I want?** `setup` on a NEW project: it is the front door that wires everything and
is safe to re-run. `update` to keep an EXISTING one current: it updates the CLI itself and then
reconciles that project's bridge. `setup` never self-updates the CLI, and `update` never installs
the MCP registration or the agent surface from scratch. See
[What `loombridge setup` does](#what-loombridge-setup-does) below.

That is the supported install and update path, and the one `loombridge update` self-updates
through. The tracks below are the alternatives:

- **Track A, the GitHub Releases installer** (`install.sh`). Fetches a pinned release asset and
  hands it to `npm install -g`. Useful for pinning an exact release or for a machine without
  direct registry access.
- **Track B, from source** (clone + build). For contributors, and for running an unreleased
  branch.

> **Availability:** `npm install -g loombridge` resolves the published package. Until the first
> `v0.2.0`+ release is tagged and published, npm still serves the 0.0.1 name-reservation stub,
> which carries no `loombridge` binary. Use Track B until then.

All three end at the same place: a `loombridge` command on your PATH and the Unity bridge installed into your project as a
versioned tarball dependency, verified by `loombridge doctor`.

## Requirements (both tracks)

- Node.js `>= 18`
- Unity `6000.3 LTS` (primary) or `2022.3 LTS` (compatibility)
- `~/.local/bin` on your `PATH` (Track B installs auxiliary harness wrappers there — the core `loombridge`
  bin itself comes from the one-command installer or `npm link`, never `~/.local/bin`):
  ```bash
  echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin" || echo 'add ~/.local/bin to your PATH'
  ```

---

## Track A — One-command install (from the first tagged release)

> **Not live yet.** `get.loomtide.ai` does not serve Loombridge today — the one-liner currently
> resolves a different, legacy CLI and would **silently install the wrong binary**, not Loombridge.
> Use **Track B (from source)** below until the first Loombridge release is tagged. Everything in this
> section describes how the one-command path will work **from that release on**.

From the first tagged release, Loombridge ships through **public GitHub Releases** on this repo
(`Loomtide/loombridge`) — the release assets carry the packed CLI and installer. No npm account, no
registry config, and no repository access to grant. Install (and later update) with a single command.

#### Fresh machine? One bootstrap command (installs the prerequisites too)

On a brand-new machine you may not have Node, `gh`, or (on Windows) even a POSIX shell. The **bootstrap**
one-liner installs only what is missing (Node.js LTS + GitHub CLI), authenticates GitHub, then installs the
CLI — and it is the RECOMMENDED first command on a clean box. Re-run it any time to update.

```powershell
# Windows — in PowerShell (Windows PowerShell 5.1 or 7). NO Git Bash / WSL needed.
# Run ELEVATED if Node.js / GitHub CLI are not installed yet (winget needs it for their MSIs).
irm https://get.loomtide.ai/win | iex
```

> **Elevation:** `OpenJS.NodeJS.LTS` and `GitHub.cli` are machine-scope MSI packages. On an admin
> account winget shows a UAC prompt (even with `--silent`); on a standard user account the install
> cannot succeed at all. If both tools are already present the bootstrap only installs the CLI via
> `npm install -g` and needs no elevation.
>
> Always invoke the script as `irm … | iex`. It is delivered UTF-8 and executed in-session, which is
> why it needs no execution-policy change; `.\bootstrap.ps1` from disk is not the supported path.

```bash
# macOS / Linux
curl -fsSL https://get.loomtide.ai/setup | sh
```

The Windows bootstrap is **PowerShell-native and does not require Git Bash** — the Loombridge CLI runs on Node
and works in any shell, so the bootstrap only needs Node.js + GitHub CLI (installed via `winget`). Pass a
Unity project to wire it in the same shot: append `-Project C:\path\to\UnityProject` (PowerShell, or set
`$env:LOOMBRIDGE_PROJECT` before the `irm | iex`) / `-s -- --project /path/to/UnityProject` (the `curl … | sh`
form). The steps below are the **"I already have Node + gh"** path (or what the bootstrap runs for you).

```bash
# 0. (Optional) The release assets are public, so no auth is needed. The installer uses the GitHub
#    CLI if it is already authenticated, and falls back to LOOMBRIDGE_TOKEN=<token> in CI if you set it.

# 1. Install the CLI — this same command UPDATES it later, just re-run it
curl -fsSL https://get.loomtide.ai | sh

# 2. Wire YOUR Unity project (no repo clone, no git needed): bridge + MCP + doctor
cd /path/to/UnityProject && loombridge setup

# 3. Open that project in Unity and wait for it to finish compiling, then re-check:
loombridge doctor --project /path/to/UnityProject
```

`doctor` should print `healthy`. That's it.

**One command for a fresh machine.** Pass a project and the installer also wires the bridge in one shot
(re-run any time to update both the CLI and the bridge):

```bash
curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject
```

**Pin a version** for reproducible/CI setups: `LOOMBRIDGE_VERSION=v0.2.0 curl -fsSL https://get.loomtide.ai | sh`.

> **On Windows:** the recommended path is the PowerShell bootstrap `irm https://get.loomtide.ai/win | iex`
> (above) — it needs **no Git Bash / WSL**. If you already have Node + gh and prefer the raw `curl … | sh`
> installer, run *that* line in **Git Bash** (bundled with Git for Windows) or WSL — it is a POSIX shell script
> and won't run in cmd.exe/PowerShell. Either way, after install the `loombridge` command works in any
> Windows shell (npm installs a `loombridge.cmd` shim), and `install-bridge`/`doctor`/`update` are cross-platform.
> The default transport is **auto** (IPC first, TCP-loopback fallback). On **Windows** IPC is a named pipe and is
> used by default. On **macOS/Linux** Unity's Mono editor runtime doesn't expose the unix-domain-socket API, so the
> bridge always runs on TCP loopback there — IPC is Windows-only in practice today. `LOOMBRIDGE_UNITY_TRANSPORT_MODE=tcp`
> forces TCP (e.g. if a local security agent blocks the pipe on Windows); `=ipc` forces IPC and fails fast where no
> IPC endpoint exists (all macOS/Linux editors). `doctor --live` prints the transport it actually used, so a fallback
> is never silent. Committing the agent surface for a mixed-OS team? `install-agent`
> drops a scoped `.gitattributes` (LF-pinned) so `core.autocrlf` can't desync the ledger.

> **After `install-bridge`, focus the Unity editor.** Unity only re-resolves `Packages/manifest.json` when it
> regains focus, so a project left in the background will not import the bridge and `doctor --live` will report
> it unreachable. Expect one recompile (and, on Unity 6.3, an advisory "Missing Signature" dialog — safe to close).

### Optional: agent commands + skills

The bridge and the MCP registration are all you need. If you also want Loombridge's agent surface (the
`/loombridge:*` slash commands and the game-build/verify skills) **installed into your project repo** (so
they're committed and your teammates get them on the next `git pull`), opt in. `loombridge setup` offers
this in an interactive terminal (and skips it in every non-interactive one); the verb does it directly:

```bash
loombridge install-agent --project /path/to/UnityProject
```

This writes real files under `.claude/commands/loombridge/`, `.claude/skills/`, and `.codex/skills/` (never
into your `~/.claude` or `~/.codex`). The one-command installer can do it in the same shot with `--with-agent`:

```bash
curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject --with-agent
```

- **To skip it: do nothing.** Skipping is the default — `install-bridge`/`update` print one optional hint and
  never nag.
- **To opt out (and be remembered):** `loombridge install-agent --project /path/to/UnityProject --remove`.
  It deletes the managed files (any you hand-edited are left in place) and records the choice, so later
  `update`s stay silent. Re-run `install-agent` to re-enable.

The choice lives in the committed `ProjectSettings/LoombridgeInstall.json`, so it is **team-wide + versioned**:
one dev decides and everyone's `loombridge update` behaves identically after a pull.

> The GitHub Releases command above is the fallback channel, for a pinned release asset or a machine
> without registry access. The supported install and update path is npm (`npm install -g loombridge`),
> which is what `loombridge update` self-updates through.

---

## Track B: from source (contributors, and unreleased branches)

This is how you install Loombridge until the first release is tagged: a clone builds the CLI, `npm link`
puts it on your PATH, and you pack the bundled bridge tarball the install/health commands need.

```bash
# 1. Clone + build
git clone https://github.com/Loomtide/loombridge.git
cd loombridge/mcp-server
npm ci
npm run build

# 2. Put `loombridge` on your PATH — link the dev bin (follows every `npm run build`):
npm link                    # `loombridge --version` shows your local commit (+dirty)

# 3. Pack the bundled bridge tarball. install-bridge/doctor NEED it, and a fresh clone lacks it —
#    without it, doctor exits 1 and install-bridge refuses ("no bundled bridge tarball"):
bash ../scripts/loombridge-pack-bridge.sh   # writes dist/bridge/com.loomtide.loombridge-<ver>.tgz

# 4. Agent surface (slash commands, skills, aux harness wrappers -> ~/.local/bin/loombridge-*):
cd ..
./scripts/loombridge-install-locally.sh

# 5. Wire YOUR Unity project (bridge + MCP registration + doctor):
cd /path/to/UnityProject && loombridge setup
```

> **No Unity project handy?** `install-bridge` and offline `doctor` only touch three paths, so a
> throwaway project works fully offline (no Unity install needed):
> ```bash
> mkdir -p MyProject/Assets MyProject/Packages MyProject/ProjectSettings
> echo '{"dependencies":{}}' > MyProject/Packages/manifest.json
> echo 'm_EditorVersion: 6000.3.20f1' > MyProject/ProjectSettings/ProjectVersion.txt   # your installed version
> ```
> `loombridge doctor --project MyProject` reports `healthy` against this without Unity running; only
> `--live` needs the project actually open in Unity.

Notes for Track B:

- `loombridge-install-locally.sh` deliberately does **not** install a `loombridge` bin — a `~/.local/bin`
  wrapper would shadow the `npm link`ed (later, released) CLI on PATH. It even removes such wrappers left by older versions.
- With `npm link`, `npm run build` is all a rebuild takes; re-run `bash scripts/loombridge-pack-bridge.sh`
  after any bridge change so `install-bridge`/`update` pick up the new tarball. `loombridge --version` tells
  you which build (`+dirty` local vs a release commit) you're actually running.
- To push your checkout's **bridge** into a consumer project without a release, see the dev short path
  under [Keeping it up to date](#keeping-it-up-to-date).

---

## What `loombridge setup` does

`setup` is the front door for a new project. It **composes** the individual verbs below rather
than reimplementing them, so each one keeps working on its own and the two can never disagree:

```bash
cd /path/to/UnityProject
loombridge setup                      # or: loombridge setup --project /path/to/UnityProject
```

1. **Resolve the project.** The current directory by default. Not a Unity project is a refusal
   (exit 2) naming `--project <dir>`, never a guess at a nearby directory.
2. **Report the CLI's currency.** Report only: `setup` never self-updates. A self-update has to
   END the run (the bridge tarball ships inside the CLI, so the new binary must be the one to
   deliver it), and ending a first-time setup halfway is worse than telling you to run
   `loombridge update`. A newer CLI is therefore a warning, not a refusal.
3. **Bridge.** `install-bridge`'s installer, freshness gate and all: installed when absent,
   reconciled when present. An `--embedded` bridge is left alone, because it may hold local
   edits; reconcile that deliberately with `loombridge update --project <p> --force-bridge`.
4. **MCP.** `install-mcp` (below). Default ON, because it is what connects an agent to Unity.
5. **Agent commands + skills, LAST and confirmed.** Opinionated content committed into your repo,
   so it stays opt-in. In a terminal it asks; **not a terminal, it is SKIPPED** and prints the
   command to add it later. `--yes` installs without asking, `--no-agent-surface` skips without
   asking, and a recorded opt-out is honored silently.
6. **`doctor`**, so the run ends on evidence rather than on a claim.

It is idempotent: a second run over a wired project changes nothing and exits 0.

Exit codes: `0` wired and healthy (an OPTIONAL step that was skipped is still `0`), `1` a required
step failed, `2` usage or precondition (not a Unity project, a refused stale bridge bundle, or a
`.mcp.json` that could not be parsed or holds an entry Loombridge did not write).

## What `install-mcp` does

It registers the MCP server in the project's `.mcp.json`, the project-scoped config an MCP client
reads from the repo root:

```jsonc
{ "mcpServers": { "loombridge": { "command": "loombridge", "args": ["mcp"] } } }
```

That file belongs to your project, so the verb touches exactly one key and nothing else:

- **It MERGES.** Other servers and other top-level keys are preserved verbatim.
- **It refuses rather than overwrites.** A `loombridge` entry Loombridge did not write is yours.
  Ownership is proven by a sha recorded in `ProjectSettings/LoombridgeInstall.json` (the same
  hand-edit-safe ledger `install-agent` uses), and it covers only that one entry, so adding
  unrelated servers never trips it.
- **Malformed JSON is a refusal**, not a reason to start fresh: rewriting a file it could not
  parse would discard configuration it never read.
- Nothing is written outside the project root, and a re-run over an entry it wrote is a no-op.

Clients that do not read a project-scoped `.mcp.json` are documented, not written to: their config
lives outside your project. Register Loombridge there by hand with command `loombridge` and args
`["mcp"]`.

## What `install-bridge` does

It adds the bridge to your project's `Packages/manifest.json` as a **`file:` immutable dependency** and drops the
tarball under `Packages/tarballs/`:

```jsonc
{ "dependencies": {
    "com.loomtide.loombridge": "file:tarballs/com.loomtide.loombridge-<ver>.tgz"
} }
```

Unity resolves that read-only into `Library/PackageCache`, so the package's `Tests/` are excluded from your compile
automatically (no NUnit errors) and nobody can accidentally edit the bridge in place. It also writes
`ProjectSettings/LoombridgeInstall.json` (the record `doctor` / `update` read). This route was chosen over UPM
git-URL / scoped-registry distribution because it ships only the packaged bridge bytes (no repo clone) and
needs no consumer git credentials; see [`BridgeDistribution.md`](BridgeDistribution.md) for the fallbacks.

Air-gapped / no manifest dependency wanted? Use `loombridge install-bridge --project <p> --embedded` (physically copies
the package, `Tests/` stripped).

## Keeping it up to date

`setup` wires a new project; `update` keeps an existing one current. Re-running `setup` is safe
but it will not update the CLI, so `update` is the one to reach for after the first day.

**One command, run it twice.** From inside the Unity project (or with `--project`):

```bash
loombridge update
```

It updates two things, in this order. First the CLI itself, when a global npm install is what
is running: a local or `npx` copy, a frozen runtime, and a source checkout are each detected and
told the exact command instead, because `npm install -g` would write to a different copy than
the one executing. Second the project's bridge: a hash-checked tarball swap that backs up the
install record, prunes the old tarball, then runs `doctor`.

If the first phase actually installs a new CLI, the run STOPS and asks you to re-run. That is
deliberate: the bridge tarball ships inside the CLI, so the freshly installed binary has to be
the one that delivers it. Otherwise you would get the previous bridge with a success message.

Useful flags:

- `--check` reports what would change and installs nothing (it always exits 0; it reports, it
  does not gate).
- `--no-self-update` skips the CLI phase, for updating only a project's bridge.
- `--version <x.y.z>` pins the CLI to an exact published version.

**Dev short path** (from a checkout, no release needed) — push THIS clone's bridge into a project in two steps:

```bash
scripts/loombridge-pack-bridge.sh --out-dir /tmp/loombridge-bridge          # pack THIS checkout's bridge .tgz
loombridge update --project /path/to/UnityProject --tarball /tmp/loombridge-bridge/*.tgz
```

This packs the bridge from your working tree and runs `loombridge update --tarball` with it. After either path, focus
the Unity editor (or trigger an asset refresh) so it re-resolves the tarball — expect one domain reload while the
bridge recompiles, then `loombridge doctor --project <dir> --live` to confirm.

## Health check any time

```bash
loombridge doctor --project /path/to/UnityProject          # offline install + wiring health
loombridge doctor --project /path/to/UnityProject --live   # also connect to the running Unity bridge
loombridge doctor --project /path/to/UnityProject --ci     # JSON output for pipelines
```

Every failed row prints the exact command to fix it. Exit codes: `0` healthy · `1` problems found · `2` usage.

## Connect your agent (Claude Code / Codex)

Point your MCP client at the server the CLI ships:

- command: `loombridge`
- args: `["mcp"]`

For multiple open Unity projects and per-session routing, see the transport/endpoint-discovery notes in the
top-level `README.md` and `mcp-server/README.md`.

## Cutting a release (maintainers)

Publish a new CLI version to public GitHub Releases on this repo:

```bash
scripts/loombridge-release.sh                 # tag defaults to v<version> from mcp-server/package.json
scripts/loombridge-release.sh --dry-run       # pack only, no release (sanity check)
```

It packs `loombridge` (whose `prepack` bundles the current bridge tarball) and uploads
`loombridge-cli-<ver>.tgz` **plus** `scripts/install.sh` as release assets. Developers pick it up automatically —
`curl -fsSL https://get.loomtide.ai | sh` always resolves the latest release. (`LOOMBRIDGE_REPO=<owner/repo>`
overrides the target for both the release script and the installer.)

> **After editing `scripts/install.sh`:** redeploy it to the `get-loombridge` Vercel project so
> `get.loomtide.ai` serves the new version. The script carries no secrets — the release assets are public,
> so it fetches them without auth (using the GitHub CLI if present) — and rarely changes, since it always
> pulls "latest".

### Smoke-test the release candidate first

Point the installer at a locally built asset to exercise the **real** install path — same `npm install -g`,
same PATH check, same optional `--project` / `--with-agent` wiring — before anything is published. Needs no
auth and makes no network call, so a bad RC never reaches a published release:

```bash
(cd mcp-server && npm pack)                                    # prepack bundles the current bridge
sh scripts/install.sh --tarball mcp-server/loombridge-cli-<ver>.tgz \
   --project /path/to/ScratchUnityProject --with-agent
loombridge doctor --project /path/to/ScratchUnityProject --live  # expect: healthy
```

`LOOMBRIDGE_CLI_TARBALL=<path>` is the env-var equivalent (useful in CI). Either form takes precedence over the
release fetch. Afterwards, reinstall the published CLI with the normal
`curl -fsSL https://get.loomtide.ai | sh` so you are not left running a local build.
