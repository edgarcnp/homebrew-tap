#!/bin/bash
# Homebrew's style checks over the repository's authored files only.
#
# `brew style <tap>` expands every `*.sh` below the tap, including
# `node_modules`: dependencies may vendor scripts with their own style, which
# is not this repository's to fix. Passing the authored files explicitly keeps
# the same linters without scanning dependencies.

set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."

mapfile -t casks < <(find Casks -maxdepth 1 -type f -name '*.rb' | sort)
mapfile -t shells < <(find packaging -type f -name '*.sh' -not -path '*/node_modules/*' | sort)
mapfile -t workflows < <(find .github/workflows -maxdepth 1 -type f -name '*.yml' | sort)

brew style "${casks[@]}" "${shells[@]}" "${workflows[@]}"
