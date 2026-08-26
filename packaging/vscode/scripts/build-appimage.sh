#!/bin/bash
set -Eeuo pipefail

# Build the vscode AppImage from Microsoft's signed APT
# repository, pinned to fingerprint BC528686B50D79E339D3721CEB3E94ADBE1229CF.
# Dist output lands in <tap>/dist for the CI workflow.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

KEY_FILE="${PACKAGING_DIR}/assets/microsoft-vscode-repository-key.gpg.base64"
APPRUN_TEMPLATE="${PACKAGING_DIR}/templates/AppRun"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/vscode.desktop"
WORK_DIR="${WORK_DIR_OVERRIDE:-$(mktemp -d)}"
if [[ -z "${WORK_DIR_OVERRIDE:-}" ]]
then
  # Clean up the temp dir we created; an explicit WORK_DIR_OVERRIDE is
  # caller-owned and left alone.
  trap 'rm -rf "${WORK_DIR}"' EXIT
fi
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
APPDIR="${APPIMAGE_APPDIR_OVERRIDE:-${DIST_DIR}/appimage.AppDir}"
PACKAGE_NAME="${PACKAGE_NAME:-vscode}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-Visual Studio Code}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Code Editing. Redefined.}"
PACKAGE_VERSION="${PACKAGE_VERSION:-}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

prepare_appdir() {
  local payload_dir="$1"
  local code_dir="${payload_dir}/usr/share/code"
  local icon="${payload_dir}/usr/share/pixmaps/vscode.png"

  ensure_file_exists "${code_dir}/code" "code runtime"
  ensure_file_exists "${icon}" "vscode icon"

  info "Preparing AppDir at ${APPDIR}"
  rm -rf -- "${APPDIR}"
  mkdir -p -- \
    "${APPDIR}/opt" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/256x256/apps"

  cp -aT -- "${code_dir}" "${APPDIR}/opt/vscode"

  render_template "${APPRUN_TEMPLATE}" "${APPDIR}/AppRun"
  chmod 0755 -- "${APPDIR}/AppRun"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/usr/share/applications/${PACKAGE_NAME}.desktop"

  cp -- "${icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${icon}" "${APPDIR}/.DirIcon"
  cp -- "${icon}" "${APPDIR}/usr/share/icons/hicolor/256x256/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"
  chmod 0755 -- "${APPDIR}/opt/vscode/bin/code"
}

main() {
  ensure_file_exists "${KEY_FILE}" "pinned repository signing key"
  ensure_file_exists "${APPRUN_TEMPLATE}" "AppImage AppRun template"
  ensure_file_exists "${DESKTOP_TEMPLATE}" "AppImage desktop template"

  local arch_line deb_arch appimage_arch
  arch_line="$(map_arch)"
  deb_arch="${arch_line% *}"
  appimage_arch="${arch_line#* }"

  local deb_path metadata_path
  info "Resolving code package for ${deb_arch}"
  metadata_path="${WORK_DIR}/metadata.json"
  deb_path="$(node "${LIB_DIR}/upstream-linux-package.js" \
    --output-dir "${WORK_DIR}" \
    --metadata "${metadata_path}" \
    --key-base64 "${KEY_FILE}" \
    --package code \
    --fingerprint BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    --repository https://packages.microsoft.com/repos/code \
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
  mkdir -p -- "${payload_dir}"
  info "Extracting package: ${deb_path}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  prepare_appdir "${payload_dir}"

  local appimagetool
  appimagetool="$(resolve_appimagetool)"
  mkdir -p -- "${DIST_DIR}"
  local output_file="${DIST_DIR}/vscode-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  rm -f -- "${output_file}"
  info "Building AppImage: ${output_file}"
  ARCH="${appimage_arch}" VERSION="${PACKAGE_VERSION}" \
    "${appimagetool}" --no-appstream "${APPDIR}" "${output_file}" >&2
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
