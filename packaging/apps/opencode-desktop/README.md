# opencode-desktop

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from the `.deb` served by OpenCode's v2 desktop update API
(`https://opencode.ai/update/api/latest/desktop/opencode`), which publishes the
version and each asset's SHA-256 and size.

## App-specific

- **Version source** — `update-manifest`: the pinned manifest returns
  `{version, metadata: {files: {name: {url, sha256, size}}}}`. The resolver picks
  the `opencode-desktop-linux-{arch}.deb` entry, requires the URL to sit on
  `opencode.ai` and to carry the exact version as a download-path segment, and
  verifies the download against the manifest digest. `--metadata-only` resolve
  needs no download.
- **Payload** — `deb-tree`: the whole `opt/OpenCode` tree is staged into
  `AppDir/bin`; the build asserts the `.deb` `Architecture` matches the request.
- **Updater** — `resources/app-update.yml` is removed (`required: true`, since
  v2 always ships it). The residual scan runs at `severity: warning`: the
  endpoint is legitimately embedded in `app.asar` and the `opencode-cli` binary,
  which cannot be same-length patched. The AppDir `.env` sets
  `OPENCODE_DISABLE_AUTOUPDATE=1`; updates come via Homebrew only.
- **Host helper** — `bin/resources/opencode-cli` is declared in `hostHelpers`:
  the desktop app copies it to `~/.config/ai.opencode.desktop/cli/<version>/`
  and spawns it there, outside the mount, where a sharun wrapper dies with
  `Interpreter not found!`. The pipeline ships the pristine upstream binary
  (host `ld-linux`, host libc — exactly what the upstream `.deb` runs on) and
  drops quick-sharun's auto-created `bin/opencode-cli` wrapper plus its
  `shared/bin` duplicate.

Upstream versions are used verbatim (e.g. `2.0.8`).

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=2.0.8 ./build.sh
```
