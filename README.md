# Edgarcnp Tap

## How do I install these formulae?

`brew install edgarcnp/tap/<formula>`

Or `brew tap edgarcnp/tap` and then `brew install <formula>`.

Or, in a `brew bundle` `Brewfile`:

```ruby
tap "edgarcnp/tap"
brew "<formula>"
```

## Casks

### codex-desktop

Unofficial repackage of [OpenAI Codex Desktop for Linux](https://openai.com/codex/), built by this tap's CI from the signed official `.deb` (verification chain: pinned repository key -> `InRelease` -> `Packages` SHA-256 -> package SHA-256) and published as an AppImage. The app is packaged under its upstream identity (ChatGPT Community, `codex-desktop`).

```sh
brew install --cask edgarcnp/tap/codex-desktop
```

Notes:

- The cask links the AppImage into the configured AppImage directory (default `~/Applications`; override with `brew install --cask --appimagedir=<dir>`) and creates a desktop entry at `~/.local/share/applications/codex-desktop.desktop` with a stable `codex-desktop` launcher on your PATH; the entry and its icon are removed again with `brew uninstall --cask --zap codex-desktop`.
- The app shares the upstream Codex profile (`~/.codex`) and single-instance lock with OpenAI's official app; do not run both at the same time.
- AppImage builds never add `--no-sandbox`. If your distribution disables unprivileged user namespaces, use the official `.deb`/`.rpm` instead.
- A GitHub Actions workflow polls the signed upstream repository hourly and, on a new release, builds both `x86_64` and `aarch64` AppImages, publishes them as a release on this repository, and bumps the cask automatically. Until the first release exists, the cask is a placeholder and will fail checksum verification.

## Documentation

`brew help`, `man brew` or check [Homebrew's documentation](https://docs.brew.sh).