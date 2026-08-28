#!/bin/bash
set -Eeuo pipefail

# Build a self-contained gitbutler AppImage from the .deb fetched via the
# app.gitbutler.com redirect (no signed apt repo; SHA-256 pinned). The
# webkit2gtk runtime closure is bundled with linuxdeploy plus the webkit
# helper processes (WebKitWebProcess/WebKitNetworkProcess) and their runtime
# data; dist output lands in <tap>/dist for CI.

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGING_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

RESOLVE_SCRIPT="${PACKAGING_DIR}/scripts/resolve-gitbutler.js"
APPRUN_TEMPLATE="${PACKAGING_DIR}/templates/AppRun"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/templates/gitbutler.desktop"
setup_work_dir "gb-build"
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
PACKAGE_NAME="${PACKAGE_NAME:-gitbutler}"
[[ "${PACKAGE_NAME}" =~ ^[A-Za-z0-9._-]+$ ]] || error "invalid PACKAGE_NAME: ${PACKAGE_NAME}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-GitButler}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Git, finally designed for humans}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"
# Assumed upstream layout (no signed apt repo): GET <base>/<deb_arch>/deb
# redirects to
# https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<url_arch>/GitButler_<version>_<deb_arch>.deb
# and the resolver validates exactly that shape.
RESOLVE_BASE_URL="${RESOLVE_BASE_URL:-https://app.gitbutler.com/downloads/release/linux}"

resolve_linuxdeploy() {
  if [[ -n "${LINUXDEPLOY:-}" ]]
  then
    [[ -x "${LINUXDEPLOY}" ]] || error "LINUXDEPLOY is not executable: ${LINUXDEPLOY}"
    printf '%s\n' "${LINUXDEPLOY}"
    return 0
  fi

  command -v linuxdeploy >/dev/null 2>&1 || error "linuxdeploy is required.
Install linuxdeploy or set LINUXDEPLOY=/path/to/linuxdeploy."
  command -v linuxdeploy
}

prepare_appdir() {
  local payload_dir="$1"
  local bin_dir="${payload_dir}/usr/bin"
  local icon="${payload_dir}/usr/share/icons/hicolor/128x128/apps/gitbutler-tauri.png"

  ensure_file_exists "${bin_dir}/gitbutler-tauri" "gitbutler runtime"
  ensure_file_exists "${bin_dir}/gitbutler-git-askpass" "gitbutler askpass helper"
  ensure_file_exists "${icon}" "gitbutler icon"

  info "Preparing AppDir at ${APPDIR}"
  rm -rf -- "${APPDIR}"
  mkdir -p -- \
    "${APPDIR}/opt/gitbutler/bin" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/128x128/apps"

  cp -- "${bin_dir}/gitbutler-tauri" "${APPDIR}/opt/gitbutler/bin/gitbutler-tauri"
  cp -- "${bin_dir}/gitbutler-git-askpass" "${APPDIR}/opt/gitbutler/bin/gitbutler-git-askpass"
  ln -s gitbutler-tauri -- "${APPDIR}/opt/gitbutler/bin/but"

  render_template "${DESKTOP_TEMPLATE}" "${APPDIR}/${PACKAGE_NAME}.desktop"
  chmod 0644 -- "${APPDIR}/${PACKAGE_NAME}.desktop"
  cp -- "${APPDIR}/${PACKAGE_NAME}.desktop" "${APPDIR}/usr/share/applications/${PACKAGE_NAME}.desktop"

  cp -- "${icon}" "${APPDIR}/${PACKAGE_NAME}.png"
  cp -- "${icon}" "${APPDIR}/.DirIcon"
  cp -- "${icon}" "${APPDIR}/usr/share/icons/hicolor/128x128/apps/${PACKAGE_NAME}.png"
}

run_linuxdeploy() {
  local linuxdeploy="$1"

  info "Bundling shared libraries with linuxdeploy"
  # The desktop file Exec must name the main binary; linuxdeploy validates it
  # against --executable and copies the ldd closure into <appdir>/usr/lib.
  APPIMAGE_EXTRACT_AND_RUN=1 "${linuxdeploy}" \
    --appdir "${APPDIR}" \
    --executable "${APPDIR}/opt/gitbutler/bin/gitbutler-tauri" \
    --desktop-file "${APPDIR}/${PACKAGE_NAME}.desktop" \
    --icon-file "${APPDIR}/${PACKAGE_NAME}.png"
}

# Production webkit2gtk hardcodes its helper-process directory (LIBEXECDIR,
# e.g. /usr/libexec/webkit2gtk-4.1) at compile time and ignores
# WEBKIT_EXEC_PATH outside developer builds, so the AppImage must carry the
# helpers at a patched relative path. The binary patch replaces /usr with
# ././ (same byte length) so the .so stays valid; the helpers are copied to
# the relative path the patched string resolves to, and AppRun cd's to the
# AppDir root so that path resolves.
bundle_webkit_helpers() {
  local webkit_dir=""
  local candidate
  for candidate in /usr/libexec/webkit2gtk-4.1 /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1 /usr/lib64/webkit2gtk-4.1
  do
    if [[ -d "${candidate}" ]]
    then
      webkit_dir="${candidate}"
      break
    fi
  done
  if [[ -z "${webkit_dir}" ]]
  then
    local webkit_process
    webkit_process="$(find /usr -maxdepth 4 -name WebKitWebProcess -path "*webkit2gtk*" 2>/dev/null | head -n1 || true)"
    if [[ -n "${webkit_process}" ]]
    then
      webkit_dir="$(dirname "${webkit_process}")"
    fi
  fi
  [[ -n "${webkit_dir}" ]] || error "WebKit helper directory not found; install libwebkit2gtk-4.1-dev before building"

  local webkit_lib="${APPDIR}/usr/lib/libwebkit2gtk-4.1.so.0"
  ensure_file_exists "${webkit_lib}" "bundled libwebkit2gtk-4.1"

  local hardcoded
  hardcoded="$(strings "${webkit_lib}" | grep -m1 '/webkit2gtk-4.1$' || true)"
  [[ -n "${hardcoded}" ]] || error "No hardcoded webkit2gtk helper path found in ${webkit_lib}; cannot patch helper locations"
  [[ "${hardcoded}" == /usr/* ]] || error "hardcoded webkit helper path does not start with /usr: ${hardcoded}"

  local relative="././${hardcoded#/usr}"
  [[ "${#hardcoded}" -eq "${#relative}" ]] || error "patched path length mismatch: ${#hardcoded} vs ${#relative} (${hardcoded} -> ${relative}); refusing to corrupt ELF"
  info "Patching webkit helper path: ${hardcoded} -> ${relative}"

  local escaped_hardcoded escaped_relative
  escaped_hardcoded="$(sed_escape_replacement "${hardcoded}")"
  escaped_hardcoded="${escaped_hardcoded//|/\\|}"
  escaped_relative="$(sed_escape_replacement "${relative}")"
  escaped_relative="${escaped_relative//|/\\|}"

  local tmp_lib
  tmp_lib="$(mktemp "${webkit_lib}.tmp.XXXXXX")"
  cp -- "${webkit_lib}" "${tmp_lib}" || {
    rm -f -- "${tmp_lib}"
    error "failed to copy ${webkit_lib} to temp file"
  }
  LC_ALL=C sed -i "s|${escaped_hardcoded}|${escaped_relative}|g" "${tmp_lib}" || {
    rm -f -- "${tmp_lib}"
    error "failed to patch webkit helper path"
  }
  mv -- "${tmp_lib}" "${webkit_lib}" || {
    rm -f -- "${tmp_lib}"
    error "failed to move patched lib into place"
  }

  strings "${webkit_lib}" | grep -F -q -- "${relative}" || error "patch verification failed: ${relative} not found in ${webkit_lib}"

  local helpers_dir="${APPDIR}${hardcoded#/usr}"
  mkdir -p -- "${helpers_dir}"
  cp -- "${webkit_dir}/WebKitWebProcess" "${helpers_dir}/"
  cp -- "${webkit_dir}/WebKitNetworkProcess" "${helpers_dir}/"
  if [[ -d "${webkit_dir}/injected-bundle" ]]
  then
    cp -r -- "${webkit_dir}/injected-bundle" "${helpers_dir}/"
  fi
  info "Bundled webkit helpers from ${webkit_dir} into ${helpers_dir}"
}

# The official .deb ships with Tauri's built-in updater enabled. brew owns
# updates for this AppImage, so neutralize the updater at the source: rewrite
# the embedded updater endpoint host to a never-resolving name (same byte
# length, like the webkit helper patch) so neither the periodic auto-check nor
# the manual "Check for updates…" menu item can ever find or install an
# update. Fail loudly if upstream changes the endpoint, rather than shipping
# a build with the updater silently re-enabled.
disable_updater_endpoint() {
  local binary="${APPDIR}/opt/gitbutler/bin/gitbutler-tauri"
  ensure_file_exists "${binary}" "gitbutler runtime"

  local from to
  from="https://app.gitbutler.com/releases/release/"
  to="https://x.invalid.invalid/releases/release/"
  [[ "${#from}" -eq "${#to}" ]] || error "updater endpoint patch length mismatch: ${#from} vs ${#to}; refusing to corrupt ELF"

  local escaped_from escaped_to
  escaped_from="$(sed_escape_replacement "${from}")"
  escaped_from="${escaped_from//|/\\|}"
  escaped_to="$(sed_escape_replacement "${to}")"
  escaped_to="${escaped_to//|/\\|}"

  local tmp_bin
  tmp_bin="$(mktemp "${binary}.tmp.XXXXXX")"
  cp -- "${binary}" "${tmp_bin}" || {
    rm -f -- "${tmp_bin}"
    error "failed to copy ${binary} to temp file"
  }
  LC_ALL=C sed -i "s|${escaped_from}|${escaped_to}|g" "${tmp_bin}" || {
    rm -f -- "${tmp_bin}"
    error "failed to patch updater endpoint in ${binary}"
  }
  mv -- "${tmp_bin}" "${binary}" || {
    rm -f -- "${tmp_bin}"
    error "failed to move patched binary into place"
  }

  strings "${binary}" | grep -F -q -- "${to}" || error "updater endpoint patch verification failed: ${to} not found in ${binary}"
  if strings "${binary}" | grep -F -q -- "${from}"
  then
    error "updater endpoint patch verification failed: original endpoint ${from} still present in ${binary}"
  fi
  info "Neutralized updater endpoint: ${from} -> ${to}"
}

# The endpoint may be embedded in more than the main binary (e.g. a resources
# JSON file or a helper .so); scan every file in the AppDir so a second copy
# can never silently re-enable the updater after disable_updater_endpoint.
verify_updater_neutralized() {
  local from="https://app.gitbutler.com/releases/release/"
  local matches
  matches="$(grep -rlaF -- "${from}" "${APPDIR}" 2>/dev/null || true)"
  if [[ -n "${matches}" ]]
  then
    error "updater endpoint patch incomplete: original endpoint still present in: ${matches}"
  fi
  info "Verified no file in APPDIR still references the upstream updater endpoint"
}

bundle_glib_schemas() {
  local schemas="/usr/share/glib-2.0/schemas/gschemas.compiled"
  [[ -f "${schemas}" ]] || error "Missing ${schemas}; install libwebkit2gtk-4.1-dev before building"
  mkdir -p -- "${APPDIR}/usr/share/glib-2.0/schemas"
  cp -- "${schemas}" "${APPDIR}/usr/share/glib-2.0/schemas/"
  info "Bundled GLib schemas from ${schemas}"
}

bundle_gio_modules() {
  local gio_dir
  gio_dir="$(pkg-config --variable=giomoduledir gio-2.0 2>/dev/null || true)"
  if [[ -z "${gio_dir}" || ! -d "${gio_dir}" ]]
  then
    for candidate in /usr/lib/x86_64-linux-gnu/gio/modules /usr/lib64/gio/modules
    do
      if [[ -d "${candidate}" ]]
      then
        gio_dir="${candidate}"
        break
      fi
    done
  fi
  [[ -n "${gio_dir}" && -d "${gio_dir}" ]] || error "GIO modules directory not found; install glib-networking before building"
  mkdir -p -- "${APPDIR}/usr/lib/gio/modules"
  shopt -s nullglob
  local _gio_so=("${gio_dir}"/*.so)
  ((${#_gio_so[@]})) || error "No GIO modules found in ${gio_dir}"
  shopt -u nullglob
  cp -- "${_gio_so[@]}" "${APPDIR}/usr/lib/gio/modules/"
  info "Bundled GIO modules from ${gio_dir}"
}

bundle_gdk_pixbuf_loaders() {
  local pixbuf_module_dir
  pixbuf_module_dir="$(pkg-config --variable=gdk_pixbuf_moduledir gdk-pixbuf-2.0 2>/dev/null || true)"
  local pixbuf_dir=""
  if [[ -n "${pixbuf_module_dir}" && -d "${pixbuf_module_dir}" ]]
  then
    pixbuf_dir="$(dirname "${pixbuf_module_dir}")"
  else
    for candidate in /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0 /usr/lib64/gdk-pixbuf-2.0/2.10.0
    do
      if [[ -d "${candidate}" ]]
      then
        pixbuf_dir="${candidate}"
        break
      fi
    done
  fi
  [[ -n "${pixbuf_dir}" && -d "${pixbuf_dir}/loaders" ]] || error "GDK pixbuf loader directory not found; install libgdk-pixbuf2.0-bin before building"
  mkdir -p -- "${APPDIR}/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders"
  shopt -s nullglob
  local _pix_so=("${pixbuf_dir}"/loaders/*.so)
  ((${#_pix_so[@]})) || error "No GDK pixbuf loaders found in ${pixbuf_dir}/loaders"
  shopt -u nullglob
  cp -- "${_pix_so[@]}" "${APPDIR}/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders/"
  if command -v gdk-pixbuf-query-loaders >/dev/null 2>&1
  then
    GDK_PIXBUF_MODULEDIR="${APPDIR}/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders" \
      gdk-pixbuf-query-loaders >"${APPDIR}/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
  fi
  info "Bundled GDK pixbuf loaders from ${pixbuf_dir}"
}

write_apprun() {
  # linuxdeploy leaves AppRun as a symlink to the main binary; writing
  # through it would overwrite gitbutler-tauri with the script, so remove
  # it before rendering the real AppRun.
  rm -f -- "${APPDIR}/AppRun"
  render_template "${APPRUN_TEMPLATE}" "${APPDIR}/AppRun"
  chmod 0755 -- "${APPDIR}/AppRun"
  cp -- "${LIB_DIR}/apprun-common.sh" "${APPDIR}/apprun-common.sh"
  chmod 0644 -- "${APPDIR}/apprun-common.sh"
}

main() {
  ensure_file_exists "${RESOLVE_SCRIPT}" "GitButler resolver"
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
  if [[ -n "${PACKAGE_VERSION}" ]]
  then
    [[ "${resolved_version}" = "${PACKAGE_VERSION}" ]] || error "Resolved upstream version ${resolved_version} does not match PACKAGE_VERSION ${PACKAGE_VERSION}"
  else
    PACKAGE_VERSION="${resolved_version}"
    info "Derived PACKAGE_VERSION ${PACKAGE_VERSION} from upstream metadata"
    validate_package_version "${PACKAGE_VERSION}"
  fi

  local payload_dir="${WORK_DIR}/deb-payload"
  mkdir -p -- "${payload_dir}"
  info "Extracting package: ${deb_path}"
  dpkg-deb -x "${deb_path}" "${payload_dir}"

  prepare_appdir "${payload_dir}"
  disable_updater_endpoint

  local linuxdeploy
  linuxdeploy="$(resolve_linuxdeploy)"
  run_linuxdeploy "${linuxdeploy}"

  bundle_webkit_helpers
  bundle_glib_schemas
  bundle_gio_modules
  bundle_gdk_pixbuf_loaders
  write_apprun

  normalize_package_payload_permissions "${APPDIR}"
  chmod 0755 -- "${APPDIR}/opt/gitbutler/bin/gitbutler-tauri"
  chmod 0755 -- "${APPDIR}/opt/gitbutler/bin/gitbutler-git-askpass"

  local appimagetool
  appimagetool="$(resolve_appimagetool)"
  verify_updater_neutralized
  mkdir -p -- "${DIST_DIR}"
  local output_file="${DIST_DIR}/gitbutler-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
  rm -f -- "${output_file}"
  info "Building AppImage: ${output_file}"
  ARCH="${appimage_arch}" VERSION="${PACKAGE_VERSION}" \
    "${appimagetool}" --no-appstream "${APPDIR}" "${output_file}" >&2
  chmod 0755 -- "${output_file}"
  smoke_test_appimage "${output_file}"
  info "Built AppImage: ${output_file}"
}

main "$@"
