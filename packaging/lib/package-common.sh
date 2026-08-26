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

# Echoes "<deb_arch> <appimage_arch>" for the TARGET_ARCH global set by the
# sourcing script.
map_arch() {
  case "${TARGET_ARCH}" in
    amd64 | x86_64)
      echo "amd64 x86_64"
      ;;
    arm64 | aarch64)
      echo "arm64 aarch64"
      ;;
    *) error "Unsupported AppImage architecture: ${TARGET_ARCH} (upstream packages support amd64 and arm64 only)" ;;
  esac
}

resolve_appimagetool() {
  if [[ -n "${APPIMAGETOOL:-}" ]]
  then
    [[ -x "${APPIMAGETOOL}" ]] || error "APPIMAGETOOL is not executable: ${APPIMAGETOOL}"
    printf '%s\n' "${APPIMAGETOOL}"
    return 0
  fi

  command -v appimagetool >/dev/null 2>&1 || error "appimagetool is required.
Install appimagetool or set APPIMAGETOOL=/path/to/appimagetool."
  command -v appimagetool
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

  local tmp_target
  tmp_target="$(mktemp "${target}.tmp.XXXXXX")"
  sed \
    -e "s/__PACKAGE_NAME__/${package_name}/g" \
    -e "s/__PACKAGE_DISPLAY_NAME__/${display_name}/g" \
    -e "s/__PACKAGE_COMMENT__/${comment}/g" \
    -e "s/__VERSION__/${version}/g" \
    -- "${source}" >"${tmp_target}" || {
    rm -f -- "${tmp_target}"
    error "render_template: failed to render ${source}"
  }
  mv -- "${tmp_target}" "${target}" || {
    rm -f -- "${tmp_target}"
    error "render_template: failed to move rendered template into place"
  }
}

normalize_package_payload_permissions() {
  local root="$1"

  [[ -d "${root}" ]] || error "Missing package root: ${root}"
  find "${root}" -type d -exec chmod 0755 {} +
  find "${root}" -type f \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0755 {} +
  find "${root}" -type f ! \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0644 {} +
}

# Runs the built AppImage briefly, headless, and fails on dynamic-loader
# errors (missing shared libraries, unresolved symbols). Mirrors pkgforge's
# quick-sharun --simple-test release gate. Uses xvfb-run when available.
# APPIMAGE_EXTRACT_AND_RUN=1 forces extraction so the gate never depends on
# FUSE availability in CI. Override the kill timeout with SMOKE_TIMEOUT
# (default 20s).
smoke_test_appimage() {
  local appimage="$1"
  local output

  [[ -f "${appimage}" ]] || error "Smoke test: missing AppImage: ${appimage}"
  [[ -x "${appimage}" ]] || error "Smoke test: AppImage is not executable: ${appimage}"

  local SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-20}"

  info "Smoke testing: ${appimage}"
  if command -v xvfb-run >/dev/null 2>&1
  then
    output="$(APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a timeout "${SMOKE_TIMEOUT}" "${appimage}" --no-sandbox 2>&1 || true)"
  else
    output="$(APPIMAGE_EXTRACT_AND_RUN=1 timeout "${SMOKE_TIMEOUT}" "${appimage}" --no-sandbox 2>&1 || true)"
  fi

  if grep -Eq 'symbol lookup error|undefined symbol|error while loading shared libraries|cannot open shared object|Cannot mount AppImage|AppRun not found|Failed to execute dwarfsextract' <<<"${output}"
  then
    error "$(printf 'Smoke test failed: loader errors in %s\n%s' "${appimage}" "${output}")"
  fi
  info "Smoke test passed: ${appimage}"
}
