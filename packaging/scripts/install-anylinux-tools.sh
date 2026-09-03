#!/bin/bash
set -Eeuo pipefail

# Downloads the pkgforge Anylinux build tools pinned to a commit of
# pkgforge-dev/Anylinux-AppImages, verifying SHA-256 before install.
# Must run inside the Arch Linux container used by the CI build job.
#
# Pinned commit: 3201fb3e48a35d76d750560e11f96bca2f3b6fe0
# (Anylinux-AppImages main, 2026-09-02). Bumps are manual PRs: update the
# commit and the two hashes below together, from the same commit.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

ANYLINUX_TOOLS_DIR="${ANYLINUX_TOOLS_DIR:-/usr/local/bin}"
PINNED_COMMIT="3201fb3e48a35d76d750560e11f96bca2f3b6fe0"
BASE_URL="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/${PINNED_COMMIT}/useful-tools"
declare -A TOOLS=(
  ["quick-sharun"]=564f686f9eb8d08676fe1bfd5ef49049e362576ccc0bb04c0538d595b7fd1bc9
  ["get-debloated-pkgs"]=946cfc8c40b518bad9d9b5597869f46394bb4111a4ac40acdccf17c8bb46fc1f
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
