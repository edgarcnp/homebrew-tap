# artcraft-launcher

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from ArtCraft Launcher's GitHub releases
([`storytold/craft-launcher`](https://github.com/storytold/craft-launcher)): the
Linux x86_64 `.deb` asset is staged and repacked as this tap's AppImage.

## Trust model

GitHub release assets: the advisory pins the repository and the asset-name
template, and verifies the downloaded `.deb` against the SHA-256 the releases
API publishes for that exact asset. The cask starts with a placeholder
checksum that the first publish replaces with the built AppImage's SHA-256.

## App-specific

- **Version source** — `github-release`: tag `v<version>`, release title
  `ArtCraft Launcher v<version>`. The asset template hardcodes `-linux-x86_64`
  because upstream names its packages with the upstream machine spelling
  (`x86_64`, `aarch64`) while `{arch}` substitutes the deb arch (`amd64`,
  `arm64`); the app is amd64-only here, matching the tap.
- **Release watch** — the pattern matches the release *title*, not the tag, so
  capture group 1 is the version. Upstream marks every `-suffix` version
  (`1.2.3-rc.1`) as a GitHub prerelease, but the feed reader lists titles and
  never sees that flag, so `skipPattern` drops those titles instead; without it
  the watcher would advertise a version `resolve` (which skips prerelease
  releases) can never reach.
- **Payload** — `deb-files`: `usr/bin/artcraft-launcher` is staged into
  `AppDir/bin`, and the icon comes from the `scalable` hicolor tree.
- **dlopen libraries** — the binary links only libc/libgcc/libm; the whole
  windowing stack (X11/XCB/cursor/Xi, xkbcommon, Wayland, EGL) is loaded with
  `dlopen`, so no `ldd` closure would find it. `quickSharun.libraries` names
  each library as a deploy target; `debloatArgs: --add-common` makes
  `get-debloated-pkgs` fetch pkgforge's debloated common-library set (mesa,
  Wayland and the rest), which carries them into the pack step.
- **Updater** — the launcher checks its own repository's releases and, when
  started from an AppImage (`$APPIMAGE` is set), replaces the AppImage file
  with the upstream one. The descriptor patches the embedded
  `storytold/craft-launcher` repository string to `update.invalid/launchers`
  (same length, so the ELF stays valid) and a post-patch residual scan fails
  the build at severity `error` if that exact byte string survives, keeping
  Homebrew the owner of updates. The patched path still reaches
  `api.github.com` and 404s there — `update.invalid` is RFC-2606 reserved, so
  no repository can ever be claimed under it. The scan is a literal substring
  match, so an upstream rename of the slug would need a descriptor update.
  The launcher's Craft App Suite catalog is untouched: it uses other
  repositories and the ArtCraft feed, none of which are patched.
- **Local data** — the launcher keeps downloads and release answers under
  `~/.cache/artcraft-launcher` and its install records under
  `~/.local/share/artcraft-launcher`; eframe keeps the launcher's settings in
  its own per-app folder (`~/.local/share/ai.storyteller.artcraft-launcher`).
  The cask's zap removes all three, plus the desktop entry and icon.
