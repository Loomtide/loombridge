#!/usr/bin/env bash
#
# new-raw-project.sh — scaffold a NO-LOOMBRIDGE Unity project for the A/B value
# experiment: a "raw" Claude Code session gets the SAME design brief + the SAME
# an identical Unity starting project, but NO Loombridge bridge, NO MCP
# server, NO skills. It is the honest "vanilla Claude Code given the spec"
# counterfactual — the agent can edit files but cannot see, drive, or verify Unity.
#
# Created OUTSIDE the repo by default so the session gets an empty memory namespace
# (no run-learnings priming) and physically cannot read demo-platformer / the skills
# / the acceptance contract. For Switchyard, the raw arm also does not get the curated
# Loombridge registry files; it must source, draw, or generate assets itself from the brief.
#
# Usage:
#   scripts/new-raw-project.sh [name] [--dest=PATH] [--force] [--brief=PATH] [--no-assets]
#     name         project folder name (default: tiderunner-raw)
#     --dest=PATH  where to create it (default: $HOME/loombridge-raw-experiment/<name>)
#     --force      delete and recreate if it already exists
#     --brief=PATH design brief to copy in as BUILD-BRIEF.md
#                  (no default shipped in this repo; relative paths resolve from repo root — omit
#                  to skip the brief copy)
#     --mock=PATH  design mock project dir to stage into _Design/mock
#                  (no default shipped in this repo; relative paths resolve from repo root — omit
#                  to skip the mock copy)
#     --no-assets  do not stage art/font/mock assets; raw agent must source/draw/generate
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/demos/unity-platformer"
ART_SRC="$REPO_ROOT/asset-layer/incoming/Free"
MOCK_SRC=""
BRIEF=""

NAME="tiderunner-raw"
DEST=""
FORCE=0
STAGE_ASSETS=1
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-assets) STAGE_ASSETS=0 ;;
    --dest=*) DEST="${arg#--dest=}" ;;
    --brief=*) BRIEF="${arg#--brief=}"; case "$BRIEF" in /*) ;; *) BRIEF="$REPO_ROOT/$BRIEF" ;; esac ;;
    --mock=*) MOCK_SRC="${arg#--mock=}"; case "$MOCK_SRC" in /*) ;; *) MOCK_SRC="$REPO_ROOT/$MOCK_SRC" ;; esac ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) NAME="$arg" ;;
  esac
done

PROJ="${DEST:-$HOME/loombridge-raw-experiment/$NAME}"

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

echo "Scaffolding RAW (no-Loombridge) project -> $PROJ ..."
mkdir -p "$PROJ/Assets" "$PROJ/Packages" "$PROJ/ProjectSettings" "$PROJ/_Design"
: > "$PROJ/Assets/.gitkeep"

# Identical standard 2D package set to the Loombridge arm, MINUS com.loomtide.loombridge.
cat > "$PROJ/Packages/manifest.json" <<'JSON'
{
  "dependencies": {
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

# Same editor config as the Loombridge arm (Input System, 2D physics, built-in RP, ProjectVersion).
# Skip EditorBuildSettings (empty scene list) and packages-lock (it pins the loombridge file: dep).
cp -R "$TEMPLATE/ProjectSettings/." "$PROJ/ProjectSettings/"
rm -f "$PROJ/ProjectSettings/EditorBuildSettings.asset"
if [ -f "$PROJ/ProjectSettings/ProjectSettings.asset" ]; then
  perl -0pi -e "s/productName: demo-platformer/productName: $NAME/g; s/metroPackageName: demo-platformer/metroPackageName: $NAME/g; s/metroApplicationDescription: demo-platformer/metroApplicationDescription: $NAME/g" "$PROJ/ProjectSettings/ProjectSettings.asset"
fi

# Same provided font input as the Loombridge arm when the brief permits it. For
# non-platformer proof briefs, skip Press Start 2P so the raw arm is not tempted
# into the same forbidden taste leak.
STAGE_PRESSSTART=1
if [ "$STAGE_ASSETS" = "0" ]; then
  STAGE_PRESSSTART=0
elif [ -f "$BRIEF" ] && grep -qi "Do not copy .*HUD font\\|Do not copy .*arcade HUD fonts" "$BRIEF"; then
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

if [ "$STAGE_ASSETS" = "0" ]; then
  # Raw discovery arm: do NOT stage Loombridge registry fixtures, Pixel Adventure art,
  # provided font, or the polished mock. Asset discovery/sourcing and feel/camera
  # choices are part of the comparison.
  :
elif [ -f "$BRIEF" ] && grep -qi "Switchyard Courier" "$BRIEF"; then
  # Switchyard raw arm: do NOT stage Loombridge registry fixtures. Asset discovery/sourcing is part
  # of the comparison, so the raw agent starts with an empty Assets folder and the qualitative brief.
  :
else
  # Tiderunner/default arm: stage the same art + mock reference used in the original comparison.
  if [ -d "$ART_SRC" ]; then
    mkdir -p "$PROJ/Assets/_Art"
    cp -R "$ART_SRC" "$PROJ/Assets/_Art/Free"
    # Drop any stray Unity .meta from the source so Unity re-imports cleanly.
    find "$PROJ/Assets/_Art" -name "*.meta" -delete 2>/dev/null || true
  else
    echo "WARN: art pack not found at $ART_SRC — raw arm will have no sprites." >&2
  fi

  # Stage the mock (HTML + its asset PNGs) as reference material, OUTSIDE Assets (not game content).
  if [ -d "$MOCK_SRC" ]; then
    cp -R "$MOCK_SRC/." "$PROJ/_Design/mock/"
  else
    echo "WARN: mock not found at $MOCK_SRC." >&2
  fi
fi

# The design brief (Loombridge-tooling stripped).
if [ -f "$BRIEF" ]; then
  cp "$BRIEF" "$PROJ/BUILD-BRIEF.md"
else
  echo "WARN: design brief not found at $BRIEF (skipping copy)." >&2
fi

if [ "$STAGE_ASSETS" = "0" ]; then
  STAGED_NOTE="Staged: ProjectSettings (Input System / 2D / built-in RP), empty Assets folder, BUILD-BRIEF.md. No Loombridge art pack, font, mock, registry fixtures, skills, bridge, or MCP config are preloaded."
  COMPARE_NOTE="and compare against the Loombridge arm with the same final scrutiny."
elif [ -f "$BRIEF" ] && grep -qi "Switchyard Courier" "$BRIEF"; then
  STAGED_NOTE="Staged: ProjectSettings (Input System / 2D / built-in RP), empty Assets folder, BUILD-BRIEF.md. No Loombridge registry fixtures are preloaded."
  COMPARE_NOTE="and compare against the Loombridge arm (switchyard-courier-clean) + the same Switchyard gates."
else
  STAGED_NOTE="Staged: ProjectSettings (Input System / 2D / built-in RP), optional Press Start 2P font, art pack -> Assets/_Art/Free, mock -> _Design/mock, BUILD-BRIEF.md."
  COMPARE_NOTE="and compare against the Loombridge arm (tiderunner-clean) + the mock."
fi

cat <<EOF

Done -> $PROJ  (RAW: no Loombridge bridge, no .mcp.json, no skills)

$STAGED_NOTE

Next steps (the no-Loombridge arm):
  1. Optionally open the project in Unity 6000.3 to confirm it imports (the agent can't drive it).
  2. Start a fresh raw session FROM the project folder:
       cd "$PROJ" && claude
     This folder is OUTSIDE the repo -> empty memory namespace, no access to the skills/contract/demo.
     There is NO loombridge MCP server here (by design). Then hand it:
       @BUILD-BRIEF.md
  3. Record what it can produce WITHOUT seeing/driving/verifying Unity, then open its output in Unity
     $COMPARE_NOTE
EOF
