#!/bin/bash
set -Eeuo pipefail

# Downloads the pkgforge Anylinux build tools pinned to a commit of
# pkgforge-dev/Anylinux-AppImages. Must run inside the Arch Linux container
# used by the CI build job.
#
# PINNED_COMMIT below tracks Anylinux-AppImages main and is owned by Renovate
# (renovate.json customManagers). The download URL is addressed by that
# 40-character commit digest, which fixes the exact bytes of every tool, so
# there is no separate SHA-256 to co-update.
#
# Since the restructure, quick-sharun ships prebuilt helper libs
# (sharun+helper-libs-$ARCH.tar from Anylinux-sharun releases) instead of
# compiling useful-tools/lib/anylinux.c, which upstream deleted.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

ANYLINUX_TOOLS_DIR="${ANYLINUX_TOOLS_DIR:-/usr/local/bin}"
PINNED_COMMIT="a4e83228b35fc00884465522c429d4e380b8966a"
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
