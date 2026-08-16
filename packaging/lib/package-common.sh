#!/bin/bash

# Shared bash helpers for the in-tap packaging scripts; sourced by per-app
# build scripts, which set the PACKAGE_* vars before calling render_template.
# shellcheck disable=SC2154,SC2153 # globals are provided by the sourcing script
(return 0 2>/dev/null) || exit 1

info() {
  echo "[INFO] $*" >&2
}

warn() {
  echo "[WARN] $*" >&2
}

# Requires callers to run under `set -Eeuo pipefail`; error() exits and
# `set -E` makes the failure visible to the caller's ERR trap.
error() {
  echo "[ERROR] $*" >&2
  exit 1
}

ensure_file_exists() {
  local path="$1"
  local label="$2"
  [[ -f "${path}" ]] || error "Missing ${label}: ${path}"
}

sed_escape_replacement() {
  printf '%s' "$1" | sed -e ':a;$!N;$!ba;s/[\/&\\]/\\&/g;s/\n/\\n/g'
}

render_template() {
  local source="$1"
  local target="$2"
  local name
  local package_name
  local display_name
  local comment
  local version

  for name in PACKAGE_NAME PACKAGE_DISPLAY_NAME PACKAGE_COMMENT PACKAGE_VERSION
  do
    [[ -n "${!name:-}" ]] || error "render_template: ${name} is unset or empty"
  done

  package_name="$(sed_escape_replacement "${PACKAGE_NAME}")"
  display_name="$(sed_escape_replacement "${PACKAGE_DISPLAY_NAME}")"
  comment="$(sed_escape_replacement "${PACKAGE_COMMENT}")"
  version="$(sed_escape_replacement "${PACKAGE_VERSION}")"

  sed \
    -e "s/__PACKAGE_NAME__/${package_name}/g" \
    -e "s/__PACKAGE_DISPLAY_NAME__/${display_name}/g" \
    -e "s/__PACKAGE_COMMENT__/${comment}/g" \
    -e "s/__VERSION__/${version}/g" \
    "${source}" >"${target}"
}

normalize_package_payload_permissions() {
  local root="$1"

  [[ -d "${root}" ]] || error "Missing package root: ${root}"
  find "${root}" -type d -exec chmod 0755 {} +
  find "${root}" -type f \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0755 {} +
  find "${root}" -type f ! \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0644 {} +
}
