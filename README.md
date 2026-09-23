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
| `gitcomet` | [GitComet](https://gitcomet.dev/) | |
| `commandcode-desktop` | [Command Code Desktop](https://commandcode.ai/desktop) | amd64 only |
| `opencode-desktop` | [OpenCode Desktop](https://opencode.ai/) | |
| `little-genius` | [Little Genius](https://lg.avakot.org/) | Soulframe companion, amd64 only |
| `wfhelper` | [WFHelper](https://github.com/WFHelper/WFHelper) | Warframe companion, amd64 only |
| `vscode` | [Visual Studio Code](https://code.visualstudio.com/) | |

## Requirements

- Linux with Homebrew. Mainly supported on Fedora, including the Atomic flavor,
  but runs on any distro.
- The bundled sandbox needs unprivileged user namespaces (on by default on
  Fedora). On a distro that restricts them (Ubuntu 24.04+, secureblue) the
  AppImage offers to lift the restriction; without FUSE3 it just extracts and
  runs instead of mounting.
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
