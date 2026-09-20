#!/bin/bash
set -Eeuo pipefail

# Thin shim: the pipeline lives in packaging/lib/shell/build-appimage.sh and this
# app's configuration in app.json.
# shellcheck source=lib/shell/build-appimage.sh
exec "$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")/../../lib/shell" && pwd)/build-appimage.sh" commandcode
