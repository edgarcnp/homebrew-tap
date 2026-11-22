# AppImage packaging

Build tooling for this tap's AppImage casks. One pipeline serves every app:
what differs between apps is **data** (`apps/<app>/app.json`), not a forked
script.

The TypeScript runs directly on Bun — no build step. The descriptor schema is
plain **Zod**, so `bun install` is required and the CLI runs directly as
`packaging/bin/fbr.ts`. `zod` is the runtime dependency; `typescript` and
`@types/node` are dev-only.

## Layout

```
packaging/
  apps/<app>/app.json      descriptor: the single source of truth for one app
  apps/<app>/build.sh      shim -> lib/shell/build-appimage.sh <app>
  apps/<app>/templates/    desktop entry (+ runtime hook)
  apps/<app>/assets/       pinned signing key material
  bin/fbr.ts               the CLI entry point
  builder/Dockerfile       the pinned Arch builder image
  builder/pins.json        the image refs the build workflow reads
  lib/cli.ts               CLI composition root
  lib/core/                primitives: paths, guards, patterns, version,
                           architecture, template, http, metadata
  lib/descriptor/          app.json Zod schemas (and inferred types),
                           validation, loading and the CI projection
  lib/pipeline/            descriptor-driven steps: cask, gate, release,
                           neutralize, render, report, retry
  lib/advisories/          one module per artifact kind; custom/ holds
                           provider-specific artifacts (e.g. avakot)
  lib/shell/               the bash pipeline
  tests/                   unit suite, mirrors lib/  (bun test)
  scripts/                 repo tooling (tool installer, local style gate)
```

`lib/` is a library: no import-time side effects, and the CLI is the only
process entry point. The folders group by role, not file kind — `core/` knows
nothing about a cask, `descriptor/` owns the app.json schema and its
invariants, `pipeline/` implements the descriptor-driven steps, `advisories/`
resolves upstream sources. Tests live in `tests/`, mirroring those groups.

`packaging/lib/descriptor/app.ts` is the single source of truth for the
descriptor: its Zod schema **is** both the validator and the source of the
`AppDescriptorInput` type. `validate.ts` runs `appDescriptorSchema.safeParse`
for the shape (including unknown-field rejection) and then a semantic pass for
path containment, cross-field identity, artifact/payload compatibility and the
single-line rules. `fbr descriptor-schema` renders that same schema as JSON
Schema for editors.

The artifact resolvers share one download path (`advisories/download.ts`) and
one GitHub API client (`advisories/github-api.ts`), so a resolver only supplies
its URL, expected content and hosts. Shared regexes, the arch table and name
templating live in `core/`. `watch` lives only in the descriptor: the API reads
it for the version, and the tap never resolves "the newest".

## Pipeline stages

`lib/shell/build-appimage.sh <app>` runs:

1. **init** — load and validate the descriptor, resolve the architecture
   (`TARGET_ARCH` → `amd64`/`arm64` + the AppImage arch), set up the scratch and
   AppDir directories with path guards.
2. **resolve** — `fbr resolve` asks the app's artifact for the **requested
   version's** payload URL, size and SHA-256, and writes `metadata.json`. The
   requested version is the API's dispatched version, or the cask pin for a
   manual run; a missing artifact is a typed not-ready (CLI exit 8), not a
   fallback to another release.
3. **extract** — `dpkg-deb -x` for `.deb` payloads (with an arch assertion), the
   upstream AppImage's own `--appimage-extract` (no FUSE needed), or `tar` for
   an application tarball (`.tar.gz`, `.tar.xz`).
4. **stage** — descriptor-driven staging into `AppDir/bin` (a payload tree, a
   list of binaries, an AppImage tree with renames/excludes, or a tarball's
   `root`/`target`).
5. **neutralize** — `fbr neutralize` disables the app's own updater, then
   asserts no updater endpoint survived.
6. **render + icon** — `fbr render-desktop` (literal substitution, no `sed`)
   writes the entry at the AppDir root under the launcher name (`desktopId`,
   else the cask token) and the pipeline copies it to
   `share/applications/<launcher>.desktop`; the descriptor's icon goes into the
   hicolor tree. The root name is the one that reaches a user: Homebrew's
   `app_image` artifact installs every root `*.desktop`, so a second name there
   is a second launcher.
7. **pack** — `quick-sharun` (generates AppRun, bundles the runtime closure
   including glibc and ld-linux), sidecar reconciliation, the bundled-loader
   shim for a bundle's `libexec/` binaries, `fbr finalize` (AppDir `.env` +
   runtime hook), the descriptor's `appDirLinks`, pkgforge `appimagetool`, the
   desktop-entry gate (the packed image's root must carry
   `<launcher>.desktop` and nothing else), then the smoke test. A closure that
   needs a soname the build environment does not carry aborts as
   `MISSING_PAYLOAD_LIB`, and the record names the sonames it could not resolve.

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
| `desktopId` | Launcher name, for an app whose generic name is already taken on a user's desktop — Orca the IDE would otherwise ship `orca.desktop` and `orca.png` beside the GNOME Orca screen reader's. Names the entry at the AppDir root, its copy under `share/applications`, the entry the cask installs, and the icon. The root name is what a user ends up with: Homebrew's `app_image` artifact installs every root `*.desktop` it finds, so a root entry named after the cask token would land beside the cask's own and give the app two launchers; the pack stage fails on the disagreement. A renamed launcher also makes the cask remove the pre-rename entry (`remove ".local/share/applications/<cask>.desktop"`), which earlier casks wrote and an image packed before the rename still installs. The icon file inside the AppImage keeps the cask token, because the cask copies that name out of the published asset. Absent means the cask token. |
| `sourceRepo`, `sourceOwner` | Upstream repo to build from, and the owner of the fallback fork. |
| `sourceDir`, `buildCommand` | Where CI `cd`s before building. `sourceDir` must be `packaging/apps/<app>`: the app id, directory, cask token and asset prefix are one name end to end. |
| `debloatArgs` | pkgforge debloat flags. |
| `buildPackages` | Arch packages CI installs into the build container for this app, beyond the shared toolchain — for libraries that must exist at pack time, e.g. one named in `quickSharun.libraries`. |
| `architectures` | Arches this app ships; the pipeline builds, publishes and checks only these. |
| `binaryTargets` | Names the cask must expose on `PATH` (checked by `fbr cask --action check`). |
| `artifact` | Where the **requested version's** payload comes from: `github-release`, `json-asset`, `mozilla-release`, `update-manifest` or `avakot`. `mozilla-release` requires a `tarball-tree` payload; `update-manifest` and `avakot` require `deb-tree`/`deb-files`; a `github-release` asset template must end in `.deb` (deb payload), `.AppImage` (appimage-tree) or `.tar.gz`/`.tar.xz` (tarball-tree). The old `advisory` alias is removed. |
| `payload` | How the upstream package is staged. `deb-tree`/`deb-files` from a dpkg tree and `appimage-tree` entries go into `AppDir/bin`. `tarball-tree` stages a tarball tree either at the AppDir root (`target: "root"`, the default) so a bundle's own `bin/`, `libexec/`, `lib/` and `share/` keep the relative paths its binaries resolve (`$ORIGIN/../lib`, the CLI's `../libexec/zed-editor`), or into `AppDir/bin` (`target: "bin"`) for a flat application tarball. `root` names the directory inside the tarball; when absent, the tarball must contain exactly one top-level directory. `exclude` skips top-level names/globs while staging (ArtCraft skips its inert `share/` docs, whose text repeats the slug its updater scan rejects). |
| `icon` | Icon path plus its hicolor directory: a `WxH` size for a raster icon, or `scalable` for an SVG. `base: "payload"` (default) resolves the path inside the extracted payload; `base: "app"` resolves a repo-owned icon under the app directory (GitComet's tarball ships none). The staged icon keeps the source file's extension. |
| `desktopTemplate` | Desktop entry template, relative to the app dir. |
| `caskDesktopEntry` | Optional `{from, exec}`: instead of writing a generated entry, the cask rewrites the `Exec=` line of the desktop entry the payload ships and installs that file (Zed's `share/applications/dev.zed.Zed.desktop`), so `Name=`, `Comment=` and `Icon=` come from upstream. `from` is payload-relative; `exec` must be one `Exec=<command>` line. |
| `updater` | Updater neutralization: JSON key removal, endpoint patch, feed removal, `.env`, runtime hook, residual scan. |
| `quickSharun` | quick-sharun knobs: `hooks` (`ADD_HOOKS`), `env`, and `libraries` — absolute paths of libraries the app only `dlopen`s at runtime, passed to quick-sharun as deploy targets (an `ldd` scan never surfaces those, so nothing else would bundle them). |
| `hostHelpers` | Optional AppDir paths under `bin/` the app executes outside the mount. Stashed before quick-sharun and restored after, so they stay host-runnable instead of becoming sharun wrappers. |
| `extraFiles` | Optional `{source, target}` pairs copied verbatim from the app directory into the AppDir after quick-sharun, e.g. Firefox's default prefs under `bin/defaults/pref/`. `target` is AppDir-relative and unique; an existing target whose bytes differ fails the build instead of overwriting the payload. |
| `appDirLinks` | Optional `{link, target}` pairs creating relative symlinks in the finished AppDir before packing, for an app that resolves its own files beside the launcher at the extracted AppImage root: Orca's self-extraction asks for `resources/bin/<launcher>` there and its launcher then needs the executable beside `resources`, so the descriptor links `resources -> bin/resources` and `orca-ide -> bin/orca-ide`. Both paths are AppDir-relative, link paths are unique, and a missing target or an existing link path fails the build. |
| `smoke` | Optional post-build smoke-gate exceptions. `ignoreDefunct` names the `/proc/<pid>/comm` values a defunct descendant may carry without failing the gate (Orca's parcel watcher leaves a `sh` zombie); a known upstream leak only, never a stuck launcher. Loader errors and every other defunct child still fail. |
| `watch` | Optional release-watch block (`feedUrl`, `format`, `versionPattern`, optional `skipPattern`, `repo`, and `versionField` for `"json"`). `format` — `"atom"`, `"json"` or `"github-release"` — must be declared: the API's reader still defaults an absent one to atom, but this validator does not, so a forgotten format fails here instead of silently watching the wrong reader. The pattern matches the feed entry *title* and capture group 1 is the version: the atom entry title, the release `name` for `"github-release"` (falling back to `tag_name` when GitHub left the name empty — what the atom title carried), or the `versionField` value (a dotted path, e.g. `version`) for `"json"`, which reads a single version string from a JSON document for upstreams like avakot that publish no feed. A `"github-release"` feed must be the pinned `https://api.github.com/repos/<owner>/<repo>/releases` URL. The API reads this block for the version it dispatches; the tap never fetches it, so there is no feed-versus-artifact comparison. |

### Artifact kinds

The artifact is **declared**, never searched at runtime. The requested version
is the only version input: no resolver selects "the newest". The preference
order for choosing a declared artifact (tarball → `.deb` → `.rpm` →
`.AppImage`) applies when a descriptor is written, not to a build.

| Kind | Version and payload source |
| --- | --- |
| `github-release` | The release whose tag normalizes to the requested version, and the declared asset for the architecture. A `tagPrefix` plus `assetNameTemplate`; the template substitutes `{version}`, `{arch}` (amd64) and `{appimage_arch}` (x86_64), and must carry a placeholder. The asset's `digest` and `size` are required; a missing tag, asset or digest is not-ready. A `.AppImage` asset additionally cross-checks the release's electron-builder update yml (SHA-512 + size); every other container is verified by the release's published SHA-256. |
| `json-asset` | A pinned https update document (VS Code's `linux-x64` endpoint) naming the asset URL, SHA-256 and version at `urlField`, `sha256Field` and `versionField`. The document's version must equal the requested version; a missing digest is not-ready. The payload is downloaded, verified and measured. |
| `mozilla-release` | The release tarball at `urlTemplate` plus its detached `.asc` signature at `signatureTemplate` (e.g. `{url}.asc`). The signature is verified with `gpgv` against the pinned release key (`keyPath`, `fingerprint`) before SHA-256 and size are computed from the verified bytes. A missing tarball or signature, or a failed signature, is not-ready. No `.deb`, no package repository. |
| `update-manifest` | A pinned https JSON manifest publishing the version and per-asset SHA-256/size. The manifest's version must equal the requested version; the `assetTemplate` entry (`{arch}` substituted) must carry that version as a download-path segment on a pinned host. A mismatch, a missing entry or a missing digest is not-ready. |
| `avakot` (in `custom/`) | Provider-specific manifest: avakot's `manifest.json` serves an `artifacts` map with a fixed entry name, static download URLs and no published size. The manifest and per-entry versions must equal the requested version; the payload is measured from the verified download (downloaded and discarded in `--metadata-only` mode). A missing entry or digest is not-ready. |

## `fbr` CLI

```
fbr list-apps [--json]                       app ids
fbr resolve-app --name X                     app name -> app id
fbr descriptor --app X [--field a.b]         validated descriptor (or one field)
fbr descriptor-schema                        JSON Schema for app.json (editor validation)
fbr descriptor-env --app X [--format env|output]
                                             KEY=VALUE lines for $GITHUB_ENV/$GITHUB_OUTPUT
fbr resolve --app X --arch A --requested-version V
     --output-dir D --metadata F
     [--metadata-only] [--failure-out F]     resolve the requested version; a missing
                                             artifact exits 8 (not-ready), a classified
                                             failure writes its verdict to F
fbr metadata --file F --field version|sha256|url|path
fbr gate --app X --requested-version V [--artifact-version V]
     [--release-exists] [--tap T]            cask gate decision; omit --artifact-version
                                             when resolve was not-ready, and the gate
                                             reports the typed not-ready skip
fbr report --app X --phase P --stage S --message M --run-id N
     --run-attempt A --output F [--code C] [--reason not-ready]
     [--event-id UUID] [--request-id ID] [--public-output F]
     [--resolved-version V] [--cask-version V]
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
(exit 2), never silently ignored. A typed not-ready verdict exits 8 and writes
no failure fragment. A classified failure exits 3 (upstream unavailable), 4
(guard violation), 5 (checksum mismatch), 6 (updater residual) or 7 (upstream
conflict) and, when the caller passed `--failure-out`, leaves the run-record
fragment there. Every other failure exits 1, which the record reports
UNCLASSIFIED.

## The run record

Each build answers with one JSON record per app and phase. The workflow POSTs
the full record, OIDC-authenticated, to the API's `/v1/homebrew/tap/event`
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
API's inbox. A manual run with no requested version resolves the cask pin. A
dispatched run resolves the version the API asked for; when the vendor has not
published that artifact yet, resolve returns a typed not-ready and the gate
reports a `skipped` record with `reason: "not-ready"` (the human `message` also
names it), and the API asks again later. A not-ready is **never** `failed`, and
the tap never builds an older version instead. The tap does not re-run skips:
`retry.yml` consumes the public copy and `fbr retry-plan` decides only on failed
records, from the record's own verdict:

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
- `resolved_version` / `cask_version` — the resolved (requested) version and
  the cask pin.

A failure site writes a fragment (`{"code","message","stage"?,"evidence"?}`)
before exiting; the report job downloads the fragments and prefers the site's
verdict over its job-level fallback, logging the download's real outcome and
what landed on disk so a fragment that goes missing cannot change a verdict
without a trace. An absent record means the run died before
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
  an artifact resolver cannot forget an edge host.
- **Content** — size caps, a SHA-256 for every payload, a SHA-512 cross-check
  for the AppImage update yml, and a detached-signature verification for the
  Mozilla release tarball, with constant-time digest comparison and atomic
  writes. A payload with no digest is not-ready, never downloaded on trust.
- **Paths** — metadata and key paths stay inside their output directory (or, for
  keys, inside the repo); descriptor paths are repo-relative.
- **Updaters** — descriptor-declared, then verified: a survivor declared
  `severity: error` fails the build, while a `warning` scan records it instead
  (opencode-desktop and wfhelper intentionally leave inert copies behind).
- **Casks** — one parser reads `Casks/*.rb`; `fbr cask --action check` asserts
  the cask agrees with its descriptor (URL, asset name, binaries, icon size,
  desktop entry — written from the template, or patched from the payload when
  `caskDesktopEntry` is set — the pre-rename entry's removal when `desktopId`
  renames the launcher, and zap paths).
- **The build** — `smoke_test_appimage` runs the AppImage headless and fails on
  dynamic-loader errors and on a launcher left waiting on a defunct child (a
  child still unreaped after `SMOKE_DEFUNCT_SECONDS`, default 3, means the app
  never got past it — the way a host-glibc mismatch reaches the gate, because
  the dead child's stderr goes nowhere). A descriptor's `smoke.ignoreDefunct`
  skips a known upstream leak by process name; every other defunct child still
  fails. It passes `--no-sandbox` only to
  Chromium-based payloads: a native bundle rejects the flag and exits before it
  starts, which would make the gate vacuous. The release pins the AppImage
  SHA-256 back into the cask.
- **The installed launcher** — `cask-smoke.yml` installs every cask and runs
  `packaging/scripts/check-desktop-entries.sh`, which requires exactly one
  entry in the applications directory for that app: the artifact's entry and
  the cask's postflight entry must be the same file. The build gate asserts
  the root name; this one asserts what a user's desktop actually received.

## Adding an app

1. `apps/<app>/app.json` — copy a similar descriptor and adjust the artifact,
   payload, icon and updater sections.
2. `apps/<app>/templates/<name>.desktop`, plus a four-line `build.sh`
   (`exec ../../lib/shell/build-appimage.sh <app>`).
3. `Casks/<app>.rb` with `version "0.0.0"` and zero placeholder checksums; the
   first publish fills both. Never start the cask at the upstream head: the
   watcher dispatches only when the feed is newer than the pinned version, so
   a cask already at the feed version reads as up-to-date and its first build
   never runs. A manual first build must name the version explicitly
   (`requested_version` / `PACKAGE_VERSION`), because `0.0.0` has no artifact
   and resolve answers not-ready.

Nothing else — the build matrix and the dispatch route read the descriptor
directory.

## Build model

Builds run in the pinned base builder image (`packaging/builder/Dockerfile`):
`ghcr.io/edgarcnp/fbr-builder-base`, one Arch environment carrying the shared
toolchain. Pack-time libraries an app needs beyond it are declared in the
descriptor's `buildPackages` and installed by the build job. The builder
workflow rebuilds the image and its `pin` job commits the new tag+digest into
`packaging/builder/pins.json`, which the build job reads for its container, so
the reference cannot drift from the image. The workflow also prunes the
registry after each main run, keeping the newest three versions of the
image, so a build re-run whose pin has fallen outside that window can no
longer pull its container. The build job then upgrades the container
(`pacman -Syu`) before installing anything: the image's package database is
frozen at build time while mirrors keep only the current package files, so
dependency resolution follows the live repos between image rebuilds.
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
  release tree does, and those libraries carry no `$ORIGIN` rpath). The
  pack stage runs `quick-sharun` with `LD_LIBRARY_PATH=<AppDir>/bin` for exactly
  that call, so the closure scan resolves the siblings instead of aborting on
  "missing libraries".
- A bundle tarball (Zed) keeps its own layout at the AppDir root — `bin/zed`
  (the CLI), `libexec/zed-editor` (the editor), `lib/`, `share/` — because both
  binaries resolve `$ORIGIN/../lib` and the CLI spawns `../libexec/zed-editor`.
  `quick-sharun` still deploys the editor as a target, so its dlopen surface
  (Vulkan, GL) is bundled: the editor lands in `shared/bin/zed-editor` with a
  `bin/zed-editor` wrapper beside it. That wrapper is the one the CLI has to
  reach: the CLI execs its sibling itself, and a direct exec runs the host's
  `ld-linux` while the rpath pulls the bundled libc, so on a host older than the
  bundled glibc the editor dies on a `GLIBC_PRIVATE` symbol before it can open a
  window while the CLI waits on it forever — the report is "the processes are
  there and no window appears" (Zed 1.27.0 on host glibc 2.43 against bundled
  2.44: `__pointer_chk_guard`). `pipeline_shim_bundle_libexec` replaces every
  `libexec/<name>` whose `bin/<name>` wrapper `quick-sharun` created with a shim
  that re-exports `APPDIR`/`SHARUN_DIR` and execs that wrapper, so the editor and
  its crash-handler re-exec always start under the bundled loader; `zed
  --version` still reports `<AppDir>/libexec/zed-editor`. Zed links `libasound`,
  which the builder image does not carry, so its descriptor installs it through
  `buildPackages: ["alsa-lib"]`.
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
bun install --frozen-lockfile --ignore-scripts
TARGET_ARCH=amd64 PACKAGE_VERSION=1.137.0 packaging/apps/vscode/build.sh
```

`PACKAGE_VERSION` is the requested version and is required: the resolver only
returns that version's artifact, and the build fails if the resolved version
differs (CI always sets it from the dispatch or the cask pin). Requires an
Arch Linux system — the builder image (`packaging/builder/Dockerfile`) is the
supported one — plus `bun` ≥ 1.4.5, `jq`, the app's own tooling (`dpkg-deb`,
`gpg`/`gpgv`), `quick-sharun` in `PATH` and `APPIMAGETOOL` pointing at the
uruntime `appimagetool`. The build script runs `packaging/bin/fbr.ts`; Zod's
`node_modules` must be installed first. Output lands in `<tap>/dist/`.

## Dependency pinning

Renovate opens one reviewed PR per dependency (automerge off), with the
grouped rules in `renovate.json` for routine bumps:

| Dependency | Declared in | Manager |
| --- | --- | --- |
| `zod`, `typescript`, `@types/node` | `package.json` | npm (exact pins, no `^`) |
| GitHub Actions | workflow `uses:` | github-actions (SHA re-pinned) |
| `Homebrew/actions` | workflow `uses:` (SHA plus CalVer comment) | regex custom manager (the built-in manager truncates the four-part CalVer tag) |
| Container images | workflow `container:`, including the nested matrix image, and the builder Dockerfile's `FROM` | docker (regex for the matrix) |
| Builder image (`fbr-builder-base`) | `packaging/builder/pins.json` | pinned by the builder workflow's `pin` job, not Renovate |
| Runner labels | `runs-on:`, and the labels the build matrix bakes in | github-runners (regex for the matrix) |
| Bun version | `packageManager`, `bun-version:`, the builder Dockerfile | npm, regex custom managers |
| actionlint, pkgforge `appimagetool` | workflow (actionlint), builder Dockerfile (appimagetool) | regex custom managers |
| `quick-sharun`, `get-debloated-pkgs` | `install-anylinux-tools.sh` | git-refs custom manager |

The inputs baked into the builder image — the `pkgforge-dev/archlinux` base,
the Bun runtime, pkgforge `appimagetool`, and the `Anylinux-AppImages` commit
behind `quick-sharun`/`get-debloated-pkgs` — are one Renovate group
(`builder image`), matched by the two files that trigger the rebuild (plus
Bun, which is also pinned in `packageManager` and each workflow), so a tool
added to either file joins the group without a rule change. A merge touching
`packaging/builder/Dockerfile` or `install-anylinux-tools.sh` rebuilds and
re-pins the image, so a grouped PR produces one rebuild and one digest
instead of one per dependency. `groupSingleUpdates` keeps a lone member's
update on the same group branch, so a later update joins that open PR rather
than opening a second one. A major version still gets its own
`major-builder-image` PR (Renovate's `separateMajorMinor`), and vulnerability
fixes stay ungrouped because `vulnerabilityAlerts` sets `groupName` to null.
A `GitHub Actions` PR that updates an action used by `builder.yml` also
triggers one rebuild: the workflow file is itself a path trigger.

Casks are not Renovate's: versions and checksums are produced by this pipeline
through `fbr cask`.

No tool carries a local SHA-256 for Renovate to trip over: `actionlint` and
pkgforge `appimagetool` are downloaded from a URL addressed by the version
Renovate bumps, so a version PR needs no hand-edited pin — both trust whatever
GitHub serves over HTTPS (pkgforge publishes only b3sum sidecars, served from
the same release as the binary, so they would add no trust). `typescript`
stays on the stable 6.x line, and `@types/node` on the Node major line Bun
implements; both are `renovate.json` rules.

## Production gate

Unit tests do not exercise `quick-sharun`, `appimagetool` or the smoke test.
A main push runs the fast `check-tools.sh` and test gates; the full
**Pipeline smoke (build only)** workflow is manual, because six AppImage builds
are expensive. Run it before releasing a change that touches the descriptor
schema, the staging stages, or the pack/smoke path. It builds one app per
artifact/payload family with `publish: false` and `force_build: true`:

- `vscode` — json-asset + tarball-tree
- `orca` — github-release + deb-tree
- `wfhelper` — github-release + appimage-tree
- `firefox` — mozilla-release + tarball-tree
- `little-genius` — avakot + deb-files
- `opencode-desktop` — update-manifest + deb-tree

It creates no release and changes no cask. For a focused app check, dispatch
**Build AppImages** with that app, `publish: false`, `force_build: true`
(e.g. `orca`). The test workflow also runs on the main push (including
`brew audit` and the production-dependency CLI job); after both pass, run one
real dispatch so publish and pin-cask are exercised.

## Tests and gates

`bun test` runs the unit suite (Bun's runner over `node:test`; no test
dependencies). The push/PR workflow also has a `runtime-dependencies` job that
installs with `--production` and runs `packaging/scripts/check-tools.sh`:
every descriptor, its CI projection, the JSON Schema command and every cask,
without a build. The suite covers dpkg ordering, HTTP timeout/cap/atomic write,
guards and metadata validation, descriptor validation, cask read/update/consistency, the gate table,
updater neutralization, desktop rendering, run records, retry plans, the
artifact parsers, the JSON-asset and Mozilla-signature paths, and the detached
signature fixture. The signature tests need `gpg`/`gpgv` (the `gnupg` package).

`bun run typecheck` runs `tsc --noEmit` (strict). `bun run style` runs
`packaging/scripts/style.sh` on its own — `brew style` over the authored Ruby,
shell and workflow files, explicitly excluding `node_modules` — the fast subset
to run before every commit and push.
`scripts/check-style.sh` runs the full local gate — shellcheck, typecheck,
tests, cask check, brew style/audit, actionlint — the same set CI runs per PR
and main push.
