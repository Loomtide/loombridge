#!/usr/bin/env bash
# Restore a Loomtide project to a STAGE FIXTURE captured by `loomtide-checkpoint`,
# so you can re-run or iterate ONE phase from a deterministic starting state
# instead of rebuilding the whole prototype (~1.5-2h) every time.
#
# Restores the `.loomtide/` state and the captured scene file(s) in place. Other
# Assets/ (scripts, sprites) are left untouched — they are construct-time stable.
#
# IMPORTANT: close the Unity editor before restoring (Unity holds the project +
# its Library cache). Reopen afterwards; Unity reimports as needed.
#
# Usage:
#   loomtide-restore --project <dir> --stage <name> [--fixtures-root <dir>]

set -euo pipefail

PROJECT="" STAGE="" FIXROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --stage) STAGE="${2:-}"; shift 2 ;;
    --fixtures-root) FIXROOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "loomtide-restore: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

[ -n "$PROJECT" ] || { echo "loomtide-restore: --project is required." >&2; exit 2; }
[ -n "$STAGE" ]   || { echo "loomtide-restore: --stage is required." >&2; exit 2; }
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd || true)"
[ -n "$PROJECT" ] || { echo "loomtide-restore: --project directory does not exist." >&2; exit 1; }

FIXROOT="${FIXROOT:-$PROJECT/.loomtide-fixtures}"
FIX="$FIXROOT/$STAGE"
[ -d "$FIX/loomtide" ] || { echo "loomtide-restore: no fixture for stage '$STAGE' at $FIX (checkpoint it first)." >&2; exit 1; }

echo "==> Restoring stage '$STAGE' from $FIX"
echo "    (close the Unity editor first; it holds the project + Library cache)"

# .loomtide/ — replace wholesale with the fixture snapshot.
rm -rf "$PROJECT/.loomtide"
mkdir -p "$PROJECT/.loomtide"
cp -R "$FIX/loomtide/." "$PROJECT/.loomtide/"
echo "  -> restored .loomtide/"

# Scene file(s) — restore each to its original project-relative path.
if [ -s "$FIX/SCENES" ]; then
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    mkdir -p "$PROJECT/$(dirname "$s")"
    cp "$FIX/files/$s" "$PROJECT/$s"
    [ -f "$FIX/files/$s.meta" ] && cp "$FIX/files/$s.meta" "$PROJECT/$s.meta"
    echo "  -> restored scene $s"
  done < "$FIX/SCENES"
fi

echo "==> Done. Reopen the project in Unity, then iterate the next phase (e.g. \`loomtide verify --stage $STAGE\`)."
