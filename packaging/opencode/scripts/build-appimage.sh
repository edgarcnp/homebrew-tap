#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/opencode-desktop.desktop"
setup_work_dir "opencode-build"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
[[ -z "${DIST_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
[[ -z "${WORK_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
validate_package_version "${PACKAGE_VERSION:-}"
PACKAGE_NAME="${PACKAGE_NAME:-opencode-desktop}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-OpenCode}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Open source AI coding agent}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

main() {
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
  if [[ -n "${PACKAGE_VERSION}" ]]; then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved version ${resolved_version} != PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    validate_package_version "${PACKAGE_VERSION}"
  fi

  local deb_arch_actual
  deb_arch_actual="$(dpkg-deb -f "${deb_path}" Architecture)"
  [[ "${deb_arch_actual}" = "${deb_arch}" ]] || error "Package arch ${deb_arch_actual} != requested ${deb_arch}"

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p -- "${payload_dir}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  rm -rf -- "${APPDIR}"
  mkdir -p -- "${APPDIR}/bin" "${APPDIR}/share/applications" "${APPDIR}/share/icons/hicolor/128x128/apps"

  # Stage the entire app payload into bin/ (pkgforge pattern for Electron apps)
  cp -aT -- "${payload_dir}/opt/OpenCode" "${APPDIR}/bin"

  # Remove the electron-updater feed
  if [[ -f "${APPDIR}/bin/resources/app-update.yml" ]]; then
    rm -- "${APPDIR}/bin/resources/app-update.yml"
    info "Removed app-update.yml"
  fi

  # Fail loudly if a future release embeds a hardcoded fallback feed URL
  local from="https://github.com/anomalyco/opencode/releases/download/"
  local matches
  matches="$(grep -rlaF -- "${from}" "${APPDIR}" 2>/dev/null || true)"
  if [[ -n "${matches}" ]]; then
    error "updater endpoint patch incomplete: original endpoint still present in: ${matches}"
  fi
  info "Verified no file in APPDIR still references the upstream updater endpoint"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/share/applications/${PACKAGE_NAME}.desktop"

  cp -- "${payload_dir}/usr/share/icons/hicolor/128x128/apps/ai.opencode.desktop.png" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${APPDIR}/${PACKAGE_NAME}.png" "${APPDIR}/share/icons/hicolor/128x128/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"

  export DESKTOP="${APPDIR}/${PACKAGE_NAME}.desktop"
  export ICON="${APPDIR}/${PACKAGE_NAME}.png"
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
  echo 'OPENCODE_DISABLE_AUTOUPDATE=1' >>"${APPDIR}/.env"

  if ! "${APPIMAGETOOL}"; then
    error "appimagetool failed"
  fi

  local output_file="${DIST_DIR}/${OUTNAME}"
  ensure_file_exists "${output_file}" "AppImage output"
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
