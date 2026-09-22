# wfhelper

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[WFHelper](https://github.com/WFHelper/WFHelper) is an Electron app (the
Warframe companion) that ships Linux builds for x64 only as an upstream
`.AppImage`, which this pipeline unpacks and repacks (no FUSE needed for the
extract step).

## App-specific

- **Version source** — `github-release`, versioned-asset flavor for an
  `.AppImage`: the newest release whose tag starts with `v` and carries
  `WFHelper-{version}.AppImage` with a SHA-256 digest. The release's
  electron-builder `latest-linux.yml` is cross-checked (SHA-512 and size
  against the API asset) before downloading, mirroring the `electron-feed`
  oracle minus its feed-redirect step. An arm64 resolve finds no yml and fails
  rather than packaging the wrong architecture.
- **Watch** — the normal atom block over `WFHelper/WFHelper` releases; the
  entry titles are `v2.1.0`-style tags.
- **Single-arch** — `architectures: ["amd64"]`: the only linux target upstream
  ships. The cask pins one `sha256` and `depends_on arch: :x86_64`; CI builds,
  publishes and checks amd64 only.
- **Payload** — `appimage-tree`: the upstream squashfs tree is staged entry by
  entry into `AppDir/bin`, dropping the AppDir furniture this pipeline replaces
  (`AppRun`, the upstream desktop entry, the root icon symlink) and the
  vendored `usr/` tree (six stale `.so`s plus icons — quick-sharun deploys
  fresh libraries from the build container, and the icon is installed from the
  payload by the icon stage). No rename: the upstream binary is already named
  `wfhelper`.
- **Updater** — `resources/app-update.yml` is removed and its absence is
  required, so a future upstream build that drops it fails the build instead of
  silently keeping a live feed. `WF_DISABLE_AUTO_UPDATE=1` is written to the
  AppDir `.env` (the app's own `shouldEnableAutoUpdater` returns false for it).
  The residual scan for `WFHelper/WFHelper` runs at `severity: warning`: four
  copies legitimately remain in `app.asar` as inert package metadata (repo,
  `.git`, issues and readme URLs), mirroring the opencode asar-embedded
  endpoint.
- **Runtime helper downloads** — at runtime the app fetches its
  `warframe-api-helper` companion from GitHub releases (setup flow) and reads
  game data; that is core functionality, not self-update, and is left alone.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=2.1.0 ./build.sh
```
