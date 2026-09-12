#!/bin/bash

# The AppImage build pipeline, driven by the app descriptor. Every app's
# build.sh calls these stages in order; anything app specific lives in
# packaging/apps/<app>/app.json rather than in a forked copy of this script.
#
# Globals produced here (consumed by the stages below and by the caller):
#   APP_ID APP_JSON PACKAGE_NAME PACKAGE_VERSION
#   TARGET_ARCH DEB_ARCH APPIMAGE_ARCH
#   WORK_DIR DIST_DIR APPDIR METADATA_PATH PAYLOAD_PATH PAYLOAD_ROOT
#
# Requires: bash, jq, bun (for the fbr CLI), plus the app's own tooling
# (dpkg-deb for .deb payloads, quick-sharun and APPIMAGETOOL for packing).
# shellcheck disable=SC2154 # globals are provided by pipeline_init
(return 0 2>/dev/null) || exit 1

PIPELINE_LIB_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_REPO_DIR="$(cd "${PIPELINE_LIB_DIR}/../.." && pwd)"
FBR_ENTRY="${FBR_ENTRY:-${PIPELINE_REPO_DIR}/packaging/bin/fbr.ts}"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=lib/shell-common.sh
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

  local arch_line
  arch_line="$(map_arch)"
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

# Stages the payload into AppDir/bin (and AppDir/usr when the descriptor says
# the vendored usr/ belongs at the AppDir root).
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
      # Stage the upstream payload entry by entry, renaming the scoped
      # executable to the package name and dropping the upstream AppDir
      # furniture that this pipeline replaces (AppRun, desktop entries,
      # icons, and usr/ when the descriptor moves it to the AppDir root).
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

# Neutralizes the app's own updater (endpoint patches, feed removal, product
# .json keys) and fails when a residual updater endpoint survives.
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

# Packages the AppDir: quick-sharun (which generates AppRun and bundles the
# runtime closure including libc), then the pkgforge appimagetool (uruntime /
# DWARFS) invoked through APPIMAGETOOL with no CLI args, then the smoke gate.
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
    # Electron payloads: quick-sharun auto-detects the electron binary from
    # the staged tree and deploys its support libraries.
    targets=("${APPDIR}/bin/"*)
  fi
  quick-sharun "${targets[@]}"

  # .env entries and the runtime hook belong to the finished AppDir, so they
  # are applied after quick-sharun generated AppRun.
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
