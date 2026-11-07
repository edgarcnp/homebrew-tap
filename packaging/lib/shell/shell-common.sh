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

# True while <pid> is a live process; a zombie has already exited.
smoke_process_running() {
  local stat_file="/proc/$1/stat"
  local line
  [[ -r "${stat_file}" ]] || return 1
  IFS= read -r line <"${stat_file}" 2>/dev/null || return 1
  [[ "${line##*) }" != Z* ]]
}

# Zombies among <root>'s descendants, one pid per line. Read from /proc so the
# gate needs no procps in the builder image.
smoke_defunct_descendants() {
  local root="$1"
  local -A parent_of=() state_of=()
  local stat_file line pid rest candidate node depth
  for stat_file in /proc/[0-9]*/stat
  do
    [[ -r "${stat_file}" ]] || continue
    IFS= read -r line <"${stat_file}" 2>/dev/null || continue
    pid="${line%% *}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    # the state and parent fields follow "<pid> (<comm>) "
    rest="${line##*) }"
    state_of["${pid}"]="${rest%% *}"
    rest="${rest#* }"
    parent_of["${pid}"]="${rest%% *}"
  done
  for candidate in "${!state_of[@]}"
  do
    [[ "${state_of[${candidate}]}" = "Z" ]] || continue
    node="${parent_of[${candidate}]:-}"
    depth=0
    while [[ -n "${node}" && "${node}" != "0" && "${depth}" -lt 128 ]]
    do
      if [[ "${node}" = "${root}" ]]
      then
        printf '%s\n' "${candidate}"
        break
      fi
      node="${parent_of[${node}]:-}"
      depth=$((depth + 1))
    done
  done
}

# Runs the built AppImage headless and fails on dynamic-loader errors and on a
# launcher that never gets past its own dead child, mirroring quick-sharun
# --simple-test. Extra arguments are passed to the app itself (an Electron
# payload needs --no-sandbox headless). APPIMAGE_EXTRACT_AND_RUN=1 avoids a
# FUSE dependency; SMOKE_TIMEOUT (default 20s) sets the kill timeout.
#
# The child check covers the case where a repackaged app leaves the build
# looking healthy while nothing opens: the app's CLI spawns the real binary,
# that binary dies at startup, and the CLI waits on the corpse — the processes
# stay for the whole window and the loader message goes to the dead child's
# stderr, so no captured output tells the story (Zed 1.27.0 on a host glibc
# older than the bundled one). A child that exits on the way up is normal, so
# a pid has to stay defunct for SMOKE_DEFUNCT_SECONDS (default 3) first.
smoke_test_appimage() {
  local appimage="$1"
  shift
  local -a launch_args=("$@")
  local output_file output

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
  [[ "${SMOKE_DEFUNCT_SECONDS:-3}" =~ ^[0-9]+$ ]] || SMOKE_DEFUNCT_SECONDS=3
  local defunct_seconds="${SMOKE_DEFUNCT_SECONDS:-3}"

  info "Smoke testing: ${appimage}"
  output_file="$(mktemp "${TMPDIR:-/tmp}/fbr-smoke.XXXXXX")" || error "mktemp failed for the smoke output"
  local -a runner=()
  if command -v xvfb-run >/dev/null 2>&1
  then
    runner=(xvfb-run -a)
  fi
  # In the background so the tree can be watched while it runs; the timeout
  # still bounds the whole window.
  APPIMAGE_EXTRACT_AND_RUN=1 "${runner[@]}" timeout -k 5 "${timeout_seconds}" \
    "${appimage}" "${launch_args[@]}" >"${output_file}" 2>&1 &
  local runner_pid=$!

  local -A first_seen=()
  local elapsed=0 stuck="" pid since
  while [[ -z "${stuck}" ]] && smoke_process_running "${runner_pid}"
  do
    sleep 1
    elapsed=$((elapsed + 1))
    for pid in $(smoke_defunct_descendants "${runner_pid}")
    do
      first_seen["${pid}"]="${first_seen[${pid}]:-${elapsed}}"
      since="${first_seen[${pid}]}"
      if ((elapsed - since >= defunct_seconds))
      then
        stuck="${pid}"
        break
      fi
    done
  done
  # A stuck child is a verdict already: stop the window instead of waiting out
  # the timeout, so the build fails on the finding rather than on the clock.
  if [[ -n "${stuck}" ]]
  then
    kill "${runner_pid}" 2>/dev/null || true
  fi
  wait "${runner_pid}" 2>/dev/null || true

  output="$(cat -- "${output_file}" 2>/dev/null || true)"
  rm -f -- "${output_file}"

  if [[ -n "${stuck}" ]]
  then
    # The launcher is waiting on a child that already exited, so the window
    # this gate exists to see never opened, and a re-run cannot fix it.
    classify_failure SMOKE_FAILED "smoke test: unreaped child"
    error "$(printf 'Smoke test failed: %s kept pid %s defunct for %ss or more, so its parent is waiting on a process that already exited\n%s' \
      "${appimage}" "${stuck}" "${defunct_seconds}" "${output}")"
  fi

  if grep -Eq 'symbol lookup error|undefined symbol|error while loading shared libraries|cannot open shared object|Cannot mount AppImage|AppRun not found|Failed to execute dwarfsextract' <<<"${output}"
  then
    # The artifact is broken, not the runner: permanent, so the record must not
    # invite a re-run of the same build.
    classify_failure SMOKE_FAILED "smoke test: loader errors"
    error "$(printf 'Smoke test failed: loader errors in %s\n%s' "${appimage}" "${output}")"
  fi
  info "Smoke test passed: ${appimage}"
}
