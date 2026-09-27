#!/bin/bash

# Shared bash primitives for the build scripts: logging, work-dir handling,
# path guards, permission normalization and the post-build smoke test. Sourced
# by appimage-pipeline.sh.
# shellcheck disable=SC2154 # globals are provided by the sourcing script
(return 0 2>/dev/null) || exit 1

info() {
  printf '[INFO] %s\n' "$*" >&2
}

# Callers run under `set -Eeuo pipefail`; `set -E` makes this exit visible to
# the caller's ERR trap.
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
    # An explicit WORK_DIR_OVERRIDE is caller-owned and left alone.
    trap 'rm -rf -- "${WORK_DIR}"' EXIT
  fi
}

# Validates and normalizes an absolute, non-root override path
# (WORK_DIR_OVERRIDE and DIST_DIR_OVERRIDE style), echoing the normalized path
# so `..` cannot dodge the guards.
validate_absolute_override() {
  local value="$1"
  local label="$2"
  [[ "${value}" == /* ]] || error "${label} must be absolute: ${value}"
  local normalized
  normalized="$(realpath -m -- "${value}")" || error "cannot normalize ${label}: ${value}"
  [[ "${normalized}" != "/" ]] || error "refusing ${label}=/"
  printf '%s\n' "${normalized}"
}

# Resolves APPDIR from APPIMAGE_APPDIR_OVERRIDE or the default inside DIST_DIR.
# Both must be inside DIST_DIR once normalized, so an override cannot point the
# stage's rm -rf at a path reached through `..`.
resolve_appdir_override() {
  local repo_dir="$1"
  local dist_dir="$2"
  local override="${APPIMAGE_APPDIR_OVERRIDE:-}"
  local normalized_dist
  normalized_dist="$(realpath -m -- "${dist_dir}")" || error "cannot normalize DIST_DIR: ${dist_dir}"
  if [[ -n "${override}" ]]
  then
    [[ "${override}" == /* ]] || error "APPIMAGE_APPDIR_OVERRIDE must be absolute: ${override}"
    override="$(realpath -m -- "${override}")" || error "cannot normalize APPIMAGE_APPDIR_OVERRIDE: ${override}"
    [[ "${override}" == "${normalized_dist}/"* ]] || error "APPIMAGE_APPDIR_OVERRIDE must be inside DIST_DIR: ${override}"
    [[ "${override}" != "${normalized_dist}" ]] || error "refusing to operate on suspicious APPIMAGE_APPDIR_OVERRIDE"
    printf '%s\n' "${override}"
    return 0
  fi
  local default="${normalized_dist}/appimage.AppDir"
  [[ "${default}" != "${repo_dir}" && "${default}" != "${normalized_dist}" ]] || error "refusing to operate on suspicious APPDIR"
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

# Writes the machine-readable failure fragment the build workflow uploads with
# its run record (FBR_FAILURE_OUT, set by the workflow). A no-op outside CI, so
# a local build keeps failing loudly without inventing a record. The message is
# flattened and stripped of quotes/backslashes so the fragment stays one JSON
# line; callers pass ASCII messages without them anyway.
classify_failure() {
  local code="$1"
  local message="$2"
  [[ -n "${FBR_FAILURE_OUT:-}" ]] || return 0
  local flat
  flat="$(printf '%s' "${message}" | tr -d '\r\\"' | tr '\n' ' ')"
  printf '{"code":"%s","message":"%s"}\n' "${code}" "${flat}" >"${FBR_FAILURE_OUT}"
}

normalize_package_payload_permissions() {
  local root="$1"

  [[ -d "${root}" ]] || error "Missing package root: ${root}"
  # Requires GNU find for -perm /... semantics.
  find "${root}" -type d -exec chmod 0755 {} +
  find "${root}" -type f \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0755 {} +
  find "${root}" -type f ! \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0644 {} +
}

# Runs the built AppImage headless and fails on dynamic-loader errors, mirroring
# quick-sharun --simple-test. APPIMAGE_EXTRACT_AND_RUN=1 avoids a FUSE
# dependency; SMOKE_TIMEOUT (default 20s) sets the kill timeout.
smoke_test_appimage() {
  local appimage="$1"
  local output

  if [[ ! -f "${appimage}" ]]
  then
    classify_failure ARTIFACT_MISSING "smoke test: missing AppImage"
    error "Smoke test: missing AppImage: ${appimage}"
  fi
  if [[ ! -x "${appimage}" ]]
  then
    classify_failure ARTIFACT_MISSING "smoke test: AppImage is not executable"
    error "Smoke test: AppImage is not executable: ${appimage}"
  fi

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
    # The artifact is broken, not the runner: permanent, so the record must not
    # invite a re-dispatch of the same build.
    classify_failure SMOKE_FAILED "smoke test: loader errors"
    error "$(printf 'Smoke test failed: loader errors in %s\n%s' "${appimage}" "${output}")"
  fi
  info "Smoke test passed: ${appimage}"
}
