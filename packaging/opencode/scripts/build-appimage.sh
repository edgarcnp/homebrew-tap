#!/bin/bash
set -Eeuo pipefail

# Build the opencode desktop AppImage from the .deb published on the
# anomalyco/opencode GitHub releases, verified against the SHA-256 asset
# digest exposed by the GitHub API. Dist output lands in <tap>/dist for
# the CI workflow.

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

APPRUN_TEMPLATE="${PACKAGING_DIR}/templates/AppRun"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/opencode-desktop.desktop"
setup_work_dir "opencode-build"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
if [[ -n "${DIST_DIR_OVERRIDE:-}" ]]
then
  validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
fi
APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
if [[ -n "${WORK_DIR_OVERRIDE:-}" ]]
then
  validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
fi
validate_package_version "${PACKAGE_VERSION:-}"
PACKAGE_NAME="${PACKAGE_NAME:-opencode-desktop}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME: ${PACKAGE_NAME}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-OpenCode}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Open source AI coding agent}"
PACKAGE_VERSION="${PACKAGE_VERSION:-}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

prepare_appdir() {
  local payload_dir="$1"
  local app_dir="${payload_dir}/opt/OpenCode"
  local executable="${app_dir}/ai.opencode.desktop"
  local icon_dir="${payload_dir}/usr/share/icons/hicolor/128x128/apps"
  local icon="${icon_dir}/ai.opencode.desktop.png"

  ensure_file_exists "${executable}" "opencode desktop executable"
  ensure_file_exists "${icon}" "opencode desktop icon"

  # Remove the electron-updater feed so the app never self-updates from
  # upstream (anomalyco/opencode); updates come via Homebrew only.
  if [[ -f "${app_dir}/resources/app-update.yml" ]]
  then
    rm -- "${app_dir}/resources/app-update.yml"
    info "Removed embedded electron-updater feed: resources/app-update.yml"
  else
    warn "resources/app-update.yml already absent; embedded updater feed already disabled"
  fi

  info "Preparing AppDir at ${APPDIR}"
  rm -rf -- "${APPDIR}"
  mkdir -p -- \
    "${APPDIR}/opt" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/128x128/apps"

  cp -aT -- "${app_dir}" "${APPDIR}/opt/opencode-desktop"

  render_template "${APPRUN_TEMPLATE}" "${APPDIR}/AppRun"
  chmod 0755 -- "${APPDIR}/AppRun"
  cp -- "${LIB_DIR}/apprun-common.sh" "${APPDIR}/apprun-common.sh"
  chmod 0644 -- "${APPDIR}/apprun-common.sh"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/usr/share/applications/${PACKAGE_NAME}.desktop"

  cp -- "${icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${icon}" "${APPDIR}/.DirIcon"
  cp -- "${icon}" "${APPDIR}/usr/share/icons/hicolor/128x128/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"
  chmod 0755 -- "${APPDIR}/opt/opencode-desktop/ai.opencode.desktop"
}

# The official .deb ships with electron-updater enabled. Removing
# resources/app-update.yml neutralizes the feed, but if the Electron main
# process ever hardcodes a feed URL as a fallback, this scan fails the build
# loudly rather than shipping a build with the updater silently re-enabled.
verify_updater_neutralized() {
  local from="https://github.com/anomalyco/opencode/releases/download/"
  local matches
  matches="$(grep -rlaF -- "${from}" "${APPDIR}" 2>/dev/null || true)"
  if [[ -n "${matches}" ]]
  then
    error "updater endpoint patch incomplete: original endpoint still present in: ${matches}"
  fi
  info "Verified no file in APPDIR still references the upstream updater endpoint"
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
  # shellcheck disable=SC2154 # WORK_DIR is set by setup_work_dir from package-common.sh
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
    validate_package_version "${PACKAGE_VERSION}"
  fi

  local deb_arch_actual
  deb_arch_actual="$(dpkg-deb -f "${deb_path}" Architecture)"
  [[ "${deb_arch_actual}" = "${deb_arch}" ]] || error "Downloaded package architecture ${deb_arch_actual} does not match requested ${deb_arch}"

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p -- "${payload_dir}"
  info "Extracting package: ${deb_path}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  prepare_appdir "${payload_dir}"
  verify_updater_neutralized

  local appimagetool
  appimagetool="$(resolve_appimagetool)"
  mkdir -p -- "${DIST_DIR}"
  local output_file="${DIST_DIR}/opencode-desktop-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  rm -f -- "${output_file}"
  info "Building AppImage: ${output_file}"
  ARCH="${appimage_arch}" VERSION="${PACKAGE_VERSION}" \
    "${appimagetool}" --no-appstream "${APPDIR}" "${output_file}" >&2
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
