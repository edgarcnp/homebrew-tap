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
3. `scripts/build-appimage.sh` — extracts the `.deb`, stages the whole
   `usr/share/code` payload into `AppDir/bin`, renders the desktop entry and
   icon, then runs `quick-sharun` (sharun-based, bundles libc + ld-linux so
   the AppImage has no host-libc dependency) and builds the AppImage with
   the uruntime `appimagetool` via the `APPIMAGETOOL` env var. The built-in
   updater is disabled because brew owns updates: `scripts/disable-updater.js`
   removes `updateUrl` from `product.json` and rewrites the hardcoded
   `update.code.visualstudio.com` endpoint in the compiled bundles (a
   same-length replacement for ELF files so they are not corrupted). See
   [Updater neutralization](#updater-neutralization).

## Updater neutralization

The updater endpoint is compiled into `product.json` (the `updateUrl` field)
and into the JS bundles and the `code-tunnel` ELF binary. To disable it:

- `product.json`: the `updateUrl` key is deleted outright.
- Text files (JS bundles): the endpoint string is replaced with the shorter,
  inert `update.invalid`.
- ELF binaries (e.g. `code-tunnel`): the replacement must be **the same byte
  length** (`update.invalidupdate.invalid`), or shortening the string shifts
  every byte after it and corrupts the file structure.

Binary vs. text is decided by the first four bytes of the file: the **ELF
magic number** `0x7f 0x45 0x4c 0x46` (ASCII `DEL` + `ELF`). Every ELF
executable/shared library on Linux starts with exactly those bytes; text
files never do. This replaced the older `buf.includes(0)` heuristic (any NUL
byte = binary), which would have misclassified a NUL-free binary as text and
corrupted it with the shorter replacement.

After patching, the build scans the whole AppDir for
`update.code.visualstudio.com` and fails if any copy remains — so an
endpoint embedded elsewhere (a helper `.so`, a second bundle) can never
silently re-enable the updater.

The cask version uses the upstream version (e.g. `1.133.0`), not the
`.deb` build epoch suffix (e.g. `1.133.0-1786487972`), which differs between
amd64 and arm64 for the same release.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.133.0 ./scripts/build-appimage.sh
```

Requires an Arch Linux system (or the `ghcr.io/pkgforge-dev/archlinux`
container), `node`, `gpgv`, `dpkg-deb`, `quick-sharun` in PATH and
`APPIMAGETOOL` pointing at the uruntime `appimagetool`. Output lands in
`<tap>/dist/`.
