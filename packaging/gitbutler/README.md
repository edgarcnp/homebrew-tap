# gitbutler packaging

Build scripts for the `gitbutler` cask in this tap. The AppImage is built
from GitButler's Linux `.deb`, located through the
`app.gitbutler.com` download redirect. GitButler publishes no signed apt
repository and no release assets on GitHub, so there is no GPG verification
chain; the trust model is HTTPS + GitButler's CDN, with the `.deb` SHA-256
computed by the resolver and the webkit dependency debs verified against the
SHA-256 recorded in the apt index (index fetched by apt over HTTPS and
signature-verified against apt's own keyring). The cask's `sha256` starts as
zero placeholders and is filled by the publish pipeline on the first release
(`update-cask` hashes the released AppImages), so the final AppImage is
pinned at install.

The assumed upstream URL layout (validated by the resolver) is:

```
GET https://app.gitbutler.com/downloads/release/linux/<x86_64|aarch64>/deb   (302)
→ https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<x86_64|aarch64>/GitButler_<version>_<amd64|arm64>.deb
```

1. `scripts/resolve-gitbutler.js` — resolver: follows the redirect above to
   the latest release on `releases.gitbutler.com`, extracts the version and
   build suffix from the redirect URL (e.g. `0.22.0-3180`), downloads the
   `.deb` and hashes it. Version normalization is shared with the other
   resolvers (`../lib/upstream-linux-package.js`). In `--metadata-only` mode
   (used by the workflow's detect job) the URL and version are resolved
   without downloading the `.deb` payload.
2. `scripts/build-appimage.sh` — extracts the `.deb`, stages an AppDir (AppRun,
   desktop entry, icon, and both `gitbutler-tauri` + `gitbutler-git-askpass`
   side by side so the askpass lookup relative to the main binary works),
   bundles `libwebkit2gtk-4.1-0` + `libjavascriptcoregtk-4.1-0` and their full
   runtime dependency closure (via `scripts/fetch-webkit-deps.sh`) into the
   AppDir so the AppImage is self-contained and runs on hosts without webkit,
   and builds the AppImage with the FUSE3-native uruntime `appimagetool`
   (pkgforge fork; the `../scripts/appimagetool-uruntime.sh` shim keeps the
   upstream `appimagetool` invocation working). The dependency closure is
   resolved with `apt-cache` and downloaded with `apt-get`, so the build runs
   on an ubuntu-24.04 runner where apt is available natively. The temporary
   work dir is created with `mktemp -d` and removed on exit.
   `gitbutler-tauri` picks between the `but` CLI and the GUI from its argv[0]
   basename; the AppImage runtime rewrites argv[0] to the mounted AppRun path
   but keeps the original invocation in `ARGV0`, so the AppRun template
   re-execs the binary with `exec -a "${ARGV0:-$0}"` to preserve it.
3. `scripts/fetch-webkit-deps.sh` — reads the webkit root packages
   (`libwebkit2gtk-*`) from the `.deb`'s own `Depends` field (so a future
   webkit soname bump is handled automatically), computes the recursive
   `Depends` closure (`apt-cache depends --recurse`, excluding
   libc/libc-bin/locales and dev/dbg/doc packages and resolving virtual
   packages to their providers), `apt-get download`s the union into a deps dir,
   verifies every `.deb` against the SHA-256 from the apt index (missing or
   mismatched hashes fail the build), and prints the dir path for the build
   script to extract. apt's lists and archive cache are redirected into the
   work dir (`-o Dir::Etc::lists` / `Dir::Cache::archives`), so the host's apt
   state is never mutated. On non-Debian hosts, set `WEBKIT_DEPS_DIR_OVERRIDE`
   to a directory of pre-downloaded debs to skip apt.
4. `../lib/package-common.sh` — shared bash helpers sourced by the build script.

The cask version uses the upstream version (`0.22.0`), not the redirect's build
suffix (`0.22.0-3180`).

GitButler is a Tauri app that hard-links `libwebkit2gtk-4.1` and
`libjavascriptcoregtk-4.1`; those libraries and their entire dependency closure
are bundled into the AppImage (see step 2), so no webkit libraries are needed
on the host at runtime.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 ./scripts/build-appimage.sh
```

`PACKAGE_VERSION` is optional: when unset it is derived from the upstream
metadata the resolver writes; when set, the build fails if the resolved
upstream version differs (CI always sets it).

Requires `node`, `dpkg-deb`, the uruntime `appimagetool` (or `APPIMAGETOOL`),
and an apt-enabled host to fetch the webkit dependency debs. On non-Debian
hosts, download the debs once on ubuntu-24.04 and reuse them via
`WEBKIT_DEPS_DIR_OVERRIDE=/path/to/debs`.
Output lands in `<tap>/dist/`.