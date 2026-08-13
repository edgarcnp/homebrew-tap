#!/bin/bash

info() {
    echo "[INFO] $*" >&2
}

warn() {
    echo "[WARN] $*" >&2
}

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

ensure_file_exists() {
    local path="$1"
    local label="$2"
    [ -f "$path" ] || error "Missing $label: $path"
}

sed_escape_replacement() {
    printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

render_template() {
    local source="$1"
    local target="$2"
    local package_name
    local display_name
    local comment
    local version

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    display_name="$(sed_escape_replacement "$PACKAGE_DISPLAY_NAME")"
    comment="$(sed_escape_replacement "$PACKAGE_COMMENT")"
    version="$(sed_escape_replacement "$PACKAGE_VERSION")"

    sed \
        -e "s/__PACKAGE_NAME__/$package_name/g" \
        -e "s/__PACKAGE_DISPLAY_NAME__/$display_name/g" \
        -e "s/__PACKAGE_COMMENT__/$comment/g" \
        -e "s/__VERSION__/$version/g" \
        "$source" > "$target"
}

normalize_package_payload_permissions() {
    local root="$1"

    [ -d "$root" ] || error "Missing package root: $root"
    find "$root" -type d -exec chmod 0755 {} +
    find "$root" -type f \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0755 {} +
    find "$root" -type f ! \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0644 {} +
}
