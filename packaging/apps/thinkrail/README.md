# thinkrail

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from JetBrains' `stable-linux-x64` Electrobun bundle, the release's own
tag, and verified against the SHA-256 in its `SHA256SUMS` asset.

## App-specific

- **Version source** — `github-release` on `JetBrains/thinkrail`. Releases are
  cut on two channels: a stable tag (`v0.4.0`) and a daily prerelease
  (`v0.5.0-nightly.11`, published as `Nightly 0.5.0-nightly.11`). The watch
  pattern matches the plain three-part tag, so the tap only ever dispatches
  stable builds; the cask's livecheck carries the same anchored pattern.
- **Payload** — `tarball-tree` on `stable-linux-{appimage_arch}-ThinkRail-{version}.tar.zst`:
  the electrobun bundle, zstd-compressed. Upstream's
  `thinkrail-desktop-linux-x64.tar.gz` is *not* the payload: it holds a 63 MB
  `installer` that extracts the app to `~/.local/share/`, which is nothing this
  pipeline can stage. The bundle keeps its own layout at the AppDir root
  (`bin/` beside `Resources/`), which is what its launcher resolves, and the
  bundle's own `ThinkRail.desktop` is excluded because the pipeline renders the
  entry it installs.
- **Launcher** — `Exec=launcher` is upstream's own command, and it has to stay
  that name: quick-sharun reads `MAIN_BIN` from the top-level desktop entry and
  requires a matching `AppDir/bin/` file. The cask exposes the AppImage itself
  as `thinkrail` and writes its own entry with that `Exec=`.
- **Layout links** — the bundle is an Electrobun app, so its native pieces are
  found relative to the *running executable*: the launcher wants
  `../Resources/` beside `bin/`, and the bun process it spawns sees itself at
  `shared/bin/bun` after quick-sharun wraps it. Its `Resources/` and its three
  private libraries (`libElectrobunCore.so`, `libNativeWrapper.so`,
  `libasar.so`) are therefore linked into `shared/bin`, or the app dies with
  `Failed to open library .../shared/bin/libElectrobunCore.so`. A release that
  adds another private `.so` fails the smoke gate until it is listed here.
- **dlopen'd desktop stack** — nothing here links GTK or WebKit: `libNativeWrapper.so`
  carries them as `NEEDED`, so the closure scan finds them once `buildPackages`
  installs `webkit2gtk-4.1`, `gtk3`, `libayatana-appindicator` and `librsvg`.
  `webkit2gtk-4.1-mini` and `gdk-pixbuf2-mini` follow the pairing the other
  GTK-bundling apps use.

## Updater neutralization

The updater reads one URL out of `Resources/version.json`:

```json
"baseUrl": "https://github.com/JetBrains/thinkrail/releases/download/desktop-updates"
```

and fetches `${baseUrl}/${channel}-${platform}-${arch}-update.json` from it. The
descriptor patches that string in place (and the residual scan fails the build
if it survives), so Settings → Updates reports no update instead of installing
an unattended copy outside the AppImage. Both replacement fields carry the same
URL because the only target is a text file, and the length equality the pipeline
requires of a binary replacement then holds trivially. The bundle's `bspatch`,
`zig-zstd` and `Resources/uninstall` ride along unused.

## Runtime state

Measured from a run with a scratch `HOME`: app state in `~/.thinkrail` (projects,
chats, logs, fonts, themes, locales), Electrobun's webview state in
`~/.local/share/ai.thinkrail.app` and its cache in `~/.cache/ai.thinkrail.app`.
It also writes the bundled pi agent's config into `~/.pi/agent`, which the cask's
zap stanza deliberately leaves alone: that directory belongs to a pi the user
may have installed separately.
