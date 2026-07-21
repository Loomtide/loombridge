# Install Loomtide on a new machine

The simplest end-to-end setup. There are two tracks — pick one:

- **Track A — Partner install** (one command; installs **and** updates). The recommended path.
- **Track B — From source** (works from a clone of this monorepo — the contributor/maintainer path).

Both end at the same place: a `loomtide` command on your PATH and the Unity bridge installed into your project as a
versioned tarball dependency, verified by `loomtide doctor`.

## Requirements (both tracks)

- Node.js `>= 18`
- Unity `6000.3 LTS` (primary) or `2022.3 LTS` (compatibility)
- `~/.local/bin` on your `PATH` (Track B installs auxiliary harness wrappers there — the core `loomtide`
  bin itself comes from the one-command installer or `npm link`, never `~/.local/bin`):
  ```bash
  echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin" || echo 'add ~/.local/bin to your PATH'
  ```

---

## Track A — Partner install (one command)

Loomtide ships to partners through **GitHub Releases** on a dedicated **release distribution channel** —
release assets only, no source; partners never need access to this monorepo. No npm account, no registry
config. You already have a GitHub account, so authenticate once and then install (and later update) with a
single command.

> **Maintainers — granting a partner access** (read on the distribution repo is all they need):
> `gh api -X PUT repos/Loomtide/loombridge/collaborators/<github-username> -f permission=pull`

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

The Windows bootstrap is **PowerShell-native and does not require Git Bash** — the Loomtide CLI runs on Node
and works in any shell, so the bootstrap only needs Node.js + GitHub CLI (installed via `winget`). Pass a
Unity project to wire it in the same shot: append `-Project C:\path\to\UnityProject` (PowerShell, or set
`$env:LOOMTIDE_PROJECT` before the `irm | iex`) / `-s -- --project /path/to/UnityProject` (the `curl … | sh`
form). The steps below are the **"I already have Node + gh"** path (or what the bootstrap runs for you).

```bash
# 0. One-time: authenticate GitHub so the private release is downloadable
gh auth login                     # GitHub CLI — https://cli.github.com
#   (CI / no gh CLI? export LOOMTIDE_TOKEN=<fine-grained token, contents-read on the release distribution channel> instead)

# 1. Install the CLI — this same command UPDATES it later, just re-run it
curl -fsSL https://get.loomtide.ai | sh

# 2. Install the Unity bridge into YOUR Unity project (no repo clone, no git needed)
loomtide install-bridge --project /path/to/UnityProject

# 3. Open that project in Unity, wait for it to finish compiling, then:
loomtide doctor --project /path/to/UnityProject
```

`doctor` should print `healthy`. That's it.

**One command for a fresh machine.** Pass a project and the installer also wires the bridge in one shot
(re-run any time to update both the CLI and the bridge):

```bash
curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject
```

**Pin a version** for reproducible/CI setups: `LOOMTIDE_VERSION=v0.2.0 curl -fsSL https://get.loomtide.ai | sh`.

> **On Windows:** the recommended path is the PowerShell bootstrap `irm https://get.loomtide.ai/win | iex`
> (above) — it needs **no Git Bash / WSL**. If you already have Node + gh and prefer the raw `curl … | sh`
> installer, run *that* line in **Git Bash** (bundled with Git for Windows) or WSL — it is a POSIX shell script
> and won't run in cmd.exe/PowerShell. Either way, after install the `loomtide` command works in any
> Windows shell (npm installs a `loomtide.cmd` shim), and `install-bridge`/`doctor`/`update` are cross-platform.
> The default transport is **auto** (IPC first, TCP-loopback fallback). On **Windows** IPC is a named pipe and is
> used by default. On **macOS/Linux** Unity's Mono editor runtime doesn't expose the unix-domain-socket API, so the
> bridge always runs on TCP loopback there — IPC is Windows-only in practice today. `LOOMTIDE_UNITY_TRANSPORT_MODE=tcp`
> forces TCP (e.g. if a local security agent blocks the pipe on Windows); `=ipc` forces IPC and fails fast where no
> IPC endpoint exists (all macOS/Linux editors). `doctor --live` prints the transport it actually used, so a fallback
> is never silent. Committing the agent surface for a mixed-OS team? `install-agent`
> drops a scoped `.gitattributes` (LF-pinned) so `core.autocrlf` can't desync the ledger.

> **After `install-bridge`, focus the Unity editor.** Unity only re-resolves `Packages/manifest.json` when it
> regains focus, so a project left in the background will not import the bridge and `doctor --live` will report
> it unreachable. Expect one recompile (and, on Unity 6.3, an advisory "Missing Signature" dialog — safe to close).

### Optional: agent commands + skills

The bridge is all you need. If you also want Loomtide's agent surface — the `/loomtide:*` slash
commands and the game-build/verify skills — **installed into your project repo** (so they're committed and
your teammates get them on the next `git pull`), opt in:

```bash
loomtide install-agent --project /path/to/UnityProject
```

This writes real files under `.claude/commands/loomtide/`, `.claude/skills/`, and `.codex/skills/` (never
into your `~/.claude` or `~/.codex`). The one-command installer can do it in the same shot with `--with-agent`:

```bash
curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject --with-agent
```

- **To skip it: do nothing.** Skipping is the default — `install-bridge`/`update` print one optional hint and
  never nag.
- **To opt out (and be remembered):** `loomtide install-agent --project /path/to/UnityProject --remove`.
  It deletes the managed files (any you hand-edited are left in place) and records the choice, so later
  `update`s stay silent. Re-run `install-agent` to re-enable.

The choice lives in the committed `ProjectSettings/LoomtideInstall.json`, so it is **team-wide + versioned**:
one dev decides and everyone's `loomtide update` behaves identically after a pull.

> A published npm package (`npm install -g @loomtide/cli`) is the eventual public-launch channel; while the
> repo is private, the GitHub Releases command above is the supported path.

---

## Track B — From source (contributors/maintainers)

Even from a clone, the **CLI on your PATH should come from the release channel** (Track A's one-liner) — it's
the same build partners run. Track B adds the two source-only pieces on top: a linked dev bin for testing
unreleased CLI changes, and the agent surface (slash commands, skills, aux harness wrappers).

```bash
# 1. Clone + build
git clone https://github.com/Loomtide/loombridge.git
cd Loomtide/mcp-server
npm ci
npm run build

# 2a. CLI for everyday use — same as Track A (release build, updates with the same command):
curl -fsSL https://get.loomtide.ai | sh

# 2b. OR, to run your UNRELEASED CLI changes: link the dev bin (follows every `npm run build`):
npm link                    # `loomtide --version` will show your local commit (+dirty)

# 3. Agent surface (slash commands, skills, aux harness wrappers -> ~/.local/bin/loomtide-*):
cd ..
./scripts/loomtide-install-locally.sh

# 4. Install the Unity bridge into YOUR Unity project + verify (same as Track A):
loomtide install-bridge --project /path/to/UnityProject
loomtide doctor --project /path/to/UnityProject
```

Notes for Track B:

- `loomtide-install-locally.sh` deliberately does **not** install a `loomtide` bin — a `~/.local/bin`
  wrapper would shadow the released CLI on PATH. It even removes such wrappers left by older versions.
- With `npm link`, `npm run build` is all a rebuild takes; `loomtide --version` tells you which build
  (release commit vs your local `+dirty`) you're actually running.
- To push your checkout's **bridge** into a consumer project without a release, see the dev short path
  under [Keeping it up to date](#keeping-it-up-to-date).

---

## What `install-bridge` does

It adds the bridge to your project's `Packages/manifest.json` as a **`file:` immutable dependency** and drops the
tarball under `Packages/tarballs/`:

```jsonc
{ "dependencies": {
    "com.loomtide.unitybridge": "file:tarballs/com.loomtide.unitybridge-<ver>.tgz"
} }
```

Unity resolves that read-only into `Library/PackageCache`, so the package's `Tests/` are excluded from your compile
automatically (no NUnit errors) and nobody can accidentally edit the bridge in place. It also writes
`ProjectSettings/LoomtideInstall.json` (the record `doctor` / `update` read). This route was chosen over UPM
git-URL / scoped-registry distribution because it keeps a private monorepo private (only packaged bytes ship)
and needs no consumer git credentials; see [`BridgeDistribution.md`](BridgeDistribution.md) for the fallbacks.

Air-gapped / no manifest dependency wanted? Use `loomtide install-bridge --project <p> --embedded` (physically copies
the package, `Tests/` stripped).

## Keeping it up to date

**Release path** (partners and everyday use) — two commands, always in this order:

```bash
curl -fsSL https://get.loomtide.ai | sh              # 1. update the CLI (pulls the latest release)
loomtide update --project /path/to/UnityProject      # 2. swap the project's bridge to the CLI-bundled one
```

`loomtide update` swaps in the bridge tarball bundled with your current CLI (backs up the install record, prunes the
old tarball), then runs `doctor`. It never self-updates the CLI (self-running an install is unreliable across
nvm/volta/asdf) — that's what the first command is for.

**Dev short path** (from a checkout, no release needed) — push THIS clone's bridge into a project in one command:

```bash
scripts/loomtide-dev-update.sh --project /path/to/UnityProject            # add --dry-run to preview
```

It packs the bridge from your working tree and runs `loomtide update --tarball` with it. After either path, focus
the Unity editor (or trigger an asset refresh) so it re-resolves the tarball — expect one domain reload while the
bridge recompiles, then `loomtide doctor --project <dir> --live` to confirm.

## Health check any time

```bash
loomtide doctor --project /path/to/UnityProject          # offline install + wiring health
loomtide doctor --project /path/to/UnityProject --live   # also connect to the running Unity bridge
loomtide doctor --project /path/to/UnityProject --ci     # JSON output for pipelines
```

Every failed row prints the exact command to fix it. Exit codes: `0` healthy · `1` problems found · `2` usage.

## Connect your agent (Claude Code / Codex)

Point your MCP client at the server the CLI ships:

- command: `loomtide`
- args: `["mcp"]`

For multiple open Unity projects and per-session routing, see [`GettingStarted.md`](GettingStarted.md).

## Cutting a release (maintainers)

Publish a new CLI version to GitHub Releases for the CLI (release assets only; partners get read there,
never on this monorepo):

```bash
scripts/loomtide-release.sh                 # tag defaults to v<version> from mcp-server/package.json
scripts/loomtide-release.sh --dry-run       # pack only, no release (sanity check)
```

It packs `@loomtide/cli` (whose `prepack` bundles the current bridge tarball) and uploads
`loomtide-cli-<ver>.tgz` **plus** `scripts/install.sh` as release assets. Developers pick it up automatically —
`curl -fsSL https://get.loomtide.ai | sh` always resolves the latest release. (`LOOMTIDE_REPO=<owner/repo>`
overrides the target for both the release script and the installer.)

> **After editing `scripts/install.sh`:** redeploy it to the `get-loomtide` Vercel project so
> `get.loomtide.ai` serves the new version. The script carries no secrets — it uses each developer's own
> GitHub auth to fetch the private release asset — and rarely changes, since it always pulls "latest".

### Smoke-test the release candidate first

Point the installer at a locally built asset to exercise the **real** install path — same `npm install -g`,
same PATH check, same optional `--project` / `--with-agent` wiring — before anything is published. Needs no
auth and makes no network call, so a bad RC never reaches the release distribution channel:

```bash
(cd mcp-server && npm pack)                                    # prepack bundles the current bridge
sh scripts/install.sh --tarball mcp-server/loomtide-cli-<ver>.tgz \
   --project /path/to/ScratchUnityProject --with-agent
loomtide doctor --project /path/to/ScratchUnityProject --live  # expect: healthy
```

`LOOMTIDE_CLI_TARBALL=<path>` is the env-var equivalent (useful in CI). Either form takes precedence over the
release fetch. Afterwards, reinstall the published CLI with the normal
`curl -fsSL https://get.loomtide.ai | sh` so you are not left running a local build.
