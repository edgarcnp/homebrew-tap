# commandcode-desktop

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

[Command Code Desktop](https://commandcode.ai/desktop) ships Linux builds for
x64 only, so this pipeline repackages the amd64 `.deb` from the
[CommandCodeAI/desktop](https://github.com/CommandCodeAI/desktop) releases. The
canonical download page (`https://commandcode.ai/download/linux`) is only a
redirect, so the version oracle is the GitHub releases API.

## App-specific

- **Version source** — `github-release`, versioned-asset flavor: the newest
  release whose tag starts with `v` and carries `CommandCode-{version}-{arch}.deb`
  with a SHA-256 digest. The tag and filename must agree, so an upstream layout
  change fails loudly; an arm64 resolve finds no asset and fails rather than
  packaging the wrong architecture.
- **Single-arch** — `architectures: ["amd64"]`: the only app here without an
  arm64 build. The cask pins one `sha256` and `depends_on arch: :x86_64`; CI
  builds, publishes and checks amd64 only.
- **Payload** — `deb-tree`: the `opt/Command Code` tree is staged into `AppDir/bin`.
- **Updater** — `resources/app-update.yml` is removed and its absence is
  required, so a future upstream build that drops it fails the build instead of
  silently keeping a live feed. `CC_DISABLE_AUTO_UPDATE=1` is written to the
  AppDir `.env`. The residual scan looks for `CommandCodeAI/gui`.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=0.1.29 ./build.sh
```
