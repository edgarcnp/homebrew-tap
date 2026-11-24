# gitcomet

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from GitComet's GitHub release tarball.

## Trust model

GitHub release asset: the release whose tag normalizes to the requested version
must carry `gitcomet-v<version>-linux-x86_64.tar.gz` with a SHA-256 `digest` and
a sane `size`; the download is verified against both. A missing tag, asset or
digest is a typed not-ready. The cask's `sha256` starts as placeholders and is
filled on the first publish, pinning the final AppImage at install.

## App-specific

- **Version source** — `github-release` with tag prefix `v` and asset template
  `gitcomet-v{version}-linux-x86_64.tar.gz`. The watch feed is the API's source;
  the tap resolves only the requested release.
- **Payload** — `tarball-tree` with `target: "bin"`: the versioned tarball root
  (`gitcomet-v<version>-linux-x86_64/`) is detected as the single top-level
  directory, and its contents (the `gitcomet` binary plus docs) are staged into
  `AppDir/bin`. The tarball ships no icon, so the descriptor uses a repo-owned
  512×512 `templates/gitcomet.png` from upstream's `assets/linux` tree
  (`icon.base: "app"`).
- **No webkit** — GitComet is a GPUI/OpenGL app, not GTK/WebKit. It links only
  base system libraries, which sharun reaches through `ldd` and bundles, so the
  host needs none of them. `debloatArgs` is `--add-common` alone — the tool's
  own usage examples show it standalone, it implies `--add-mesa` (which this
  app wants), and nothing here needs ffmpeg.
- **Updater** — upstream's check is read-only: it queries the releases API and
  shows a toast with a link, it never downloads or installs anything. Setting
  `GITCOMET_NO_UPDATE_CHECK=1` — upstream's supported switch, written to the
  AppDir `.env` by `fbr finalize` — disables it, so there is no endpoint to
  patch and no residual scan to assert one.
- **Release watch** — the pattern matches the release *name* (`GitComet
  v<version>`), not the tag, so capture group 1 is the version.
  `releases/latest` answers only a release that is neither a draft nor a
  prerelease, so upstream's `-rc.N` versions can never reach the watch and no
  skip list is needed. The cask's livecheck reads this tap's own release tags
  (the versions the pipeline published), so it never sees an upstream rc.
- **Local data** — the app keeps everything under XDG data and state only
  (`~/.local/share/gitcomet`, `~/.local/state/gitcomet`; upstream defines no
  config directory), which is exactly what the cask's zap removes.
