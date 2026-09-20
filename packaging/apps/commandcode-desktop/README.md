# commandcode-desktop packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

Upstream [Command Code Desktop](https://commandcode.ai/desktop) publishes
Linux builds only for x64 (an electron-builder `.deb` plus an `x86_64`
AppImage; the installer fails on any other Linux architecture with "The
current Linux preview supports x64 only"). This pipeline repackages the
amd64 `.deb` from the
[CommandCodeAI/desktop](https://github.com/CommandCodeAI/desktop) GitHub
releases (`CommandCode-<version>-amd64.deb`, verified against the release's
SHA-256 asset digest) into a FUSE 3-compatible uruntime image with an
extract-and-run fallback. The canonical end-user download page is
`https://commandcode.ai/download/linux` (currently a redirect to the GitHub
releases page, so it cannot serve as a version oracle); the pipeline reads
the GitHub releases API instead.

## What is app specific here

- **Version source** (`oracle.kind: github-release`, versioned-asset flavor):
  the newest non-draft, non-prerelease release whose tag starts with `v`
  and which carries `CommandCode-{version}-{arch}.deb` with a SHA-256
  digest. The tag and filename must agree, so an upstream layout change
  fails loudly. An `arm64` resolve scans every release for
  `CommandCode-<version>-arm64.deb`, which upstream never publishes, so it
  fails with an asset mismatch instead of packaging the wrong architecture.
- **Single-arch** (`architectures: ["amd64"]`): the only app in this tap
  without an arm64 Linux build. The cask carries one `sha256`, a hardcoded
  `x86_64` URL and `depends_on arch: :x86_64`; CI builds, publishes and
  checks only `amd64`.
- **Payload staging** (`payload.kind: deb-tree`): the `opt/Command Code`
  tree from the `.deb` is staged into `AppDir/bin`.
- **Updater neutralization**: `resources/app-update.yml` (owner
  `CommandCodeAI`, repo `gui`) is removed and its absence is *required* —
  a future upstream build that stops shipping it fails the build instead of
  silently keeping a live feed. `CC_DISABLE_AUTO_UPDATE=1` is written to the
  AppDir's `.env` to gate the app's own update checks (the main process
  disables its electron-updater controller when that variable is `1`).
  The residual scan looks for `CommandCodeAI/gui` (the updater feed repo,
  distinct from the `desktop`/`commandcode` repos named in the binary).
- **Sandboxing**: the repackaging never adds `--no-sandbox` (matching the
  other casks in this tap).

The cask version uses the upstream version (e.g. `0.1.29`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.1.29 ./build.sh
```
