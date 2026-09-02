# Shared packaging components

Components shared by the per-app packagings in `packaging/<app>/`:

- `package-common.sh` — bash helpers (`info`/`warn`/`error`,
  `ensure_file_exists`, `render_template`, `sed_escape_replacement`,
  `normalize_package_payload_permissions`, `smoke_test_appimage`).
- `net-utils.js` — shared network helpers used by all three resolvers:
  `fetchWithRetry` (429/5xx + network-error retry with backoff, honors
  `Retry-After`, capped at 30s; timeouts throw without retry),
  `readPayload` (streaming reads under a 512 MiB cap), and
  `writeFileAtomic`.
- `upstream-linux-package.js` — signed-apt-repository resolver:
  pinned key -> `InRelease` -> `Packages` SHA-256 -> package SHA-256/size.
  Picks the newest `--package` entry per architecture. Required flags:
  `--output-dir`, `--metadata`, `--key-base64`, `--package`, `--fingerprint`,
  `--repository`, `--arch` (`amd64`/`arm64`); `--metadata-only` skips the
  `.deb` download. When the Debian version has a numeric build-epoch suffix
  (`1.133.0-1786487972`), the metadata's `version` field is the upstream
  version (`1.133.0`) and `packageVersion` keeps the full version.
- `../scripts/install-anylinux-tools.sh` — downloads `quick-sharun.sh` and
  `get-debloated-pkgs.sh` from pkgforge-dev/Anylinux-AppImages, pinned to a
  commit and verified by SHA-256. Bumps are manual PRs that update the commit
  and both hashes together.

Per-app packagings provide the pinned key, the desktop templates, and a thin
`scripts/build-appimage.sh` that drives the resolvers plus the shared
toolchain. The reusable workflow (`build-appimage.yml`) runs the resolver
from the source checkout root (`resolve_script` input) and the build command
from `source_dir`.

## Build model: sharun/quick-sharun in an Arch container

AppImage builds run inside `ghcr.io/pkgforge-dev/archlinux:<tag>` (pinned in
`build-appimage.yml`), mirroring how pkgforge's Anylinux-AppImages are built.
`linuxdeploy` was retired: quick-sharun (wrapping sharun) bundles the app's
dynamic-linker closure **including glibc and ld-linux** and generates the
AppRun, so the resulting AppImages have no host-libc dependency and run on
musl, non-FHS and very old distros. The same setup installs pkgforge's
debloated Arch packages (`get-debloated-pkgs`, flags per app via the
`debloat_args` workflow input) so the AppImages carry stripped `libicudata`,
mesa without LLVM, and other size optimizations.

The workflow installs the webkit2gtk/GTK deps only when the `needs_webkit`
input is set (gitbutler only) — vscode and opencode-desktop are Electron and
ship their own webkit. The other build deps (`nodejs`, `gnupg`, `dpkg`,
`patchelf`, `xorg-server-xvfb`) are installed for every app. The pinned
pkgforge `appimagetool` (uruntime/DWARFS) is invoked by quick-sharun through
the `APPIMAGETOOL` env var with no CLI args; it reads
`APPDIR/OUTPATH/OUTNAME/ARCH/VERSION` from the environment.
