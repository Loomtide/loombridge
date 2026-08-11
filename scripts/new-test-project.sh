#!/usr/bin/env bash
#
# new-test-project.sh — scaffold a throwaway Unity project wired to the Loombridge bridge,
# so a fresh agent can build/verify a demo from scratch quickly.
#
# Usage:
#   scripts/new-test-project.sh [name] [--force] [--brief=PATH] [--output=PATH]
#     name         project folder under unity-dev-project/ (default: platformer-clean)
#     --force      delete and recreate if it already exists
#     --brief=PATH build brief to copy in as BUILD-BRIEF.md (no default shipped in this repo;
#                  relative paths resolve from repo root — omit to skip the brief copy)
#     --output=PATH absolute or relative Unity project folder. Use this for true clean-room
#                  runs outside the Loombridge repo so parent repo state/memory is not inherited.
#
# Produces unity-dev-project/<name>/ with:
#   - Packages/manifest.json   bridge (relative file: ref) + the known-good dependency set
#   - ProjectSettings/         copied from demo-platformer (Input System enabled, 2D, built-in RP)
#   - Assets/.gitkeep          empty assets
#   - BUILD-BRIEF.md           the PRD to hand the building agent
#
# Generated dirs (Library/Temp/obj/Logs/UserSettings) are already covered by the repo .gitignore.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/demos/unity-platformer"
BRIEF=""

NAME="platformer-clean"
OUTPUT=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --brief=*) BRIEF="${arg#--brief=}"; case "$BRIEF" in /*) ;; *) BRIEF="$REPO_ROOT/$BRIEF" ;; esac ;;
    --output=*) OUTPUT="${arg#--output=}"; case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/$OUTPUT" ;; esac ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) NAME="$arg" ;;
  esac
done

if [ -n "$OUTPUT" ]; then
  PROJ="$OUTPUT"
else
  PROJ="$REPO_ROOT/unity-dev-project/$NAME"
fi

if [ ! -d "$TEMPLATE/ProjectSettings" ]; then
  echo "ERROR: template ProjectSettings not found at $TEMPLATE/ProjectSettings" >&2
  exit 1
fi

if [ -d "$PROJ" ]; then
  if [ "$FORCE" = "1" ]; then
    echo "Removing existing $PROJ ..."
    rm -rf "$PROJ"
  else
    echo "ERROR: $PROJ already exists. Re-run with --force to recreate it." >&2
    exit 1
  fi
fi

echo "Scaffolding $PROJ ..."
mkdir -p "$PROJ/Assets" "$PROJ/Packages" "$PROJ/ProjectSettings"
: > "$PROJ/Assets/.gitkeep"

# Package set proven on demo-platformer. Projects under repo/unity-projects use a relative file:
# ref; external clean-room projects use an absolute file: ref so they cannot inherit parent repo
# instructions just to resolve the bridge package.
case "$PROJ" in
  "$REPO_ROOT"/unity-dev-project/*) BRIDGE_PACKAGE_REF="file:../../../packages/com.loomtide.loombridge" ;;
  *) BRIDGE_PACKAGE_REF="file:$REPO_ROOT/packages/com.loomtide.loombridge" ;;
esac
cat > "$PROJ/Packages/manifest.json" <<JSON
{
  "dependencies": {
    "com.loomtide.loombridge": "$BRIDGE_PACKAGE_REF",
    "com.unity.2d.pixel-perfect": "5.0.3",
    "com.unity.2d.sprite": "1.0.0",
    "com.unity.inputsystem": "1.7.0",
    "com.unity.ugui": "2.0.0",
    "com.unity.modules.animation": "1.0.0",
    "com.unity.modules.audio": "1.0.0",
    "com.unity.modules.physics2d": "1.0.0"
  }
}
JSON

# Known-good editor config (Active Input Handling = Input System, 2D physics, built-in RP,
# and the matching ProjectVersion.txt). Skip EditorBuildSettings so the new project starts with
# an empty scene list rather than a dangling reference to the demo scene.
cp -R "$TEMPLATE/ProjectSettings/." "$PROJ/ProjectSettings/"
rm -f "$PROJ/ProjectSettings/EditorBuildSettings.asset"

# Pin identical package resolution when the lock is available (faster, deterministic).
if [ -f "$TEMPLATE/Packages/packages-lock.json" ]; then
  cp "$TEMPLATE/Packages/packages-lock.json" "$PROJ/Packages/packages-lock.json"
fi

# Stage the Press Start 2P TTF (OFL) only for briefs that may legitimately use a
# pixel HUD face. Non-platformer proof briefs explicitly ban copying that exact
# style, so don't put the tempting asset in the project.
STAGE_PRESSSTART=1
if [ -f "$BRIEF" ] && grep -qi "Do not copy .*HUD font\\|Do not copy .*arcade HUD fonts" "$BRIEF"; then
  STAGE_PRESSSTART=0
fi
if [ "$STAGE_PRESSSTART" = "1" ] && [ -d "$TEMPLATE/Assets/Fonts" ]; then
  mkdir -p "$PROJ/Assets/Fonts"
  for f in "PressStart2P-Regular.ttf" "PressStart2P-Regular.ttf.meta" "OFL.txt" "OFL.txt.meta"; do
    [ -f "$TEMPLATE/Assets/Fonts/$f" ] && cp "$TEMPLATE/Assets/Fonts/$f" "$PROJ/Assets/Fonts/$f"
  done
elif [ "$STAGE_PRESSSTART" = "0" ]; then
  echo "Skipping Press Start 2P staging: build brief bans platformer HUD font reuse."
fi

# Per-project MCP config: devs start Claude Code FROM the project folder, so put the bridge
# server here (not just at the repo root) with ABSOLUTE paths -> independent of launch cwd and
# PATH. This project is git-ignored, so machine-specific paths are fine. settings.local.json
# pre-approves it (no /mcp prompt; the one-time folder-trust prompt still appears on first open).
NODE_BIN="$(command -v node || true)"
SERVER_JS="$REPO_ROOT/mcp-server/dist/surfaces/index.js"
[ -z "$NODE_BIN" ] && echo "WARN: 'node' not on PATH; edit $PROJ/.mcp.json command by hand." >&2
[ -f "$SERVER_JS" ] || echo "WARN: $SERVER_JS missing — run: (cd mcp-server && npm install && npm run build)" >&2

cat > "$PROJ/.mcp.json" <<EOF
{
  "mcpServers": {
    "loombridge": {
      "type": "stdio",
      "command": "${NODE_BIN:-node}",
      "args": ["$SERVER_JS"]
    }
  }
}
EOF

mkdir -p "$PROJ/.claude"
cat > "$PROJ/.claude/settings.local.json" <<'JSON'
{
  "enabledMcpjsonServers": ["loombridge"]
}
JSON

cat > "$PROJ/AGENTS.md" <<EOF
# Clean-Room Loombridge Build

This folder is a clean Unity project for a recorded Loombridge build.

Source of truth, in order:
1. \`BUILD-BRIEF.md\`
2. \`LOOMBRIDGE-ASSETS.md\`
3. The local linked skills under \`.claude/skills\` / \`.codex/skills\`

Do not read or use parent-repo planning/roadmap state, old run logs, archived
summaries, or prior-run memory. Do not claim this project has prior green runs. Build from this
project's brief and the linked reusable skills only.

Repo files may be consulted only when explicitly named by the brief or a skill (for example the mock,
acceptance contract, registry/profile, or MCP server path).
EOF

cp "$PROJ/AGENTS.md" "$PROJ/CLAUDE.md"

# Link the build skills into the project so relevant local skills are available when the session is
# started FROM this folder. Claude Code loads <cwd>/.claude/skills; Codex loads <cwd>/.codex/skills
# in local project workflows, so stage both to keep the comparison arms honest.
mkdir -p "$PROJ/.claude/skills" "$PROJ/.codex/skills"
SKILLS=(asset-layer unity-2d-game game-polish-2d verify-2d-game)
if [ ! -f "$BRIEF" ] || ! grep -qi "Do not build a platformer" "$BRIEF"; then
  SKILLS+=(platformer-level-design parallax-2d)
else
  echo "Skipping platformer/parallax skill links: build brief declares a non-platformer proof."
fi
for s in "${SKILLS[@]}"; do
  if [ -d "$REPO_ROOT/.skills/$s" ]; then
    ln -sfn "$REPO_ROOT/.skills/$s" "$PROJ/.claude/skills/$s"
    ln -sfn "$REPO_ROOT/.skills/$s" "$PROJ/.codex/skills/$s"
  fi
done

cat > "$PROJ/LOOMBRIDGE-ASSETS.md" <<EOF
# Loombridge Asset Registry Quickstart

This project was scaffolded by Loombridge. Before final art/audio, prepare curated registry assets and
use them as the default source for polished roles.

For the Switchyard/top-down proof:

\`\`\`bash
$REPO_ROOT/scripts/prepare-project-assets.sh \\
  --project="\$PWD" \\
  --profile=asset-layer/profiles/2d-topdown-arena.json \\
  --registry=asset-layer/registry/switchyard-2d.json \\
  --name=switchyard
\`\`\`

Then read \`.loombridge/run/handoff/switchyard-asset-prepare-report.json\`. Import each accepted sprite using
its \`import.toolArguments.source_path\` and \`import.toolArguments.path\`; copy/import accepted WAV
assets to their reported Unity paths and wire them to gameplay. Preserve
\`.loombridge/run/handoff/switchyard-asset-attribution.md\` in the final handoff.

Do not ship procedural placeholders when the report contains accepted \`placeholder:false\` candidates
for the same primitive.
EOF

# Hand the building agent the spec.
if [ -f "$BRIEF" ]; then
  cp "$BRIEF" "$PROJ/BUILD-BRIEF.md"
else
  echo "WARN: build brief not found at $BRIEF (skipping copy)." >&2
fi

cat <<EOF

Done -> $PROJ  (carries its own .mcp.json -> loombridge bridge, absolute paths)

Next steps:
  1. Open the project through the autonomous launcher:
       $REPO_ROOT/scripts/unity/open-project.sh $PROJ
     Import "TMP Essentials" when prompted if Unity asks. Keep ONLY this editor open unless a command pins
     LOOMBRIDGE_UNITY_PROJECT or LOOMBRIDGE_TARGET_PROJECT_PATH.
  2. Optional preflight from repo root:
       $REPO_ROOT/scripts/check-agent-surface.sh $PROJ
  3. Start the build session FROM the project folder.

     Claude Code:
       cd $PROJ && claude
     Accept the one-time "trust this folder" prompt; loombridge is pre-approved and auto-loads.

     Codex:
       cd $PROJ && codex
     Run /mcp. If loombridge is not listed, register it with:
       codex mcp add loombridge -- ${NODE_BIN:-node} $SERVER_JS

  4. Verify the bridge. MCP tools are deferred and carry the server-name prefix, so load with the
     FULL name (not the bare op):
       ToolSearch "select:mcp__loombridge__unity_editor_get_state"
     then call mcp__loombridge__unity_editor_get_state — it should return live editor state
     (play_mode, error_count, ...). If it times out, the Unity editor isn't open on THIS project
     (or another editor grabbed the bridge — keep only this one open). Then hand it:
       @BUILD-BRIEF.md
     The agent builds with the linked local skills appropriate for this brief, then self-checks
     with /verify-2d-game until build-verdict.json is green.
     For Loombridge runs, also hand it:
       @LOOMBRIDGE-ASSETS.md
EOF
