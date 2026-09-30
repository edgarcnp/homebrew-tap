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
| `cline-desktop` | [Cline Desktop](https://cline.bot/) | |
| `firefox` | [Firefox](https://www.mozilla.org/firefox/) | en-US build; [hardware decoding notes](#hardware-video-decoding) |
| `gitcomet` | [GitComet](https://gitcomet.dev/) | |
| `little-genius` | [Little Genius](https://lg.avakot.org/) | Soulframe companion |
| `opencode-desktop` | [OpenCode Desktop](https://opencode.ai/) | |
| `vscode` | [Visual Studio Code](https://code.visualstudio.com/) | |
| `wfhelper` | [WFHelper](https://github.com/WFHelper/WFHelper) | Warframe companion |

> [!NOTE]
> Every cask in this tap is amd64-only. Each descriptor declares
> `architectures: ["amd64"]`, so the pipeline builds, publishes and pins a
> single `x86_64` AppImage, and each cask carries one `sha256` behind
> `depends_on arch: :x86_64`. On an arm64 host `brew install --cask` refuses
> up front instead of fetching an amd64 build.

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

## Hardware video decoding

The `firefox` AppImage enables hardware video decoding by default. It ships
`media.ffmpeg.vaapi.enabled`, `media.hardware-video-decoding.force-enabled` and
`media.rdd-ffmpeg.enabled` as default prefs (overridable in `about:config`),
and it disables Firefox's RDD sandbox **only on hosts with an NVIDIA device**,
because the driver cannot initialise CUDA inside it.

- **Intel / AMD** — decoded by the bundled drivers (`intel-media-driver`,
  Mesa); nothing to install.
- **NVIDIA** — decoded by the host's
  [`nvidia-vaapi-driver`](https://github.com/elFarto/nvidia-vaapi-driver)
  (e.g. the `libva-nvidia-driver` package), which must be installed, with the
  NVIDIA kernel module running `nvidia-drm.modeset=1`. Without it, decoding
  falls back to software. Because the driver needs it, the AppImage sets
  `MOZ_DISABLE_RDD_SANDBOX=1` on NVIDIA hosts, which weakens the media
  process isolation — the price of hardware decoding there. Verified on an
  RTX 3080 (driver 615.71.09): H.264, VP8, VP9, AV1 and HEVC all decode in
  hardware.

> [!NOTE]
> Firefox is moving to Vulkan video decoding by default on Linux
> ([bug 2053144](https://bugzilla.mozilla.org/show_bug.cgi?id=2053144)). The
> tap stays on VA-API for now: Vulkan has to be forced on, has no VP8 decoder
> (that codec would fall back to software), and its NVIDIA issues are still
> open ([2054380](https://bugzilla.mozilla.org/show_bug.cgi?id=2054380),
> [2072790](https://bugzilla.mozilla.org/show_bug.cgi?id=2072790)). Forcing it
> here does decode H.264/VP9/AV1/HEVC on the NVDEC engine; the defaults will
> be revisited once the upstream switch lands.

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
