# opencode-desktop packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

The AppImage is built from the `.deb` published on the
[anomalyco/opencode](https://github.com/anomalyco/opencode) GitHub releases.

## What is app specific here

- **Version source** (`oracle.kind: github-release`): the newest non-draft,
  non-prerelease release carrying both `opencode-desktop-linux-<arch>.deb`
  assets with SHA-256 digests. The digest comes from the GitHub API and the
  payload is verified against it at download time.
- **Payload staging** (`payload.kind: deb-tree`): the whole `opt/OpenCode`
  payload is staged into `AppDir/bin`; the build asserts the `.deb`'s
  `Architecture` matches the requested one before staging.
- **Updater neutralization**: the embedded electron-updater feed
  (`resources/app-update.yml`) is removed when present — it is optional here
  because upstream does not always ship it — and any residual copy of the
  release-download URL anywhere in the AppDir fails the build. The AppDir's
  `.env` sets `OPENCODE_DISABLE_AUTOUPDATE=1` so the app's own update channel
  stays off; updates come via Homebrew only.

The cask version uses the upstream version (e.g. `1.18.25`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.18.25 ./build.sh
```
