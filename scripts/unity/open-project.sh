#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/unity/open-project.sh <project-path-or-name> [options]

Launch a Unity project and wait until the Loomtide MCP bridge can route to it.

Project may be an absolute/relative Unity project path, or a repo-owned name under
unity-projects/ (for example: shooter-3d-combat-dogfood).

Options:
  --timeout <seconds>       Wait timeout for MCP routability (default: 180).
  --unity <path>            Unity executable or Unity.app path to use.
  --assert-compile-clean    Also fail if Unity console has C# compile errors.
  --skip-build              Do not build mcp-server before the routability check.
  --no-wait                 Launch only; do not wait for MCP routability.
  --no-launch               Do not launch Unity; only wait for an already-open editor.
  --print-command           Resolve and print the Unity launch command; do not launch.
  -h, --help                Show this help.

Environment:
  UNITY_EDITOR              Unity executable or Unity.app path override.
  LOOMTIDE_UNITY_LAUNCH_LOG Launch log path (default: /tmp/loomtide-unity-<project>.log).
EOF
}

die() {
  echo "open-project: $*" >&2
  exit 1
}

repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/../.." && pwd
}

realpath_portable() {
  local target="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$target"
  else
    cd "$(dirname "$target")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")"
  fi
}

json_quote() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
  else
    printf '"%s"' "$1"
  fi
}

resolve_project() {
  local root="$1"
  local value="$2"
  local candidate

  if [[ -d "$value" ]]; then
    realpath_portable "$value"
    return
  fi

  candidate="$root/$value"
  if [[ -d "$candidate" ]]; then
    realpath_portable "$candidate"
    return
  fi

  candidate="$root/unity-projects/$value"
  if [[ -d "$candidate" ]]; then
    realpath_portable "$candidate"
    return
  fi

  die "Unity project not found: $value"
}

read_unity_version() {
  local project="$1"
  local version_file="$project/ProjectSettings/ProjectVersion.txt"
  [[ -f "$version_file" ]] || die "not a Unity project (missing ProjectSettings/ProjectVersion.txt): $project"
  sed -n 's/^m_EditorVersion:[[:space:]]*//p' "$version_file" | head -n 1
}

normalize_unity_executable() {
  local value="$1"
  if [[ -d "$value" && "$value" == *.app ]]; then
    value="$value/Contents/MacOS/Unity"
  fi
  [[ -x "$value" ]] || die "Unity executable is not executable: $value"
  realpath_portable "$value"
}

to_unix_path() {
  # Windows paths (C:\Editor) only work as bash test/exec targets once converted.
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1" 2>/dev/null || printf '%s' "$1"
  else printf '%s' "$1"; fi
}

# Unity Hub can install editors outside the default root; it records that choice here.
hub_secondary_install_path() {
  local cfg
  cfg="$(to_unix_path "${APPDATA:-}")/UnityHub/secondaryInstallPath.json"
  [[ -f "$cfg" ]] || return 0
  node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof p==="string"&&p)process.stdout.write(p)}catch{}' "$cfg" 2>/dev/null
}

find_unity() {
  local version="$1"
  local override="${UNITY_EDITOR:-}"
  local candidate secondary

  if [[ -n "$override" ]]; then
    normalize_unity_executable "$override"
    return
  fi

  # macOS (Unity Hub default), then Windows: Hub default root, Hub secondary root, and the
  # common Program Files layouts. Linux Hub installs land under ~/Unity/Hub/Editor.
  local -a candidates=(
    "/Applications/Unity/Hub/Editor/$version/Unity.app/Contents/MacOS/Unity"
    "$HOME/Unity/Hub/Editor/$version/Editor/Unity"
  )

  secondary="$(hub_secondary_install_path || true)"
  if [[ -n "$secondary" ]]; then
    candidates+=("$(to_unix_path "$secondary")/$version/Editor/Unity.exe")
  fi
  if [[ -n "${PROGRAMFILES:-}" ]]; then
    candidates+=("$(to_unix_path "$PROGRAMFILES")/Unity/Hub/Editor/$version/Editor/Unity.exe")
  fi
  candidates+=("/c/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe")

  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      realpath_portable "$candidate"
      return
    fi
  done

  die "Unity $version not found. Install it in Unity Hub or set UNITY_EDITOR=/path/to/Unity."
}

wait_for_bridge() {
  local root="$1"
  local project="$2"
  local timeout_s="$3"
  local assert_compile_clean="$4"
  local skip_build="$5"
  local smoke_log
  local deadline
  local status=1

  smoke_log="$(mktemp "${TMPDIR:-/tmp}/loomtide-unity-smoke.XXXXXX")"

  if [[ "$skip_build" != "true" ]]; then
    (cd "$root/mcp-server" && npm run build)
  elif [[ ! -f "$root/mcp-server/dist/index.js" ]]; then
    die "mcp-server/dist/index.js is missing; rerun without --skip-build or build mcp-server first."
  fi

  deadline=$((SECONDS + timeout_s))
  echo "open-project: waiting for Loomtide MCP bridge (timeout ${timeout_s}s)"
  while (( SECONDS <= deadline )); do
    if LOOMTIDE_UNITY_PROJECT="$project" \
      LOOMTIDE_TARGET_PROJECT_PATH="$project" \
      node "$root/scripts/phase3-mcp-smoke.mjs" --expect-connected ${assert_compile_clean:+--assert-compile-clean} \
      >"$smoke_log" 2>&1; then
      cat "$smoke_log"
      rm -f "$smoke_log"
      return 0
    else
      # Capture the probe's status HERE. After a failed `if` with no `else`, bash sets `$?`
      # to 0, so `status=$?` below the `fi` made a timeout look like success to the caller.
      status=$?
    fi
    sleep 3
  done

  echo "open-project: Unity launched, but MCP bridge was not routable before timeout." >&2
  echo "open-project: pinned project: $project" >&2
  echo "open-project: last smoke output:" >&2
  sed -n '1,160p' "$smoke_log" >&2 || true
  rm -f "$smoke_log"
  # Never report success from this path: a routability timeout is a failure for callers/CI.
  [[ "${status:-1}" -ne 0 ]] && return "$status"
  return 1
}

main() {
  local root
  local project_arg=""
  local timeout_s=180
  local unity_override=""
  local assert_compile_clean=""
  local skip_build=false
  local no_wait=false
  local no_launch=false
  local print_command=false

  root="$(repo_root)"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --timeout)
        [[ $# -ge 2 ]] || die "--timeout requires seconds"
        timeout_s="$2"
        shift 2
        ;;
      --unity)
        [[ $# -ge 2 ]] || die "--unity requires a path"
        unity_override="$2"
        shift 2
        ;;
      --assert-compile-clean)
        assert_compile_clean=1
        shift
        ;;
      --skip-build)
        skip_build=true
        shift
        ;;
      --no-wait)
        no_wait=true
        shift
        ;;
      --no-launch)
        no_launch=true
        shift
        ;;
      --print-command)
        print_command=true
        shift
        ;;
      --*)
        die "unknown option: $1"
        ;;
      *)
        if [[ -n "$project_arg" ]]; then
          die "only one project may be supplied (got '$project_arg' and '$1')"
        fi
        project_arg="$1"
        shift
        ;;
    esac
  done

  [[ -n "$project_arg" ]] || { usage >&2; exit 2; }
  [[ "$timeout_s" =~ ^[0-9]+$ ]] || die "--timeout must be an integer number of seconds"

  local project
  local version
  local unity
  local launch_log
  local project_name

  project="$(resolve_project "$root" "$project_arg")"
  version="$(read_unity_version "$project")"
  [[ -n "$version" ]] || die "could not read m_EditorVersion from $project/ProjectSettings/ProjectVersion.txt"

  project_name="$(basename "$project")"
  launch_log="${LOOMTIDE_UNITY_LAUNCH_LOG:-/tmp/loomtide-unity-${project_name}.log}"

  if [[ "$no_launch" != "true" || "$print_command" == "true" ]]; then
    if [[ -n "$unity_override" ]]; then
      unity="$(normalize_unity_executable "$unity_override")"
    else
      unity="$(find_unity "$version")"
    fi
  fi

  if [[ "$print_command" == "true" ]]; then
    printf '%s -projectPath %s\n' "$(json_quote "$unity")" "$(json_quote "$project")"
    exit 0
  fi

  if [[ "$no_launch" != "true" ]]; then
    echo "open-project: launching Unity $version"
    echo "open-project: project=$project"
    echo "open-project: editor=$unity"
    echo "open-project: log=$launch_log"
    nohup "$unity" -projectPath "$project" >"$launch_log" 2>&1 &
    disown || true
  else
    echo "open-project: not launching; waiting for existing editor for $project"
  fi

  if [[ "$no_wait" == "true" ]]; then
    echo "open-project: launch requested; skipping MCP wait (--no-wait)"
    exit 0
  fi

  wait_for_bridge "$root" "$project" "$timeout_s" "$assert_compile_clean" "$skip_build"
}

main "$@"
