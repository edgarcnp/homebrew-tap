# gitbutler packaging

Build scripts for the `gitbutler` cask in this tap. The AppImage is built
from GitButler's Linux `.deb`, located through the `app.gitbutler.com`
download redirect. GitButler publishes no signed apt repository and no
release assets on GitHub, so there is no GPG verification chain: the trust
model is HTTPS + GitButler's CDN, with the `.deb` SHA-256 computed by the
resolver and trusted on first sight (the CDN publishes no checksums). The
cask's `sha256` starts as zero placeholders and is filled by the publish
pipeline on the first release, so the final AppImage is pinned at install.

1. `scripts/resolve-gitbutler.js` — resolver: follows the CDN redirect to
   the latest release, downloads the `.deb` and hashes it. Version
   normalization is shared with the other resolvers
   (`../lib/upstream-linux-package.js`). In `--metadata-only` mode (used by
   the workflow's detect job) the payload is downloaded to compute the
   SHA-256 but discarded instead of written to disk.
2. `scripts/build-appimage.sh` — extracts the `.deb`, stages
   `gitbutler-tauri` (main GUI binary) + `gitbutler-git-askpass` + the `but`
   CLI symlink into `AppDir/bin`, then runs `quick-sharun` (sharun-based:
   bundles libc, ld-linux and the whole runtime closure so the AppImage has
   no host-libc dependency — the webkit2gtk/GTK libs are bundled from the
   Arch build container). The updater endpoint in the binary is rewritten to
   a never-resolving host (`x.invalid.invalid`, same-length patch) so the
   Tauri built-in updater can never find or install an update, and a custom
   `.hook` (sourced by the generated AppRun at runtime) seeds
   `~/.config/gitbutler/settings.json` with
   `ui.checkForUpdatesIntervalInSeconds: 0` to disable the in-app
   auto-update checker (mirroring the `disable-auto-updates` Cargo feature
   the GitButler flatpak ships with).
3. `../lib/package-common.sh` — shared bash helpers sourced by the build script.

The cask version uses the upstream `version` string (e.g. `0.22.3`), not
the redirect's build suffix (e.g. `0.22.3-3215`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires an Arch Linux system (or the `ghcr.io/pkgforge-dev/archlinux`
container), `node`, `dpkg-deb`, `quick-sharun` in PATH and `APPIMAGETOOL`
pointing at the uruntime `appimagetool`. Output lands in `<tap>/dist/`.
