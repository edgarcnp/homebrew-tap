# gitbutler packaging

Build scripts for the `gitbutler` cask in this tap. The AppImage is built
from GitButler's Linux `.deb`, located through the `app.gitbutler.com`
download redirect. GitButler publishes no signed apt repository and no
release assets on GitHub, so there is no GPG verification chain: the trust
model is HTTPS + GitButler's CDN, with the `.deb` SHA-256 computed by the
resolver. The cask's `sha256` starts as zero placeholders and is filled by
the publish pipeline on the first release, so the final AppImage is pinned
at install.

1. `scripts/resolve-gitbutler.js` — resolver: follows the CDN redirect to
   the latest release, downloads the `.deb` and hashes it. Version
   normalization is shared with the other resolvers
   (`../lib/upstream-linux-package.js`). In `--metadata-only` mode (used by
   the workflow's detect job) the payload is downloaded to compute the
   SHA-256 but discarded instead of written to disk.
2. `scripts/build-appimage.sh` — extracts the `.deb`, stages an AppDir
   (desktop entry, icon, `gitbutler-tauri` + `gitbutler-git-askpass`),
   runs `linuxdeploy` to bundle the shared library closure, then
   binary-patches the hardcoded webkit helper-process paths in the .so to
   relative paths (the `././` prefix trick) and bundles the helper
   processes, GLib schemas, GIO modules, and GDK pixbuf loaders so the
   AppImage runs on hosts without webkit. AppRun preserves argv[0] with
   `exec -a "${ARGV0:-$0}"` so `gitbutler-tauri` can still pick between
   the `but` CLI and the GUI by name, and seeds
   `~/.config/gitbutler/settings.json` with
   `ui.checkForUpdatesIntervalInSeconds: 0` to disable the in-app
   auto-update checker (mirroring the `disable-auto-updates` Cargo
   feature the GitButler flatpak ships with).
3. `../lib/package-common.sh` — shared bash helpers sourced by the build script.

The cask version uses the upstream `version` string (e.g. `0.22.1`), not
the redirect's build suffix (e.g. `0.22.1-3215`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires `node`, `dpkg-deb`, `linuxdeploy`, the uruntime `appimagetool`
(or `APPIMAGETOOL`/`LINUXDEPLOY`), and the webkit/GTK build dependencies
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libgdk-pixbuf2.0-bin`,
`glib-networking`). Output lands in `<tap>/dist/`.
