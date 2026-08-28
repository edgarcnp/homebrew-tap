# Shared packaging components

Components shared by the per-app packagings in `packaging/<app>/`:

- `package-common.sh` — bash helpers (`info`/`warn`/`error`,
  `ensure_file_exists`, `render_template`, `sed_escape_replacement`,
  `normalize_package_payload_permissions`).
- `apprun-common.sh` — shared AppRun preamble sourced by the per-app AppRun
  templates. Resolves the real AppDir root at runtime (handles symlink chains
  and host-injected APPDIR overrides) and exports APPDIR. Every build script
  copies it into the AppDir alongside AppRun.
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

Per-app packagings provide the pinned key, the templates, and a thin
`scripts/build-appimage.sh` that drives the two shared components. The
reusable workflow (`build-appimage.yml`) runs the resolver from the source
checkout root (`resolve_script` input) and the build command from
`source_dir`.

