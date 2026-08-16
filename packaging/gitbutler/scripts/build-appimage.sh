#!/bin/bash
set -Eeuo pipefail

# Build a self-contained gitbutler AppImage from the .deb fetched via the
# app.gitbutler.com redirect (no signed apt repo; SHA-256 pinned). Webkit
# runtime closure is bundled; dist output lands in <tap>/dist for CI.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

RESOLVE_SCRIPT="${PACKAGING_DIR}/scripts/resolve-gitbutler.js"
FETCH_WEBKIT_DEPS_SCRIPT="${PACKAGING_DIR}/scripts/fetch-webkit-deps.sh"
APPRUN_TEMPLATE="${PACKAGING_DIR}/templates/AppRun"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/gitbutler.desktop"
WORK_DIR="${WORK_DIR_OVERRIDE:-$(mktemp -d)}"
if [[ -z "${WORK_DIR_OVERRIDE:-}" ]]
then
  # Clean up the temp dir we created; an explicit WORK_DIR_OVERRIDE is
  # caller-owned and left alone.
  trap 'rm -rf "${WORK_DIR}"' EXIT
fi
DIST_DIR="${DIST_DIR_OVERRIDE:-${REPO_DIR}/dist}"
APPDIR="${APPIMAGE_APPDIR_OVERRIDE:-${DIST_DIR}/appimage.AppDir}"
PACKAGE_NAME="${PACKAGE_NAME:-gitbutler}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-GitButler}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Git, finally designed for humans}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"
# Assumed upstream layout (no signed apt repo): GET <base>/<deb_arch>/deb
# redirects to
# https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<url_arch>/GitButler_<version>_<deb_arch>.deb
# and the resolver validates exactly that shape.
RESOLVE_BASE_URL="${RESOLVE_BASE_URL:-https://app.gitbutler.com/downloads/release/linux}"

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
  local bin_dir="${payload_dir}/usr/bin"
  local icon="${payload_dir}/usr/share/icons/hicolor/256x256@2/apps/gitbutler-tauri.png"

  ensure_file_exists "${bin_dir}/gitbutler-tauri" "gitbutler runtime"
  ensure_file_exists "${bin_dir}/gitbutler-git-askpass" "gitbutler askpass helper"
  ensure_file_exists "${icon}" "gitbutler icon"

  info "Preparing AppDir at ${APPDIR}"
  rm -rf "${APPDIR}"
  mkdir -p \
    "${APPDIR}/opt/gitbutler/bin" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/256x256/apps"

  cp "${bin_dir}/gitbutler-tauri" "${APPDIR}/opt/gitbutler/bin/gitbutler-tauri"
  cp "${bin_dir}/gitbutler-git-askpass" "${APPDIR}/opt/gitbutler/bin/gitbutler-git-askpass"
  ln -s gitbutler-tauri "${APPDIR}/opt/gitbutler/bin/but"

  render_template "${APPRUN_TEMPLATE}" "${APPDIR}/AppRun"
  chmod 0755 "${APPDIR}/AppRun"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/usr/share/applications/${PACKAGE_NAME}.desktop"

  cp "${icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp "${icon}" "${APPDIR}/.DirIcon"
  cp "${icon}" "${APPDIR}/usr/share/icons/hicolor/256x256/apps/${PACKAGE_NAME}.png"

  bundle_webkit_deps

  normalize_package_payload_permissions "${APPDIR}"
  chmod 0755 "${APPDIR}/opt/gitbutler/bin/gitbutler-tauri"
  chmod 0755 "${APPDIR}/opt/gitbutler/bin/gitbutler-git-askpass"
}

bundle_webkit_deps() {
  local deps_dir extract_dir deb
  deps_dir="$("${FETCH_WEBKIT_DEPS_SCRIPT}" "${TARGET_ARCH}" "${WORK_DIR}/webkit-deps" "${deb_path}")"
  [[ -d "${deps_dir}" ]] || error "webkit dependency debs directory is missing: ${deps_dir}"
  extract_dir="${WORK_DIR}/webkit-deps-extract"
  rm -rf "${extract_dir}"
  mkdir -p "${extract_dir}"
  for deb in "${deps_dir}"/*.deb
  do
    [[ -e "${deb}" ]] || continue
    info "Bundling webkit dependency: $(basename "${deb}")"
    dpkg-deb -x "${deb}" "${extract_dir}"
  done
  mkdir -p "${APPDIR}/usr/lib" "${APPDIR}/usr/share/glib-2.0"
  [[ -d "${extract_dir}/lib" ]] && cp -a "${extract_dir}/lib/." "${APPDIR}/usr/lib/"
  [[ -d "${extract_dir}/usr/lib" ]] && cp -a "${extract_dir}/usr/lib/." "${APPDIR}/usr/lib/"
  [[ -d "${extract_dir}/usr/share/glib-2.0" ]] && cp -a "${extract_dir}/usr/share/glib-2.0/." "${APPDIR}/usr/share/glib-2.0/"
  [[ -d "${extract_dir}/usr/share/gsettings-schemas" ]] && cp -a "${extract_dir}/usr/share/gsettings-schemas/." "${APPDIR}/usr/share/gsettings-schemas/"
  info "Bundled webkit dependency closure into ${APPDIR}/usr"
}

main() {
  ensure_file_exists "${RESOLVE_SCRIPT}" "GitButler resolver"
  ensure_file_exists "${FETCH_WEBKIT_DEPS_SCRIPT}" "webkit dependency fetcher"
  ensure_file_exists "${APPRUN_TEMPLATE}" "AppImage AppRun template"
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
  if [[ -n "${PACKAGE_VERSION:-}" ]]
  then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved upstream version ${resolved_version} does not match PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    info "Derived PACKAGE_VERSION ${PACKAGE_VERSION} from upstream metadata"
  fi

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p "${payload_dir}"
  info "Extracting package: ${deb_path}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  prepare_appdir "${payload_dir}"

  local appimagetool
  appimagetool="$(resolve_appimagetool)"
  mkdir -p "${DIST_DIR}"
  local output_file="${DIST_DIR}/gitbutler-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  rm -f "${output_file}"
  info "Building AppImage: ${output_file}"
  ARCH="${appimage_arch}" VERSION="${PACKAGE_VERSION}" \
    "${appimagetool}" --no-appstream "${APPDIR}" "${output_file}" >&2
  chmod 0755 "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
