# vscode

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from Microsoft's `linux-x64` tarball, named by the stable update JSON and
verified against its published SHA-256.

## App-specific

- **Version source** — `json-asset`: the pinned
  `https://update.code.visualstudio.com/api/update/linux-x64/stable/latest`
  document carries `productVersion`, the asset `url` and `sha256hash`. Its
  version must equal the requested version; the download is restricted to the
  declared hosts, verified against the digest and measured. The `url` points at
  `vscode.download.prss.microsoft.com`, which is why both hosts are declared.
- **Payload** — `tarball-tree` with `target: "bin"`: the `VSCode-linux-x64`
  tree is staged into `AppDir/bin`, the same layout the old `.deb` produced.
  The icon is the tarball's 1024×1024 `resources/app/resources/linux/code.png`.
- **Debloated GTK pairing** — `gdk-pixbuf2-mini` is requested alongside
  `--add-common` on purpose. The debloated `glycin-mini` ships glycin-ng, which
  lacks the glycin 2.2 symbols (`gly_pixel_density_new`) that Arch's current
  `gdk-pixbuf2` calls; the debloated `gdk-pixbuf2-mini` is built without glycin
  and uses its built-in loaders, so the pair cannot drift apart when Arch bumps
  either side.

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

`PACKAGE_VERSION` is the requested version and is required; the build fails
if the resolved version differs (CI always sets it).

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.146.0 ./build.sh
```
