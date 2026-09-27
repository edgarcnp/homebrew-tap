#!/bin/bash
set -Eeuo pipefail

# Pins the two builder image references in packaging/builder/pins.json, the file
# the AppImage build workflow's detect job reads for the build container. Run by
# the builder workflow's pin job after it pushes new images; see
# packaging/README.md ("Build model"). The file lives outside .github/workflows/
# on purpose: a PAT without the `workflow` scope can commit it.
#
# Usage: pin-builder-image.sh <pins-file> <base-ref> <webkit-ref>
# Each ref is ghcr.io/edgarcnp/fbr-builder-<variant>:<tag>@sha256:<64 hex>.
# Validates both the refs and the file's reference counts before writing, so a
# failure leaves the file untouched.

info() { printf '[INFO] %s\n' "$*" >&2; }
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

# The JSON string value after "<variant>":, up to the closing quote.
ref_pattern() {
  printf '%s' "\"$1\": \"[^\"]+\""
}

count_refs() {
  grep -oE "$(ref_pattern "$2")" "$1" | wc -l | tr -d ' ' || true
}

replace_ref() {
  local file="$1" variant="$2" ref="$3" pattern replacement
  pattern="$(ref_pattern "${variant}")"
  replacement="\"${variant}\": \"${ref}\""
  sed -i -E "s|${pattern}|${replacement}|" "${file}"
}

main() {
  local file="${1:-}" base_ref="${2:-}" webkit_ref="${3:-}"
  if [[ -z "${file}" ]] || [[ -z "${base_ref}" ]] || [[ -z "${webkit_ref}" ]]
  then
    error "usage: pin-builder-image.sh <pins-file> <base-ref> <webkit-ref>"
  fi
  [[ -f "${file}" ]] || error "no such pins file: ${file}"

  local suffix='[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+@sha256:[0-9a-f]{64}'
  [[ "${base_ref}" =~ ^ghcr\.io/edgarcnp/fbr-builder-base:${suffix}$ ]] ||
    error "base ref is not a pinned fbr-builder-base reference: ${base_ref}"
  [[ "${webkit_ref}" =~ ^ghcr\.io/edgarcnp/fbr-builder-webkit:${suffix}$ ]] ||
    error "webkit ref is not a pinned fbr-builder-webkit reference: ${webkit_ref}"

  local base_count webkit_count
  base_count="$(count_refs "${file}" base)"
  webkit_count="$(count_refs "${file}" webkit)"
  [[ "${base_count}" = "1" ]] ||
    error "expected exactly one base reference in ${file}, found ${base_count}"
  [[ "${webkit_count}" = "1" ]] ||
    error "expected exactly one webkit reference in ${file}, found ${webkit_count}"

  replace_ref "${file}" base "${base_ref}"
  replace_ref "${file}" webkit "${webkit_ref}"
  info "pinned base to ${base_ref}"
  info "pinned webkit to ${webkit_ref}"
}

main "$@"
