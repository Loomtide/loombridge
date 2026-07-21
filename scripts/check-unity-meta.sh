#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "${1:-$default_repo_root}" && pwd)"

package_root="$repo_root/packages/com.loomtide.loombridge"
asset_roots=( "$repo_root"/unity-projects/*/Assets )

missing_meta=()
orphaned_meta=()
scanned_roots=()

add_missing_meta() {
  local path="$1"
  missing_meta+=("${path#$repo_root/}")
}

add_orphaned_meta() {
  local path="$1"
  orphaned_meta+=("${path#$repo_root/}")
}

is_hidden_path() {
  local path="$1"
  [[ "$path" =~ /\.[^/]+(/|$) ]]
}

check_files_have_meta() {
  local root="$1"
  shift

  while IFS= read -r -d '' path; do
    is_hidden_path "$path" && continue
    [[ "$path" == *.meta ]] && continue
    if [[ ! -f "${path}.meta" ]]; then
      add_missing_meta "$path"
    fi
  done < <(find "$root" "$@" -type f ! -name ".*" -print0)
}

check_directories_have_meta() {
  local root="$1"

  while IFS= read -r -d '' path; do
    is_hidden_path "$path" && continue
    [[ "$path" == "$root" ]] && continue
    if [[ ! -f "${path}.meta" ]]; then
      add_missing_meta "$path"
    fi
  done < <(find "$root" -type d ! -name ".*" -print0)
}

check_orphaned_meta() {
  local root="$1"

  while IFS= read -r -d '' path; do
    is_hidden_path "$path" && continue
    target="${path%.meta}"
    if [[ ! -e "$target" ]]; then
      add_orphaned_meta "$path"
    fi
  done < <(find "$root" -type f -name "*.meta" -print0)
}

if [[ -d "$package_root" ]]; then
  scanned_roots+=("${package_root#$repo_root/}")
  # Unity package conventions: package.json and folders suffixed with "~" are not imported assets.
  check_files_have_meta \
    "$package_root" \
    ! -path "*/Documentation~/*" \
    ! -path "*/Samples~/*" \
    ! -name "package.json"
  check_orphaned_meta "$package_root"
fi

if [[ ${#asset_roots[@]} -eq 0 ]]; then
  echo "unity-projects/*/Assets not found; skipping Unity metadata check."
  exit 0
fi

for assets_root in "${asset_roots[@]}"; do
  [[ -d "$assets_root" ]] || continue
  scanned_roots+=("${assets_root#$repo_root/}")
  check_files_have_meta "$assets_root"
  check_directories_have_meta "$assets_root"
  check_orphaned_meta "$assets_root"
done

if [[ ${#scanned_roots[@]} -eq 0 ]]; then
  echo "No Unity metadata roots found."
  exit 0
fi

if [[ ${#missing_meta[@]} -eq 0 && ${#orphaned_meta[@]} -eq 0 ]]; then
  echo "Checked Unity metadata roots:"
  printf '  - %s\n' "${scanned_roots[@]}"
  echo "Unity metadata check passed."
  exit 0
fi

echo "Checked Unity metadata roots:"
printf '  - %s\n' "${scanned_roots[@]}"

if [[ ${#missing_meta[@]} -gt 0 ]]; then
  echo "Missing Unity .meta files for:"
  printf '  - %s\n' "${missing_meta[@]}"
fi

if [[ ${#orphaned_meta[@]} -gt 0 ]]; then
  echo "Orphaned Unity .meta files without matching asset/folder:"
  printf '  - %s\n' "${orphaned_meta[@]}"
fi

echo
echo "Regenerate metadata in Unity and commit asset + .meta together."
exit 1
