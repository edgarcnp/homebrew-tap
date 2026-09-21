#!/bin/bash
set -Eeuo pipefail

# Downloads the pkgforge Anylinux build tools, pinned to a commit of
# pkgforge-dev/Anylinux-AppImages. Runs inside the Arch container used by CI.
#
# PINNED_COMMIT tracks main and is owned by Renovate. The URL is addressed by
# that digest, so it fixes the exact bytes of every tool — including what
# quick-sharun fetches for itself — with no separate SHA-256 to co-update.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

ANYLINUX_TOOLS_DIR="${ANYLINUX_TOOLS_DIR:-/usr/local/bin}"
PINNED_COMMIT="05d6f47d723abd45eac6568fa8a2335c9663783f"
BASE_URL="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/${PINNED_COMMIT}/useful-tools"
declare -a TOOLS=(
  quick-sharun
  get-debloated-pkgs
)

mkdir -p -- "${ANYLINUX_TOOLS_DIR}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/anylinux-tools.XXXXXX")"
trap 'rm -rf -- "${tmp_dir}"' EXIT

for name in "${TOOLS[@]}"
do
  dest="${tmp_dir}/${name}"
  info "Downloading ${name} from pinned commit ${PINNED_COMMIT}"
  curl -fL --retry 5 --retry-all-errors --retry-delay 5 -o "${dest}" "${BASE_URL}/${name}.sh"
  test -s "${dest}" || error "${name} downloaded empty"
  chmod 0755 -- "${dest}"
  mv -- "${dest}" "${ANYLINUX_TOOLS_DIR}/${name}"
  info "Installed ${ANYLINUX_TOOLS_DIR}/${name}"
done
