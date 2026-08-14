# Shared packaging components

Components shared by the per-app packagings in `packaging/<app>/`:

- `package-common.sh` — bash helpers (`info`/`warn`/`error`,
  `ensure_file_exists`, `render_template`, `sed_escape_replacement`,
  `normalize_package_payload_permissions`).
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

Codex-desktop's packaging lives in an external repo (`ilysenko/codex-desktop-linux`),
but its build pipeline uses this library and the vendored key under
`packaging/codex/assets/` from this tap (the workflow's `resolve_script` and
`key_path` inputs point at `../tap/...`, resolved from the source checkout).
