#!/bin/bash
set -Eeuo pipefail

# Build the visual-studio-code AppImage from Microsoft's signed APT repository.
# The unattended source of trust is the signed stable APT index
# (packages.microsoft.com/repos/code), pinned to key fingerprint
# BC528686B50D79E339D3721CEB3E94ADBE1229CF. Runs inside the tap checkout on
# the CI runner; dist output lands in <tap>/dist so the reusable AppImage
# workflow can upload it.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGING_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$PACKAGING_DIR/../.." && pwd)"
LIB_DIR="$(cd "$PACKAGING_DIR/../lib" && pwd)"

. "$LIB_DIR/package-common.sh"

KEY_FILE="$PACKAGING_DIR/assets/microsoft-vscode-repository-key.gpg.base64"
APPRUN_TEMPLATE="$PACKAGING_DIR/templates/AppRun"
DESKTOP_TEMPLATE="$PACKAGING_DIR/templates/vscode.desktop"
WORK_DIR="${WORK_DIR_OVERRIDE:-$(mktemp -d)}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
APPDIR="${APPIMAGE_APPDIR_OVERRIDE:-$DIST_DIR/appimage.AppDir}"
PACKAGE_NAME="${PACKAGE_NAME:-vscode}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-Visual Studio Code}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Code Editing. Redefined.}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d)}"

map_arch() {
    case "$TARGET_ARCH" in
        amd64 | x86_64)
            echo "amd64 x86_64"
            ;;
        arm64 | aarch64)
            echo "arm64 aarch64"
            ;;
        *) error "Unsupported AppImage architecture: $TARGET_ARCH (official packages support amd64 and arm64 only)" ;;
    esac
}

resolve_appimagetool() {
    if [ -n "${APPIMAGETOOL:-}" ]; then
        [ -x "$APPIMAGETOOL" ] || error "APPIMAGETOOL is not executable: $APPIMAGETOOL"
        printf '%s\n' "$APPIMAGETOOL"
        return 0
    fi

    command -v appimagetool >/dev/null 2>&1 || error "appimagetool is required.
Install appimagetool or set APPIMAGETOOL=/path/to/appimagetool."
    command -v appimagetool
}

prepare_appdir() {
    local payload_dir="$1"
    local arch="$2"
    local code_dir="$payload_dir/usr/share/code"
    local icon="$payload_dir/usr/share/pixmaps/vscode.png"

    ensure_file_exists "$code_dir/code" "official code runtime"
    ensure_file_exists "$icon" "official vscode icon"

    info "Preparing AppDir at $APPDIR"
    rm -rf "$APPDIR"
    mkdir -p \
        "$APPDIR/opt" \
        "$APPDIR/usr/share/applications" \
        "$APPDIR/usr/share/icons/hicolor/256x256/apps"

    cp -aT "$code_dir" "$APPDIR/opt/vscode"

    render_template "$APPRUN_TEMPLATE" "$APPDIR/AppRun"
    chmod 0755 "$APPDIR/AppRun"

    render_template "$DESKTOP_TEMPLATE" "$APPDIR/$PACKAGE_NAME.desktop"
    chmod 0644 "$APPDIR/$PACKAGE_NAME.desktop"
    cp "$APPDIR/$PACKAGE_NAME.desktop" "$APPDIR/usr/share/applications/$PACKAGE_NAME.desktop"

    cp "$icon" "$APPDIR/$PACKAGE_NAME.png"
    cp "$icon" "$APPDIR/.DirIcon"
    cp "$icon" "$APPDIR/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"

    normalize_package_payload_permissions "$APPDIR"
    chmod 0755 "$APPDIR/opt/vscode/code"
}

main() {
    ensure_file_exists "$KEY_FILE" "pinned repository signing key"
    ensure_file_exists "$APPRUN_TEMPLATE" "AppImage AppRun template"
    ensure_file_exists "$DESKTOP_TEMPLATE" "AppImage desktop template"

    local arch_line deb_arch appimage_arch
    arch_line="$(map_arch)"
    deb_arch="${arch_line% *}"
    appimage_arch="${arch_line#* }"

    local deb_path
    info "Resolving official code package for $deb_arch"
    deb_path="$(node "$LIB_DIR/upstream-linux-package.js" \
        --output-dir "$WORK_DIR" \
        --metadata "$WORK_DIR/metadata.json" \
        --key-base64 "$KEY_FILE" \
        --package code \
        --fingerprint BC528686B50D79E339D3721CEB3E94ADBE1229CF \
        --repository https://packages.microsoft.com/repos/code \
        --arch "$deb_arch")"

    local payload_dir="$WORK_DIR/deb-payload"
    mkdir -p "$payload_dir"
    info "Extracting official package: $deb_path"
    dpkg-deb -x "$deb_path" "$payload_dir"

    prepare_appdir "$payload_dir" "$appimage_arch"

    local appimagetool
    appimagetool="$(resolve_appimagetool)"
    mkdir -p "$DIST_DIR"
    local output_file="$DIST_DIR/vscode-${PACKAGE_VERSION}-${appimage_arch}.AppImage"
    rm -f "$output_file"
    info "Building AppImage: $output_file"
    ARCH="$appimage_arch" VERSION="$PACKAGE_VERSION" \
        "$appimagetool" --no-appstream "$APPDIR" "$output_file" >&2
    chmod 0755 "$output_file"
    info "Built AppImage: $output_file"
}

main "$@"
