# edgarcnp/tap

A Homebrew tap of Linux desktop apps, repackaged as AppImages.

## Install

Install an app by its full cask name:

```sh
brew install --cask edgarcnp/tap/<cask>
```

Or add the tap once and then install by the short name:

```sh
brew tap edgarcnp/tap
brew install --cask <cask>
```

## Casks

| Cask | App | Notes |
| --- | --- | --- |
| `firefox` | [Firefox](https://www.mozilla.org/firefox/) | en-US build; [hardware decoding notes](packaging/apps/firefox/README.md) |
| `gitcomet` | [GitComet](https://gitcomet.dev/) | |
| `little-genius` | [Little Genius](https://lg.avakot.org/) | |
| `opencode-desktop` | [OpenCode Desktop](https://opencode.ai/) | |
| `spotifast` | [Spotifast](https://github.com/crmne/spotifast) | |
| `vscode` | [Visual Studio Code](https://code.visualstudio.com/) | |
| `wfhelper` | [WFHelper](https://github.com/WFHelper/WFHelper) | |

> [!NOTE]
> Every app here is amd64-only. On an arm64 machine, `brew install --cask`
> stops right away instead of downloading a build it cannot run.

## How these AppImages differ

These apps are still normal AppImages: one self-contained file per app, with
nothing to install by hand. A few things are different from most AppImages
you may have used:

- **They bring their own basic libraries.** Most AppImages rely on the C
  library and other basics already installed on your computer, and they can
  refuse to start on older or less common systems, saying a library is
  missing or too old. These pack those libraries inside, so they start where
  a classic build would not.
- **FUSE is optional.** Most AppImages need FUSE3 to mount themselves like a
  small disk. These use FUSE3 when your system has it, and quietly unpack
  into a temporary folder and run from there when it does not. Either way,
  there is nothing for you to set up.
- **They never update themselves.** There is no built-in updater and nothing
  runs in the background. Homebrew pins each version, so
  `brew upgrade --cask <cask>` is how updates happen.
- **The download carries more than the app.** The app files are compressed
  with a newer format (DWARFS), but the file also includes the libraries the
  app needs, so it can be larger than a classic AppImage of the same app. A
  classic build expects your computer to provide those libraries instead.
- **Sandboxing may need a one-time OK.** Browsers and other sandboxed apps
  use a Linux feature called unprivileged user namespaces. Most distributions
  allow it. A few, among them Ubuntu 24.04 and newer and secureblue, restrict
  it, and on those systems the first launch explains the situation and offers
  to lift the restriction for you.

The apps themselves are the same official releases the projects publish. Only
the packaging around them is different.

## Requirements

- Linux with Homebrew. Fedora is the best-supported system here, Atomic flavor
  included, though the apps run on other distributions too.
- Both Wayland and X11 work, and nothing forces one or the other.

## What a cask installs

- The AppImage, in `~/Applications`. You can put it somewhere else with
  `brew install --cask --appimagedir=<dir>`.
- A launcher on your `PATH`, so you can start the app from a terminal, plus a
  menu entry and icon under `~/.local/share/`.

## Uninstall

```sh
brew uninstall --cask <cask>
```

Add `--zap` to remove the desktop entry and icon along with the app. If the
app is already gone, add `--force` as well:

```sh
brew uninstall --cask --zap <cask>
```

## Documentation

For how these builds are made, see
[`packaging/README.md`](packaging/README.md). The short version: they are the
upstream releases, packed with pkgforge's `appimagetool` (uruntime and DWARFS,
where a classic AppImage uses AppImageKit and squashfs).

## License

Apache-2.0. See [LICENSE](LICENSE).
