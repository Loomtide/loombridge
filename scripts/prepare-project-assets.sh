#!/usr/bin/env bash
#
# Prepare curated Loomtide asset-registry entries into a clean Unity project.
#
# Usage:
#   scripts/prepare-project-assets.sh --project PATH --profile asset-layer/profiles/2d-topdown-arena.json \
#     --registry asset-layer/registry/switchyard-2d.json [--name switchyard] [--handoff-dir .loomtide/handoff]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=""
PROFILE=""
REGISTRY=""
NAME="assets"
HANDOFF_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project=*) PROJECT="${1#--project=}" ;;
    --profile=*) PROFILE="${1#--profile=}" ;;
    --registry=*) REGISTRY="${1#--registry=}" ;;
    --name=*) NAME="${1#--name=}" ;;
    --handoff-dir=*) HANDOFF_DIR="${1#--handoff-dir=}" ;;
    --project) shift; PROJECT="${1:-}" ;;
    --profile) shift; PROFILE="${1:-}" ;;
    --registry) shift; REGISTRY="${1:-}" ;;
    --name) shift; NAME="${1:-}" ;;
    --handoff-dir) shift; HANDOFF_DIR="${1:-}" ;;
    -*) echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
    *) echo "ERROR: unexpected argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$PROJECT" ] || [ -z "$PROFILE" ] || [ -z "$REGISTRY" ]; then
  echo "Usage: scripts/prepare-project-assets.sh --project=PATH --profile=PATH --registry=PATH [--name=assets] [--handoff-dir=.loomtide/handoff]" >&2
  exit 2
fi

case "$PROJECT" in /*) ;; *) PROJECT="$PWD/$PROJECT" ;; esac
case "$PROFILE" in /*) ;; *) PROFILE="$REPO_ROOT/$PROFILE" ;; esac
case "$REGISTRY" in /*) ;; *) REGISTRY="$REPO_ROOT/$REGISTRY" ;; esac
if [ -z "$HANDOFF_DIR" ]; then
  HANDOFF_DIR="$PROJECT/.loomtide/handoff"
else
  case "$HANDOFF_DIR" in /*) ;; *) HANDOFF_DIR="$PROJECT/$HANDOFF_DIR" ;; esac
fi

if [ ! -d "$PROJECT/Assets" ]; then
  echo "ERROR: Unity project Assets folder not found: $PROJECT/Assets" >&2
  exit 1
fi
if [ ! -f "$PROFILE" ]; then
  echo "ERROR: asset profile not found: $PROFILE" >&2
  exit 1
fi
if [ ! -f "$REGISTRY" ]; then
  echo "ERROR: asset registry not found: $REGISTRY" >&2
  exit 1
fi

mkdir -p "$HANDOFF_DIR"

pushd "$REPO_ROOT/mcp-server" >/dev/null
if [ ! -f dist/asset-layer/prepare-cli.js ] || [ src/asset-layer/prepare-cli.ts -nt dist/asset-layer/prepare-cli.js ]; then
  npm run build
fi

REPORT="$HANDOFF_DIR/${NAME}-asset-prepare-report.json"
ATTRIBUTION="$HANDOFF_DIR/${NAME}-asset-attribution.md"
CACHE="$HANDOFF_DIR/asset-cache"

node dist/asset-layer/prepare-cli.js \
  --profile "$PROFILE" \
  --registry "$REGISTRY" \
  --output "$REPORT" \
  --cache "$CACHE" \
  --preferred-license CC0-1.0

node dist/asset-layer/reporting.js \
  --report "$REPORT" \
  --output "$ATTRIBUTION"
popd >/dev/null

echo "Prepared asset report: $REPORT"
echo "Prepared attribution: $ATTRIBUTION"
echo "Import accepted sprite entries using .assets[].import.toolArguments."
