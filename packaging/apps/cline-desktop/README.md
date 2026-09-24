# cline-desktop

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[Cline for Desktop](https://cline.bot/) ships Linux builds for x64 only (`.deb`
and `.rpm`, no AppImage upstream), so this pipeline repackages the amd64 `.deb`
from the [cline/cline](https://github.com/cline/cline) releases.

## App-specific

- **Version source** — `github-release`, versioned-asset flavor: the newest
  release whose tag starts with `desktop-v` and carries
  `Cline_{version}_{arch}.deb` with a SHA-256 digest. That repository shares one
  release list with the CLI (`cli-v…`), the SDK (`sdk/…`) and the plain `v…`
  releases, so only the `desktop-v` prefix selects this line; a resolve for a
  tag without the matching asset fails instead of packaging something else.
- **Watch** — the same shared feed, but `versionPattern` anchors on the entry
  *title* `Desktop v…`: a CLI or SDK release can never satisfy it.
- **Single-arch** — `architectures: ["amd64"]`: upstream publishes no arm64
  `.deb`, so CI builds, publishes and checks amd64 only and the cask pins one
  `sha256` behind `depends_on arch: :x86_64`.
- **Payload** — `deb-files`: `usr/bin/cline-app` (the Tauri GUI) and
  `usr/bin/code-sidecar` (the backend it spawns) are staged into `AppDir/bin`.
  The GUI resolves the sidecar as a sibling of its own executable, so keeping
  both in `bin/` is what makes it start.
  The deb also ships two upstream extras that are deliberately not staged:
  `usr/lib/Cline/bin/remote-helpers/*` (the remote/SSH connection helpers, 50 MB
  — their feature is unavailable in the AppImage) and `usr/lib/Cline/icons/app`
  (the app-icon choices, which `main.rs` only resolves on macOS and Windows).
- **Icon** — the deb has no plain `256x256` directory; the 256×256 PNG lives in
  `usr/share/icons/hicolor/256x256@2/`, which the descriptor names as its source
  and the pipeline installs as a normal `256x256` hicolor icon.
- **Updater** — the tauri updater endpoint
  `https://github.com/cline/cline/releases/download/desktop-latest/latest.json`
  occurs exactly once in the `cline-app` ELF, so it is patched in place to the
  same-length `https://ab.invalid/…` (the `.invalid` TLD never resolves). The
  original endpoint is 75 bytes and the replacement must match that length or
  the ELF would shift, and the residual scan requires the original string to be
  gone, so an upstream change that moves the endpoint fails the build rather
  than shipping a live updater.
- **Runtime libraries** — `needsWebkit` pulls in the webkit2gtk 4.1/GTK closure
  the GUI links (`libwebkit2gtk-4.1.so.0`), while the tray indicator is only
  `dlopen`ed: `libayatana-appindicator` is installed into the build container
  and `libayatana-appindicator3.so.1` named as a quick-sharun deploy target so
  it is bundled.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.0.35 ./build.sh
```
