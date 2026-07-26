---
name: new-unity-test-project
description: Scaffold a throwaway Unity project wired to the Loombridge bridge for clean-room MCP testing. Use when you need a fresh Unity project to build or verify a demo (e.g. the 2D platformer) from scratch, rather than reusing demo-platformer.
---

# New Unity Test Project (Loombridge)

Spin up a disposable Unity project that is already wired to the Loombridge bridge, so a fresh agent can
build and verify a demo from scratch fast. The project lives under `unity-dev-project/<name>/`; its
generated dirs are git-ignored, so it's safe to delete and recreate anytime.

## Scaffold it

```bash
scripts/new-test-project.sh [name] [--force]
# default name: platformer-clean ; --force recreates an existing one
```

This writes `unity-dev-project/<name>/` with:
- `Packages/manifest.json` — the bridge (relative `file:` ref) + the proven dependency set
  (`2d.pixel-perfect`, `2d.sprite`, `inputsystem`, `ugui`, `modules.animation`, `modules.audio`, `modules.physics2d`;
  the bridge pulls `newtonsoft-json` transitively).
- `ProjectSettings/` — copied from `demo-platformer` (Active Input Handling already = Input System,
  2D physics, built-in render pipeline, matching `ProjectVersion.txt`), minus `EditorBuildSettings`.
- `.mcp.json` — the `loombridge` bridge server with **absolute** node + script paths, so a session
  started from this folder finds it regardless of cwd/PATH.
- `.claude/settings.local.json` — pre-approves `loombridge` (`enabledMcpjsonServers`).
- `.claude/skills/*` and `.codex/skills/*` — symlinks for `asset-layer`, `unity-2d-game`,
  `game-polish-2d`, and `verify-2d-game`; platformer-only skills are linked only for platformer briefs.
- `LOOMBRIDGE-ASSETS.md` — the project-local asset-registry quickstart for Loombridge proof runs.
- `Assets/.gitkeep` and a copy of the build brief as `BUILD-BRIEF.md`.

## Manual steps (one-time per project — agents can't do these)
1. **Unity Hub → Add → Add project from disk →** the new folder, open with **Unity 6000.3 LTS**.
2. Let packages resolve; **import "TMP Essentials"** when prompted (HUD uses TextMeshPro).
3. Keep **only one Unity editor open** — the bridge auto-starts (`[InitializeOnLoad]`) and the MCP
   server attaches by port discovery (8200–8210); multiple editors make it ambiguous.

## The building session must SEE the MCP tools (start it FROM the project folder)
Devs start agents in the folder they're working in, so the scaffolder writes a **`.mcp.json` into
the project itself** pointing at this repo's mcp-server with **absolute paths**. Claude and Codex
load this differently:

### Claude Code

- `cd unity-dev-project/<name> && claude` — start the session from the project folder.
- Accept the one-time **"trust this folder"** prompt. `loombridge` auto-loads through the project
  `.mcp.json` plus `.claude/settings.local.json`.

### Codex

- `cd unity-dev-project/<name> && codex` — start the session from the project folder.
- Run `/mcp`. If `loombridge` is not listed, register the same server explicitly:

  ```bash
  codex mcp add loombridge -- node <loombridge-repo>/mcp-server/dist/surfaces/index.js
  ```

  Use the `node` path and `dist/surfaces/index.js` path from this project's `.mcp.json` if they differ.

### Verify before building

Load the deferred tool with the full server-prefixed name:

```text
ToolSearch "select:mcp__loombridge__unity_editor_get_state"
```

Then call `mcp__loombridge__unity_editor_get_state`. It should return `play_mode`, `error_count`, and
other live editor state. If it times out, the Unity editor is not open on this project, another editor
grabbed the bridge, or the MCP server is not loaded.

**Build the server once first:** `cd mcp-server && npm install && npm run build`. (The repo-root
`.mcp.json` uses a *relative* path and only works if you instead launch from the repo root — the
in-project `.mcp.json` is what makes the project-folder workflow reliable.)

### Input readiness is mandatory

The scaffold is intentionally Input-System-first because Loombridge's input-driven capture cannot drive
legacy `UnityEngine.Input` polling. Before building a fixture or demo, verify:

- `Packages/manifest.json` contains `com.unity.inputsystem`.
- `ProjectSettings/ProjectSettings.asset` has Active Input Handling = Input System or Both.
- Authored gameplay scripts use `InputAction`, `PlayerInput`, `Keyboard.current`, `Mouse.current`, or a
  wrapper built on those APIs.
- Authored gameplay scripts do **not** use `UnityEngine.Input.GetAxis*`, `GetButton*`, `GetKey*`, or
  `GetMouseButton*`.

If a new agent introduces legacy input, stop and migrate it before verification. A legacy-only project
will be refused as `LEGACY_INPUT_UNSUPPORTED`, not measured as zero motion.

## Then build
Hand a fresh agent the spec: `@unity-dev-project/<name>/BUILD-BRIEF.md` (a copy of the canonical
platformer build brief). It contains the design, tuned values, the bug fixes to
reproduce, the asset-registry pipeline, and the verification gates.

For Loombridge proof runs, also hand the agent `@unity-dev-project/<name>/LOOMBRIDGE-ASSETS.md`. A final
visual build should use accepted non-placeholder registry assets when the prepare report contains them.

## Gotchas (carried from real sessions)
- **Recompile dance:** after a script change, `unity_editor_refresh_assets` → `wait_for {compiling:false}`
  → `wait_for {delayMs:3000}` to settle (the compiling flag can read false in the gap before compilation
  starts). Check `unity_editor_console_logs` for errors.
- **Sim freezes when the editor is backgrounded** — use `unity_runtime_measure_motion` /
  `unity_runtime_probe` for motion (they force `runInBackground` + pin `captureDeltaTime`); don't drive
  input across separate calls and "wait".
- **New MCP tools/params need an MCP server restart** to register — ask the user.
- **Preflight the agent surface:** from the repo root, run
  `scripts/check-agent-surface.sh unity-dev-project/<name>` before starting a fresh agent. It catches
  missing `.claude`/`.codex` skill links, missing MCP server build output, and malformed skill
  frontmatter.

## Make it independent later
The bridge `file:` ref is relative (works only under `unity-dev-project/`). To use the project standalone
elsewhere, switch the ref to an absolute `file:` path or a UPM git URL
(`https://github.com/<org>/Loombridge.git?path=packages/com.loomtide.loombridge`), and carry the build
brief + the `.skills/` (or make them global) since they live in this repo.
