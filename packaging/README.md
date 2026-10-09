# AppImage packaging

Build tooling for this tap's AppImage casks. One pipeline serves every app:
what differs between apps is **data** (`apps/<app>/app.json`), not a forked
script.

The TypeScript runs directly on Node — native type stripping, no build step,
no runtime dependencies. `typescript` and `@types/node` are dev-only (for
`tsc --noEmit` and editors).

The redesign of this toolchain is [`REDESIGN.md`](REDESIGN.md): phases 0–1
(the v2 and manifest schemas, the pinned builder image) are live, while the
descriptor v2 migration and the `plan`/`build`/`publish`/`cask render` commands
are not. This file describes what runs today.

## Layout

```
packaging/
  apps/<app>/app.json      descriptor: the single source of truth for one app
  apps/<app>/build.sh      shim -> lib/shell/build-appimage.sh <app>
  apps/<app>/templates/    desktop entry (+ runtime hook)
  apps/<app>/assets/       pinned signing key material
  bin/fbr.ts               the CLI
  builder/Dockerfile       the pinned Arch builder image
  builder/pins.json        the image refs the build workflow reads
  lib/cli.ts               CLI composition root
  lib/core/                primitives: paths, types, guards, patterns, version,
                           architecture, template, http, deb822, metadata
  lib/pipeline/            descriptor-driven steps: descriptor, cask, gate, watch,
                           release, neutralize, render, report
  lib/oracles/             one module per upstream source kind; custom/ holds
                           provider-specific oracles (e.g. avakot)
  lib/schema/              JSON Schema subset validator (descriptor v2, manifest)
  lib/shell/               the bash pipeline
  schema/                  descriptor v2 and manifest JSON Schemas, with examples
  tests/                   unit suite, mirrors lib/  (node --test)
  scripts/                 repo tooling (tool installer, local style gate)
```

`lib/` is a library: no import-time side effects, and the CLI is the only entry
point. The folders group by role, not file kind — `core/` knows nothing about a
cask, `pipeline/` implements the descriptor-driven steps, `oracles/` resolves
upstream sources, `schema/` validates documents. Tests live in `tests/`,
mirroring those groups.

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
must equal `id`, `cask` and `assetPrefix` — one name end to end. An app id is
the API's app id too: lowercase alphanumeric or `-`, starting with an
alphanumeric, at most 64 characters (`^[a-z0-9][a-z0-9-]{0,63}$`). The API's
discovery skips app directories that do not match, and it answers 422 for a run
record whose `app` does not — `fbr report` refuses such a record first.

| Field | Meaning |
| --- | --- |
| `id`, `cask`, `assetPrefix`, `tagPrefix` | Identity. The three names above are the same string; the release tag is `<tagPrefix><version>`. |
| `appName`, `displayName`, `comment` | Release title and desktop entry `Name=`/`Comment=`. |
| `sourceRepo`, `sourceOwner` | Upstream repo to build from, and the owner of the fallback fork. |
| `sourceDir`, `buildCommand` | Where CI `cd`s before building. |
| `debloatArgs` | pkgforge debloat flags. |
| `buildPackages` | Arch packages CI installs into the build container for this app, beyond the shared toolchain — for libraries that must exist at pack time, e.g. one named in `quickSharun.libraries`. |
| `architectures` | Arches this app ships; the pipeline builds, publishes and checks only these. |
| `binaryTargets` | Names the cask must expose on `PATH` (checked by `fbr cask --action check`). |
| `oracle` | Where the version and payload come from. |
| `payload` | How the upstream package is staged into `AppDir/bin`. |
| `icon` | Icon path in the payload plus its hicolor directory: a `WxH` size for a raster icon, or `scalable` for an SVG. The staged icon keeps the payload file's extension. |
| `desktopTemplate` | Desktop entry template, relative to the app dir. |
| `updater` | Updater neutralization: JSON key removal, endpoint patch, feed removal, `.env`, runtime hook, residual scan. |
| `quickSharun` | quick-sharun knobs: `hooks` (`ADD_HOOKS`), `env`, and `libraries` — absolute paths of libraries the app only `dlopen`s at runtime, passed to quick-sharun as deploy targets (an `ldd` scan never surfaces those, so nothing else would bundle them). |
| `hostHelpers` | Optional AppDir paths under `bin/` the app executes outside the mount. Stashed before quick-sharun and restored after, so they stay host-runnable instead of becoming sharun wrappers. |
| `extraFiles` | Optional `{source, target}` pairs copied verbatim from the app directory into the AppDir after quick-sharun, e.g. Firefox's default prefs under `bin/defaults/pref/`. `target` is AppDir-relative and unique; an existing target whose bytes differ fails the build instead of overwriting the payload. |
| `watch` | Optional release-watch block (`feedUrl`, `format`, `versionPattern`, optional `skipPattern`, `repo`, and `versionField` for `"json"`). `format` — `"atom"` or `"json"` — must be declared: the API's reader still defaults an absent one to atom, but this validator does not, so a forgotten format fails here instead of silently watching the wrong reader. The pattern matches the feed entry *title* (the GitHub release name, not the tag) and capture group 1 is the version; for `"json"` it matches the `versionField` value (a dotted path, e.g. `version`) instead, reading a single version string from a JSON document for upstreams like avakot that publish no feed. |

### Oracle kinds

| Kind | Version and payload source |
| --- | --- |
| `apt` | Signed apt repo: pinned key → `InRelease` (verified with `gpgv` against a pinned fingerprint) → `Packages` SHA-256 → package SHA-256/size. Newest entry per architecture wins, by dpkg ordering. Reads the `stable` suite unless the descriptor pins `suite` (Mozilla serves `dists/mozilla`), and strips Mozilla's `~buildN` rebuild marker from the cask version so it matches the release feed. |
| `github-release` | GitHub release assets. Legacy: newest release carrying both `<assetPrefix>-<arch>.deb`. Versioned-asset: pins a tag prefix plus an `assetNameTemplate` and resolves each shipped architecture separately. A `.AppImage` asset additionally cross-checks the release's electron-builder update yml (SHA-512 + size) before downloading. |
| `electron-feed` | An electron-updater feed whose 302 names the release tag. The yml supplies filename, SHA-512 and size; the GitHub API supplies the SHA-256. All three must agree. |
| `cdn-redirect` | A CDN download redirect that is itself the version source. The target URL shape is pinned and the payload is hashed on download (the CDN publishes no checksums). No app currently consumes it; it is validated and tested as infrastructure for a future CDN-sourced app. |
| `update-manifest` | A pinned https JSON manifest that publishes the version and per-asset SHA-256/size. The `assetTemplate` entry (`{arch}` substituted) must carry the version as a download-path segment on a pinned host. |
| `avakot` (in `custom/`) | Provider-specific manifest oracle: avakot's `manifest.json` serves an `artifacts` map with a fixed entry name, static download URLs and no published size. The version binds through the per-entry `version` field and the payload is measured from the verified download (downloaded and discarded in `--metadata-only` mode). |

## `fbr` CLI

```
fbr list-apps [--json]                       app ids
fbr resolve-app --name X                     app name -> app id
fbr descriptor --app X [--field a.b]         validated descriptor (or one field)
fbr descriptor-env --app X [--format env|output]
                                             KEY=VALUE lines for $GITHUB_ENV/$GITHUB_OUTPUT
fbr resolve --app X --arch A --output-dir D --metadata F
     [--metadata-only] [--failure-out F]     resolve upstream metadata; a classified
                                             failure writes its verdict to F
fbr metadata --file F --field version|sha256|url|path
fbr gate --app X --upstream-version V [--requested-version V]
     [--release-exists] [--release-matches-cask true|false] [--tap T]
                                             cask gate decision; omit the match flag when
                                             the asset comparison could not run; a
                                             requested version newer than upstream is a
                                             not-ready skip
fbr feed-version --app X [--tap T]           newest version the release feed advertises,
                                             as feed_version= (advisory; recorded in the
                                             run record, nothing waits on it)
fbr report --app X --phase P --stage S --message M --run-id N
     --run-attempt A --output F [--code C] [--reason not-ready]
     [--event-id UUID] [--request-id ID] [--public-output F]
     [--resolved-version V] [--cask-version V] [--feed-version V]
     [--evidence k=v]...                     write the machine-readable run record the API
                                             reads; --phase is accepted|succeeded|failed|
                                             skipped, --event-id defaults to a fresh UUID,
                                             and --public-output is the artifact copy with
                                             request_id redacted
fbr retry-plan --reports-dir D --attempt N
     --conclusion S                          decide from a completed run's failed records
                                             whether the CI re-runs it; prints the plan
                                             JSON the retry workflow executes
fbr cask --action read|set-version|check     read, re-pin or check casks
     [--app X] [--tap T] [--version V]       set-version takes --version plus the
     [--sha256-x86-64 H] [--sha256-arm-64 H] checksum of each architecture the
                                             descriptor ships
fbr release-check --app X --asset-dir D      release assets vs the cask pin (true|false,
     [--tap T]                               or nothing when it could not compare)
fbr release-prune --prefix P --keep N TAGS   stale release versions to prune, oldest first
fbr release-notes --app X --asset-dir D      release-notes markdown
     [--upstream arch=SHA=URL]... [--output F]
fbr neutralize --app X --appdir D [--failure-out F]
                                             disable the in-AppDir updater; a surviving
                                             endpoint is classified as UPDATER_RESIDUAL
fbr finalize --app X --appdir D              write .env and install the hook
fbr render-desktop --app X --version V --appdir D
fbr arch --arch S                            arch spelling -> "<deb-arch> <appimage-arch>"
fbr version-compare A B                      dpkg-equivalent comparison (-1|0|1)
fbr version-compare --sort A B [C ...]       dpkg-order a list ascending, one per line
```

Every command declares its flags: an unknown or duplicate flag is a usage error
(exit 2), never silently ignored. A classified failure exits 3 (upstream
unavailable), 4 (guard violation), 5 (checksum mismatch) or 6 (updater
residual) and, when the caller passed `--failure-out`, leaves the run-record
fragment there. Every other failure exits 1, which the record reports as
UNCLASSIFIED.

## The run record

Each build answers with one JSON record per app and phase. The workflow POSTs
the full record, OIDC-authenticated, to the API's `/v1/homebrew/tap/events`
endpoint (written by `fbr report`); the concluding `succeeded`/`failed`/
`skipped` record is also uploaded as a public `run-report-<app>` artifact, the
input `retry.yml` reads. The phases are the API's contract: `accepted` goes out
from the plan job before planning can fail (this is how the API binds the
attempt to the run), and `succeeded`/`failed`/`skipped` conclude it from the
report job. A cask-only repair reports `succeeded`: the API treats the observed
cask pin as the truth. The record also carries `run_attempt`, `stage`, `class`,
`retryable` and `retry_after_seconds` for the CI's own retry decision; the API
ignores them. There is no `schema` field.

`request_id` is the API's correlation id for the dispatch that caused the run
(null for manual runs); it stays in the POSTed record, is redacted to null in
the artifact, and is never traced into logs. `event_id` is a UUID, fresh per
report and stable across delivery retries: delivery lives in
`.github/actions/deliver-report`, which fetches a fresh GitHub OIDC token
(audience `api.edgarcnp.dev`) for every attempt — a token may deliver one body
— and retries 429/5xx with the same body while 401, 413, 415 and 422 are
permanent. The API accepts tokens only from `refs/heads/main`,
`workflow_dispatch` runs of `dispatch.yml`, `build.yml` or `build-appimage.yml`.

A manual run has no request id, so it uploads its artifact but stays out of the
API's inbox. A dispatched run resolves the version the API asked for; when the
upstream has not published that artifact yet, the gate reports a `skipped`
record with typed `reason: not-ready` (the human `message` also names it), and
the API asks again later. The tap does not re-run skips: `retry.yml` consumes
the public copy and `fbr retry-plan` decides only on failed records, from the
record's own verdict:

- `phase`/`stage`/`code` — what happened, where, and why. `code` carries its
  own verdict (`class`, `retryable`, `retry_after_seconds`), so the retry plan
  needs no table from this repository. A `skipped` record may carry the typed
  `reason: not-ready`; the API reads that field to wait and ask again, never the
  human message.
- `evidence` — what the transport said, e.g. `http_status`,
  `retry_after_seconds`, `reason`, `rate_limited` on a transient failure. A
  value is one line of at most 256 bytes, and the serialized map at most 4096
  bytes; the API rejects a record beyond either bound, so `fbr report` and the
  failure-fragment writer refuse it first. The message is clamped at 2 KiB with
  a truncation marker, so an over-long one never costs the record; the whole
  body is capped at 64 KiB.
- `resolved_version` / `cask_version` / `feed_version` — the three versions the
  record reports; a not-ready skip names what resolve actually saw.

A failure site writes a fragment (`{"code","message","stage"?,"evidence"?}`)
before exiting; the report job uploads the fragments and prefers the site's
verdict over its job-level fallback. An absent record means the run died before
the report job could start (runner loss, cancellation), which is
infrastructure, not a verdict — and the one failure `retry.yml` re-runs without
a classification. The retry budget is `MAX_ATTEMPTS` in `lib/pipeline/retry.ts`
(initial run plus one re-run), and a record's `retry_after_seconds` paces the
next attempt, capped.

## Verification model

Each check lives in one place:

- **Hosts** — every download validates the final URL's protocol and host
  against a pinned allow-list (intermediate redirect hops are not inspected; the
  runtime follows the chain). GitHub asset hosts come from one shared list, so
  an oracle cannot forget an edge host.
- **Content** — size caps, SHA-256 for apt/GitHub/CDN payloads, a SHA-512
  cross-check for the electron feed, constant-time digest comparison, atomic
  writes.
- **Freshness** — a signed apt index is rejected when its `Valid-Until` has
  passed or its `Date` is over 14 days old.
- **Paths** — metadata and key paths stay inside their output directory (or, for
  keys, inside the repo); descriptor paths are repo-relative.
- **Updaters** — descriptor-declared, then verified: a survivor declared
  `severity: error` fails the build, while a `warning` scan records it instead
  (opencode-desktop and wfhelper intentionally leave inert copies behind).
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

Builds run in the pinned base builder image (`packaging/builder/Dockerfile`):
`ghcr.io/edgarcnp/fbr-builder-base`, one Arch environment carrying the shared
toolchain. Pack-time libraries an app needs beyond it are declared in the
descriptor's `buildPackages` and installed by the build job. The builder
workflow rebuilds the image and its `pin` job commits the new tag+digest into
`packaging/builder/pins.json`, which the build job reads for its container, so
the reference cannot drift from the image. The build job then upgrades the
container (`pacman -Syu`) before installing anything: the image's package
database is frozen at build time while mirrors keep only the current package
files, so dependency resolution follows the live repos between image rebuilds.
`linuxdeploy` was retired:
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
  basename also lands in `shared/bin`, and over `lib/` executables deployed
  via `ADD_DIR` (the webkit2gtk helpers in `lib/webkit2gtk-4.1`). Only a
  wrapper directly under `bin/` resolves at runtime, so
  `pipeline_reconcile_sharun_sidecars` re-points nested and `lib/` wrappers at
  the working `bin/<name>` wrapper, then fails the build on any sharun
  hardlink outside the legal slots.
- Helpers the app executes outside the mount take a different path: the
  descriptor's `hostHelpers` lists `bin/`-relative files that are stashed before
  `quick-sharun` and restored after, with auto-created `bin/<name>` wrappers
  and their `shared/bin/<name>` duplicates removed. A sharun wrapper cannot run
  outside the mount (it resolves `shared/bin` from its own location), so
  without this an app that copies a helper out at runtime — opencode-desktop
  staging `bin/resources/opencode-cli` to userData — ships a helper that dies
  with `Interpreter not found!`.
- A staged payload tree can keep its libraries beside its binaries (Firefox's
  `usr/lib/firefox` does, and those libraries carry no `$ORIGIN` rpath). The
  pack stage runs `quick-sharun` with `LD_LIBRARY_PATH=<AppDir>/bin` for exactly
  that call, so the closure scan resolves the siblings instead of aborting on
  "missing libraries".
- Three things stay in this pipeline rather than delegating to `quick-sharun`:
  updater neutralization, the smoke gate (run against the packed AppImage), and
  the `appimagetool` invocation (so no zsync updater feed is embedded).
- Pack-time-only libraries come from `buildPackages`: little-genius installs
  the webkit2gtk/GTK closure (+ X11 libs, mirroring upstream
  `webkit2gtk4-demo-appimage.sh`) plus `libayatana-appindicator`, then debloats
  with `--add-common --prefer-nano webkit2gtk-4.1-mini gdk-pixbuf2-mini`.
- Apps whose AppImage bundles the GTK stack (Electron, Firefox and WebKitGTK)
  request the debloated `gdk-pixbuf2-mini` alongside `--add-common`: the
  debloated `glycin-mini` asset is glycin-ng, which lags Arch's `gdk-pixbuf2`
  (the 2.44.8 build calls glycin 2.2 API that glycin-ng lacks, and the packed
  AppImage then fails the smoke gate with `undefined symbol:
  gly_pixel_density_new`). The mini gdk-pixbuf is built without glycin and
  decodes through its built-in loaders.

`scripts/install-anylinux-tools.sh` fetches `quick-sharun` and
`get-debloated-pkgs` from a URL addressed by a commit digest of
pkgforge-dev/Anylinux-AppImages, so one Renovate pin fixes the exact bytes of
both — including what `quick-sharun` downloads for itself at build time. Only
`appimagetool` is overridden, by the builder image's pinned build.

## Local run

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.137.0 packaging/apps/vscode/build.sh
```

`PACKAGE_VERSION` is optional: unset, it comes from the resolved metadata; set,
the build fails if the resolved version differs (CI always sets it). Requires an
Arch Linux system — the builder image (`packaging/builder/Dockerfile`) is the
supported one — plus `node` ≥ 24.17, `jq`, the app's own tooling (`dpkg-deb`,
`gpg`/`gpgv`), `quick-sharun` in `PATH` and `APPIMAGETOOL` pointing at the
uruntime `appimagetool`. Output lands in `<tap>/dist/`.

## Dependency pinning

Renovate opens one reviewed PR per dependency (automerge off), with the
grouped rules in `renovate.json` for routine bumps:

| Dependency | Declared in | Manager |
| --- | --- | --- |
| `typescript`, `@types/node` | `package.json` | npm (exact pins, no `^`) |
| GitHub Actions | workflow `uses:` | github-actions (SHA re-pinned) |
| `Homebrew/actions` | workflow `uses:` (SHA plus CalVer comment) | regex custom manager (the built-in manager truncates the four-part CalVer tag) |
| Container images | workflow `container:`, including the nested matrix image, and the builder Dockerfile's `FROM` | docker (regex for the matrix) |
| Builder image (`fbr-builder-base`) | `packaging/builder/pins.json` | pinned by the builder workflow's `pin` job, not Renovate |
| Runner labels | `runs-on:`, and the labels the build matrix bakes in | github-runners (regex for the matrix) |
| Node version | `engines.node`, `node-version:`, the builder Dockerfile | npm, github-actions, regex custom manager |
| pnpm version | `packageManager`, `version:` in pnpm/action-setup | npm, github-actions |
| actionlint, pkgforge `appimagetool` | workflow (actionlint), builder Dockerfile (appimagetool) | regex custom managers |
| `quick-sharun`, `get-debloated-pkgs` | `install-anylinux-tools.sh` | git-refs custom manager |

Casks are not Renovate's: versions and checksums are produced by this pipeline
through `fbr cask`.

No tool carries a local SHA-256 for Renovate to trip over: `actionlint` and
pkgforge `appimagetool` are downloaded from a URL addressed by the version
Renovate bumps, so a version PR needs no hand-edited pin — both trust whatever
GitHub serves over HTTPS (pkgforge publishes only b3sum sidecars, served from
the same release as the binary, so they would add no trust). `typescript` stays
on 6.x and `@types/node` on the runtime's major line, both via `renovate.json`
rules.

## Tests and gates

`pnpm test` runs the unit suite (Node's built-in runner over `node:test`; no
test dependencies): dpkg ordering, deb822/InRelease parsing and freshness, HTTP
timeout/cap/atomic write, guards and metadata validation, descriptor validation,
cask read/update/consistency, the gate table, updater neutralization, desktop
rendering, run records, retry plans, the oracle parsers, and the descriptor
v2/manifest schema contracts.

`pnpm run typecheck` runs `tsc --noEmit` (strict). `pnpm run style` runs
`brew style edgarcnp/tap` on its own — RuboCop plus shellcheck, shfmt and
actionlint — the fast subset to run before every commit and push.
`scripts/check-style.sh` runs the full local gate — shellcheck, typecheck,
tests, cask check, brew style/audit, actionlint — the same set CI runs per PR.
