# Edgarcnp Tap

Homebrew tap with Linux desktop apps, repackaged as AppImages and built automatically by this repository's CI.

## Supported platforms

> [!Note]
> All casks are supported on Wayland. Casks prefer Wayland when available; they fall back to X11 otherwise.

Casks should work on any Linux distro with Homebrew, but this tap is mainly supported on Fedora Linux, including the Atomic flavor. All casks ship AppImages and rely on unprivileged user namespaces (enabled by default on Fedora) for the Chromium sandbox.

## Installation

Install any cask directly:

```sh
brew install --cask edgarcnp/tap/<cask>
```

Or tap once, then install by name:

```sh
brew tap edgarcnp/tap
brew install --cask <cask>
```

Or in a `brew bundle` `Brewfile`:

```ruby
tap "edgarcnp/tap"
cask "<cask>"
```

## Casks

### gitbutler

Repackage of [GitButler](https://gitbutler.com/) as an AppImage, built from the checksum-pinned `.deb` published through GitButler's download CDN. GitButler is a Tauri app; the AppImage bundles the webkit runtime (`libwebkit2gtk-4.1`) and GTK3 dependencies, so no webkit libraries are required on the host. The cask installs the GUI as `gitbutler-tauri` and the `but` CLI (same binary, dispatched by name), matching upstream.

```sh
brew install --cask edgarcnp/tap/gitbutler
```

Shares the standard GitButler profile and the `but://` URL scheme with the app.

### opencode-desktop

Repackage of [OpenCode Desktop](https://opencode.ai/) as an AppImage, built from the `.deb` published on the [anomalyco/opencode](https://github.com/anomalyco/opencode) GitHub releases and verified against the release's SHA-256 asset digests.

```sh
brew install --cask edgarcnp/tap/opencode-desktop
```

### vscode

Repackage of [Visual Studio Code](https://code.visualstudio.com/) as an AppImage, built from Microsoft's signed APT repository.

```sh
brew install --cask edgarcnp/tap/vscode
```

## General notes (applies to all casks)

### What a cask installs

- The AppImage, copied into the configured AppImage directory (default `~/Applications`; override with `brew install --cask --appimagedir=<dir>`).
- A launcher binary on your PATH and a desktop entry in `~/.local/share/applications/`, with its icon in `~/.local/share/icons/`.

Uninstall with:

```sh
brew uninstall --cask <cask>
```

Add `--zap` to also remove the desktop entry and icon:

```sh
brew uninstall --cask --zap <cask>
```

### Sandboxing

AppImage builds never add `--no-sandbox`. If your distribution disables unprivileged user namespaces, use the `.deb`/`.rpm` packages instead.

## Documentation

`brew help`, `man brew` or check [Homebrew's documentation](https://docs.brew.sh).

## License

Apache-2.0. See [LICENSE](LICENSE).
