#!/bin/bash
# Local style gate: runs the same checks as the CI test-bot workflow.
# Install as a pre-push hook:
#   ln -sf ../../packaging/scripts/check-style.sh .git/hooks/pre-push
# Or run manually before pushing:
#   packaging/scripts/check-style.sh

set -euo pipefail

TAP_REPO="${GITHUB_REPOSITORY:-edgarcnp/homebrew-tap}"
TAP_DIR="$(brew --repository "${TAP_REPO}")"
cd "${TAP_DIR}"

echo "=== shellcheck ==="
shellcheck packaging/scripts/install-anylinux-tools.sh \
  packaging/lib/package-common.sh \
  packaging/gitbutler/scripts/build-appimage.sh \
  packaging/opencode/scripts/build-appimage.sh \
  packaging/vscode/scripts/build-appimage.sh
echo "shellcheck: OK"

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
  actionlint \
    .github/workflows/build-appimage.yml \
    .github/workflows/build-gitbutler.yml \
    .github/workflows/build-opencode-desktop.yml \
    .github/workflows/build-vscode.yml \
    .github/workflows/cask-smoke.yml \
    .github/workflows/tests.yml \
    .github/workflows/autobump.yml \
    .github/workflows/publish.yml
  echo "actionlint: OK"
else
  echo "actionlint: not installed; skipping (CI still runs it)"
fi

echo "--- all style gates passed ---"
