# vscode packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

The AppImage is built from Microsoft's signed APT repository rather than the
unsigned tar.gz on code.visualstudio.com, so the full verification chain
applies.

## What is app specific here

- **Pinned key**: `assets/microsoft-vscode-repository-key.gpg.base64` is the
  Microsoft release key, fingerprint
  `BC528686B50D79E339D3721CEB3E94ADBE1229CF`. The base64 is the `gpg --export`
  keyring, not the raw `microsoft.asc`: the raw file contains an old-format
  packet that modern `gpgv` rejects.
- **Version source** (`oracle.kind: apt`): `InRelease` is verified with `gpgv`
  against the pinned key, `Packages` is checked against the SHA-256 from that
  signed index, and the newest `code` entry per architecture is selected using
  dpkg's version ordering. The `.deb` is then checked against the SHA-256/size
  from the verified index. The cask version uses the upstream version (e.g.
  `1.133.0`), not the `.deb` build-epoch suffix (e.g. `1.133.0-1786487972`),
  which differs between amd64 and arm64 for the same release.
- **Payload staging** (`payload.kind: deb-tree`): the whole `usr/share/code`
  payload is staged into `AppDir/bin`.

## Updater neutralization

The updater endpoint is compiled into `product.json` (the `updateUrl` field)
and into the JS bundles and the `code-tunnel` ELF binary. The descriptor's
`updater` section declares exactly what happens:

- `removeJsonKeys` deletes `updateUrl` and `checksums` from
  `resources/app/product.json`; the values must then be absent or the build
  fails.
- `patchEndpoint` rewrites the hardcoded `update.code.visualstudio.com`
  everywhere in the AppDir. Text files get the shorter, inert
  `update.invalid`; ELF files get the same byte length
  (`update.invalidupdate.invalid`), because shortening the string inside a
  binary shifts every byte after it and corrupts the file. Binary vs. text is
  decided by the first four bytes — the **ELF magic number**
  `0x7f 0x45 0x4c 0x46` (ASCII `DEL` + `ELF`) — rather than the older "any NUL
  byte means binary" heuristic, which misclassified NUL-free binaries as text
  and corrupted them with the short replacement. The same-length rule is
  asserted twice: when the descriptor is loaded and again before the patch is
  written.
- `residualScan` (severity `error`) then scans the whole AppDir for
  `update.code.visualstudio.com` and fails the build if any copy remains — so
  an endpoint embedded elsewhere (a helper `.so`, a second bundle) can never
  silently re-enable the updater.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.133.0 ./build.sh
```
