#!/usr/bin/env bash
# Cut a Loombridge CLI release and publish it to GitHub Releases on the PRIVATE
# DISTRIBUTION repo (Loomtide/loombridge — release assets only, no
# source; partners get read access there, never on this monorepo).
#
# Packs @loomtide/loombridge (its `prepack` bundles the current bridge tarball) and
# uploads the resulting loombridge-cli-<ver>.tgz PLUS scripts/install.sh as release
# assets. Developers then install/update with a single command:
#
#   curl -fsSL https://get.loomtide.ai | sh
#
# (get.loomtide.ai should serve scripts/install.sh — host it once on R2/Pages;
# the script itself carries no secrets and always pulls the latest release.)
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

echo "==> Packing @loomtide/loombridge@$ver (prepack bundles the bridge tarball)"
( cd "$DIR/mcp-server" && npm pack >/dev/null )
tgz="$DIR/mcp-server/loombridge-cli-$ver.tgz"
[ -f "$tgz" ] || { echo "loombridge-release: pack did not produce $tgz" >&2; exit 1; }
echo "    $tgz"

if [ "$DRY" = 1 ]; then
  echo "==> --dry-run: skipping GitHub Release for $TAG"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "loombridge-release: the GitHub CLI (gh) is required to publish." >&2; exit 1; }

notes="${NOTES:-Loombridge CLI ${TAG}. Install or update with one command: \`curl -fsSL https://get.loomtide.ai | sh\`}"

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
