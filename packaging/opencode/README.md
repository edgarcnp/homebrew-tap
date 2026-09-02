# opencode-desktop packaging

Build scripts for the `opencode-desktop` cask in this tap. The AppImage is
built from the `.deb` published on the
[anomalyco/opencode](https://github.com/anomalyco/opencode) GitHub releases
and verified against the release's SHA-256 asset digests.

1. `../lib/upstream-github-release.js` — shared resolver: lists the latest
   non-draft, non-prerelease release carrying both
   `opencode-desktop-linux-<arch>.deb` assets with SHA-256 digests, then
   downloads and verifies the `.deb` for the requested architecture.
2. `scripts/build-appimage.sh` — extracts the `.deb`, stages the whole
   `opt/OpenCode` payload into `AppDir/bin`, removes the embedded
   electron-updater feed (`resources/app-update.yml`) so the app never
   self-updates from upstream (updates come via Homebrew only), renders the
   desktop entry and icon, then runs `quick-sharun` (sharun-based, bundles
   libc + ld-linux so the AppImage has no host-libc dependency) and builds
   the AppImage with the uruntime `appimagetool` via the `APPIMAGETOOL`
   env var. The `OPENCODE_DISABLE_AUTOUPDATE=1` env var is also written to
   the AppDir's `.env` so the app's own update channel stays off.
3. `../lib/package-common.sh` — shared bash helpers sourced by the build script.

The cask version uses the upstream version (e.g. `1.18.25`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.18.25 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires an Arch Linux system (or the `ghcr.io/pkgforge-dev/archlinux`
container), `node`, `dpkg-deb`, `quick-sharun` in PATH and `APPIMAGETOOL`
pointing at the uruntime `appimagetool`. Output lands in `<tap>/dist/`.
