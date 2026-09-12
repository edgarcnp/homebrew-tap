#!/bin/bash
set -Eeuo pipefail

# Builds one app's AppImage from its descriptor. Every app shares this script;
# per-app behavior comes from packaging/apps/<app>/app.json. Invoked through
# the thin packaging/apps/<app>/build.sh shims.
#
# Usage: packaging/lib/build-appimage.sh <app-id>

LIB_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=lib/appimage-pipeline.sh
. "${LIB_DIR}/appimage-pipeline.sh"

APP_ID="${1:?usage: build-appimage.sh <app-id>}"
pipeline_init "${APP_ID}"

main() {
  pipeline_resolve
  pipeline_extract
  pipeline_stage
  pipeline_neutralize
  pipeline_render_desktop
  pipeline_install_icon
  pipeline_pack
}

main
