#!/bin/bash
# Local gate: runs the same checks as the CI test-bot workflow.
# Install as a pre-push hook:
#   ln -sf ../../packaging/scripts/check-style.sh .git/hooks/pre-push
# Or run manually before pushing:
#   packaging/scripts/check-style.sh

set -euo pipefail

TAP_REPO="${GITHUB_REPOSITORY:-edgarcnp/homebrew-tap}"
TAP_DIR="$(brew --repository "${TAP_REPO}")"
cd "${TAP_DIR}"

echo "=== shellcheck ==="
# globbed so a new script is covered automatically; -x follows the sourced
# pipeline libraries from packaging/
find packaging -name '*.sh' -print0 | xargs -0 shellcheck -x -P packaging
echo "shellcheck: OK"

echo "=== packaging dev dependencies ==="
if [[ ! -d node_modules ]]
then
  bun install --frozen-lockfile --ignore-scripts
fi
echo "dev dependencies: OK"

echo "=== typecheck ==="
bun run typecheck
echo "typecheck: OK"

echo "=== unit tests ==="
bun test
echo "unit tests: OK"

echo "=== cask vs app descriptor ==="
bun packaging/bin/fbr.ts cask --action check
echo "cask check: OK"

echo "=== brew style ==="
brew style edgarcnp/tap
echo "brew style: OK"

echo "=== brew audit ==="
for cask in "${TAP_DIR}"/Casks/*.rb
do
  brew audit --cask "edgarcnp/tap/$(basename "${cask}" .rb)"
done
echo "brew audit: OK"

echo "=== actionlint ==="
if command -v actionlint >/dev/null 2>&1
then
  # no arguments: actionlint discovers .github/workflows/*.yml itself
  actionlint
  echo "actionlint: OK"
else
  echo "actionlint: not installed; skipping (CI still runs it)"
fi

echo "--- all gates passed ---"
