#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

RESOLVE_SCRIPT="${PACKAGING_DIR}/scripts/resolve-freebuff.js"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/freebuff-desktop.desktop"
setup_work_dir "freebuff-build"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
[[ -z "${DIST_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
[[ -z "${WORK_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
validate_package_version "${PACKAGE_VERSION:-}"
PACKAGE_NAME="${PACKAGE_NAME:-freebuff-desktop}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-Freebuff}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Freebuff Desktop}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

main() {
  ensure_file_exists "${RESOLVE_SCRIPT}" "freebuff-desktop resolver"
  ensure_file_exists "${DESKTOP_TEMPLATE}" "AppImage desktop template"

  local arch_line deb_arch appimage_arch
  arch_line="$(map_arch)"
  deb_arch="${arch_line% *}"
  appimage_arch="${arch_line#* }"

  local appimage_path metadata_path
  info "Resolving freebuff-desktop package for ${deb_arch}"
  # shellcheck disable=SC2154 # WORK_DIR is set by setup_work_dir from package-common.sh
  metadata_path="${WORK_DIR}/metadata.json"
  appimage_path="$(node "${RESOLVE_SCRIPT}" \
    --output-dir "${WORK_DIR}" \
    --metadata "${metadata_path}" \
    --repository https://freebuff.com/api/desktop/updates \
    --github-repository https://api.github.com/repos/CodebuffAI/codebuff-community \
    --arch "${deb_arch}")"

  local resolved_version
  resolved_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "${metadata_path}")"
  if [[ -n "${PACKAGE_VERSION}" ]]
  then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved version ${resolved_version} != PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    validate_package_version "${PACKAGE_VERSION}"
  fi

  # Upstream ships a classic type-2 AppImage whose runtime needs FUSE 2;
  # --appimage-extract unpacks it without mounting, so no FUSE is required.
  local payload_dir="${WORK_DIR}/extracted"
  mkdir -p -- "${payload_dir}"
  chmod +x -- "${appimage_path}"
  (cd "${payload_dir}" && "${appimage_path}" --appimage-extract >/dev/null)
  local source_root="${payload_dir}/squashfs-root"
  [[ -d "${source_root}" ]] || error "upstream AppImage extracted to no squashfs-root"

  local upstream_binary="${source_root}/@codebufffreebuff-desktop"
  ensure_file_exists "${upstream_binary}" "Freebuff Electron runtime"

  rm -rf -- "${APPDIR}"
  mkdir -p -- "${APPDIR}/bin" "${APPDIR}/share/applications" "${APPDIR}/share/icons/hicolor/512x512/apps"

  # Stage the Electron payload into bin/ (pkgforge pattern), renaming the
  # scoped executable to the package name; the upstream AppDir furniture
  # (AppRun, desktop entry, root icon symlink) is replaced below, and usr/
  # moves to the AppDir root where the AppImage spec places it.
  local entry name
  for entry in "${source_root}"/*
  do
    name="$(basename -- "${entry}")"
    case "${name}" in
      AppRun | *.desktop | *.png | usr) continue ;;
      @codebufffreebuff-desktop)
        cp -a -- "${entry}" "${APPDIR}/bin/${PACKAGE_NAME}"
        ;;
      *)
        cp -a -- "${entry}" "${APPDIR}/bin/"
        ;;
    esac
  done
  cp -a -- "${source_root}/usr" "${APPDIR}/usr"

  # Remove the electron-updater feed; updates come via Homebrew only. The app
  # never calls setFeedURL, so without this file the updater has no feed.
  local feed="${APPDIR}/bin/resources/app-update.yml"
  ensure_file_exists "${feed}" "upstream electron-updater feed"
  rm -- "${feed}"
  info "Removed app-update.yml"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/share/applications/${PACKAGE_NAME}.desktop"

  local upstream_icon="${APPDIR}/usr/share/icons/hicolor/512x512/apps/@codebufffreebuff-desktop.png"
  ensure_file_exists "${upstream_icon}" "upstream icon"
  cp -- "${upstream_icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${APPDIR}/${PACKAGE_NAME}.png" "${APPDIR}/share/icons/hicolor/512x512/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"

  export APPDIR
  export OUTPATH="${DIST_DIR}"
  export OUTNAME="${PACKAGE_NAME}-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  export ARCH="${appimage_arch}"
  export VERSION="${PACKAGE_VERSION}"
  mkdir -p -- "${DIST_DIR}"

  # Electron apps need their support libs deployed; quick-sharun auto-detects
  # the electron binary from the staged payload
  quick-sharun "${APPDIR}/bin/"*

  # Disable the app's own update channel; updates come via Homebrew only
  echo 'FREEBUFF_DISABLE_UPDATE_CHECK=1' >>"${APPDIR}/.env"

  # shellcheck disable=SC2154 # APPIMAGETOOL is set by the workflow env
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

main "$@"
