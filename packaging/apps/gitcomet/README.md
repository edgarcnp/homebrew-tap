# gitcomet

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from GitComet's signed apt repository, `apt.gitcomet.dev`.

## Trust model

GPG chain, the strongest in this tap alongside vscode: the keyring is pinned in
[`assets/`](assets) by fingerprint, `InRelease` is verified against it, and both
the `Packages` index and the downloaded `.deb` are checked against the SHA-256
and size the signed index records. The repository host is pinned too — the
downloader accepts no edge host. The cask's `sha256` starts as placeholders and
is filled on the first publish, pinning the final AppImage at install.

## App-specific

- **Version source** — `apt`: the index carries `0.2.5-1` for both
  architectures, and `normalizeUpstreamVersion` drops the numeric `-1`
  revision, so the cask version and the feed title agree on `0.2.5`. The repo is
  republished minutes after each GitHub release (v0.2.5: release 12:33:33Z,
  `InRelease` `Date` 12:38:38Z), which also keeps `InRelease` inside the
  oracle's 14-day freshness window. `InRelease` publishes no `Valid-Until`, so
  freshness falls back to `Date`.
- **Payload** — `deb-files`: `usr/bin/gitcomet` is staged into `AppDir/bin`, and
  the 512×512 icon comes from
  `usr/share/icons/hicolor/512x512/apps/gitcomet.png`.
- **No webkit** — `needsWebkit: false`: GitComet is a GPUI/OpenGL app, not
  GTK/WebKit. Its deb depends only on `git, libc6, libgcc-s1, libxcb1,
  libxkbcommon-x11-0, libxkbcommon0, zlib1g`, which sharun reaches through `ldd`
  and bundles, so the host needs none of them. `debloatArgs` is `--add-common`
  alone — the tool's own usage examples show it standalone, it implies
  `--add-mesa` (which this app wants), and nothing here needs ffmpeg.
- **Updater** — upstream's check is read-only: it queries the releases API and
  shows a toast with a link, it never downloads or installs anything. Setting
  `GITCOMET_NO_UPDATE_CHECK=1` — upstream's supported switch, written to the
  AppDir `.env` by `fbr finalize` — disables it, so there is no endpoint to
  patch and no residual scan to assert one.
- **Release watch** — the pattern matches the release *title* (`GitComet
  v0.2.5`), not the tag, so capture group 1 is `0.2.5`. `skipPattern` drops
  `-rc` entries: upstream's release workflow accepts `-rc.N` versions, and an rc
  that the apt index never carries would advertise a version `resolve` cannot
  reach, holding every run until it gave up.
