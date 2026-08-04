#!/usr/bin/env bash
# Cut a Loombridge CLI release and publish it to GitHub Releases on the PRIVATE
# DISTRIBUTION repo (Loomtide/loombridge — release assets only, no
# source; partners get read access there, never on this monorepo).
#
# Packs loombridge (its `prepack` bundles the current bridge tarball) and
# uploads the resulting loombridge-cli-<ver>.tgz PLUS scripts/install.sh as release
# assets. Developers then install/update with a single command:
#
#   gh release download -R Loomtide/loombridge -p install.sh && sh install.sh
#
# (get.loomtide.ai does NOT serve Loombridge today — it returns a different product's installer.
# Once it does serve scripts/install.sh, that becomes a `curl | sh` one-liner; the script itself
# carries no secrets and always pulls the latest release.)
#
# Usage: scripts/loombridge-release.sh [--tag vX.Y.Z] [--notes <str>] [--dry-run] [--deploy-installer]
#   --tag                release tag (default: v<version> from mcp-server/package.json)
#   --notes              release notes body (default: a one-line install hint)
#   --dry-run            pack only; do not create/upload a GitHub Release
#   --deploy-installer   after releasing, also redeploy get.loomtide.ai
#                        (scripts/deploy-get-loombridge.sh) so the curl|sh channel
#                        serves the current scripts/install.sh
set -euo pipefail

REPO="${LOOMBRIDGE_REPO:-Loomtide/loombridge}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0
TAG=""
NOTES=""
DEPLOY_INSTALLER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --deploy-installer) DEPLOY_INSTALLER=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "loombridge-release: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

ver="$(node -p "require('$DIR/mcp-server/package.json').version")"
TAG="${TAG:-v$ver}"

echo "==> Packing loombridge@$ver (prepack bundles the bridge tarball)"
( cd "$DIR/mcp-server" && npm pack >/dev/null )

# npm names the tarball after the PACKAGE NAME (loombridge -> loomtide-loombridge-<ver>.tgz),
# but the published ASSET name is a separate contract: scripts/install.sh fetches the release asset by
# `ASSET_GLOB='loombridge-cli-*.tgz'`, and installers already deployed at get.loomtide.ai carry that
# glob. So we pack, then RENAME to the asset name. Renaming the asset instead would silently break
# every installer already in the wild.
#
# This step is why the script could not cut a release between the 2026-07-21 mechanical rename and
# now: that rename rewrote a hard-coded `loomtide-cli-$ver.tgz` to `loombridge-cli-$ver.tgz` while the
# package name became `loombridge`, so the script looked for a file npm never produces.
# Deriving the produced name from package.json (npm's own scope-flattening rule) keeps a future
# rename from re-breaking it.
produced="$DIR/mcp-server/$(node -p "const p=require('$DIR/mcp-server/package.json'); p.name.replace(/^@/, '').replace(/\//, '-') + '-' + p.version + '.tgz'")"
[ -f "$produced" ] || { echo "loombridge-release: npm pack did not produce $produced" >&2; exit 1; }

tgz="$DIR/mcp-server/loombridge-cli-$ver.tgz"
mv -f "$produced" "$tgz"
echo "    $tgz (packed as $(basename "$produced"), renamed to the install.sh asset name)"

if [ "$DRY" = 1 ]; then
  echo "==> --dry-run: skipping GitHub Release for $TAG"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "loombridge-release: the GitHub CLI (gh) is required to publish." >&2; exit 1; }

# The default notes must NOT advertise get.loomtide.ai: that endpoint serves a DIFFERENT product's
# installer (@loomtide/cli), so the previous default told every reader of a release page to install
# something else. README.md and Docs/Install.md already said the endpoint was not live for
# Loombridge; this default contradicted them, and would have repeated the error on every release cut
# without --notes.
notes="${NOTES:-Loombridge CLI ${TAG}. Install or update: \`gh release download ${TAG} -R ${REPO} -p install.sh && sh install.sh\`}"

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "==> Updating existing release $TAG"
  gh release upload "$TAG" "$tgz" "$DIR/scripts/install.sh" -R "$REPO" --clobber
else
  echo "==> Creating release $TAG"
  gh release create "$TAG" "$tgz" "$DIR/scripts/install.sh" -R "$REPO" --title "$TAG" --notes "$notes"
fi

echo "==> Released $TAG to $REPO"

# The get.loomtide.ai installer (scripts/install.sh) is a SEPARATE channel from the
# release asset — it only updates when the Vercel `get-loombridge` project is redeployed.
if [ "$DEPLOY_INSTALLER" = 1 ]; then
  echo "==> Refreshing the get.loomtide.ai installer channel"
  bash "$DIR/scripts/deploy-get-loombridge.sh"
else
  echo "!!  get.loomtide.ai still serves the PREVIOUS installer. If scripts/install.sh changed,"
  echo "    refresh it: scripts/deploy-get-loombridge.sh   (or re-run release with --deploy-installer)"
fi
