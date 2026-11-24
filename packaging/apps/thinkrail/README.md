# thinkrail

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from JetBrains' `stable-linux-x64` Electrobun bundle, the release's own
tag, and verified against the SHA-256 in its `SHA256SUMS` asset.

## App-specific

- **Version source** — `format: "json"` against GitHub's
  `api.github.com/repos/JetBrains/thinkrail/releases/latest`, whose `tag_name`
  is the stable release (`v0.4.0` today). GitHub filters drafts and
  prereleases out of `latest` server-side, which is the same answer upstream's
  own installer uses for its stable channel. It stays a `json` read of
  `tag_name` rather than a `"github-release"` watch because the tag is the
  release's identifier: a `"github-release"` watch judges the release *name*
  first and falls back to the tag only when the name is empty, so it would tie
  this app's version to how upstream happens to title a stable release. The
  pattern keeps the `v` and rejects anything with a suffix, so a nightly can
  never be dispatched even if one were ever marked stable. The cask's livecheck
  reads the tap's own tags, so it is unaffected.
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
- **White window on an NVIDIA render node** — WebKit's DMABUF renderer
  allocates its compositor buffers through GBM on a render node it picks at
  runtime. Where that node belongs to the NVIDIA proprietary driver
  (`DRIVER=nvidia` in `/sys/class/drm/renderD128/device/uevent`), every
  allocation fails with `Failed to create GBM buffer ...: Invalid argument`
  and nothing is painted: the window stays white while the app runs normally.
  `templates/webkit-dmabuf.hook` rides the descriptor's `updater.hook` — the
  pipeline's runtime-hook slot, as Firefox's NVIDIA sandbox hook does — is
  installed into the AppDir's `bin/`, and is sourced by quick-sharun's
  `AppRun.sh` before it execs the launcher, so
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` reaches the launcher and the WebKit
  child processes it spawns. It applies to every launch, the cask's desktop
  entry included. The cost is accelerated compositing on hosts without the
  bug: the software path renders, but it does not use the GPU. Forcing
  `GDK_BACKEND=x11` and `__NV_DISABLE_EXPLICIT_SYNC=1` do not help, the
  bundle's WebKit (2.54.3) is current and `webkitgtk-6.0` is unavailable
  (`bin/libNativeWrapper.so` has `NEEDED libwebkit2gtk-4.1.so.0`), so the
  hook is the only lever until the driver renders.

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
