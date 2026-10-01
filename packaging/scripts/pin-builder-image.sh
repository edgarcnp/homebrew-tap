#!/bin/bash
set -Eeuo pipefail

# Pins the base builder image reference in packaging/builder/pins.json, the file
# the AppImage build workflow's detect job reads for the build container. Run by
# the builder workflow's pin job after it pushes a new image; see
# packaging/README.md ("Build model"). The file lives outside .github/workflows/
# on purpose: a PAT without the `workflow` scope can commit it.
#
# Usage: pin-builder-image.sh <pins-file> <image-ref>
# The ref is ghcr.io/edgarcnp/fbr-builder-base:<tag>@sha256:<64 hex>.
# Validates the ref and the file's reference count before writing, so a failure
# leaves the file untouched.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

# The JSON string value after "image":, up to the closing quote.
ref_pattern() {
  printf '%s' "\"image\": \"[^\"]+\""
}

count_refs() {
  grep -oE "$(ref_pattern)" "$1" | wc -l | tr -d ' ' || true
}

replace_ref() {
  local file="$1" ref="$2"
  sed -i -E "s|\"image\": \"[^\"]+\"|\"image\": \"${ref}\"|" "${file}"
}

main() {
  local file="${1:-}" image_ref="${2:-}"
  if [[ -z "${file}" ]] || [[ -z "${image_ref}" ]]
  then
    error "usage: pin-builder-image.sh <pins-file> <image-ref>"
  fi
  [[ -f "${file}" ]] || error "no such pins file: ${file}"

  local suffix='[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+@sha256:[0-9a-f]{64}'
  [[ "${image_ref}" =~ ^ghcr\.io/edgarcnp/fbr-builder-base:${suffix}$ ]] ||
    error "image ref is not a pinned fbr-builder-base reference: ${image_ref}"

  local count
  count="$(count_refs "${file}")"
  [[ "${count}" = "1" ]] ||
    error "expected exactly one image reference in ${file}, found ${count}"

  replace_ref "${file}" "${image_ref}"
  info "pinned image to ${image_ref}"
}

main "$@"
