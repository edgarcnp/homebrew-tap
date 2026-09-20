# Edgarcnp Tap

A Homebrew tap of Linux desktop apps, repackaged as AppImages and built
automatically by this repository's CI.

## Platform notes

All casks work on Wayland and X11 — nothing forces a backend; the apps' own
toolkits (Electron, Tauri) detect Wayland and fall back to X11.

The tap targets any Linux distro with Homebrew, but is mainly supported on
Fedora (including the Atomic flavor). Every cask ships an AppImage and relies on
unprivileged user namespaces (on by default on Fedora) for the Chromium/WebKit
sandbox.

## Install

```sh
brew install --cask edgarcnp/tap/<cask>
```

Or tap once, then install by name:

```sh
brew tap edgarcnp/tap
brew install --cask <cask>
```

In a `Brewfile`:

```ruby
tap "edgarcnp/tap"
cask "<cask>"
```

## Casks

| Cask | Upstream | Notes |
| --- | --- | --- |
| `gitbutler` | [GitButler](https://gitbutler.com/) | Tauri; bundles webkit2gtk/GTK3, installs the GUI and the `but` CLI |
| `commandcode-desktop` | [Command Code Desktop](https://commandcode.ai/desktop) | amd64-only; updater feed removed |
| `opencode-desktop` | [OpenCode Desktop](https://opencode.ai/) | version and digest from OpenCode's update manifest |
| `vscode` | [Visual Studio Code](https://code.visualstudio.com/) | built from Microsoft's signed APT repo |

### gitbutler

Repackage of GitButler, built from the `.deb` served through GitButler's
download CDN. The AppImage bundles the webkit runtime (`libwebkit2gtk-4.1`) and
GTK3, so no webkit libraries are needed on the host. Installs the GUI as
`gitbutler-tauri` and the `but` CLI (same binary, dispatched by name), matching
upstream. Shares the standard GitButler profile and the `but://` URL scheme.

### commandcode-desktop

Repackage of Command Code Desktop, from the amd64 `.deb` on the
[CommandCodeAI/desktop](https://github.com/CommandCodeAI/desktop) releases,
verified against the release's SHA-256 asset digests. Upstream ships Linux
builds for x64 only, so this cask is amd64-only (`depends_on arch: :x86_64`).
The embedded updater feed is removed and update checks are gated by
`CC_DISABLE_AUTO_UPDATE=1`.

### opencode-desktop

Repackage of OpenCode Desktop, built from the `.deb` served by OpenCode's v2
desktop update API, verified against the manifest's SHA-256 digest. v2 binaries
are no longer published as GitHub release assets, so the manifest is both the
version and the digest source.

### vscode

Repackage of Visual Studio Code, built from Microsoft's signed APT repository.

## What a cask installs

- The AppImage, in the AppImage directory (default `~/Applications`; override
  with `brew install --cask --appimagedir=<dir>`).
- A launcher on your `PATH`, plus a desktop entry in
  `~/.local/share/applications/` and an icon in `~/.local/share/icons/`.

## Uninstall

```sh
brew uninstall --cask <cask>
```

`--zap` also removes the desktop entry and icon:

```sh
brew uninstall --cask --zap <cask>
```

Already uninstalled without `--zap`? The cask is gone, so `--force` is needed:

```sh
brew uninstall --cask --zap --force <cask>
```

## How these AppImages differ

Official AppImages usually use AppImageKit's `appimagetool` (squashfs + the
classic type-2 runtime). This tap builds with
[pkgforge `appimagetool`](https://github.com/pkgforge-dev/appimagetool):

- **uruntime** (from
  [Anylinux-AppImages](https://github.com/pkgforge-dev/Anylinux-AppImages))
  instead of the type-2 runtime. FUSE3-compatible.
- **DWARFS** compression instead of squashfs — smaller, delta-friendly images
  with built-in zsync.
- A single Rust binary, no Python/C++ toolchain.

The binaries inside are the official upstream releases; only the packaging
toolchain differs.

### Running

The runtime first tries to **mount** the embedded filesystem via FUSE3 and falls
back to **extract-and-run** (unpack to a temp dir), so the AppImages work even
without FUSE.

### Sandboxing

Builds never add `--no-sandbox`. The AppImages bundle pkgforge's
`fix-namespaces` hook, which detects a distro that restricts unprivileged user
namespaces (Ubuntu 24.04+, secureblue) and offers to lift the restriction so the
Chromium/WebKit sandbox works. If it can't help on your system, use the upstream
`.deb`/`.rpm` instead.

## Documentation

How the AppImages are built — pipeline, descriptors, verification and adding an
app: [`packaging/README.md`](packaging/README.md).

For Homebrew itself: `brew help`, `man brew`, or
[docs.brew.sh](https://docs.brew.sh).

## License

Apache-2.0. See [LICENSE](LICENSE).
