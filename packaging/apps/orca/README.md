# orca

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from the `.deb` in Stably's GitHub release, staged as the Electron tree
`opt/Orca`. The GUI executable is `orca-ide`; that is also the command the cask
exposes, so it does not shadow the `orca` CLI launcher the app registers under
`~/.local/bin`.

## App-specific

- **Version source** — `github-release`: the release whose tag normalizes to the
  requested version, asset `orca-ide_{version}_{arch}.deb`, with the SHA-256 and
  size GitHub publishes for that asset. Tag prefix is `v`; the tap's own release
  tag is `orca-v<version>`.
- **Version watch** — the API reads the `tags.atom` feed, not the releases API,
  so a tag is seen before its release exists. Until Stably attaches the
  `orca-ide_{version}_{arch}.deb`, resolve answers not-ready and the dispatch is
  skipped.
- **Payload** — `deb-tree`: the whole `opt/Orca` tree is staged into `AppDir/bin`
  (the Electron main binary, `resources/`, locales and the node modules). The
  build asserts the `.deb` `Architecture` matches the request.
- **AppDir links** — `resources -> bin/resources` and `orca-ide -> bin/orca-ide`.
  The app extracts its own AppImage to a stable cache and looks for
  `resources/bin/<launcher>` at the extraction root, the layout upstream's
  AppImage ships. The launcher then resolves its own parent directories from
  that path and needs the Electron binary beside `resources` at the extraction
  root, so the second link points at the staged wrapper. Without them the CLI
  registration and serve daemons cannot find or start the extracted payload.
- **Updater** — `resources/app-update.yml` is removed (`required: true`). Orca
  also pins `setFeedURL` to its GitHub release feed itself, so the repo literal
  `stablyai/orca` is patched to `invalid-org/x` in `resources/app.asar` and in
  the updater's `release-channel.js`. The replacement is the same length, which
  keeps the asar offset table intact; every `stablyai/orca*` channel repo and
  release URL becomes unreachable. The residual scan fails on the release feed
  URLs if any survive. Updates come via Homebrew only.
- **Host helper** — `bin/resources/bin/orca-wayland-clipboard` is declared in
  `hostHelpers`: when running as an AppImage the app copies it into its user-data
  directory and executes it there, outside the mount, where a sharun wrapper
  dies with `Interpreter not found!`. The pipeline ships the pristine upstream
  binary (host `ld-linux`, host libc — the small helper links only libc/libdl).
- **CLI** — the app registers `~/.local/bin/orca` as a stable launcher into its
  extracted AppImage copy, and the cask's `orca-ide` binary stays the GUI entry
  point, so the two commands do not shadow each other.
- **Smoke gate** — Orca's parcel watcher leaves a defunct `sh` child for the
  whole session (an upstream process leak; the GUI and CLI both run). The
  descriptor's `smoke.ignoreDefunct: ["sh"]` skips that known leak in the
  smoke gate; loader errors and every other defunct child still fail the build.

Upstream versions are used verbatim.

## Local run

`PACKAGE_VERSION` is the requested version and is required; the build fails
if the resolved version differs (CI always sets it).

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.4.269 ./build.sh
```
