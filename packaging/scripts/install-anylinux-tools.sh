#!/bin/bash
set -Eeuo pipefail

# Downloads the pkgforge Anylinux build tools pinned to a commit of
# pkgforge-dev/Anylinux-AppImages, verifying SHA-256 before install.
# Must run inside the Arch Linux container used by the CI build job.
#
# PINNED_COMMIT below tracks Anylinux-AppImages main. Renovate owns it
# (renovate.json customManagers) but cannot recompute the two hashes, so
# update them in the same PR, from that same commit - the check prints the
# hash it measured.
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
PINNED_COMMIT="ae05e80a7fe2e91488e10871deb6d3e07d9652f8"
BASE_URL="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/${PINNED_COMMIT}/useful-tools"
declare -A TOOLS=(
  ["quick-sharun"]=87b385f17f2b1d1d4cd75d869937c2ab4dc3952a09b693aef8bad3803e42bb84
  ["get-debloated-pkgs"]=463605f27db37f67252108ab47eb673ecb07ff30c22c9561a0c0b4063075c528
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
