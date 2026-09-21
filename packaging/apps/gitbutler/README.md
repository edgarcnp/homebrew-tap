# gitbutler

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from GitButler's Linux `.deb`, located through the `app.gitbutler.com`
download redirect.

## Trust model

GitButler publishes no signed repository and no checksums, so there is no GPG
chain: trust is HTTPS plus GitButler's CDN, with the `.deb` SHA-256 computed by
the resolver and trusted on first sight. The redirect host (`redirectHosts`) and
URL shape are pinned, so an upstream layout change fails loudly. The cask's
`sha256` starts as placeholders and is filled on the first publish, pinning the
final AppImage at install.

## App-specific

- **Version source** — `cdn-redirect`: the redirect is the only oracle. In
  `--metadata-only` mode the payload is still downloaded to compute the SHA-256
  (the CDN publishes nothing to verify it against), then discarded.
- **Payload** — `deb-files`: `gitbutler-tauri`, `gitbutler-git-askpass` and `but`
  are staged into `AppDir/bin`. `but` is a symlink into `gitbutler-tauri`, copied
  with `-a` so the symlink survives.
- **webkit2gtk** — `needsWebkit: true`: the build installs the webkit2gtk/GTK
  closure (plus X11 libs, following upstream
  `webkit2gtk4-demo-appimage.sh`) and debloated common packages including
  `webkit2gtk-4.1-mini`, and sharun bundles it, so the host needs no
  webkit libraries. `GTK_CLASS_FIX=1` ships the WM_CLASS shim for GTK.
- **Updater** — the endpoint embedded in the `gitbutler-tauri` binary is
  rewritten to a never-resolving host with a same-length patch. The residual
  scan runs at `severity: warning`, since a copy can legitimately remain in a
  file that is not the patched binary. A runtime hook seeds
  `ui.checkForUpdatesIntervalInSeconds: 0` into `~/.config/gitbutler/settings.json`
  so the in-app checker never runs.

The cask version uses the upstream `version` (e.g. `0.22.3`), not the redirect's
build suffix (`0.22.3-3215`).

## Local run

```sh
TARGET_ARCH=amd64 ./build.sh
```
