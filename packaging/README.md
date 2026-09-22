# AppImage packaging

Build tooling for this tap's AppImage casks. One pipeline serves every app:
what differs between apps is **data** (`apps/<app>/app.json`), not a forked
script.

The TypeScript runs directly on Bun — no build step, no runtime dependencies.
`typescript` and `@types/bun` are dev-only (for `tsc --noEmit` and editors).

## Layout

```
packaging/
  apps/<app>/app.json      descriptor: the single source of truth for one app
  apps/<app>/build.sh      shim -> lib/shell/build-appimage.sh <app>
  apps/<app>/templates/    desktop entry (+ runtime hook)
  apps/<app>/assets/       pinned signing key material
  bin/fbr.ts               the CLI
  lib/cli.ts               CLI composition root
  lib/core/                primitives: paths, types, guards, patterns, version,
                           architecture, template, http, deb822, metadata
  lib/pipeline/            descriptor-driven steps: descriptor, cask, gate,
                           release, neutralize, render
  lib/oracles/             one module per upstream source kind; custom/ holds
                           provider-specific oracles (e.g. avakot)
  lib/shell/               the bash pipeline
  tests/                   unit suite, mirrors lib/  (bun test)
  scripts/                 repo tooling (tool installer, local style gate)
```

`lib/` is a library: no import-time side effects, and the CLI is the only entry
point. The folders group by role, not file kind — `core/` knows nothing about a
cask, `pipeline/` implements the descriptor-driven steps, `oracles/` resolves
upstream sources. Tests live in `tests/`, mirroring those groups.

The oracles share one download path (`oracles/download.ts`) and one GitHub API
client (`oracles/github-api.ts`), so a resolver only supplies its URL, expected
content and hosts. Shared regexes, the arch table and name templating live in
`core/`.

## Pipeline stages

`lib/shell/build-appimage.sh <app>` runs:

1. **init** — load and validate the descriptor, resolve the architecture
   (`TARGET_ARCH` → `amd64`/`arm64` + the AppImage arch), set up the scratch and
   AppDir directories with path guards.
2. **resolve** — `fbr resolve` asks the app's oracle for the upstream version,
   payload URL, size and SHA-256, and writes `metadata.json`.
3. **extract** — `dpkg-deb -x` for `.deb` payloads (with an arch assertion), or
   the upstream AppImage's own `--appimage-extract` (no FUSE needed).
4. **stage** — descriptor-driven staging into `AppDir/bin` (a payload tree, a
   list of binaries, or an AppImage tree with renames/excludes).
5. **neutralize** — `fbr neutralize` disables the app's own updater, then
   asserts no updater endpoint survived.
6. **render + icon** — `fbr render-desktop` (literal substitution, no `sed`) and
   the descriptor's icon into the hicolor tree.
7. **pack** — `quick-sharun` (generates AppRun, bundles the runtime closure
   including glibc and ld-linux), sidecar reconciliation, `fbr finalize` (AppDir
   `.env` + runtime hook), pkgforge `appimagetool`, then the smoke test.

## Descriptor

`apps/<app>/app.json` is the single source of truth. `<app>` is the app id and
must equal `id`, `cask` and `assetPrefix` — one name end to end.

| Field | Meaning |
| --- | --- |
| `id`, `cask`, `assetPrefix`, `tagPrefix` | Identity. The three names above are the same string; the release tag is `<tagPrefix><version>`. |
| `appName`, `displayName`, `comment` | Release title and desktop entry `Name=`/`Comment=`. |
| `sourceRepo`, `sourceOwner` | Upstream repo to build from, and the owner of the fallback fork. |
| `sourceDir`, `buildCommand` | Where CI `cd`s before building. |
| `debloatArgs`, `needsWebkit` | pkgforge debloat flags; whether the webkit2gtk/GTK build deps are needed. |
| `architectures` | Arches this app ships; the pipeline builds, publishes and checks only these. |
| `binaryTargets` | Names the cask must expose on `PATH` (checked by `fbr cask --action check`). |
| `oracle` | Where the version and payload come from. |
| `payload` | How the upstream package is staged into `AppDir/bin`. |
| `icon` | Icon path in the payload plus its hicolor size directory. |
| `desktopTemplate` | Desktop entry template, relative to the app dir. |
| `updater` | Updater neutralization: JSON key removal, endpoint patch, feed removal, `.env`, runtime hook, residual scan. |
| `quickSharun` | quick-sharun knobs exported as env vars: `hooks` (`ADD_HOOKS`) and `env`. |
| `hostHelpers` | Optional AppDir paths under `bin/` the app executes outside the mount. Stashed before quick-sharun and restored after, so they stay host-runnable instead of becoming sharun wrappers. |
| `watch` | Optional release-watch block (`feedUrl`, `format`, `versionPattern`, optional `skipPattern`, `repo`, and `versionField` for `"json"`). `format` — `"atom"` or `"json"` — must be declared: the API's reader still defaults an absent one to atom, but this validator does not, so a forgotten format fails here instead of silently watching the wrong reader. The pattern matches the feed entry *title* (the GitHub release name, not the tag) and capture group 1 is the version; for `"json"` it matches the `versionField` value (a dotted path, e.g. `version`) instead, reading a single version string from a JSON document for upstreams like avakot that publish no feed. |

### Oracle kinds

| Kind | Version and payload source |
| --- | --- |
| `apt` | Signed apt repo: pinned key → `InRelease` (verified with `gpgv` against a pinned fingerprint) → `Packages` SHA-256 → package SHA-256/size. Newest entry per architecture wins, by dpkg ordering. |
| `github-release` | GitHub release assets. Legacy: newest release carrying both `<assetPrefix>-<arch>.deb`. Versioned-asset: pins a tag prefix plus an `assetNameTemplate` and resolves each shipped architecture separately. A `.AppImage` asset additionally cross-checks the release's electron-builder update yml (SHA-512 + size) before downloading. |
| `electron-feed` | An electron-updater feed whose 302 names the release tag. The yml supplies filename, SHA-512 and size; the GitHub API supplies the SHA-256. All three must agree. |
| `cdn-redirect` | A CDN download redirect that is itself the version source. The target URL shape is pinned and the payload is hashed on download (the CDN publishes no checksums). |
| `update-manifest` | A pinned https JSON manifest that publishes the version and per-asset SHA-256/size. The `assetTemplate` entry (`{arch}` substituted) must carry the version as a download-path segment on a pinned host. |
| `avakot` (in `custom/`) | Provider-specific manifest oracle: avakot's `manifest.json` serves an `artifacts` map with a fixed entry name, static download URLs and no published size. The version binds through the per-entry `version` field and the payload is measured from the verified download (downloaded and discarded in `--metadata-only` mode). |

## `fbr` CLI

```
fbr list-apps [--json]                       app ids
fbr resolve-app --name X                     app name -> app id
fbr descriptor --app X [--field a.b]         validated descriptor (or one field)
fbr descriptor-env --app X [--format env|output]
                                             KEY=VALUE lines for $GITHUB_ENV/$GITHUB_OUTPUT
fbr resolve --app X --arch A ...             resolve upstream metadata
fbr metadata --file F --field version|sha256|url|path
fbr gate --app X --upstream-version V [--release-exists]
     [--release-matches-cask true|false]     cask gate decision; omit the match flag when
                                             the asset comparison could not run
fbr cask --action read|set-version|check     read, re-pin or check casks
fbr release-check --app X --asset-dir D      release assets vs the cask pin (true|false,
     [--tap T]                               or nothing when it could not compare)
fbr release-prune --prefix P --keep N TAGS   stale release versions to prune, oldest first
fbr release-notes --app X --asset-dir D      release-notes markdown
     [--upstream arch=SHA=URL]... [--output F]
fbr neutralize --app X --appdir D            disable the in-AppDir updater
fbr finalize --app X --appdir D              write .env and install the hook
fbr render-desktop --app X --version V --appdir D
fbr arch --arch S                            arch spelling -> "<deb-arch> <appimage-arch>"
fbr version-compare A B                      dpkg-equivalent comparison (-1|0|1)
fbr version-compare --sort A B [C ...]       dpkg-order a list ascending, one per line
```

Every command declares its flags: an unknown or duplicate flag is a usage error
(exit 2), never silently ignored.

## Verification model

Each check lives in one place:

- **Hosts** — every download validates protocol, host allow-list and redirect
  target. GitHub asset hosts come from one shared list, so an oracle cannot
  forget an edge host.
- **Content** — size caps, SHA-256 for apt/GitHub/CDN payloads, a SHA-512
  cross-check for the electron feed, constant-time digest comparison, atomic
  writes.
- **Freshness** — a signed apt index is rejected when its `Valid-Until` has
  passed or its `Date` is over 14 days old.
- **Paths** — metadata and key paths stay inside their output directory (or, for
  keys, inside the repo); descriptor paths are repo-relative.
- **Updaters** — descriptor-declared, then verified: the build fails when a
  declared endpoint survives in the AppDir.
- **Casks** — one parser reads `Casks/*.rb`; `fbr cask --action check` asserts
  the cask agrees with its descriptor (URL, asset name, binaries, icon size,
  desktop entry, zap paths).
- **The build** — `smoke_test_appimage` runs the AppImage headless and fails on
  dynamic-loader errors; the release pins the AppImage SHA-256 back into the cask.

## Adding an app

1. `apps/<app>/app.json` — copy a similar descriptor and adjust the oracle,
   payload, icon and updater sections.
2. `apps/<app>/templates/<name>.desktop`, plus a four-line `build.sh`
   (`exec ../../lib/shell/build-appimage.sh <app>`).
3. `Casks/<app>.rb` with zero placeholder checksums; the first publish fills
   them.

Nothing else — the build matrix and the dispatch route read the descriptor
directory.

## Build model

Builds run in `ghcr.io/pkgforge-dev/archlinux` (tag and digest pinned in
`build-appimage.yml`; Renovate bumps both). `linuxdeploy` was retired:
`quick-sharun` bundles the app's dynamic-linker closure **including glibc and
ld-linux**, so the AppImages have no host-libc dependency and run on musl,
non-FHS and old distros.

- The descriptor's `quickSharun` block is exported before `quick-sharun` runs,
  so a local `build.sh` behaves like CI. Every app deploys pkgforge's
  `fix-namespaces.hook` (offers to lift the unprivileged-userns restriction some
  distros impose). `OPTIMIZE_LAUNCH` stays off: appimagetool's DWARFS profiling
  pass relaunches the AppImage through `/dev/fuse`, which the build container
  does not have, and the pass fails the build outright rather than skipping.
- `quick-sharun` hardlinks `sharun` over every nested `bin/` executable whose
  basename also lands in `shared/bin`. Only a wrapper directly under `bin/`
  resolves at runtime, so `pipeline_reconcile_sharun_sidecars` re-points nested
  wrappers at the working `bin/<name>` wrapper, then fails the build on any
  sharun hardlink outside the legal slots.
- Helpers the app executes outside the mount take a different path: the
  descriptor's `hostHelpers` lists `bin/`-relative files that are stashed before
  `quick-sharun` and restored after, with auto-created `bin/<name>` wrappers
  and their `shared/bin/<name>` duplicates removed. A sharun wrapper cannot run
  outside the mount (it resolves `shared/bin` from its own location), so
  without this an app that copies a helper out at runtime — opencode-desktop
  staging `bin/resources/opencode-cli` to userData — ships a helper that dies
  with `Interpreter not found!`.
- Three things stay in this pipeline rather than delegating to `quick-sharun`:
  updater neutralization, the smoke gate (run against the packed AppImage), and
  the `appimagetool` invocation (so no zsync updater feed is embedded).
- The workflow installs webkit2gtk/GTK (+ X11 libs, mirroring upstream
  `webkit2gtk4-demo-appimage.sh`) only for apps with `needsWebkit`
  (gitbutler); the other build deps are installed for every app. Gitbutler
  debloats with `--add-common --prefer-nano webkit2gtk-4.1-mini` and exports
  `GTK_CLASS_FIX=1`.

`scripts/install-anylinux-tools.sh` fetches `quick-sharun` and
`get-debloated-pkgs` from a URL addressed by a commit digest of
pkgforge-dev/Anylinux-AppImages, so one Renovate pin fixes the exact bytes of
both — including what `quick-sharun` downloads for itself at build time. Only
`appimagetool` is overridden, by the workflow's own pinned build.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.137.0 packaging/apps/vscode/build.sh
```

`PACKAGE_VERSION` is optional: unset, it comes from the resolved metadata; set,
the build fails if the resolved version differs (CI always sets it). Requires an
Arch Linux system (or the pkgforge container), `bun` ≥ 1.4, `jq`, the app's own
tooling (`dpkg-deb`, `gpg`/`gpgv`), `quick-sharun` in `PATH` and `APPIMAGETOOL`
pointing at the uruntime `appimagetool`. Output lands in `<tap>/dist/`.

## Dependency pinning

Renovate opens one reviewed PR per dependency (automerge off):

| Dependency | Declared in | Manager |
| --- | --- | --- |
| `typescript`, `@types/bun` | `package.json` | npm + bun (exact pins, no `^`) |
| GitHub Actions | workflow `uses:` | github-actions (SHA re-pinned) |
| Container images | workflow `container:` | docker |
| Runner labels | `runs-on:` | github-runner |
| Bun version | `bun-version:` | uses-with |
| actionlint, pkgforge `appimagetool` | workflows | regex custom managers |
| `quick-sharun`, `get-debloated-pkgs` | `install-anylinux-tools.sh` | git-refs custom manager |

Casks are not Renovate's: versions and checksums are produced by this pipeline
through `fbr cask`.

Two pins carry a local SHA-256 Renovate cannot recompute — actionlint's tarball
and appimagetool's per-arch binaries. The version bump still arrives as a PR; the
build then fails printing the hash it measured, so the fix is a copy-paste in
that PR. `typescript` stays on 6.x and `@types/bun` on the CI's Bun minor, both
via `renovate.json` rules.

## Tests and gates

`bun test` runs the unit suite (Bun's runner over `node:test`; no test
dependencies): dpkg ordering, deb822/InRelease parsing and freshness, HTTP
retry/cap/atomic write, guards and metadata validation, descriptor validation,
cask read/update/consistency, the gate table, updater neutralization, desktop
rendering, and the oracle parsers.

`bun run typecheck` runs `tsc --noEmit` (strict). `scripts/check-style.sh` runs
the full local gate — shellcheck, typecheck, tests, cask check, brew
style/audit, actionlint — the same set CI runs per PR.
