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
brew "<cask>"
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

AppImage builds never add `--no-sandbox`. If your distribution disables unprivileged user namespaces, use the official `.deb`/`.rpm` packages instead.

### Where the AppImages come from

Each app is built from its upstream's signed package (verification chain: pinned repository key -> `InRelease` -> `Packages` SHA-256 -> package SHA-256) and published as an AppImage on this repository.

### How updates work

A GitHub Actions workflow per app polls the signed upstream repository on its own schedule, resolves the latest upstream version, and only builds when it is newer than the cask's version. It then builds both `x86_64` and `aarch64` AppImages, publishes them under an app-prefixed release tag (e.g. `codex-desktop-v26.803.81509`), and bumps the cask automatically.

The pipeline is shared (`.github/workflows/build-appimage.yml`); each app gets its own caller workflow with its own release cadence. If a release exists but the cask never caught up (e.g. a failed push), the cask is updated from the existing release without rebuilding.

Until the first release exists, a cask is a placeholder that fails checksum verification — keep its version older than upstream (e.g. `0.0.1`) so the first build triggers.

## Casks

### codex-desktop

Unofficial repackage of [OpenAI Codex Desktop for Linux](https://openai.com/codex/) as an AppImage.

```sh
brew install --cask edgarcnp/tap/codex-desktop
```

The app shares the upstream Codex profile (`~/.codex`) and single-instance lock with OpenAI's official app; do not run both at the same time.

### visual-studio-code

Official [Visual Studio Code](https://code.visualstudio.com/) stable build, repackaged as an AppImage from Microsoft's signed APT repository (`packages.microsoft.com/repos/code`, pinned key fingerprint `BC528686B50D79E339D3721CEB3E94ADBE1229CF`).

```sh
brew install --cask edgarcnp/tap/visual-studio-code
```

The build script and pinned key live in `packaging/vscode/` in this repository. The daily build workflow tracks the stable channel; the cask version is the upstream version (e.g. `1.133.0`), not the `.deb` build-epoch suffix.

## Documentation

`brew help`, `man brew` or check [Homebrew's documentation](https://docs.brew.sh).
