# Edgarcnp Tap

Homebrew tap with Linux desktop apps, repackaged as AppImages and built automatically by this repository's CI.

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

## Supported platforms

Casks should work on any Linux distro with Homebrew, but this tap is mainly supported on Fedora Linux, including the Atomic flavor. All casks ship AppImages and rely on unprivileged user namespaces (enabled by default on Fedora) for the Chromium sandbox.

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

### Where the AppImages come from

Each app is built from its upstream's release artifacts — Visual Studio Code from Microsoft's signed APT repository, GitButler from checksum-pinned release packages — and published as an AppImage on this repository.

## Casks

### codex-desktop

Repackage of [OpenAI Codex Desktop for Linux](https://openai.com/codex/) as an AppImage.

```sh
brew install --cask edgarcnp/tap/codex-desktop
```

The app shares the upstream Codex profile (`~/.codex`) and single-instance lock with OpenAI's app; do not run both at the same time.

### visual-studio-code

Repackage of [Visual Studio Code](https://code.visualstudio.com/) as an AppImage, built from Microsoft's signed APT repository.

```sh
brew install --cask edgarcnp/tap/visual-studio-code
```

### gitbutler

Repackage of [GitButler](https://gitbutler.com/) as an AppImage. GitButler is a Tauri app; its AppImage bundles the webkit runtime (`libwebkit2gtk-4.1`) and GTK3 dependencies, so no webkit libraries are required on the host. The cask installs the GUI as `gitbutler-tauri` and the `but` CLI (same binary, dispatched by name), matching upstream.

```sh
brew install --cask edgarcnp/tap/gitbutler
```

Shares the standard GitButler profile and the `but://` URL scheme with the app.

## Documentation

`brew help`, `man brew` or check [Homebrew's documentation](https://docs.brew.sh).

## License

Apache-2.0. See [LICENSE](LICENSE).
