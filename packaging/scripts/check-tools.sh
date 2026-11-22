#!/bin/bash
# Fast packaging-tool check: no AppImage build. It loads every descriptor,
# exercises the CI projection and the JSON Schema command, and checks every
# cask. Main pushes and the production-dependency CI job run this; the full
# six-app build smoke is manual.

set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."

mapfile -t apps < <(bun packaging/bin/fbr.ts list-apps)
if [[ ${#apps[@]} -eq 0 ]]
then
  echo "no app descriptors found" >&2
  exit 1
fi

for app in "${apps[@]}"
do
  bun packaging/bin/fbr.ts descriptor --app "${app}" >/dev/null
  bun packaging/bin/fbr.ts descriptor-env --app "${app}" >/dev/null
  bun packaging/bin/fbr.ts descriptor-env --app "${app}" --format output >/dev/null
  echo "checked ${app}"
done

bun packaging/bin/fbr.ts descriptor-schema >/dev/null
bun packaging/bin/fbr.ts cask --action check
echo "packaging tools: OK"
