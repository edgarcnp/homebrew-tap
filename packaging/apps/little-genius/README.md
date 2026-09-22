# little-genius

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[Little Genius](https://lg.avakot.org) is a Tauri app (the Soulframe companion)
that ships Linux builds for x64 only as an amd64 `.deb`. There is no atom feed
and no GitHub releases page — the version oracle and the release-watch feed are
the same pinned JSON manifest (`https://api.avakot.org/lg/manifest.json`).

## App-specific

- **Version source** — `avakot`, the provider-specific manifest oracle in
  `oracles/custom/`: the top-level `version` plus
  `artifacts.linux_x86_64_deb = {version, url, sha256}`. The `.deb` URL is
  static (no version segment) and no size is published, so the version binding
  is the per-entry `version` field (it must equal the top-level version) and
  the size is measured from the verified download — including in
  `--metadata-only` mode, mirroring the `cdn-redirect` oracle.
- **Watch** — `format: "json"` with `versionField: "version"`: the watcher reads
  the same manifest and treats the top-level version as a single-entry feed.
  Requires the API's JSON-feed support (the watcher was atom-only).
- **Single-arch** — `architectures: ["amd64"]`: the only linux target upstream
  ships. The cask pins one `sha256` and `depends_on arch: :x86_64`; CI builds,
  publishes and checks amd64 only.
- **Payload** — `deb-files`: `usr/bin/little-genius` and
  `usr/bin/lg-linux-compat` are staged side by side into `AppDir/bin`, which is
  also where the app looks for its helper ("not found next to the app" is its
  own fallback path). Both binaries are cask `binaryTargets`.
- **webkit2gtk** — `needsWebkit: true`: the main binary links
  `libwebkit2gtk-4.1` and GTK 3, so the build installs the webkit2gtk/GTK
  closure (plus X11 libs) and debloats with `webkit2gtk-4.1-mini`, following
  the gitbutler flow.
- **Updater** — the manifest endpoint embedded once in the `little-genius` ELF
  is rewritten to a never-resolving host with a same-length patch
  (`https://update.invalid/lg/manifest.json` is byte-identical in length to the
  original). The residual scan for the endpoint runs at `severity: error`:
  there is exactly one copy and nothing legitimately keeps it.
- **Memory scanning caveat** — the `.deb` postinst grants `cap_sys_ptrace` to
  the installed binary so it can read the game's process memory. An AppImage
  cannot carry file capabilities, so that step is skipped here; the app detects
  the missing capability at runtime and falls back to its authorization-prompt
  path instead of failing.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.6.7 ./build.sh
```
