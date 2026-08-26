# gitbutler packaging

Build scripts for the `gitbutler` cask in this tap. The AppImage is built
from GitButler's Linux `.deb`, located through the
`app.gitbutler.com` download redirect. GitButler publishes no signed apt
repository and no release assets on GitHub, so there is no GPG verification
chain; the trust model is HTTPS + GitButler's CDN, with the `.deb` SHA-256
computed by the resolver. The cask's `sha256` starts as zero placeholders and
is filled by the publish pipeline on the first release (`update-cask` hashes
the released AppImages), so the final AppImage is pinned at install.

The assumed upstream URL layout (validated by the resolver) is:

```
GET https://app.gitbutler.com/downloads/release/linux/<x86_64|aarch64>/deb   (302)
-> https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<x86_64|aarch64>/GitButler_<version>_<amd64|arm64>.deb
```

1. `scripts/resolve-gitbutler.js` — resolver: follows the redirect above to
   the latest release on `releases.gitbutler.com`, extracts the version and
   build suffix from the redirect URL (e.g. `0.22.1-3215`), downloads the
   `.deb` and hashes it. Version normalization is shared with the other
   resolvers (`../lib/upstream-linux-package.js`). In `--metadata-only` mode
   (used by the workflow's detect job) the payload is downloaded to compute
   the SHA-256 — the CDN publishes no checksums — but discarded instead of
   written to disk.

2. `scripts/build-appimage.sh` — extracts the `.deb`, stages an AppDir
   (desktop entry, icon, and both `gitbutler-tauri` + `gitbutler-git-askpass`
   side by side so the askpass lookup relative to the main binary works),
   runs `linuxdeploy` to bundle the shared library closure (including
   `libwebkit2gtk-4.1` and `libjavascriptcoregtk-4.1`), then binary-patches
   the hardcoded webkit helper-process paths in the .so to relative paths
   (the `././` prefix trick) and bundles the helper processes, GLib schemas,
   GIO modules, and GDK pixbuf loaders into the AppDir so the AppImage is
   self-contained and runs on hosts without webkit. The AppImage is built
   with the FUSE3-native uruntime `appimagetool` (pkgforge fork). The
   temporary work dir is created with `mktemp -d` and removed on exit.
   `gitbutler-tauri` picks between the `but` CLI and the GUI from its argv[0]
   basename; the AppImage runtime rewrites argv[0] to the mounted AppRun path
   but keeps the original invocation in `ARGV0`, so the AppRun template
   re-execs the binary with `exec -a "${ARGV0:-$0}"` to preserve it.

3. `../lib/package-common.sh` — shared bash helpers sourced by the build script.

The cask version uses the upstream `version` string (e.g. `0.22.1`), not the
redirect's build suffix (`0.22.1-3215`).

GitButler is a Tauri app that hard-links `libwebkit2gtk-4.1` and
`libjavascriptcoregtk-4.1`; those libraries and their entire dependency
closure are bundled into the AppImage (see step 2), so no webkit libraries
are needed on the host at runtime.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires `node`, `dpkg-deb`, `linuxdeploy`, the uruntime `appimagetool`
(or `APPIMAGETOOL`/`LINUXDEPLOY`), and the build dependencies
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libgdk-pixbuf2.0-bin`,
`glib-networking`). On Fedora, install the equivalents via `dnf`.
Output lands in `<tap>/dist/`.