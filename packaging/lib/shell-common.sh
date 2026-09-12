#!/bin/bash

# Shared bash primitives for the in-tap build scripts: logging, scratch/work
# directory handling, path guards, architecture mapping, payload permission
# normalization and the post-build smoke test. Sourced by
# appimage-pipeline.sh; not used directly by app build scripts.
# shellcheck disable=SC2154 # globals are provided by the sourcing script
(return 0 2>/dev/null) || exit 1

info() {
  printf '[INFO] %s\n' "$*" >&2
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

# Requires callers to run under `set -Eeuo pipefail`; error() exits and
# `set -E` makes the failure visible to the caller's ERR trap.
error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

# Sets WORK_DIR (global) from WORK_DIR_OVERRIDE or a fresh temp dir; installs
# a cleanup trap unless the caller owns the dir via WORK_DIR_OVERRIDE.
setup_work_dir() {
  local prefix="$1"
  WORK_DIR="${WORK_DIR_OVERRIDE:-$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")}" || error "mktemp failed"
  if [[ -z "${WORK_DIR_OVERRIDE:-}" ]]
  then
    # Clean up the temp dir we created; an explicit WORK_DIR_OVERRIDE is
    # caller-owned and left alone.
    trap 'rm -rf -- "${WORK_DIR}"' EXIT
  fi
}

# Validates an absolute, non-root override path (WORK_DIR_OVERRIDE and
# DIST_DIR_OVERRIDE style).
validate_absolute_override() {
  local value="$1"
  local label="$2"
  [[ "${value}" == /* ]] || error "${label} must be absolute: ${value}"
  [[ "${value}" != "/" ]] || error "refusing ${label}=/"
}

# Resolves APPDIR from APPIMAGE_APPDIR_OVERRIDE or the default inside
# DIST_DIR, refusing repo/dist roots and paths escaping DIST_DIR. Echoes the
# resolved path.
resolve_appdir_override() {
  local repo_dir="$1"
  local dist_dir="$2"
  local override="${APPIMAGE_APPDIR_OVERRIDE:-}"
  if [[ -n "${override}" ]]
  then
    [[ "${override}" == /* ]] || error "APPIMAGE_APPDIR_OVERRIDE must be absolute: ${override}"
    [[ "${override}" != "/" && "${override}" != "${repo_dir}" && "${override}" != "${dist_dir}" ]] || error "refusing to operate on suspicious APPIMAGE_APPDIR_OVERRIDE"
    printf '%s\n' "${override}"
    return 0
  fi
  local default="${dist_dir}/appimage.AppDir"
  [[ "${default#"${dist_dir}/"}" != "${default}" ]] || error "APPDIR must be inside DIST_DIR: ${default}"
  [[ "${default}" != "${repo_dir}" && "${default}" != "${dist_dir}" ]] || error "refusing to operate on suspicious APPDIR"
  printf '%s\n' "${default}"
}

validate_package_version() {
  local version="${1:-}"
  [[ -n "${version}" ]] || error "PACKAGE_VERSION is empty"
  [[ "${version}" != *[/\\]* ]] || error "PACKAGE_VERSION contains path separator"
}

ensure_file_exists() {
  local path="$1"
  local label="$2"
  [[ -f "${path}" ]] || error "Missing ${label}: ${path}"
}

# Echoes "<deb_arch> <appimage_arch>" for the TARGET_ARCH global.
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

normalize_package_payload_permissions() {
  local root="$1"

  [[ -d "${root}" ]] || error "Missing package root: ${root}"
  # Requires GNU find for -perm /... semantics.
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

  [[ "${SMOKE_TIMEOUT:-20}" =~ ^[0-9]+$ ]] || SMOKE_TIMEOUT=20
  local timeout_seconds="${SMOKE_TIMEOUT:-20}"

  info "Smoke testing: ${appimage}"
  if command -v xvfb-run >/dev/null 2>&1
  then
    output="$(APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a timeout -k 5 "${timeout_seconds}" "${appimage}" --no-sandbox 2>&1 || true)"
  else
    output="$(APPIMAGE_EXTRACT_AND_RUN=1 timeout -k 5 "${timeout_seconds}" "${appimage}" --no-sandbox 2>&1 || true)"
  fi

  if grep -Eq 'symbol lookup error|undefined symbol|error while loading shared libraries|cannot open shared object|Cannot mount AppImage|AppRun not found|Failed to execute dwarfsextract' <<<"${output}"
  then
    error "$(printf 'Smoke test failed: loader errors in %s\n%s' "${appimage}" "${output}")"
  fi
  info "Smoke test passed: ${appimage}"
}
