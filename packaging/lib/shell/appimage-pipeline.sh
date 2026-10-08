#!/bin/bash

# The AppImage build pipeline, driven by the app descriptor. Every app's
# build.sh calls these stages in order; per-app behavior lives in app.json.
#
# Globals produced here (consumed below and by the caller):
#   APP_ID APP_JSON PACKAGE_NAME PACKAGE_VERSION
#   TARGET_ARCH DEB_ARCH APPIMAGE_ARCH
#   WORK_DIR DIST_DIR APPDIR METADATA_PATH PAYLOAD_PATH PAYLOAD_ROOT
#
# Requires: bash, jq, node (the fbr CLI), and the app's own tooling (dpkg-deb,
# quick-sharun, APPIMAGETOOL).
# shellcheck disable=SC2154 # globals are provided by pipeline_init
(return 0 2>/dev/null) || exit 1

PIPELINE_LIB_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_REPO_DIR="$(cd "${PIPELINE_LIB_DIR}/../../.." && pwd)"
FBR_ENTRY="${FBR_ENTRY:-${PIPELINE_REPO_DIR}/packaging/bin/fbr.ts}"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=lib/shell/shell-common.sh
. "${PIPELINE_LIB_DIR}/shell-common.sh"

fbr() {
  node "${FBR_ENTRY}" "$@"
}

descriptor_field() {
  jq -r "$1" <<<"${APP_JSON}"
}

# Loads and validates the descriptor, then resolves the build environment.
# Usage: pipeline_init <app-id>
pipeline_init() {
  APP_ID="$1"
  REPO_DIR="${PIPELINE_REPO_DIR}"
  ensure_file_exists "${FBR_ENTRY}" "fbr CLI"
  command -v jq >/dev/null 2>&1 || error "jq is required"
  APP_JSON="$(fbr descriptor --app "${APP_ID}")"

  PACKAGE_NAME="$(descriptor_field '.cask')"
  TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

  # The one arch mapping lives in fbr arch (core/architecture.ts).
  local arch_line
  arch_line="$(fbr arch --arch "${TARGET_ARCH}")"
  DEB_ARCH="${arch_line% *}"
  APPIMAGE_ARCH="${arch_line#* }"

  if [[ -n "${WORK_DIR_OVERRIDE:-}" ]]
  then
    WORK_DIR_OVERRIDE="$(validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE")"
  fi
  setup_work_dir "${APP_ID}-build"
  if [[ -n "${DIST_DIR_OVERRIDE:-}" ]]
  then
    DIST_DIR="$(validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE")"
  else
    DIST_DIR="${REPO_DIR}/dist"
  fi
  APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
  [[ -z "${PACKAGE_VERSION:-}" ]] || validate_package_version "${PACKAGE_VERSION}"

  info "Building ${APP_ID} for ${DEB_ARCH} (descriptor from packaging/apps/${APP_ID}/app.json)"
}

# Resolves the upstream payload and pins PACKAGE_VERSION.
pipeline_resolve() {
  info "Resolving ${APP_ID} for ${DEB_ARCH}"
  METADATA_PATH="${WORK_DIR}/metadata.json"
  # Forward the workflow's fragment path the way pipeline_neutralize does: a
  # classified resolve failure (upstream outage, checksum mismatch, guard) must
  # name itself in the run record instead of falling back to BUILD_FAILED.
  local -a resolve_args=(resolve
    --app "${APP_ID}"
    --arch "${DEB_ARCH}"
    --output-dir "${WORK_DIR}"
    --metadata "${METADATA_PATH}")
  if [[ -n "${FBR_FAILURE_OUT:-}" ]]
  then
    resolve_args+=(--failure-out "${FBR_FAILURE_OUT}")
  fi
  PAYLOAD_PATH="$(fbr "${resolve_args[@]}")"

  local resolved_version
  resolved_version="$(fbr metadata --file "${METADATA_PATH}" --field version)"
  if [[ -n "${PACKAGE_VERSION:-}" ]]
  then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved version ${resolved_version} != PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    validate_package_version "${PACKAGE_VERSION}"
  fi
  info "Resolved version ${PACKAGE_VERSION}"
}

# Unpacks the payload into PAYLOAD_ROOT: dpkg-deb -x for .deb payloads, the
# AppImage's own --appimage-extract (no FUSE needed) for upstream AppImages.
pipeline_extract() {
  local kind
  kind="$(descriptor_field '.payload.kind')"
  case "${kind}" in
    appimage-tree)
      local payload_dir="${WORK_DIR}/extracted"
      mkdir -p -- "${payload_dir}"
      chmod +x -- "${PAYLOAD_PATH}"
      (cd "${payload_dir}" && "${PAYLOAD_PATH}" --appimage-extract >/dev/null)
      PAYLOAD_ROOT="${payload_dir}/squashfs-root"
      [[ -d "${PAYLOAD_ROOT}" ]] || error "upstream AppImage extracted to no squashfs-root"
      ;;
    deb-tree | deb-files)
      local deb_payload="${WORK_DIR}/deb-payload"
      mkdir -p -- "${deb_payload}"
      local actual_arch
      actual_arch="$(dpkg-deb -f "${PAYLOAD_PATH}" Architecture)"
      [[ "${actual_arch}" = "${DEB_ARCH}" ]] || error "Package arch ${actual_arch} != requested ${DEB_ARCH}"
      dpkg-deb -x "${PAYLOAD_PATH}" "${deb_payload}"
      PAYLOAD_ROOT="${deb_payload}"
      ;;
    *)
      error "Unknown payload kind in descriptor: ${kind}"
      ;;
  esac
}

is_excluded_payload_entry() {
  local name="$1"
  local pattern
  while IFS= read -r pattern
  do
    [[ -n "${pattern}" ]] || continue
    # Intentional glob match: exclude entries are exact names or "*.ext" globs.
    # shellcheck disable=SC2053
    [[ "${name}" == ${pattern} ]] && return 0
  done < <(descriptor_field '.payload.exclude[]?')
  return 1
}

# An AppImage payload carries no arch metadata in its name, so verify the
# bytes: every ELF in AppDir/bin must carry the requested e_machine. Non-ELF
# entries (launcher scripts) are skipped. e_machine is the little-endian u16 at
# offset 18; its low byte identifies x86-64 (62) and aarch64 (183).
assert_bin_elf_arch() {
  local expected
  case "${APPIMAGE_ARCH}" in
    x86_64) expected=62 ;;
    aarch64) expected=183 ;;
    *) error "No ELF machine mapping for AppImage arch ${APPIMAGE_ARCH}" ;;
  esac
  local entry magic machine
  for entry in "${APPDIR}/bin/"*
  do
    [[ -f "${entry}" ]] || continue
    magic="$(head -c 4 -- "${entry}" | od -An -tx1 | tr -d ' \n')"
    [[ "${magic}" = "7f454c46" ]] || continue
    machine="$(od -An -tu1 -j 18 -N 1 -- "${entry}" | tr -d ' ')"
    if [[ "${machine}" != "${expected}" ]]
    then
      classify_failure GUARD_VIOLATION "payload binary ${entry} is not ${APPIMAGE_ARCH}"
      error "Payload binary ${entry} is not ${APPIMAGE_ARCH} (ELF machine ${machine})"
    fi
  done
}

# Stages the payload into AppDir/bin (and AppDir/usr when the descriptor moves
# the vendored usr/ to the AppDir root).
pipeline_stage() {
  local kind
  kind="$(descriptor_field '.payload.kind')"
  rm -rf -- "${APPDIR}"
  mkdir -p -- "${APPDIR}/bin" "${APPDIR}/share/applications" \
    "${APPDIR}/share/icons/hicolor/$(descriptor_field '.icon.size')/apps"

  case "${kind}" in
    deb-tree)
      local tree
      tree="$(descriptor_field '.payload.tree')"
      [[ -d "${PAYLOAD_ROOT}/${tree}" ]] || error "Missing payload tree: ${PAYLOAD_ROOT}/${tree}"
      cp -aT -- "${PAYLOAD_ROOT}/${tree}" "${APPDIR}/bin"
      ;;
    deb-files)
      local file
      while IFS= read -r file
      do
        ensure_file_exists "${PAYLOAD_ROOT}/${file}" "payload file ${file}"
        cp -a -- "${PAYLOAD_ROOT}/${file}" "${APPDIR}/bin/"
      done < <(descriptor_field '.payload.files[]')
      ;;
    appimage-tree)
      # Entry by entry, renaming the scoped executable and dropping the upstream
      # AppDir furniture this pipeline replaces.
      local entry name target move_usr
      move_usr="$(descriptor_field '.payload.moveUsrToRoot // false')"
      while IFS= read -r -d '' entry
      do
        name="$(basename -- "${entry}")"
        is_excluded_payload_entry "${name}" && continue
        # usr/ is copied to the AppDir root below, not into bin/.
        [[ "${name}" = "usr" && "${move_usr}" = "true" ]] && continue
        target="$(jq -r --arg name "${name}" \
          '(.payload.rename // {})[$name] // empty' <<<"${APP_JSON}")"
        if [[ -n "${target}" ]]
        then
          cp -a -- "${entry}" "${APPDIR}/bin/${target}"
        else
          cp -a -- "${entry}" "${APPDIR}/bin/"
        fi
      done < <(find "${PAYLOAD_ROOT}" -mindepth 1 -maxdepth 1 -print0)
      if [[ "${move_usr}" = "true" ]]
      then
        cp -a -- "${PAYLOAD_ROOT}/usr" "${APPDIR}/usr"
      fi
      assert_bin_elf_arch
      ;;
    *)
      error "Unknown payload kind in descriptor: ${kind}"
      ;;
  esac
}

# Neutralizes the app's own updater and fails when a declared endpoint survives.
pipeline_neutralize() {
  # FBR_FAILURE_OUT (set by the workflow) lets a surviving updater endpoint be
  # classified as UPDATER_RESIDUAL instead of the generic build failure the
  # step would otherwise record.
  if [[ -n "${FBR_FAILURE_OUT:-}" ]]
  then
    fbr neutralize --app "${APP_ID}" --appdir "${APPDIR}" --failure-out "${FBR_FAILURE_OUT}"
  else
    fbr neutralize --app "${APP_ID}" --appdir "${APPDIR}"
  fi
}

pipeline_render_desktop() {
  local desktop_file
  desktop_file="$(fbr render-desktop \
    --app "${APP_ID}" \
    --version "${PACKAGE_VERSION}" \
    --appdir "${APPDIR}")"
  cp -- "${desktop_file}" "${APPDIR}/share/applications/${PACKAGE_NAME}.desktop"
}

pipeline_install_icon() {
  local size upstream_icon name extension
  size="$(descriptor_field '.icon.size')"
  upstream_icon="${PAYLOAD_ROOT}/$(descriptor_field '.icon.source')"
  ensure_file_exists "${upstream_icon}" "upstream icon"
  # Keep the payload icon's own extension: a raster icon lands in its WxH
  # hicolor directory, an SVG in the scalable one. A dotless basename keeps
  # the historical .png name.
  name="${upstream_icon##*/}"
  extension="${name##*.}"
  if [[ "${extension}" = "${name}" ]]
  then
    extension="png"
  fi
  cp -- "${upstream_icon}" "${APPDIR}/${PACKAGE_NAME}.${extension}"
  cp -- "${upstream_icon}" "${APPDIR}/share/icons/hicolor/${size}/apps/${PACKAGE_NAME}.${extension}"
}

# quick-sharun hardlinks sharun over every nested bin/ executable whose basename
# also lands in shared/bin, and over lib/ executables deployed via ADD_DIR
# (e.g. the webkit2gtk helpers in lib/webkit2gtk-4.1). sharun resolves its root
# from /proc/self/exe, so only a wrapper directly under bin/ resolves without
# the environment; a nested one (e.g. an Electron app spawning
# bin/resources/<name>) or a lib/ copy fails at runtime once the environment is
# cleared. This stage re-points each such wrapper at the working bin/<name>
# wrapper with a relative symlink (which sharun follows), then asserts the
# whole AppDir: the only sharun hardlinks left are sharun itself and the
# bin/<name> wrappers. Helpers the app runs outside the mount never reach this
# stage: pipeline_restore_host_helpers already put their pristine binaries back
# (see hostHelpers in the README).
pipeline_reconcile_sharun_sidecars() {
  local sharun sidecar relative name wrapper real target reconciled
  sharun="${APPDIR}/sharun"
  [[ -x "${sharun}" ]] || return 0
  command -v realpath >/dev/null 2>&1 || error "realpath is required"

  reconciled=0
  while IFS= read -r -d '' sidecar
  do
    # every hardlink of sharun (a real sidecar binary is a distinct inode)
    if [[ "${sidecar}" = "${sharun}" ]]
    then
      continue
    fi
    relative="${sidecar#"${APPDIR}/"}"
    name="${sidecar##*/}"
    # a wrapper directly under bin/ is the one slot sharun resolves
    if [[ "${sidecar%/*}" = "${APPDIR}/bin" ]]
    then
      continue
    fi
    wrapper="${APPDIR}/bin/${name}"
    real="${APPDIR}/shared/bin/${name}"
    if [[ -f "${wrapper}" ]] && [[ "${wrapper}" -ef "${sharun}" ]] && [[ -x "${real}" ]]
    then
      target="$(realpath --relative-to="${sidecar%/*}" "${wrapper}")"
      [[ -n "${target}" ]] || error "Failed to compute relative target for ${relative}"
      ln -sfn "${target}" "${sidecar}"
      reconciled=$((reconciled + 1))
      info "Relinked ${relative} -> ${target}"
      continue
    fi
    if [[ "${sidecar}" == "${APPDIR}/bin/"* ]]
    then
      error "Nested sharun wrapper ${relative} has no bin/${name} wrapper for shared/bin/${name}; it would fail at runtime"
    fi
    error "sharun hardlink outside the legal slots (${relative}); only bin/<name> resolves shared/bin/${name}"
  done < <(find "${APPDIR}" -xdev -type f -samefile "${sharun}" -print0)
  [[ "${reconciled}" -eq 0 ]] || info "Reconciled ${reconciled} nested sharun sidecar(s)"
}

# quick-sharun reads its knobs from the environment; export the descriptor's so
# CI and a local build.sh apply the same configuration.
pipeline_export_quick_sharun_env() {
  local hooks key value line
  hooks="$(descriptor_field '.quickSharun.hooks // [] | join(":")')"
  if [[ -n "${hooks}" ]]
  then
    export ADD_HOOKS="${ADD_HOOKS:+${ADD_HOOKS}:}${hooks}"
    info "quick-sharun ADD_HOOKS=${ADD_HOOKS}"
  fi
  while IFS= read -r line
  do
    [[ -n "${line}" ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    export "${key}=${value}"
    info "quick-sharun ${key}=${value}"
  done < <(descriptor_field '.quickSharun.env // {} | to_entries[] | "\(.key)=\(.value)"')
}

# Helpers the app runs outside the mount (the descriptor's hostHelpers, AppDir
# paths under bin/) must stay host-runnable, so stash pristine copies before
# quick-sharun runs: its Electron scan adds every deployable binary under
# bin/resources and _handle_nested_bins hardlinks sharun over nested
# executables, and the app copies the helper out at runtime — e.g.
# opencode-desktop staging bin/resources/opencode-cli to userData — where a
# sharun wrapper dies with "Interpreter not found!".
pipeline_stash_host_helpers() {
  local stash_dir helper source
  stash_dir="${WORK_DIR}/host-helpers"
  while IFS= read -r helper
  do
    [[ -n "${helper}" ]] || continue
    source="${APPDIR}/${helper}"
    ensure_file_exists "${source}" "host helper ${helper}"
    mkdir -p -- "${stash_dir}/$(dirname -- "${helper}")"
    cp -a -- "${source}" "${stash_dir}/${helper}"
    # Remember whether a top-level wrapper for this basename already exists:
    # only an auto-created one may be removed again at restore time.
    if [[ ! -e "${APPDIR}/bin/$(basename -- "${helper}")" ]]
    then
      printf '%s\n' "$(basename -- "${helper}")" >>"${stash_dir}/.auto-tops"
    fi
  done < <(descriptor_field '.hostHelpers // [] | .[]')
}

# Restores the stashed host helpers over whatever quick-sharun left behind
# (a nested sharun hardlink) and drops the auto-created top-level wrapper plus
# its shared/bin duplicate, leaving the pristine upstream binary as the single
# copy. Runs before the sidecar reconciliation, which then has nothing to
# repair for these paths.
pipeline_restore_host_helpers() {
  local stash_dir helper dest name top real
  stash_dir="${WORK_DIR}/host-helpers"
  [[ -d "${stash_dir}" ]] || return 0
  while IFS= read -r helper
  do
    [[ -n "${helper}" ]] || continue
    dest="${APPDIR}/${helper}"
    [[ -f "${stash_dir}/${helper}" ]] || error "Missing stashed host helper: ${helper}"
    # rm first: cp would follow the reconcile symlink onto the top wrapper.
    rm -f -- "${dest}"
    cp -a -- "${stash_dir}/${helper}" "${dest}"
    chmod 0755 -- "${dest}"
    [[ -x "${dest}" ]] || error "Restored host helper is not executable: ${helper}"
    if [[ -e "${APPDIR}/sharun" ]] && [[ "${dest}" -ef "${APPDIR}/sharun" ]]
    then
      error "Restored host helper is still a sharun wrapper: ${helper}"
    fi
    name="$(basename -- "${helper}")"
    top="${APPDIR}/bin/${name}"
    real="${APPDIR}/shared/bin/${name}"
    if [[ -f "${stash_dir}/.auto-tops" ]] && grep -Fxq -- "${name}" "${stash_dir}/.auto-tops"
    then
      if [[ -e "${top}" ]]
      then
        if [[ "${top}" -ef "${APPDIR}/sharun" ]]
        then
          rm -f -- "${top}"
          info "Removed auto-created sharun wrapper bin/${name}"
        else
          error "Refusing to remove non-sharun top-level file bin/${name}"
        fi
      fi
      if [[ -e "${real}" ]]
      then
        rm -f -- "${real}"
        info "Removed sharun duplicate shared/bin/${name}"
      fi
    fi
  done < <(descriptor_field '.hostHelpers // [] | .[]')
}

# Fills TARGETS with the quick-sharun deploy targets: the staged payload
# binaries, plus every library the descriptor declares for a runtime dlopen.
# quick-sharun bundles a library only when it is a target or reachable from
# one, and an app that dlopens a library never links it, so ldd would never
# surface it.
pipeline_collect_targets() {
  TARGETS=()
  if [[ "$(descriptor_field '.payload.kind')" = "deb-files" ]]
  then
    local file
    while IFS= read -r file
    do
      TARGETS+=("${APPDIR}/bin/$(basename -- "${file}")")
    done < <(descriptor_field '.payload.files[]')
  else
    # Electron payloads: quick-sharun auto-detects the electron binary from the
    # staged tree and deploys its support libraries.
    local -a staged=("${APPDIR}/bin/"*)
    if [[ ${#staged[@]} -eq 0 || ! -e ${staged[0]} ]]
    then
      error "No staged binaries in ${APPDIR}/bin"
    fi
    TARGETS=("${staged[@]}")
  fi

  local library
  while IFS= read -r library
  do
    [[ -e "${library}" ]] || error "Missing quick-sharun library: ${library}"
    TARGETS+=("${library}")
  done < <(descriptor_field '.quickSharun.libraries // [] | .[]')
}

# Packages the AppDir: quick-sharun (AppRun + the runtime closure including
# libc), then the pkgforge appimagetool via APPIMAGETOOL, then the smoke gate.
pipeline_pack() {
  normalize_package_payload_permissions "${APPDIR}"

  export APPDIR
  export OUTPATH="${DIST_DIR}"
  export OUTNAME="${PACKAGE_NAME}-${PACKAGE_VERSION}-${APPIMAGE_ARCH}.AppImage"
  export ARCH="${APPIMAGE_ARCH}"
  export VERSION="${PACKAGE_VERSION}"
  mkdir -p -- "${DIST_DIR}"

  command -v quick-sharun >/dev/null 2>&1 || error "quick-sharun is required.
Install the Anylinux tools (packaging/scripts/install-anylinux-tools.sh) or add it to PATH."
  [[ -n "${APPIMAGETOOL:-}" && -x "${APPIMAGETOOL}" ]] || error "APPIMAGETOOL is not executable: ${APPIMAGETOOL:-<unset>}"

  pipeline_collect_targets
  pipeline_export_quick_sharun_env
  pipeline_stash_host_helpers
  # A staged tree can keep its libraries beside its binaries (Firefox's deb
  # tree does, and those libraries carry no $ORIGIN rpath), so the staged bin
  # dir must be on the search path for quick-sharun's ldd and strace scans to
  # resolve siblings; without it the build aborts on "missing libraries".
  # Scoped to the call so the later appimagetool run sees the ambient env.
  LD_LIBRARY_PATH="${APPDIR}/bin${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" \
    quick-sharun "${TARGETS[@]}"
  pipeline_restore_host_helpers
  pipeline_reconcile_sharun_sidecars

  # .env and the runtime hook belong to the finished AppDir (after AppRun exists).
  fbr finalize --app "${APP_ID}" --appdir "${APPDIR}"

  if ! "${APPIMAGETOOL}"
  then
    error "appimagetool failed"
  fi

  local output_file="${DIST_DIR}/${OUTNAME}"
  if [[ ! -f "${output_file}" ]]
  then
    # The earliest site that knows the artifact is missing; the workflow's
    # post-build check is the backstop for a build command that exits 0.
    classify_failure ARTIFACT_MISSING "the build produced no AppImage at ${output_file}"
    error "Missing AppImage output: ${output_file}"
  fi
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}
