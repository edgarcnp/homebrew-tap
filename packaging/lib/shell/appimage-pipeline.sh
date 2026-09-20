#!/bin/bash

# The AppImage build pipeline, driven by the app descriptor. Every app's
# build.sh calls these stages in order; per-app behavior lives in app.json.
#
# Globals produced here (consumed below and by the caller):
#   APP_ID APP_JSON PACKAGE_NAME PACKAGE_VERSION
#   TARGET_ARCH DEB_ARCH APPIMAGE_ARCH
#   WORK_DIR DIST_DIR APPDIR METADATA_PATH PAYLOAD_PATH PAYLOAD_ROOT
#
# Requires: bash, jq, bun (the fbr CLI), and the app's own tooling (dpkg-deb,
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
  bun "${FBR_ENTRY}" "$@"
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

  setup_work_dir "${APP_ID}-build"
  DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
  [[ -z "${DIST_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
  APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
  [[ -z "${WORK_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
  [[ -z "${PACKAGE_VERSION:-}" ]] || validate_package_version "${PACKAGE_VERSION}"

  info "Building ${APP_ID} for ${DEB_ARCH} (descriptor from packaging/apps/${APP_ID}/app.json)"
}

# Resolves the upstream payload and pins PACKAGE_VERSION.
pipeline_resolve() {
  info "Resolving ${APP_ID} for ${DEB_ARCH}"
  METADATA_PATH="${WORK_DIR}/metadata.json"
  PAYLOAD_PATH="$(fbr resolve \
    --app "${APP_ID}" \
    --arch "${DEB_ARCH}" \
    --output-dir "${WORK_DIR}" \
    --metadata "${METADATA_PATH}")"

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
      local entry name target
      while IFS= read -r entry
      do
        name="$(basename -- "${entry}")"
        is_excluded_payload_entry "${name}" && continue
        target="$(descriptor_field ".payload.rename[\"${name}\"] // empty")"
        if [[ -n "${target}" ]]
        then
          cp -a -- "${entry}" "${APPDIR}/bin/${target}"
        else
          cp -a -- "${entry}" "${APPDIR}/bin/"
        fi
      done < <(find "${PAYLOAD_ROOT}" -mindepth 1 -maxdepth 1)
      if [[ "$(descriptor_field '.payload.moveUsrToRoot // false')" = "true" ]]
      then
        cp -a -- "${PAYLOAD_ROOT}/usr" "${APPDIR}/usr"
      fi
      ;;
    *)
      error "Unknown payload kind in descriptor: ${kind}"
      ;;
  esac
}

# Neutralizes the app's own updater and fails when a declared endpoint survives.
pipeline_neutralize() {
  fbr neutralize --app "${APP_ID}" --appdir "${APPDIR}"
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
  local size upstream_icon
  size="$(descriptor_field '.icon.size')"
  upstream_icon="${PAYLOAD_ROOT}/$(descriptor_field '.icon.source')"
  ensure_file_exists "${upstream_icon}" "upstream icon"
  cp -- "${upstream_icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${APPDIR}/${PACKAGE_NAME}.png" "${APPDIR}/share/icons/hicolor/${size}/apps/${PACKAGE_NAME}.png"
}

# quick-sharun hardlinks sharun over every nested bin/ executable whose basename
# also lands in shared/bin. sharun resolves its root from /proc/self/exe, so only
# a wrapper directly under bin/ resolves; a nested one (e.g. an Electron app
# spawning bin/resources/<name>) fails at runtime. This stage re-points each
# nested wrapper under bin/ at the working bin/<name> wrapper with a relative
# symlink (which sharun follows), then asserts the whole AppDir: the only sharun
# hardlinks left are sharun itself and the bin/<name> wrappers.
pipeline_reconcile_sharun_sidecars() {
  local sharun sidecar relative name wrapper real up rest target reconciled
  sharun="${APPDIR}/sharun"
  [ -x "${sharun}" ] || return 0

  reconciled=0
  while IFS= read -r -d '' sidecar
  do
    # every hardlink of sharun (a real sidecar binary is a distinct inode)
    if [ "${sidecar}" = "${sharun}" ]
    then
      continue
    fi
    relative="${sidecar#"${APPDIR}/"}"
    name="${sidecar##*/}"
    # a wrapper directly under bin/ is the one slot sharun resolves
    if [ "${sidecar%/*}" = "${APPDIR}/bin" ]
    then
      continue
    fi
    wrapper="${APPDIR}/bin/${name}"
    real="${APPDIR}/shared/bin/${name}"
    if [[ "${sidecar}" == "${APPDIR}/bin/"* ]]
    then
      if [ -f "${wrapper}" ] && [ "${wrapper}" -ef "${sharun}" ] && [ -x "${real}" ]
      then
        rel="${sidecar#"${APPDIR}/bin/"}"
        rel="${rel%/*}"
        up=".."
        rest="${rel}"
        while [[ "${rest}" == */* ]]
        do
          up="../${up}"
          rest="${rest#*/}"
        done
        target="${up}/${name}"
        ln -sfn "${target}" "${sidecar}"
        reconciled=$((reconciled + 1))
        info "Relinked ${relative} -> ${target}"
        continue
      fi
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

  local -a targets=()
  if [[ "$(descriptor_field '.payload.kind')" = "deb-files" ]]
  then
    local file
    while IFS= read -r file
    do
      targets+=("${APPDIR}/bin/$(basename -- "${file}")")
    done < <(descriptor_field '.payload.files[]')
  else
    # Electron payloads: quick-sharun auto-detects the electron binary from the
    # staged tree and deploys its support libraries.
    targets=("${APPDIR}/bin/"*)
  fi
  pipeline_export_quick_sharun_env
  quick-sharun "${targets[@]}"
  pipeline_reconcile_sharun_sidecars

  # .env and the runtime hook belong to the finished AppDir (after AppRun exists).
  fbr finalize --app "${APP_ID}" --appdir "${APPDIR}"

  if ! "${APPIMAGETOOL}"
  then
    error "appimagetool failed"
  fi

  local output_file="${DIST_DIR}/${OUTNAME}"
  ensure_file_exists "${output_file}" "AppImage output"
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}
