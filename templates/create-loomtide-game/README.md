# create-loomtide-game (project template)

A minimal **external** Unity project skeleton pre-wired for Loomtide, so a new
build starts *inside* the plan → build → verify → doneness flow instead of
reaching only for the raw MCP bridge (finding RCL-O03, internal
dogfood ledger).

Unlike the in-repo fixtures under `unity-projects/*` (which reference the bridge
by a machine-local `file:` path), this template uses a **resolvable git-URL**
bridge dependency, so it works on any machine without a sibling Loomtide clone.

> The bridge dep pins **`#main`** (the latest merged bridge) so it resolves out of
> the box. For a **reproducible** build, repin it to a **commit SHA** or a published
> **release tag** — see `Docs/BridgeDistribution.md`. (Do not pin a version tag like
> `#v0.1.0` unless that tag has actually been pushed, or package resolution fails.)

## What's in here

```
create-loomtide-game/
├── Packages/manifest.json          # bridge via git-URL UPM dep (Option A) + base deps
├── ProjectSettings/
│   └── ProjectVersion.txt          # pins the Unity editor version (6000.3 LTS)
├── .mcp.json                       # registers the loomtide MCP server for your agent
├── .loomtide/                      # state skeleton — `loomtide plan` populates it
│   └── README.md
├── .gitignore
└── README.md                       # this file
```

`Assets/` is intentionally omitted — Unity creates it on first open.

## Use it

1. **Copy** this directory to your new project location and rename it:

   ```bash
   cp -R templates/create-loomtide-game ~/MyGame && cd ~/MyGame
   ```

2. **Pin the bridge version** in `Packages/manifest.json`. The template pins
   `#v0.1.0`; bump it to the tag/commit you want (see `Docs/BridgeDistribution.md`
   for the git-URL / scoped-registry / vendored options). `git` must be on PATH
   for the editor to resolve a git-URL dependency.

3. **Install the CLI** so the `loomtide` / `loomtide-mcp` bins are available (the
   `.mcp.json` here invokes `loomtide-mcp`). Per `Docs/GettingStarted.md`:

   ```bash
   # tarball (works today, no registry):
   #   cd <Loomtide>/mcp-server && npm ci && npm pack
   #   npm i -g ./loomtide-cli-<version>.tgz
   # or, once published to the private @loomtide org: npm i -g @loomtide/cli
   ```

   If you prefer not to install globally, switch `.mcp.json`'s server command to
   the npx form once the package is published:
   `"command": "npx", "args": ["-y", "-p", "@loomtide/cli", "loomtide-mcp"]`.

4. **Open the project in Unity** and wait for the `[UnityBridge] Published
   endpoint discovery` console log (the bridge compiled + connected).

5. **Start your agent from this folder** (cwd binding) and run the flow:

   ```bash
   loomtide plan          # scaffolds .loomtide/ contract + design target
   loomtide build         # construct via Loomtide MCP, then verify + doneness
   loomtide verify
   loomtide doneness
   ```

## Why a template, not a generator

Everything here is a committed, copyable file an external dev can read and adapt.
A `create-loomtide-game` npm generator could stamp these out with prompts later;
the files are the contract either way, and this keeps the on-ramp inspectable.
