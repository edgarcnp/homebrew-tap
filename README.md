# edgarcnp/tap

A Homebrew tap of Linux desktop apps, repackaged as AppImages.

## Install

```sh
brew install --cask edgarcnp/tap/<cask>
```

Or tap once to install by name:

```sh
brew tap edgarcnp/tap
brew install --cask <cask>
```

## Casks

| Cask | App | Notes |
| --- | --- | --- |
| `firefox` | [Firefox](https://www.mozilla.org/firefox/) | en-US build; [hardware decoding notes](packaging/apps/firefox/README.md) |
| `gitcomet` | [GitComet](https://gitcomet.dev/) | |
| `little-genius` | [Little Genius](https://lg.avakot.org/) | Soulframe companion |
| `opencode-desktop` | [OpenCode Desktop](https://opencode.ai/) | |
| `spotifast` | [Spotifast](https://github.com/crmne/spotifast) | Native Spotify client |
| `vscode` | [Visual Studio Code](https://code.visualstudio.com/) | |
| `wfhelper` | [WFHelper](https://github.com/WFHelper/WFHelper) | Warframe companion |

> [!NOTE]
> Every cask in this tap is amd64-only. Each descriptor declares
> `architectures: ["amd64"]`, so the pipeline builds, publishes and pins a
> single `x86_64` AppImage, and each cask carries one `sha256` behind
> `depends_on arch: :x86_64`. On an arm64 host `brew install --cask` refuses
> up front instead of fetching an amd64 build.

## How these AppImages differ

These are the official upstream releases repackaged, so they are still
ordinary AppImages — one self-contained file per app. The packaging around
them differs from a classic AppImage in a few ways you may notice:

- **They carry their own basic libraries.** A classic AppImage relies on the
  C library and other basics already installed on your computer, and can
  refuse to start on older or less common systems, complaining that a library
  is missing or too old. Ours pack those libraries in, so they run where a
  classic build would not.
- **FUSE is optional.** AppImages normally mount themselves like a small
  disk, which needs FUSE3. Ours use FUSE3 when it is available, and otherwise
  quietly unpack into a temporary folder and run from there — no setup either
  way.
- **They do not update themselves.** There is no built-in updater and nothing
  runs in the background. Homebrew pins each version, and
  `brew upgrade --cask <cask>` is how you update.
- **They are smaller.** They are packed with a newer compression format
  (DWARFS), so the same app usually downloads in fewer bytes than the classic
  format.
- **A one-time sandbox check.** On launch the AppImages check that
  unprivileged user namespaces are available — the feature browsers, Electron
  apps and other sandboxed software rely on. Most distributions allow it; a
  few (Ubuntu 24.04 and newer, secureblue) restrict it, and the first launch
  there explains the situation and offers to lift the restriction for you.

The app code itself is the same official release the project publishes; only
the packaging around it differs.

## Requirements

- Linux with Homebrew. Mainly supported on Fedora, including the Atomic flavor,
  but runs on any distro.
- Wayland and X11 both work — nothing forces a backend.

## What a cask installs

- The AppImage, in `~/Applications`. Override the directory with
  `brew install --cask --appimagedir=<dir>`.
- A launcher on your `PATH`, plus a desktop entry and icon under
  `~/.local/share/`.

## Uninstall

```sh
brew uninstall --cask <cask>
```

Add `--zap` to also remove the desktop entry and icon, and `--force` if the cask
is already uninstalled:

```sh
brew uninstall --cask --zap <cask>
```

## Documentation

These are the upstream releases repackaged; only the packaging toolchain differs
(pkgforge's `appimagetool` — uruntime and DWARFS instead of AppImageKit and
squashfs). See [`packaging/README.md`](packaging/README.md) for how they are
built.

## License

Apache-2.0. See [LICENSE](LICENSE).
