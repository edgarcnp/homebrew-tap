#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

. "${LIB_DIR}/package-common.sh"

RESOLVE_SCRIPT="${PACKAGING_DIR}/scripts/resolve-gitbutler.js"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/gitbutler.desktop"
setup_work_dir "gb-build"
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
[[ -z "${DIST_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${DIST_DIR_OVERRIDE}" "DIST_DIR_OVERRIDE"
APPDIR="$(resolve_appdir_override "${REPO_DIR}" "${DIST_DIR}")"
[[ -z "${WORK_DIR_OVERRIDE:-}" ]] || validate_absolute_override "${WORK_DIR_OVERRIDE}" "WORK_DIR_OVERRIDE"
validate_package_version "${PACKAGE_VERSION:-}"
PACKAGE_NAME="${PACKAGE_NAME:-gitbutler}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-GitButler}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Git, finally designed for humans}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"
RESOLVE_BASE_URL="${RESOLVE_BASE_URL:-https://app.gitbutler.com/downloads/release/linux}"

main() {
  ensure_file_exists "${RESOLVE_SCRIPT}" "GitButler resolver"
  ensure_file_exists "${DESKTOP_TEMPLATE}" "AppImage desktop template"

  local arch_line deb_arch appimage_arch
  arch_line="$(map_arch)"
  deb_arch="${arch_line% *}"
  appimage_arch="${arch_line#* }"

  local deb_path metadata_path
  info "Resolving git-butler package for ${deb_arch}"
  metadata_path="${WORK_DIR}/metadata.json"
  deb_path="$(node "${RESOLVE_SCRIPT}" \
    --output-dir "${WORK_DIR}" \
    --metadata "${metadata_path}" \
    --repository "${RESOLVE_BASE_URL}" \
    --arch "${deb_arch}")"

  local resolved_version
  resolved_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "${metadata_path}")"
  if [[ -n "${PACKAGE_VERSION}" ]]; then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved version ${resolved_version} != PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    validate_package_version "${PACKAGE_VERSION}"
  fi

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p -- "${payload_dir}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  rm -rf -- "${APPDIR}"
  mkdir -p -- "${APPDIR}/bin" "${APPDIR}/share/applications" "${APPDIR}/share/icons/hicolor/128x128/apps"

  cp -- "${payload_dir}/usr/bin/gitbutler-tauri" "${APPDIR}/bin/"
  cp -- "${payload_dir}/usr/bin/gitbutler-git-askpass" "${APPDIR}/bin/"
  cp -a -- "${payload_dir}/usr/bin/but" "${APPDIR}/bin/"

  local binary="${APPDIR}/bin/gitbutler-tauri"
  ensure_file_exists "${binary}" "gitbutler runtime"
  local from="https://app.gitbutler.com/releases/release/"
  local to="https://x.invalid.invalid/releases/release/"
  [[ "${#from}" -eq "${#to}" ]] || error "updater endpoint patch length mismatch: ${#from} vs ${#to}"
  LC_ALL=C sed -i "s|${from}|${to}|g" "${binary}"
  strings "${binary}" | grep -F -q -- "${to}" || error "updater patch verification failed: ${to} not found"
  if strings "${binary}" | grep -F -q -- "${from}"; then
    error "updater endpoint patch verification failed: original still present"
  fi
  info "Updater endpoint neutralized"

  # Fail loudly if any other file in the AppDir embeds the original endpoint
  local matches
  matches="$(grep -rlaF -- "${from}" "${APPDIR}" 2>/dev/null || true)"
  if [[ -n "${matches}" ]]; then
    error "updater endpoint patch incomplete: original endpoint still present in: ${matches}"
  fi
  info "Verified no file in APPDIR still references the upstream updater endpoint"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/share/applications/${PACKAGE_NAME}.desktop"
  cp -- "${payload_dir}/usr/share/icons/hicolor/128x128/apps/gitbutler-tauri.png" "${APPDIR}/${PACKAGE_NAME}.png"
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

  command -v quick-sharun >/dev/null 2>&1 || error "quick-sharun is required.
Install the Anylinux tools (install-anylinux-tools.sh) or add it to PATH."
  [[ -x "${APPIMAGETOOL}" ]] || error "APPIMAGETOOL is not executable: ${APPIMAGETOOL}"

  quick-sharun "${APPDIR}/bin/gitbutler-tauri" "${APPDIR}/bin/gitbutler-git-askpass" "${APPDIR}/bin/but"

  # Pre-place settings-seeding hook (sourced by AppRun.sh at runtime)
  hooks_dir="${APPDIR}/bin"
  if [[ -d "${hooks_dir}" ]]; then
    cat >"${hooks_dir}/02-prevent-autoupdate.hook" <<-'HOOK'
_prevent_autoupdate() {
  local config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/gitbutler"
  local config_file="${config_dir}/settings.json"
  [[ ! -L "${config_dir}" ]] || return 0
  [[ ! -L "${config_file}" ]] || return 0
  mkdir -p -- "${config_dir}" || return 0
  if [[ ! -s "${config_file}" ]]; then
    printf '%s\n' '{"ui":{"checkForUpdatesIntervalInSeconds":0}}' > "${config_file}" 2>/dev/null || return 0
    return 0
  fi
  grep -Eq '"checkForUpdatesIntervalInSeconds"[[:space:]]*:[[:space:]]*0([^0-9]|$)' "${config_file}" 2>/dev/null && return 0
  grep -q '"checkForUpdatesIntervalInSeconds"' "${config_file}" 2>/dev/null && {
    LC_ALL=C sed -i -E 's/"checkForUpdatesIntervalInSeconds"[[:space:]]*:[[:space:]]*[0-9]+/"checkForUpdatesIntervalInSeconds": 0/' "${config_file}" 2>/dev/null || true
    return 0
  }
  if grep -q '^[[:space:]]*"ui"[[:space:]]*:[[:space:]]*{$' "${config_file}" 2>/dev/null; then
    LC_ALL=C sed -i '/^[[:space:]]*"ui"[[:space:]]*:[[:space:]]*{/a\    "checkForUpdatesIntervalInSeconds": 0,' "${config_file}" 2>/dev/null || true
  else
    LC_ALL=C sed -i -E '$ s/\}[[:space:]]*$/,"ui":{"checkForUpdatesIntervalInSeconds":0}}/' "${config_file}" 2>/dev/null || true
  fi
}
_prevent_autoupdate
HOOK
    chmod 0644 -- "${hooks_dir}/02-prevent-autoupdate.hook"
    info "Pre-placed settings-seeding hook"
  fi

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
