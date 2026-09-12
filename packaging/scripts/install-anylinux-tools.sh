#!/bin/bash
set -Eeuo pipefail

# Downloads the pkgforge Anylinux build tools pinned to a commit of
# pkgforge-dev/Anylinux-AppImages, verifying SHA-256 before install.
# Must run inside the Arch Linux container used by the CI build job.
#
# Pinned commit: eefb8bed88f227bf7d29d3d0c5c816c2b4c5fdf4
# (Anylinux-AppImages main, 2026-09-12). Bumps are manual PRs: update the
# commit and the two hashes below together, from the same commit.
# Since the restructure, quick-sharun ships prebuilt helper libs
# (sharun+helper-libs-$ARCH.tar from Anylinux-sharun releases) instead of
# compiling useful-tools/lib/anylinux.c, which upstream deleted.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

ANYLINUX_TOOLS_DIR="${ANYLINUX_TOOLS_DIR:-/usr/local/bin}"
PINNED_COMMIT="eefb8bed88f227bf7d29d3d0c5c816c2b4c5fdf4"
BASE_URL="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/${PINNED_COMMIT}/useful-tools"
declare -A TOOLS=(
  ["quick-sharun"]=d5f0a8c902b859d9f3d6dc3ad78c1df8133ec3a2a8add7ec164279e0089529f6
  ["get-debloated-pkgs"]=a0ca19c479e0dd40e0c37f5e53fc4e61a75c302d6025a5aef6e144a2eef4daad
)

mkdir -p -- "${ANYLINUX_TOOLS_DIR}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/anylinux-tools.XXXXXX")"
trap 'rm -rf -- "${tmp_dir}"' EXIT

for name in "${!TOOLS[@]}"
do
  expected="${TOOLS[${name}]}"
  dest="${tmp_dir}/${name}"
  info "Downloading ${name} from pinned commit ${PINNED_COMMIT}"
  curl -fL --retry 5 --retry-all-errors --retry-delay 5 -o "${dest}" "${BASE_URL}/${name}.sh"
  actual="$(sha256sum "${dest}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]
  then
    error "SHA256 mismatch for ${name}: expected ${expected}, got ${actual}"
  fi
  chmod 0755 -- "${dest}"
  mv -- "${dest}" "${ANYLINUX_TOOLS_DIR}/${name}"
  info "Installed ${ANYLINUX_TOOLS_DIR}/${name}"
done
