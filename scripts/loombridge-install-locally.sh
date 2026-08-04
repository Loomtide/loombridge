#!/usr/bin/env bash
# Installs Loombridge's agent-facing surface (slash commands, skills, AUX harness binaries)
# globally for this user, backed by a FROZEN RUNTIME copied out of the dev repo. After
# install, NO loombridge-* wrapper references the dev repo — they all exec into
# ~/.loombridge/runtime. This is what lets a clean-room validation run be genuinely
# isolated: the dev repo can be relocated/made-absent and the product still works.
#
# THE CORE CLI IS NOT INSTALLED HERE. `loombridge` / `loombridge-mcp` /
# `loombridge-analyze-frames` come from the RELEASE channel:
#
#   curl -fsSL https://get.loomtide.ai | sh      # npm -g loombridge (install + update)
#
# This script must NEVER create ~/.local/bin wrappers with those names — ~/.local/bin
# precedes the npm global bin on PATH, so a wrapper would silently shadow the released
# CLI with a frozen snapshot. (To test UNRELEASED CLI changes, `npm link` from
# mcp-server/ or cut a pre-release — don't reintroduce a shadowing wrapper.)
#
# Installs:
#   ~/.loombridge/runtime/mcp-server/   frozen copy: dist + src + package.json + node_modules
#   ~/.loombridge/runtime/scripts/      frozen prepare-project-assets.sh + loombridge-embed-bridge.sh
#                                     + loombridge-checkpoint.sh + loombridge-restore.sh (stage harness)
#   ~/.loombridge/runtime/packages/     frozen Unity bridge package (source for the embed step)
#   ~/.loombridge/asset-layer/          profiles + registry + fixtures (source PNG/WAV)
#   ~/.local/bin/loombridge-*           AUX wrappers only (capture/tune/asset-prep/embed-bridge/
#                                     checkpoint/restore/handoff-check) -> the frozen runtime;
#                                     names the released loombridge provides are excluded
#   ~/.claude/commands/loombridge/      slash commands, repo paths scrubbed
#   ~/.claude/skills/<name>/          consumer skills, repo paths scrubbed
#
# This installs the global, agent-facing surface. The PER-PROJECT step — embedding the
# Unity bridge package into a consumer project's Packages/ (Tests/ excluded; RUN-1 #62) —
# is `loombridge-embed-bridge --project <unity-project>`, installed as a binary below.
#
# Requires ~/.local/bin on PATH. Verify with: echo "$PATH" | tr ':' '\n' | grep .local/bin

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not on PATH" >&2; exit 1; }

BIN_DIR="${HOME}/.local/bin"
COMMANDS_DIR="${HOME}/.claude/commands/loombridge"
SKILLS_DIR="${HOME}/.claude/skills"
DATA_DIR="${HOME}/.loombridge"
RUNTIME="$DATA_DIR/runtime"
RT_MCP="$RUNTIME/mcp-server"

echo "==> Installing Loombridge from $REPO"
mkdir -p "$BIN_DIR" "$COMMANDS_DIR" "$SKILLS_DIR" "$DATA_DIR/asset-layer/profiles" "$DATA_DIR/asset-layer/registry" "$DATA_DIR/asset-layer/fixtures" "$RT_MCP" "$RUNTIME/scripts"

# The SINGLE scrubber + the SINGLE consumer-skill list live in scripts/agent-surface-lib.mjs
# (shared with scripts/build-agent-surface.mjs — no duplicated sed, no duplicated list). The
# node scrubber generalizes/removes dev-repo absolute paths, so it is strictly more robust
# than the old $REPO-only sed (which missed committed absolute paths from a worktree).
SCRUB_LIB="$REPO/scripts/agent-surface-lib.mjs"
rewrite() {
  "$NODE_BIN" "$SCRUB_LIB" --scrub --data-dir "$DATA_DIR" --rt-mcp "$RT_MCP"
}

# Consumer-facing skills only — read from the shared module (not a duplicated bash list).
read -r -a CONSUMER_SKILLS <<< "$("$NODE_BIN" "$SCRUB_LIB" --list-skills)"

# 0a. Vendor asset-layer profiles + registry + fixtures (consumer-facing data) outside the dev repo.
echo "  -> $DATA_DIR/asset-layer/"
cp -R "$REPO/asset-layer/profiles/." "$DATA_DIR/asset-layer/profiles/"
cp -R "$REPO/asset-layer/registry/." "$DATA_DIR/asset-layer/registry/"
# fixtures/ holds the actual source PNG/WAV assets the registry entries resolve to.
# Without these, `loombridge-asset-prep` returns status=fail with an empty asset-cache.
if [ -d "$REPO/asset-layer/fixtures" ]; then
  cp -R "$REPO/asset-layer/fixtures/." "$DATA_DIR/asset-layer/fixtures/"
fi

# 0b. Build the FROZEN RUNTIME — a self-contained copy of the built product so the binaries
# never need the dev repo. dist code resolves ../../src/... at runtime (schemas, scenarios,
# plan templates), so src/ must come along; node_modules supplies the runtime deps.
echo "  -> $RT_MCP/ (frozen runtime: dist + src + node_modules + package.json)"
rm -rf "$RT_MCP/dist" "$RT_MCP/src"
cp -R "$REPO/mcp-server/dist" "$RT_MCP/dist"
cp -R "$REPO/mcp-server/src" "$RT_MCP/src"
cp "$REPO/mcp-server/package.json" "$RT_MCP/package.json"
# node_modules is large (~60M); refresh only if absent or package.json changed.
if [ ! -d "$RT_MCP/node_modules" ] || [ "$REPO/mcp-server/package.json" -nt "$RT_MCP/node_modules" ]; then
  rm -rf "$RT_MCP/node_modules"
  cp -R "$REPO/mcp-server/node_modules" "$RT_MCP/node_modules"
fi
# Make dist newer than src so prepare-project-assets.sh's stale-check never triggers a rebuild.
find "$RT_MCP/dist" -exec touch {} + 2>/dev/null || true
# Frozen asset-prep script: REPO_ROOT resolves to $RUNTIME (it has mcp-server/ alongside).
sed "s|npm run build|: # (frozen runtime — prebuilt dist, no rebuild)|g" \
  "$REPO/scripts/prepare-project-assets.sh" > "$RUNTIME/scripts/prepare-project-assets.sh"
chmod +x "$RUNTIME/scripts/prepare-project-assets.sh"

# 0c. Vendor the Unity bridge package + freeze the embed script. loombridge-embed-bridge.sh
# resolves its source as `$(dirname $0)/../packages/com.loomtide.loombridge`, so vendoring
# the package as a sibling of the frozen scripts/ lets the script run UNCHANGED against the
# frozen runtime (dev repo can be absent). The embed step itself excludes Tests/.
echo "  -> $RUNTIME/packages/com.loomtide.loombridge/ (frozen bridge source for the embed step)"
rm -rf "$RUNTIME/packages/com.loomtide.loombridge"
mkdir -p "$RUNTIME/packages"
cp -R "$REPO/packages/com.loomtide.loombridge" "$RUNTIME/packages/com.loomtide.loombridge"
cp "$REPO/scripts/loombridge-embed-bridge.sh" "$RUNTIME/scripts/loombridge-embed-bridge.sh"
chmod +x "$RUNTIME/scripts/loombridge-embed-bridge.sh"

# 0c-tarball. Pack the bridge TARBALL into the frozen runtime so the DEFAULT
# `loombridge install-bridge` route (file: immutable dependency) can resolve the
# .tgz from $RT_MCP/bridge/ without the dev repo. install-bridge's resolver
# checks `<mcp-server>/bridge/` first (bridge-install-common.ts), which is exactly
# $RT_MCP/bridge here. Also freeze the pack script for completeness.
echo "  -> $RT_MCP/bridge/ (frozen bridge tarball for 'loombridge install-bridge')"
rm -rf "$RT_MCP/bridge"; mkdir -p "$RT_MCP/bridge"
"$REPO/scripts/loombridge-pack-bridge.sh" --out-dir "$RT_MCP/bridge" >/dev/null
cp "$REPO/scripts/loombridge-pack-bridge.sh" "$RUNTIME/scripts/loombridge-pack-bridge.sh"
chmod +x "$RUNTIME/scripts/loombridge-pack-bridge.sh"

# Stage-fixture harness scripts (pure file ops; no runtime/package dependency).
for sh in loombridge-checkpoint.sh loombridge-restore.sh; do
  cp "$REPO/scripts/$sh" "$RUNTIME/scripts/$sh"
  chmod +x "$RUNTIME/scripts/$sh"
done

# 1. CLI wrappers — AUX verbs only, all pointing at the FROZEN RUNTIME, never the dev
# repo. Names the released loombridge already provides (loombridge, loombridge-mcp,
# loombridge-mcp-server, loombridge-analyze-frames, loombridge-capture-runner,
# loombridge-run-gates) are NEVER created here: ~/.local/bin precedes the npm global bin
# on PATH, so a wrapper would shadow the release install (see header). Heal machines
# where an older version of this script created the shadowing wrappers:
for stale in loombridge loombridge-mcp loombridge-mcp-server loombridge-analyze-frames loombridge-capture-runner loombridge-run-gates; do
  if [ -e "$BIN_DIR/$stale" ]; then
    echo "  -> removing stale shadowing wrapper $BIN_DIR/$stale (the CLI comes from get.loomtide.ai now)"
    rm -f "$BIN_DIR/$stale"
  fi
done

echo "  -> $BIN_DIR/loombridge-asset-prep"
cat > "$BIN_DIR/loombridge-asset-prep" <<EOF
#!/usr/bin/env bash
exec "$RUNTIME/scripts/prepare-project-assets.sh" "\$@"
EOF
chmod +x "$BIN_DIR/loombridge-asset-prep"

echo "  -> $BIN_DIR/loombridge-embed-bridge"
cat > "$BIN_DIR/loombridge-embed-bridge" <<EOF
#!/usr/bin/env bash
exec "$RUNTIME/scripts/loombridge-embed-bridge.sh" "\$@"
EOF
chmod +x "$BIN_DIR/loombridge-embed-bridge"

for verb in checkpoint restore; do
  echo "  -> $BIN_DIR/loombridge-$verb"
  cat > "$BIN_DIR/loombridge-$verb" <<EOF
#!/usr/bin/env bash
exec "$RUNTIME/scripts/loombridge-$verb.sh" "\$@"
EOF
  chmod +x "$BIN_DIR/loombridge-$verb"
done

# Additional internal dist wrappers (capture, handoff check, tuning) so agent-facing
# command/skill content never has to spell out a node path. analyze-frames is NOT here —
# the released loombridge ships a `loombridge-analyze-frames` bin (see the exclusion list
# above); only names the release does not provide may be wrapped.
for wname in capture-runner:capture handoff-consistency:handoff-check tuning-runner:tune; do
  src_basename="${wname%%:*}"
  bin_name="loombridge-${wname##*:}"
  [ "$src_basename" = "handoff-consistency" ] && src_subdir="asset-layer" || src_subdir="verification"
  echo "  -> $BIN_DIR/$bin_name"
  cat > "$BIN_DIR/$bin_name" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$RT_MCP/dist/$src_subdir/$src_basename.js" "\$@"
EOF
  chmod +x "$BIN_DIR/$bin_name"
done

# 2. Slash commands
echo "  -> $COMMANDS_DIR/"
rm -f "$COMMANDS_DIR"/*.md
for f in "$REPO/commands/loombridge"/*.md; do
  base="$(basename "$f")"
  rewrite < "$f" > "$COMMANDS_DIR/$base"
  echo "       + $base"
done

# 3. Skills
echo "  -> $SKILLS_DIR/"
# Remove any prior install of skills no longer in the consumer set
rm -rf "$SKILLS_DIR/new-unity-test-project"
for name in "${CONSUMER_SKILLS[@]}"; do
  skill_dir="$REPO/.skills/$name"
  [ -d "$skill_dir" ] || { echo "       ! missing $skill_dir, skipping" >&2; continue; }
  rm -rf "$SKILLS_DIR/$name"
  cp -R "$skill_dir/" "$SKILLS_DIR/$name"
  # Resolve any symlinks within the copied skill (cp -R follows them on macOS).
  # Rewrite repo-relative paths in every .md inside the copied skill.
  while IFS= read -r md; do
    tmp="$(mktemp)"
    rewrite < "$md" > "$tmp"
    mv "$tmp" "$md"
  done < <(find "$SKILLS_DIR/$name" -type f -name "*.md")
  echo "       + $name"
done

echo ""
# The core CLI is delivered by the release channel, not this script — confirm it's there
# and not shadowed (a ~/.local/bin `loombridge` here would mean an old shadowing wrapper).
cli_path="$(command -v loombridge || true)"
if [ -z "$cli_path" ]; then
  echo "==> NOTE: no \`loombridge\` on PATH. Install the CLI via the release channel:"
  echo "    curl -fsSL https://get.loomtide.ai | sh"
elif [ "$cli_path" = "$BIN_DIR/loombridge" ]; then
  echo "==> WARNING: $BIN_DIR/loombridge shadows the released CLI — remove it and reinstall:"
  echo "    rm $BIN_DIR/loombridge && curl -fsSL https://get.loomtide.ai | sh"
else
  echo "==> CLI: $cli_path ($(loombridge --version 2>/dev/null || echo 'version unavailable'))"
fi
echo ""
echo "==> Done. Verify with:"
echo "    which loombridge                # expect the npm global bin (e.g. /opt/homebrew/bin/loombridge), NOT $BIN_DIR"
echo "    loombridge --help"
echo "    ls $COMMANDS_DIR"
echo "    ls $SKILLS_DIR | grep -E '(verify-2d-game|unity-2d-game|asset-layer|game-polish-2d|parallax-2d|platformer-level-design)'"
echo ""
echo "==> Per-project step (for each consumer Unity project):"
echo "    loombridge-embed-bridge --project <unity-project-dir>"
echo "    # Embeds the bridge into the project's Packages/ (Tests/ excluded; RUN-1 #62),"
echo "    # then open the project in Unity so the MCP bridge compiles + connects."
echo ""
echo "==> Stage-fixture harness (iterate ONE phase instead of rebuilding ~1.5-2h):"
echo "    loombridge-checkpoint --project <dir> --stage <construct|level|polish|verify> [--scene <relpath>]"
echo "    loombridge-restore    --project <dir> --stage <name>      # resume from a checkpoint (Unity closed)"
echo "    loombridge verify --stage <name>                          # grade only that stage's gates (diagnostic)"
