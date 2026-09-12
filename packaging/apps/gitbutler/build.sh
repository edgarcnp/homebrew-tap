#!/bin/bash
set -Eeuo pipefail

# Thin shim: the pipeline lives in packaging/lib/build-appimage.sh and this
# app's configuration in app.json.
# shellcheck source=lib/build-appimage.sh
exec "$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")/../../lib" && pwd)/build-appimage.sh" gitbutler
