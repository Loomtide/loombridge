#!/bin/sh
# Loombridge installer + updater — ONE command for install AND update.
#
#   curl -fsSL https://get.loomtide.ai | sh
#   curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject
#   curl -fsSL https://get.loomtide.ai | sh -s -- --project /path/to/UnityProject --with-agent
#
# Re-run any time to pull the latest release — this script is idempotent, so the
# same command installs on a fresh machine and updates on an existing one.
#
# WINDOWS: run this in Git Bash (bundled with Git for Windows) or WSL — it is a POSIX
# shell script and will NOT run in cmd.exe or PowerShell. Once installed, the `loombridge`
# command itself works in ANY Windows shell (npm installs a `loombridge.cmd` shim).
#
# --with-agent (only meaningful with --project) ALSO opts the project in to Loombridge's
# agent commands + skills (`loombridge install-agent`) — committed into the project repo so
# teammates get them via git pull. Omit it to skip (the default); opt out later with
# `loombridge install-agent --project <dir> --remove`.
#
# Releases are published as GitHub Release assets on the release repo (see
# LOOMBRIDGE_REPO below). If that repo is private for you, fetching the asset
# needs auth. Either:
#   - log in once with the GitHub CLI:  gh auth login        (recommended)
#   - or export a GitHub token:         LOOMBRIDGE_TOKEN=<pat>  (CI / no gh CLI)
# No npm account is required; a public release repo needs no auth at all.
#
# RELEASE CANDIDATES: point the installer at a locally built asset instead of a published
# release, so an RC can be smoke-tested through THIS script before it is cut. Needs no auth
# and touches no network:
#   LOOMBRIDGE_CLI_TARBALL=mcp-server/loombridge-cli-0.2.0.tgz sh scripts/install.sh
#   sh scripts/install.sh --tarball mcp-server/loombridge-cli-0.2.0.tgz
#
# Env overrides:
#   LOOMBRIDGE_VERSION      pin a release tag (default: latest)
#   LOOMBRIDGE_REPO         release repo (default: Loomtide/loombridge)
#   LOOMBRIDGE_TOKEN        GitHub token with read access (CI / no gh CLI)
#   LOOMBRIDGE_PROJECT      Unity project to also install/update the bridge into
#   LOOMBRIDGE_CLI_TARBALL  install this local loombridge-cli-*.tgz; skips the release fetch
set -eu

REPO="${LOOMBRIDGE_REPO:-Loomtide/loombridge}"
VERSION="${LOOMBRIDGE_VERSION:-latest}"
PROJECT="${LOOMBRIDGE_PROJECT:-}"
WITH_AGENT="${LOOMBRIDGE_WITH_AGENT:-0}"
CLI_TARBALL="${LOOMBRIDGE_CLI_TARBALL:-}"
ASSET_GLOB='loombridge-cli-*.tgz'

usage() {
  # Print the header comment (everything between the shebang and `set -eu`).
  sed -n '2,/^set -eu/p' "$0" 2>/dev/null | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --tarball) CLI_TARBALL="${2:-}"; shift 2 ;;
    --with-agent) WITH_AGENT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "loombridge install: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

err() { echo "loombridge install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js >= 18 is required (not found)."
command -v npm  >/dev/null 2>&1 || err "npm is required (not found)."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tgz=""

if [ -n "$CLI_TARBALL" ]; then
  # Local-artifact path: no auth, no network. Used to smoke-test a release candidate
  # through this exact script before publishing it.
  [ -f "$CLI_TARBALL" ] || err "tarball not found: $CLI_TARBALL"
  # Absolutize before handing it to npm — the caller's relative path is not ours to trust.
  tgz="$(cd "$(dirname "$CLI_TARBALL")" && pwd)/$(basename "$CLI_TARBALL")"
  case "$(basename "$tgz")" in
    loombridge-cli-*.tgz) ;;
    *) echo "!!  $(basename "$tgz") does not match $ASSET_GLOB — installing it anyway." >&2 ;;
  esac
  echo "==> Using LOCAL CLI tarball (release channel bypassed): $tgz"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "==> Fetching Loombridge CLI ($VERSION) from $REPO"
  # GitHub CLI path — uses the developer's existing `gh auth login`.
  if [ "$VERSION" = latest ]; then
    gh release download -R "$REPO" -p "$ASSET_GLOB" -D "$tmp" \
      || err "could not download the latest release (check your repo access)."
  else
    gh release download "$VERSION" -R "$REPO" -p "$ASSET_GLOB" -D "$tmp" \
      || err "could not download release $VERSION (check the tag and your access)."
  fi
  tgz="$(ls "$tmp"/loombridge-cli-*.tgz 2>/dev/null | head -1 || true)"
elif [ -n "${LOOMBRIDGE_TOKEN:-}" ]; then
  echo "==> Fetching Loombridge CLI ($VERSION) from $REPO"
  # Token path — CI or machines without the gh CLI. Needs curl.
  command -v curl >/dev/null 2>&1 || err "curl is required for the LOOMBRIDGE_TOKEN path."
  if [ "$VERSION" = latest ]; then
    rel="https://api.github.com/repos/$REPO/releases/latest"
  else
    rel="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  fi
  meta="$(curl -fsSL -H "Authorization: Bearer $LOOMBRIDGE_TOKEN" \
                     -H "Accept: application/vnd.github+json" "$rel")" \
    || err "could not read release metadata (check LOOMBRIDGE_TOKEN / repo access)."
  # Resolve the asset's API URL with node (a hard dependency anyway — no jq needed).
  asset_url="$(printf '%s' "$meta" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const rel = JSON.parse(s);
      const a = (rel.assets || []).find((a) => /^loombridge-cli-.*\.tgz$/.test(a.name));
      if (!a) process.exit(3);
      process.stdout.write(a.url);
    });')" || err "no $ASSET_GLOB asset found in release $VERSION."
  curl -fsSL -H "Authorization: Bearer $LOOMBRIDGE_TOKEN" -H "Accept: application/octet-stream" \
       -o "$tmp/cli.tgz" "$asset_url" || err "release asset download failed."
  tgz="$tmp/cli.tgz"
else
  err "no auth available. Run 'gh auth login' (GitHub CLI), set LOOMBRIDGE_TOKEN=<github token>, or install a local build with LOOMBRIDGE_CLI_TARBALL=<path>."
fi

[ -n "$tgz" ] && [ -f "$tgz" ] || err "release asset $ASSET_GLOB was not found."

echo "==> Installing globally: npm install -g $(basename "$tgz")"
npm install -g "$tgz" || err "'npm install -g' failed (is your npm global bin writable / on PATH?)."

if command -v loombridge >/dev/null 2>&1; then
  echo "==> Installed: $(loombridge --version 2>/dev/null || echo loombridge)"
else
  # npm puts global bins in <prefix>/bin on POSIX but directly in <prefix> on Windows,
  # so print the directory that actually holds the shim rather than a wrong guess.
  prefix="$(npm prefix -g 2>/dev/null || echo '<npm prefix -g>')"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) bindir="$prefix" ;;
    *)                    bindir="$prefix/bin" ;;
  esac
  echo "!!  Installed, but 'loombridge' is not on your PATH."
  echo "    Add your npm global bin to PATH:  export PATH=\"$bindir:\$PATH\""
fi

if [ -n "$PROJECT" ]; then
  echo "==> Installing/updating the Unity bridge into $PROJECT"
  loombridge install-bridge --project "$PROJECT"
  if [ "$WITH_AGENT" = 1 ]; then
    echo "==> Installing the optional agent surface (commands + skills) into $PROJECT"
    loombridge install-agent --project "$PROJECT"
  fi
elif [ "$WITH_AGENT" = 1 ]; then
  echo "!!  --with-agent needs --project <UnityProject>; nothing to opt in (skipped)." >&2
fi

echo "==> Done. Re-run this exact command any time to update."
