# pi-desktop

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[PI-Desktop](https://github.com/vastsa/PI-Desktop) is an Electron desktop
workspace for AI agents (Rust host core, plugin system) that publishes Linux
`.deb`, `.AppImage` and `.rpm` artifacts; this tap repacks the x64 `.deb`.

## App-specific

- **Version source** — `github-release`, versioned-asset flavor: the newest
  published (non-draft, non-prerelease) release whose tag starts with `v` and
  carries `pi-desktop_{version}_{arch}.deb` with a SHA-256 digest.
- **Watch** — the GitHub releases list, stable-only
  (`^v\d+\.\d+\.\d+$`). Upstream currently ships frequent `-beta.N`
  prereleases; the advisory skips prereleases, so the watch must not
  advertise them — a feed version newer than the stable the advisory can
  resolve would gate every dispatched build as a `not-ready` skip.
- **Payload** — `deb-tree`: the whole `opt/PI-Desktop` tree is staged into
  `AppDir/bin`; the build asserts the `.deb` `Architecture` matches the
  request.
- **Updater** — `resources/app-update.yml` (electron-updater, GitHub
  provider) is removed and its absence is required, so a future upstream
  build that drops it fails the build instead of silently keeping a live
  feed. The residual scan for `vastsa/PI-Desktop` runs at
  `severity: warning`: the repository URL legitimately remains in `app.asar`
  as the manual "open releases" link, the bug-report target and package
  metadata, with no feed left to act on. The app has no update-disable
  environment variable, so feed removal is the whole neutralization.
- **Local data** — stock Electron paths under the packaged product name:
  userData (Chromium profile, single-instance lock) in `~/.config/PI-Desktop`,
  host-core database and logs in `~/.pi-desktop`. The cask's zap removes both.
- **amd64 only** — upstream also ships arm64 artifacts; like every cask in
  this tap, only the x86_64 build is packaged.

Upstream versions are used verbatim.

## Local run

`PACKAGE_VERSION` is optional; set, it must match the resolved version
(CI always sets it).

```sh
TARGET_ARCH=amd64 ./build.sh
```
