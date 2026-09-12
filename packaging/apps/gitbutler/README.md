# gitbutler packaging

Descriptor: `app.json` (see [the pipeline README](../../README.md) for the
shared stages and the descriptor field reference).

The AppImage is built from GitButler's Linux `.deb`, located through the
`app.gitbutler.com` download redirect.

## Trust model

GitButler publishes no signed apt repository and no checksums, so there is no
GPG verification chain: the trust model is HTTPS plus GitButler's CDN, with the
`.deb` SHA-256 computed by the resolver and trusted on first sight. The
redirect target host is pinned in the descriptor (`redirectHosts`) and the URL
shape is validated, so an upstream layout change fails loudly instead of
producing a wrong download. The cask's `sha256` starts as zero placeholders and
is filled by the publish pipeline on the first release, so the final AppImage
is pinned at install.

## What is app specific here

- **Version source** (`oracle.kind: cdn-redirect`): the redirect is the only
  version oracle. In `--metadata-only` mode (used by the detect job) the
  payload is still downloaded to compute the SHA-256, because the CDN
  publishes nothing to verify it against, and then discarded.
- **Payload staging** (`payload.kind: deb-files`): `gitbutler-tauri` (main GUI),
  `gitbutler-git-askpass` and the `but` CLI are staged into `AppDir/bin`; `but`
  is a symlink into `gitbutler-tauri` and is copied with `-a` so the symlink
  survives, matching upstream's dispatch-by-name behavior.
- **webkit2gtk**: the descriptor sets `needsWebkit: true`, so the build
  container installs the webkit2gtk/GTK runtime closure (and debloated mesa for
  the GPU-accelerated webkit path) and sharun bundles it into the AppImage — no
  webkit libraries are required on the host.
- **Updater neutralization**: the endpoint embedded in the `gitbutler-tauri`
  binary is rewritten to a never-resolving host (`x.invalid.invalid`) with a
  same-length patch, so the Tauri built-in updater can never find or install an
  update. The residual scan for the original endpoint runs at `severity:
  warning` — a copy can legitimately remain in a file that is not the patched
  binary, and failing the build there would be a false positive. A runtime hook
  (`templates/prevent-autoupdate.hook`, sourced by the generated AppRun) seeds
  `~/.config/gitbutler/settings.json` with
  `ui.checkForUpdatesIntervalInSeconds: 0` so the in-app auto-update checker
  never runs, mirroring the `disable-auto-updates` feature the GitButler
  flatpak ships with.

The cask version uses the upstream `version` string (e.g. `0.22.3`), not the
redirect's build suffix (e.g. `0.22.3-3215`).

## Local run (verification only)

```sh
TARGET_ARCH=amd64 ./build.sh
```
