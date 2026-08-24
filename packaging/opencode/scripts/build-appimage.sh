#!/bin/bash
set -Eeuo pipefail

# Build the opencode desktop AppImage from the .deb published on the
# anomalyco/opencode GitHub releases, verified against the SHA-256 asset
# digest exposed by the GitHub API. Dist output lands in <tap>/dist for
# the CI workflow.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

APPRUN_TEMPLATE="${PACKAGING_DIR}/templates/AppRun"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/opencode-desktop.desktop"
WORK_DIR="${WORK_DIR_OVERRIDE:-$(mktemp -d)}"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
APPDIR="${APPIMAGE_APPDIR_OVERRIDE:-${DIST_DIR}/appimage.AppDir}"
PACKAGE_NAME="${PACKAGE_NAME:-opencode-desktop}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-OpenCode}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Open source AI coding agent}"
PACKAGE_VERSION="${PACKAGE_VERSION:-}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

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

prepare_appdir() {
  local payload_dir="$1"
  local app_dir="${payload_dir}/opt/OpenCode"
  local executable="${app_dir}/ai.opencode.desktop"
  local icon_dir="${payload_dir}/usr/share/icons/hicolor/128x128/apps"
  local icon="${icon_dir}/ai.opencode.desktop.png"

  ensure_file_exists "${executable}" "opencode desktop executable"
  ensure_file_exists "${icon}" "opencode desktop icon"

  info "Preparing AppDir at ${APPDIR}"
  rm -rf "${APPDIR}"
  mkdir -p \
    "${APPDIR}/opt" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/128x128/apps"

  cp -aT "${app_dir}" "${APPDIR}/opt/opencode-desktop"

  render_template "${APPRUN_TEMPLATE}" "${APPDIR}/AppRun"
  chmod 0755 "${APPDIR}/AppRun"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/usr/share/applications/${PACKAGE_NAME}.desktop"

  cp "${icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp "${icon}" "${APPDIR}/.DirIcon"
  cp "${icon}" "${APPDIR}/usr/share/icons/hicolor/128x128/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"
  chmod 0755 "${APPDIR}/opt/opencode-desktop/ai.opencode.desktop"
}

main() {
  ensure_file_exists "${APPRUN_TEMPLATE}" "AppImage AppRun template"
  ensure_file_exists "${DESKTOP_TEMPLATE}" "AppImage desktop template"

  local arch_line deb_arch appimage_arch
  arch_line="$(map_arch)"
  deb_arch="${arch_line% *}"
  appimage_arch="${arch_line#* }"

  local deb_path metadata_path
  info "Resolving opencode-desktop package for ${deb_arch}"
  metadata_path="${WORK_DIR}/metadata.json"
  deb_path="$(node "${LIB_DIR}/upstream-github-release.js" \
    --output-dir "${WORK_DIR}" \
    --metadata "${metadata_path}" \
    --repository https://api.github.com/repos/anomalyco/opencode \
    --asset-prefix opencode-desktop-linux \
    --arch "${deb_arch}")"

  local resolved_version
  resolved_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "${metadata_path}")"
  if [[ -n "${PACKAGE_VERSION}" ]]
  then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved upstream version ${resolved_version} does not match PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    info "Derived PACKAGE_VERSION ${PACKAGE_VERSION} from upstream metadata"
  fi

  local deb_arch_actual
  deb_arch_actual="$(dpkg-deb -f "${deb_path}" Architecture)"
  [[ "${deb_arch_actual}" = "${deb_arch}" ]] || error "Downloaded package architecture ${deb_arch_actual} does not match requested ${deb_arch}"

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p "${payload_dir}"
  info "Extracting package: ${deb_path}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  prepare_appdir "${payload_dir}"

  local appimagetool
  appimagetool="$(resolve_appimagetool)"
  mkdir -p "${DIST_DIR}"
  local output_file="${DIST_DIR}/opencode-desktop-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  rm -f "${output_file}"
  info "Building AppImage: ${output_file}"
  ARCH="${appimage_arch}" VERSION="${PACKAGE_VERSION}" \
    "${appimagetool}" --no-appstream "${APPDIR}" "${output_file}" >&2
  chmod 0755 "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
