# pi-agent-desktop

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[Pi Agent](https://github.com/abcwyc/pi-agent-desktop) is a Tauri 2 desktop UI
for the `pi` coding agent. Upstream ships Linux as an amd64 `.deb` only (no
tarball, no AppImage), published on GitHub releases with an asset digest.

## App-specific

- **Version source** — `github-release`: the release whose tag normalises to the
  requested version (`v0.8.7`), asset `Pi.Agent_{version}_amd64.deb`, verified
  against the release's published SHA-256 and size. The linux entry in
  `latest.json` points at that `.deb` too, so the release is the only source.
- **Watch** — `format: "github-release"`. The release *title* is
  `pi-agent-desktop v0.8.7`, so the pattern matches the title, not the tag.
  A title change upstream silently stops dispatch: this needs a check when the
  app misses a release.
- **Payload** — `deb-files` with a `trees` entry. The Tauri binary links
  `webkit2gtk-4.1` and GTK 3 and is staged into `AppDir/bin` (the `.deb`'s
  `/usr/bin`), and its runtime resources (`resources/node`, `resources/server`,
  a bundled Node and a Next.js server) are staged at `AppDir/lib/Pi Agent`
  (the `.deb`'s `/usr/lib/Pi Agent`). That is where `tauri-utils` looks:
  `resource_dir()` resolves `exe_dir/../lib/<product name>` first
  (`tauri-utils` 2.10.1 `platform.rs`), and the launcher runs from
  `AppDir/bin`, so the AppDir root stands in for `/usr`. The APPDIR fallback
  (`<APPDIR>/usr/lib/<product name>`) is never reached in this layout; a tree
  staged under `bin/` leaves the app looking for its Node runtime in
  `/usr/bin/node` and failing at startup. quick-sharun's `shared/lib` is a
  symlink to `lib`, so an executable resolved from `shared/bin` finds the same
  tree. The bundled Node is a declared `quickSharun.targets` entry, so
  quick-sharun deploys it into `shared/bin` and its path becomes a relative
  symlink to the `bin/node` wrapper: the app runs the bundled-loader copy, with
  the image's glibc and libstdc++, and the binary is shipped once. The wrapper
  needs no environment, so the spawn works whatever the mount path is.
- **Updater** — the Tauri updater endpoint is embedded once in the
  `pi-agent-desktop` ELF and `latest.json` names the Linux `.deb` as the update
  artifact, so an in-app update would overwrite the AppImage with a package.
  The endpoint is rewritten in place to a same-length never-resolving URL
  (`.../download/no/latest.json`), and the residual scan for the original runs
  at `severity: error`: one copy, and nothing legitimately keeps it.
- **webkit2gtk** — the binary links `libwebkit2gtk-4.1` and GTK 3. The
  builder image carries neither, so `debloatArgs` installs the debloated
  `webkit2gtk-4.1-mini` and `gdk-pixbuf2-mini` before the build, and
  quick-sharun bundles the binary's `ldd` closure from there. No
  `buildPackages` beyond that: nothing else is needed at pack time.
- **Local data** — Tauri's bundle identifier is `com.abcwyc.pi-agent`, so the
  cask's zap removes `~/.config/com.abcwyc.pi-agent`,
  `~/.cache/com.abcwyc.pi-agent` and `~/.local/share/com.abcwyc.pi-agent`.
  Sessions and credentials live in `~/.pi`, shared with the `pi` CLI, and are
  deliberately not zapped.

## Local run

`PACKAGE_VERSION` is the requested version and is required; the build fails
if the resolved version differs (CI always sets it). The webkit2gtk closure
comes from the debloated packages the build workflow installs, so a local
build needs the same step first.

```sh
get-debloated-pkgs --add-common --prefer-nano webkit2gtk-4.1-mini gdk-pixbuf2-mini
TARGET_ARCH=amd64 PACKAGE_VERSION=0.8.7 ./build.sh
```
