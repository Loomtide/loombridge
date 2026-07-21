#!/usr/bin/env bash
# Snapshot a Loomtide project at a phase boundary into a reusable STAGE FIXTURE,
# so a later run can resume from this stage instead of rebuilding from scratch
# (the e2e build is ~1.5-2h; a single phase is minutes).
#
# A fixture captures the EVOLVING artifacts: the `.loomtide/` state (contract,
# captures, reports, design target) and any Unity scene files you name. Scripts
# and sprites in Assets/ are construct-time and stable, so they are NOT copied —
# the scene file carries the per-stage scene state.
#
# Pairs with `loomtide-restore` (resume) and `loomtide verify --stage <name>`
# (grade only that stage's gates). Stages: construct | level | polish | verify.
#
# Usage:
#   loomtide-checkpoint --project <dir> --stage <name> [--scene <relpath>]... \
#                       [--fixtures-root <dir>]
#
#   --project        (required) the Unity project (must contain .loomtide/)
#   --stage          (required) construct | level | polish | verify
#   --scene          (repeatable) project-relative path to a .unity scene to snapshot
#                    (its .meta is captured too). SAVE the scene in Unity first.
#   --fixtures-root  (optional) default: <project>/.loomtide-fixtures

set -euo pipefail

PROJECT="" STAGE="" FIXROOT="" ; SCENES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --stage) STAGE="${2:-}"; shift 2 ;;
    --scene) SCENES+=("${2:-}"); shift 2 ;;
    --fixtures-root) FIXROOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "loomtide-checkpoint: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

[ -n "$PROJECT" ] || { echo "loomtide-checkpoint: --project is required." >&2; exit 2; }
[ -n "$STAGE" ]   || { echo "loomtide-checkpoint: --stage is required (construct|level|polish|verify)." >&2; exit 2; }
case "$STAGE" in construct|level|polish|verify) ;; *) echo "loomtide-checkpoint: invalid --stage '$STAGE'." >&2; exit 2 ;; esac
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd || true)"
[ -n "$PROJECT" ] || { echo "loomtide-checkpoint: --project directory does not exist." >&2; exit 1; }
[ -d "$PROJECT/.loomtide" ] || { echo "loomtide-checkpoint: '$PROJECT' has no .loomtide/ (run \`loomtide plan\` first)." >&2; exit 1; }

FIXROOT="${FIXROOT:-$PROJECT/.loomtide-fixtures}"
FIX="$FIXROOT/$STAGE"
echo "==> Checkpointing stage '$STAGE' -> $FIX"
rm -rf "$FIX"
mkdir -p "$FIX/loomtide" "$FIX/files"

cp -R "$PROJECT/.loomtide/." "$FIX/loomtide/"
: > "$FIX/SCENES"
for s in "${SCENES[@]:-}"; do
  [ -n "$s" ] || continue
  [ -f "$PROJECT/$s" ] || { echo "loomtide-checkpoint: scene '$s' not found (save it in Unity first)." >&2; exit 1; }
  mkdir -p "$FIX/files/$(dirname "$s")"
  cp "$PROJECT/$s" "$FIX/files/$s"
  [ -f "$PROJECT/$s.meta" ] && cp "$PROJECT/$s.meta" "$FIX/files/$s.meta"
  echo "$s" >> "$FIX/SCENES"
  echo "  -> scene $s"
done

scene_count=$(grep -c . "$FIX/SCENES" 2>/dev/null || echo 0)
echo "==> Done. Captured .loomtide/ + $scene_count scene(s). Resume with: loomtide-restore --project <dir> --stage $STAGE"
