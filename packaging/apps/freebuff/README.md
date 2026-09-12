# freebuff-desktop packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

Upstream [Freebuff](https://freebuff.com/) (the community desktop app from
[CodebuffAI/codebuff-community](https://github.com/CodebuffAI/codebuff-community))
publishes Linux builds only as electron-builder AppImages on the classic
AppImageKit runtime, which `dlopen`s `libfuse.so.2` and therefore requires
FUSE 2. This pipeline repackages the upstream AppImage into a FUSE 3-compatible
uruntime image with an extract-and-run fallback.

## What is app specific here

- **Version source** (`oracle.kind: electron-feed`): the GitHub `/releases`
  listing is unusable because the repository interleaves `freebuff-desktop-v*`
  releases with unrelated releases that share one seeded `created_at`, so the
  list order is unstable. The app's own electron-updater feed is the version
  oracle instead:
  `GET https://freebuff.com/api/desktop/updates/<linux-x64|linux-arm64>/latest-linux[-arm64].yml`
  redirects to the exact `freebuff-desktop-v<version>` release asset on
  github.com. The redirected yml supplies the AppImage filename, SHA-512 and
  size; the GitHub release for that tag supplies the SHA-256 asset digest. All
  three must agree, and the payload is verified against both hashes at
  download time.
- **Payload staging** (`payload.kind: appimage-tree`): the upstream image is
  unpacked with `--appimage-extract` (no FUSE needed). The scoped
  `@codebufffreebuff-desktop` executable is renamed to `freebuff-desktop`,
  upstream's AppDir furniture (AppRun, desktop entry, icons) is excluded, and
  the vendored `usr/` (icons plus Electron's `dlopen`ed fallback libraries such
  as `libappindicator`) is moved to the AppDir root where the AppImage spec
  places it.
- **Updater neutralization**: `resources/app-update.yml` is removed and its
  absence is *required* (`removeFeed.required: true`) — a future upstream build
  that stops shipping it fails the build instead of silently keeping a live
  feed. `FREEBUFF_DISABLE_UPDATE_CHECK=1` is written to the AppDir's `.env` to
  gate the app's own update checks.
- **Sandboxing**: upstream's desktop entry launches with `--no-sandbox`; this
  repackaging does not. The app's own `electron/linux-launch.cjs` preflight
  re-execs with `--no-sandbox` only when the kernel blocks unprivileged user
  namespaces, so the Chromium sandbox is used where it is available (matching
  the other casks in this tap).

The cask version uses the upstream version (e.g. `0.0.109`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.0.109 ./build.sh
```
