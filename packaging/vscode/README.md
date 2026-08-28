# vscode packaging

Build scripts for the `vscode` cask in this tap. The AppImage is
built from Microsoft's signed APT repository rather than the unsigned tar.gz
on code.visualstudio.com, so the full verification chain applies:

1. `assets/microsoft-vscode-repository-key.gpg.base64` — pinned Microsoft
   release key, fingerprint `BC528686B50D79E339D3721CEB3E94ADBE1229CF`.
   The base64 is the `gpg --export` keyring, not the raw `microsoft.asc`:
   the raw file contains an old-format packet that modern `gpgv` rejects.
2. `../lib/upstream-linux-package.js` — shared resolver: downloads
   `InRelease`, verifies it with `gpgv` against the pinned key, downloads
   `Packages` (checked against the SHA-256 from the signed `InRelease`),
   picks the newest `code` entry per architecture, and finally downloads
   the `.deb` and checks its SHA-256/size from the verified index.
3. `scripts/build-appimage.sh` — extracts the `.deb`, stages an AppDir
   (AppRun, desktop entry, icon) and builds the AppImage with the FUSE3-native
   uruntime `appimagetool` (pkgforge fork; the `../scripts/appimagetool-uruntime.sh`
   shim keeps the upstream `appimagetool` invocation working). The built-in
   updater is disabled because brew owns updates: `updateUrl` is removed from
   `product.json`, and the whole AppDir is scanned for residual references to
   `update.code.visualstudio.com` (`verify_updater_neutralized`) so a second
   copy can never silently re-enable it.

The cask version uses the upstream version (e.g. `1.133.0`), not the
`.deb` build epoch suffix (e.g. `1.133.0-1786487972`), which differs between
amd64 and arm64 for the same release.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.133.0 ./scripts/build-appimage.sh
```

Requires `node`, `gpgv`, `dpkg-deb` and the uruntime `appimagetool` (or `APPIMAGETOOL`).
Output lands in `<tap>/dist/`.
