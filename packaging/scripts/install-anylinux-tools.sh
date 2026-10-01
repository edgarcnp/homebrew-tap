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
PINNED_COMMIT="75237dbb2e50a7b1cd11c2c3711fb39718f49822"
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
  # Single attempt: retries belong to the caller that re-dispatches CI runs.
  curl -fL -o "${dest}" "${BASE_URL}/${name}.sh" ||
    error "Failed to download ${name}"
  test -s "${dest}" ||
    error "Downloaded ${name} is empty"
  chmod 0755 -- "${dest}"
  mv -- "${dest}" "${ANYLINUX_TOOLS_DIR}/${name}"
  info "Installed ${ANYLINUX_TOOLS_DIR}/${name}"
done
