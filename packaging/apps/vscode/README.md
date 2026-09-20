# vscode

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from Microsoft's signed APT repository, so the full verification chain
applies.

## App-specific

- **Pinned key** — `assets/microsoft-vscode-repository-key.gpg.base64` is
  Microsoft's release key (`BC528686B50D79E339D3721CEB3E94ADBE1229CF`). It is the
  `gpg --export` keyring, not the raw `microsoft.asc`, whose old-format packet
  modern `gpgv` rejects.
- **Version source** — `apt`: `InRelease` is verified with `gpgv` against the
  pinned key, `Packages` is checked against the signed index, and the newest
  `code` entry per architecture is selected by dpkg ordering. The `.deb` is then
  checked against the index SHA-256/size. The cask uses the upstream version
  (e.g. `1.133.0`), not the build-epoch suffix (`1.133.0-1786487972`), which
  differs per architecture.
- **Payload** — `deb-tree`: the `usr/share/code` tree is staged into `AppDir/bin`.

## Updater neutralization

The endpoint is compiled into `product.json`, the JS bundles and the `code-tunnel`
binary:

- `removeJsonKeys` deletes `updateUrl` and `checksums` from `product.json`; they
  must then be absent or the build fails.
- `patchEndpoint` rewrites `update.code.visualstudio.com` everywhere. Text files
  get the shorter, inert `update.invalid`; ELF files get the same byte length
  (`update.invalidupdate.invalid`), because shortening the string inside a binary
  shifts every later byte and corrupts it. Binary vs. text is decided by the ELF
  magic (`0x7f 0x45 0x4c 0x46`), not the old "contains NUL" heuristic that
  misclassified NUL-free binaries. The same-length rule is asserted at descriptor
  load and again before writing.
- `residualScan` (`severity: error`) fails the build if any copy remains, so an
  endpoint embedded elsewhere can never silently re-enable the updater.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.133.0 ./build.sh
```
