#!/bin/bash
# Fails unless an installed app left exactly one desktop entry: the one its
# cask installs. Homebrew's app_image artifact installs the entry packed into
# the AppImage and the cask's postflight writes its own, so a name mismatch
# hands the user two identical launchers while every file on its own still
# parses (a second entry named after the cask token beside a renamed one).
#
# Usage: check-desktop-entries.sh --app <app> [--applications-dir <dir>]
#   --app                descriptor whose entry name and binaries are the contract
#   --applications-dir   installed XDG applications directory
#                        (default: $HOMEBREW_XDG_DATA_HOME, $XDG_DATA_HOME or
#                        ~/.local/share, plus /applications)

set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."

app=""
applications_dir="${HOMEBREW_XDG_DATA_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}}/applications"
while [[ $# -gt 0 ]]
do
  case "$1" in
    --app)
      app="${2:-}"
      shift 2
      ;;
    --applications-dir)
      applications_dir="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
if [[ -z "${app}" ]]
then
  echo "missing --app" >&2
  exit 2
fi

descriptor="$(bun packaging/bin/fbr.ts descriptor --app "${app}")"
asset_prefix="$(jq -r '.assetPrefix' <<<"${descriptor}")"
launcher_entry="$(jq -r '(.desktopId // .cask) + ".desktop"' <<<"${descriptor}")"
# An app whose cask installs the payload's own entry (caskDesktopEntry) names it
# after that file; every other cask writes the generated entry.
payload_entry="$(jq -r '.caskDesktopEntry.from // empty' <<<"${descriptor}")"
if [[ -n "${payload_entry}" ]]
then
  expected="${payload_entry##*/}"
else
  expected="${launcher_entry}"
fi
mapfile -t binaries < <(jq -r '.binaryTargets[]' <<<"${descriptor}")

if [[ ! -d "${applications_dir}" ]]
then
  echo "${app}: no applications directory at ${applications_dir}" >&2
  exit 1
fi

# An entry belongs to the app when its Exec names one of the cask's binaries or
# the AppImage the app_image artifact installs.
mapfile -t found < <(
  for entry in "${applications_dir}"/*.desktop
  do
    [[ -e "${entry}" ]] || continue
    exec_line="$(grep -m1 '^Exec=' -- "${entry}" || true)"
    [[ -n "${exec_line}" ]] || continue
    for binary in "${binaries[@]}"
    do
      if [[ "${exec_line}" == *"/bin/${binary}"* ]]
      then
        printf '%s\n' "${entry##*/}"
        continue 2
      fi
    done
    if [[ "${exec_line}" == *"/${asset_prefix}-"* && "${exec_line}" == *".AppImage"* ]]
    then
      printf '%s\n' "${entry##*/}"
    fi
  done | LC_ALL=C sort
)

count="${#found[@]}"
if [[ "${count}" -eq 1 && "${found[0]}" = "${expected}" ]]
then
  echo "ok ${app}: ${expected}"
  exit 0
fi
if [[ "${count}" -eq 0 ]]
then
  echo "${app}: no desktop entry in ${applications_dir}" >&2
  exit 1
fi
if [[ "${count}" -eq 1 ]]
then
  echo "${app}: expected ${expected}, found ${found[0]}" >&2
  exit 1
fi
echo "${app}: ${count} desktop entries for one app: ${found[*]}" >&2
exit 1
