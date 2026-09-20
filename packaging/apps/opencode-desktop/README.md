# opencode-desktop packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

The AppImage is built from the `.deb` served by OpenCode's v2 desktop update
API (`https://opencode.ai/update/api/latest/desktop/opencode`), which is the
version source and publishes the per-asset SHA-256 and size directly — the
payload is verified against the manifest digest at download time.

## What is app specific here

- **Version source** (`oracle.kind: update-manifest`): the pinned manifest
  endpoint returns `{version, metadata: {files: {name: {url, sha256, size}}}}`;
  the resolver picks the `opencode-desktop-linux-{arch}.deb` entry, requires the
  asset URL to sit on `opencode.ai` and to carry the exact version as a
  download-path segment, and verifies the downloaded payload against the
  manifest's digest. `--metadata-only` resolve (the detect job, both
  architectures) trusts the manifest digest and needs no download. Upstream
  versions are used verbatim (e.g. `2.0.8`).
- **Payload staging** (`payload.kind: deb-tree`): the whole `opt/OpenCode`
  payload is staged into `AppDir/bin`; the build asserts the `.deb`'s
  `Architecture` matches the requested one before staging.
- **Updater neutralization**: the embedded electron-updater feed
  (`resources/app-update.yml`) is removed — `required: true`, because v2
  always ships it — and a residual copy of the update-API endpoint anywhere in
  the AppDir is scanned at `severity: warning`: the endpoint is legitimately
  embedded inside `app.asar` (and the `opencode-cli` binary), which cannot be
  same-length patched, so a legitimate copy there must not fail the build. The
  AppDir's `.env` sets `OPENCODE_DISABLE_AUTOUPDATE=1` so the app's own update
  channel stays off; updates come via Homebrew only.

The cask version uses the upstream version (e.g. `2.0.8`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=2.0.8 ./build.sh
```