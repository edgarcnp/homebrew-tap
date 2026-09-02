#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

KEY_FILE="${PACKAGING_DIR}/assets/microsoft-vscode-repository-key.gpg.base64"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/vscode.desktop"
setup_work_dir "vscode-build"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
[[ -z "${DIST_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
[[ -z "${WORK_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
validate_package_version "${PACKAGE_VERSION:-}"
PACKAGE_NAME="${PACKAGE_NAME:-vscode}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-Visual Studio Code}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Code Editing. Redefined.}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

main() {
  ensure_file_exists "${KEY_FILE}" "pinned repository signing key"
  ensure_file_exists "${DESKTOP_TEMPLATE}" "AppImage desktop template"

  local arch_line deb_arch appimage_arch
  arch_line="$(map_arch)"
  deb_arch="${arch_line% *}"
  appimage_arch="${arch_line#* }"

  local deb_path metadata_path
  info "Resolving code package for ${deb_arch}"
  # shellcheck disable=SC2154 # WORK_DIR is set by setup_work_dir from package-common.sh
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
  mkdir -p -- "${APPDIR}/bin" "${APPDIR}/share/applications" "${APPDIR}/share/icons/hicolor/256x256/apps"

  # Stage the entire /usr/share/code payload into bin/ (pkgforge pattern)
  cp -aT -- "${payload_dir}/usr/share/code" "${APPDIR}/bin"

  # Remove the update service URL from product.json and neutralize the
  # hardcoded updater endpoint in the compiled bundles
  node "${SCRIPT_DIR}/disable-updater.js" "${APPDIR}/bin"

  # Fail loudly if any residual copy of the updater endpoint remains
  local from="update.code.visualstudio.com"
  local matches
  matches="$(grep -rlaF -- "${from}" "${APPDIR}" 2>/dev/null || true)"
  if [[ -n "${matches}" ]]
  then
    error "updater endpoint patch incomplete: original endpoint still present in: ${matches}"
  fi
  if grep -Fq -- '"updateUrl"' "${APPDIR}/bin/resources/app/product.json" 2>/dev/null
  then
    error "updater endpoint patch incomplete: updateUrl still present in ${APPDIR}/bin/resources/app/product.json"
  fi
  if grep -Fq -- '"checksums"' "${APPDIR}/bin/resources/app/product.json" 2>/dev/null
  then
    error "integrity patch incomplete: checksums still present in ${APPDIR}/bin/resources/app/product.json"
  fi
  info "Verified no file in APPDIR still references the upstream updater endpoint"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/share/applications/${PACKAGE_NAME}.desktop"

  cp -- "${payload_dir}/usr/share/pixmaps/vscode.png" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${APPDIR}/${PACKAGE_NAME}.png" "${APPDIR}/share/icons/hicolor/256x256/apps/${PACKAGE_NAME}.png"

  normalize_package_payload_permissions "${APPDIR}"

  export DESKTOP="${APPDIR}/${PACKAGE_NAME}.desktop"
  export ICON="${APPDIR}/${PACKAGE_NAME}.png"
  export APPDIR
  export OUTPATH="${DIST_DIR}"
  export OUTNAME="${PACKAGE_NAME}-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  export ARCH="${appimage_arch}"
  export VERSION="${PACKAGE_VERSION}"
  mkdir -p -- "${DIST_DIR}"

  quick-sharun "${APPDIR}/bin/"*

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
