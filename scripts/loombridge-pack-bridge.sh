#!/usr/bin/env bash
# Pack the Loombridge Unity bridge package into a versioned UPM tarball (.tgz).
#
# This is the SINGLE VERSIONED DISTRIBUTION UNIT for the "immutable dependency"
# route. The tarball is what the CLI ships bundled, what a GitHub Release hosts
# as an asset, and what `loombridge install-bridge` installs into a consumer
# project's manifest as a `file:` dependency:
#
#   "com.loomtide.loombridge": "file:Packages/tarballs/com.loomtide.loombridge-<ver>.tgz"
#
# WHY A TARBALL (not the physical `Tests/`-stripped embed):
#   Unity resolves a tarball as an IMMUTABLE dependency in Library/PackageCache
#   (read-only, package-manager-owned). Immutable dependencies are NOT
#   "testables" by default, so `UNITY_INCLUDE_TESTS` is never defined for them
#   and the package's Tests asmdefs (which carry the `UNITY_INCLUDE_TESTS`
#   define constraint) are excluded from the CONSUMER compile automatically —
#   no nunit/TestRunner CS0246 (RUN-1 #62). We therefore SHIP Tests/ inside the
#   tarball; Unity's own dependency semantics gate them. An embedded copy, by
#   contrast, is treated as a local package (a testable), which is exactly why
#   the old embed step had to physically strip Tests/.
#
# The tar layout matches `npm pack`: a single top-level `package/` directory
# with package.json at its root, which is the layout Unity's tarball importer
# expects.
#
# Usage:
#   scripts/loombridge-pack-bridge.sh [--package <src>] [--out-dir <dir>] [--version <x.y.z>]
#
#   --package   source package dir (default: this repo's packages/com.loomtide.loombridge)
#   --out-dir   where to write the .tgz (default: dist/bridge/ under the repo root)
#   --version   override the version stamped into the emitted package.json + filename
#               (default: the source package.json version)
#
# Output: <out-dir>/com.loomtide.loombridge-<version>.tgz
#         plus <out-dir>/com.loomtide.loombridge-<version>.tgz.sha256
#
# The tarball also carries `package/.loombridge-source-digest`: a record binding it to the
# SOURCE bytes it was packed from, so a CLI can later tell whether its bundled tarball
# still corresponds to the sources it ships. The `.tgz.sha256` sidecar cannot answer that
# (it hashes the tarball itself), which is how a bundle packed months earlier stayed
# invisible to every check while `doctor` reported healthy. No `.source-digest` sidecar is
# written: the EMBEDDED record is the one truth, because that is the copy that travels
# with the tarball into a consumer project.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="com.loomtide.loombridge"
SRC="$REPO/packages/$PKG_NAME"
OUT_DIR="$REPO/dist/bridge"
VERSION_OVERRIDE=""

# The ONE digest implementation, shelled from here exactly as the version stamp below
# shells to node. A bash-side reimplementation would be a second source of truth that
# drifts silently from the TypeScript one the freshness check uses.
DIGEST_BUILDER_REL="mcp-server/dist/shared/bridge-source-digest.js"
DIGEST_ENTRY_NAME=".loombridge-source-digest"

usage() { sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --package) SRC="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --version) VERSION_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "loombridge-pack-bridge: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

[ -d "$SRC" ] || { echo "loombridge-pack-bridge: source package not found at '$SRC'." >&2; exit 1; }
[ -f "$SRC/package.json" ] || { echo "loombridge-pack-bridge: '$SRC' is not a UPM package (no package.json)." >&2; exit 1; }

# Resolve the version: from package.json unless overridden.
src_version="$(grep -m1 '"version"' "$SRC/package.json" | sed 's/[^0-9A-Za-z.+-]*//g' | sed 's/version//')"
VERSION="${VERSION_OVERRIDE:-$src_version}"
[ -n "$VERSION" ] || { echo "loombridge-pack-bridge: could not resolve a version." >&2; exit 1; }

# Bind the tarball to the SOURCE bytes it is packed from.
#
# Computed over $SRC, the UNSTAMPED tree, NOT over the staged copy: a `--version` override
# rewrites the staged package.json, so digesting the stage would make every override-packed
# tarball read as stale against the very sources it came from.
DIGEST_BUILDER="$REPO/$DIGEST_BUILDER_REL"
[ -f "$DIGEST_BUILDER" ] || {
  echo "loombridge-pack-bridge: REFUSING to pack without the source digest." >&2
  echo "    missing $DIGEST_BUILDER_REL (build it first: cd mcp-server && npm run build)." >&2
  echo "    An undigested tarball cannot be bound to any source tree, so every later" >&2
  echo "    freshness check would have to fail it. Packing one is never the right move." >&2
  exit 1; }
SRC_DIGEST="$(node "$DIGEST_BUILDER" "$SRC")"
[ -n "$SRC_DIGEST" ] || { echo "loombridge-pack-bridge: source digest came back empty." >&2; exit 1; }

# Provenance for the layouts that cannot recompute the digest (an npm-installed CLI has no
# source tree next to it): which CLI build packed this, from which commit.
CLI_VERSION="$(node -e '
  const fs = require("fs");
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || "unknown")); }
  catch { process.stdout.write("unknown"); }
' "$REPO/mcp-server/package.json")"
COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"

echo "==> Packing $PKG_NAME@$VERSION"
echo "    source: $SRC"
echo "    source digest: $SRC_DIGEST"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG_ROOT="$STAGE/package"   # npm-pack layout: everything under package/
mkdir -p "$PKG_ROOT"

# Copy the whole package, then prune what must not ship. We deliberately KEEP
# Tests/ (gated by UNITY_INCLUDE_TESTS for immutable-dependency consumers) and
# the Unity-ignored `Documentation~`/`Samples~` folders (the trailing ~ tells
# Unity not to import them, but they are valid to distribute).
cp -R "$SRC/." "$PKG_ROOT/"

# Prune OS/editor/VCS cruft that must never ship in a package.
find "$PKG_ROOT" \( \
  -name '.DS_Store' -o \
  -name 'Thumbs.db' -o \
  -name '.git' -o \
  -name '.gitkeep' \
  \) -exec rm -rf {} + 2>/dev/null || true

# Stamp the resolved version into the emitted package.json (so an overridden
# --version is authoritative and the tarball is self-describing).
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const v = process.argv[2];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PKG_ROOT/package.json" "$VERSION"

# Embed the digest record. Written through node so the JSON is escaped correctly, and
# written AFTER the prune so nothing can remove it. The leading dot keeps Unity's asset
# pipeline from importing it (hidden files need no .meta sibling).
node -e '
  const fs = require("fs");
  fs.writeFileSync(
    process.argv[1],
    JSON.stringify({ digest: process.argv[2], cliVersion: process.argv[3], commit: process.argv[4] }, null, 2) + "\n",
  );
' "$PKG_ROOT/$DIGEST_ENTRY_NAME" "$SRC_DIGEST" "$CLI_VERSION" "$COMMIT"

# Sanity: the load-bearing assemblies and the (gated) tests must all be present.
[ -d "$PKG_ROOT/Editor" ]   || { echo "loombridge-pack-bridge: FAILED — Editor/ missing." >&2; exit 1; }
[ -d "$PKG_ROOT/Runtime" ]  || { echo "loombridge-pack-bridge: FAILED — Runtime/ missing." >&2; exit 1; }
[ -f "$PKG_ROOT/Tests/Editor/$PKG_NAME.tests.asmdef" ] || {
  echo "loombridge-pack-bridge: FAILED — Tests asmdef missing (expected to ship, gated)." >&2; exit 1; }
grep -q 'UNITY_INCLUDE_TESTS' "$PKG_ROOT/Tests/Editor/$PKG_NAME.tests.asmdef" || {
  echo "loombridge-pack-bridge: REFUSING — Tests asmdef lacks the UNITY_INCLUDE_TESTS define constraint." >&2
  echo "    Without it, an immutable-dependency consumer would still compile the tests. Fix the asmdef first." >&2
  exit 1; }

mkdir -p "$OUT_DIR"
# Canonicalize to absolute: the tar step runs inside `cd "$STAGE"`, so a relative
# --out-dir (e.g. prepack's `bridge`) would otherwise resolve against the stage dir.
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
OUT_TGZ="$OUT_DIR/$PKG_NAME-$VERSION.tgz"

# Purge any stale bridge tarballs from a prior version before writing this one.
# The bundled-tarball resolver picks the newest by mtime, so a lingering older
# .tgz is (today) harmless but a latent trap; leaving two also bloats the CLI
# artifact and can confuse doctor's bundled-version read. Only OUR versioned
# tarballs/sha files are touched — nothing else in the out-dir.
#
# `*.source-digest` is in the glob although this script never writes one: an earlier
# iteration of the freshness work did, and an orphaned sidecar left in an out-dir is a
# second, unauthoritative answer to "what sources is this bundle from" sitting next to the
# tarball whose EMBEDDED record is the real one. Pack-output is asserted exact by
# bridge-freshness.test.ts.
for stale in "$OUT_DIR"/"$PKG_NAME"-*.tgz "$OUT_DIR"/"$PKG_NAME"-*.tgz.sha256 "$OUT_DIR"/"$PKG_NAME"-*.source-digest; do
  [ -e "$stale" ] || continue          # no match → glob stays literal; skip
  [ "$stale" = "$OUT_TGZ" ] && continue # never delete the one we're about to write
  rm -f "$stale"
done

# Deterministic tar: sort names, zero out mtimes/owners so the same source
# yields a byte-stable tarball (matters for the version-contract sha stamp).
( cd "$STAGE" && \
  find package -print0 | LC_ALL=C sort -z | \
  tar --numeric-owner --owner=0 --group=0 --mtime='1970-01-01 00:00:00 UTC' \
      --no-recursion --null -T - -cf - 2>/dev/null | gzip -n > "$OUT_TGZ" ) || {
  # BSD tar (macOS default) lacks --numeric-owner/--mtime/--null -T; fall back to
  # a plain deterministic-enough tar (still correct; just not byte-reproducible).
  ( cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$OUT_TGZ" package )
}

SHA="$( { shasum -a 256 "$OUT_TGZ" 2>/dev/null || sha256sum "$OUT_TGZ"; } | awk '{print $1}')"
echo "$SHA  $PKG_NAME-$VERSION.tgz" > "$OUT_TGZ.sha256"

echo "==> Wrote $OUT_TGZ"
echo "    sha256: $SHA"
echo "    contents:"
# Informational preview only — must NEVER fail the pack. A live `tar -tzf | ... | head -40`
# SIGPIPEs its tar/sed producers once head closes the pipe after 40 lines; under
# `set -o pipefail` that exit 141 aborts the whole script — green on macOS (the ~200 short
# lines fit the pipe buffer, so tar finishes first) but red on GNU/Linux CI. Capture the
# listing once, then slice it (no live pipe to break); `|| true` guards any future growth.
listing="$(tar -tzf "$OUT_TGZ")"
n="$(printf '%s\n' "$listing" | wc -l | tr -d ' ')"
printf '%s\n' "$listing" | head -40 | sed 's/^/      /' || true
echo "      ... ($n entries total)"
