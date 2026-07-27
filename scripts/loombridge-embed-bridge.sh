#!/usr/bin/env bash
# Embed the Loombridge Unity bridge package physically into a CONSUMER Unity
# project's Packages/, EXCLUDING Tests/.
#
# Why exclude Tests/ (RUN-1 finding #62): a consumer project does not carry
# `com.unity.test-framework` / NUnit, so an embedded `Tests/Editor` asmdef
# (precompiledReferences nunit.framework.dll) breaks the consumer compile with
# CS0246. Shipping the package without Tests/ is the validated fix — the
# Editor + Runtime assemblies are all a consumer needs.
#
# This is the SUPPORTED consumer embed: the package lives physically in the
# project (no dev-repo `file:` reference), so the dev repo can be relocated or
# made absent and the bridge still loads — the same isolation property the
# frozen runtime gives the CLI (see scripts/loombridge-install-locally.sh).
#
# Dev-repo projects under unity-dev-project/* intentionally use a `file:` package
# reference instead (see scripts/new-test-project.sh) so they track the source;
# this script is for an OUTSIDE-repo consumer project.
#
# Usage:
#   scripts/loombridge-embed-bridge.sh --project <unity-project-dir> [--package <src>]
#
#   --project   (required) the Unity project to embed into (must contain Packages/ or be creatable)
#   --package   (optional) source package dir (default: this repo's packages/com.loomtide.loombridge)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="com.loomtide.loombridge"
SRC="$REPO/packages/$PKG_NAME"
PROJECT=""

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --package) SRC="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "loombridge-embed-bridge: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$PROJECT" ] || { echo "loombridge-embed-bridge: --project <unity-project-dir> is required." >&2; exit 2; }
[ -d "$SRC" ] || { echo "loombridge-embed-bridge: source package not found at '$SRC'." >&2; exit 1; }
[ -f "$SRC/package.json" ] || { echo "loombridge-embed-bridge: '$SRC' is not a UPM package (no package.json)." >&2; exit 1; }

PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd || true)"
[ -n "$PROJECT" ] || { echo "loombridge-embed-bridge: --project directory does not exist." >&2; exit 1; }

DEST="$PROJECT/Packages/$PKG_NAME"
echo "==> Embedding $PKG_NAME (Tests/ excluded) into $DEST"
# Source provenance + freshness: this script (and the installed binary) runs from the
# FROZEN runtime, so SRC is the runtime's bridge copy — it only refreshes on
# `loombridge-install-locally.sh`. If you just changed bridge SOURCE in the dev repo,
# reinstall FIRST or pass --package <dev-repo>/packages/$PKG_NAME, else you embed a stale
# bridge (a silent compile error then halts ALL script compilation — check Editor.log).
echo "    source: $SRC"
if [ -f "$SRC/package.json" ]; then
  echo "    source version: $(grep -m1 '"version"' "$SRC/package.json" | sed 's/[^0-9.]*//g' || echo unknown)"
fi

# A stale file: reference in the project manifest would double-declare the
# package id. Embedding wins (Packages/<id> is auto-discovered), but warn so the
# operator can remove the now-redundant manifest entry.
MANIFEST="$PROJECT/Packages/manifest.json"
if [ -f "$MANIFEST" ] && grep -q "\"$PKG_NAME\"" "$MANIFEST"; then
  echo "  !! WARNING: $MANIFEST still references \"$PKG_NAME\" (likely a dev-repo file: ref)." >&2
  echo "     Remove that dependency entry — the embedded copy under Packages/ is auto-discovered." >&2
fi

mkdir -p "$PROJECT/Packages"
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy every top-level package entry EXCEPT Tests/ and its .meta. dotglob in case
# the package ever grows a hidden top-level file; nullglob so an empty glob is a no-op.
shopt -s dotglob nullglob
copied=0
for entry in "$SRC"/*; do
  base="$(basename "$entry")"
  case "$base" in
    .|..|Tests|Tests.meta) continue ;;
  esac
  cp -R "$entry" "$DEST/"
  copied=$((copied + 1))
done
shopt -u dotglob nullglob

# Hard guard: the whole point is that Tests/ must not ship to the consumer.
if [ -e "$DEST/Tests" ] || [ -e "$DEST/Tests.meta" ]; then
  echo "loombridge-embed-bridge: FAILED — Tests/ leaked into the embedded package." >&2
  exit 1
fi
[ -d "$DEST/Editor" ] || { echo "loombridge-embed-bridge: FAILED — Editor/ missing from the embed." >&2; exit 1; }
[ -d "$DEST/Runtime" ] || { echo "loombridge-embed-bridge: FAILED — Runtime/ missing from the embed." >&2; exit 1; }

echo "  -> $copied top-level entries copied (Tests/ excluded)"
echo "==> Done. The bridge is embedded; open the project in Unity to let it compile."
