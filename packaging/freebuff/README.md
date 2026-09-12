# freebuff-desktop packaging

Build scripts for the `freebuff-desktop` cask in this tap. Upstream
[Freebuff](https://freebuff.com/) (the community desktop app from
[CodebuffAI/codebuff-community](https://github.com/CodebuffAI/codebuff-community))
publishes Linux builds only as electron-builder AppImages built with the
classic AppImageKit runtime, which `dlopen`s `libfuse.so.2` and therefore
requires FUSE 2. This pipeline repackages the upstream AppImage into a
FUSE 3-compatible uruntime image with an extract-and-run fallback.

1. `scripts/resolve-freebuff.js` — version discovery cannot use the GitHub
   `/releases` listing: the repo interleaves `freebuff-desktop-v*` releases
   with unrelated releases that share one seeded `created_at`, so the list
   order is unstable. Instead the app's own electron-updater feed is the
   version source:
   `GET https://freebuff.com/api/desktop/updates/<linux-x64|linux-arm64>/latest-linux[-arm64].yml`
   302-redirects to the exact `freebuff-desktop-v<version>` release asset
   on github.com; the redirected yml supplies the AppImage filename,
   SHA-512 and size, and `GET /releases/tags/freebuff-desktop-v<version>`
   supplies the SHA-256 asset digest. All three sources must agree and the
   payload is verified against both hashes at download time
   (`--metadata-only` skips the download).
2. `scripts/build-appimage.sh` — invokes the resolver, unpacks the
   downloaded upstream image with `--appimage-extract` (no FUSE needed),
   stages the Electron payload into `AppDir/bin` with the scoped
   `@codebufffreebuff-desktop` executable renamed to `freebuff-desktop`,
   moves the vendored `usr/` (icons and Electron's dlopen'd fallback
   libraries such as `libappindicator`) to the AppDir root, removes the
   embedded electron-updater feed (`resources/app-update.yml`) so the app
   never self-updates from upstream (updates come via Homebrew only; the
   app never calls `setFeedURL`, so the feed is dead without that file),
   renders the desktop entry and icon, then runs `quick-sharun`
   (sharun-based, bundles libc + ld-linux so the AppImage has no
   host-libc dependency) and builds the AppImage with the uruntime
   `appimagetool` via the `APPIMAGETOOL` env var. The
   `FREEBUFF_DISABLE_UPDATE_CHECK=1` env var is also written to the
   AppDir's `.env` to gate the app's own update checks. Upstream's desktop
   entry launches with `--no-sandbox`; this repackaging does not — the
   app's own `electron/linux-launch.cjs` preflight re-execs with
   `--no-sandbox` only when the kernel blocks unprivileged user
   namespaces, and the Chromium sandbox uses userns where available
   (matching the other casks in this tap).
3. `../lib/package-common.sh` — shared bash helpers sourced by the build
   script.

The cask version uses the upstream version (e.g. `0.0.109`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.0.109 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires an Arch Linux system (or the `ghcr.io/pkgforge-dev/archlinux`
container), `node`, `quick-sharun` in PATH and `APPIMAGETOOL` pointing at
the uruntime `appimagetool`. Output lands in `<tap>/dist/`.
