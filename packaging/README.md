# AppImage packaging pipeline

Build tooling for the AppImage casks in this tap. One pipeline serves every
app: what differs between apps is **data** (`packaging/apps/<app>/app.json`),
not a forked script. The TypeScript runs directly on Bun (no build step), so
there is no runtime dependency — `typescript` and `@types/bun` are dev-only,
used for `tsc --noEmit` and editor support.

## Layout

```
packaging/
  apps/<app>/app.json        app descriptor: the single source of truth
  apps/<app>/build.sh        thin shim -> packaging/lib/build-appimage.sh <app>
  apps/<app>/templates/      app's desktop entry (and runtime hook)
  apps/<app>/assets/         app's pinned signing key material
  apps/<app>/README.md       app-specific notes
  bin/fbr.ts                 the one CLI (resolve, gate, cask, neutralize, render)
  lib/*.ts                   pipeline core, one responsibility per module
  lib/*.test.ts              unit tests (bun test)
  lib/*.sh                   shared bash: build driver, pipeline stages, primitives
  scripts/                   repo-level tooling (tool installer, local style gate)
```

`packaging/lib/` is a library: nothing in it has side effects at import, and
the CLI is the only entry point. `packaging/lib/oracles/` holds one module per
upstream source kind behind a shared interface, dispatched exhaustively
(`registry.ts`), so adding a kind without handling it is a compile error.

## Pipeline stages

`packaging/lib/build-appimage.sh <app>` runs, in order:

1. **init** — load and validate the descriptor, resolve the architecture
   (`TARGET_ARCH` → `amd64`/`arm64` + the AppImage arch), set up the scratch
   and AppDir directories with path guards.
2. **resolve** — `fbr resolve` asks the app's oracle for the upstream version,
   payload URL, size and SHA-256, and writes `metadata.json`.
3. **extract** — `dpkg-deb -x` for `.deb` payloads (with an arch assertion), or
   the upstream AppImage's own `--appimage-extract` (no FUSE needed).
4. **stage** — descriptor-driven staging into `AppDir/bin` (a payload tree, a
   list of binaries, or an AppImage tree with renames/excludes).
5. **neutralize** — `fbr neutralize` disables the app's own updater and then
   asserts that no updater endpoint survived anywhere in the AppDir.
6. **render + icon** — `fbr render-desktop` (literal substitution, no sed) and
   the descriptor's icon into the hicolor tree.
7. **pack** — `normalize_package_payload_permissions`, `quick-sharun` (generates
   AppRun, bundles the runtime closure including glibc and ld-linux),
   `pipeline_reconcile_sharun_sidecars` (repairs nested sharun wrappers, below),
   `fbr finalize` (AppDir `.env` entries and the runtime hook), then pkgforge's
   `appimagetool` through `APPIMAGETOOL`, and finally the smoke test.

## Descriptor reference

| Field | Meaning |
| --- | --- |
| `id`, `cask`, `assetPrefix`, `tagPrefix` | Identity: app id, cask token (`Casks/<cask>.rb`), release asset and tag prefixes (the tag is `<tagPrefix><version>`) |
| `appName`, `displayName`, `comment` | Release title and desktop entry `Name=`/`Comment=` |
| `sourceRepo`, `sourceOwner` | Upstream repository to build from, and the owner of the fallback fork |
| `sourceDir`, `buildCommand` | Where CI `cd`s before running the build |
| `debloatArgs`, `needsWebkit` | pkgforge debloat flags; whether the webkit2gtk/GTK build deps are needed |
| `architectures` | Architectures this app ships (`["amd64", "arm64"]` or, for amd64-only upstreams like CommandCode, `["amd64"]`); the pipeline builds, publishes and checks only these arches |
| `binaryTargets` | Names the cask must expose on `PATH` (checked by `fbr cask --action check`) |
| `oracle` | Where the version and payload come from (below) |
| `watch` | Optional release-watch block (`feedUrl`, `versionPattern`, optional `skipPattern`, `repo`) the API's watcher polls to dispatch builds. The pattern is matched against the feed entry title — the GitHub release *name*, not the tag — and capture group 1 is the version; `repo` only feeds the informational `trigger_repo`. The watched version must be one the `oracle` can build, or the app stalls at `dispatched` |
| `payload` | How the upstream package is staged into `AppDir/bin` |
| `icon` | Icon path inside the payload plus its hicolor size directory |
| `desktopTemplate` | Desktop entry template relative to the app directory |
| `updater` | Updater neutralization: JSON key removal, endpoint patch, feed removal, `.env` entries, runtime hook, residual scan |
| `quickSharun` | quick-sharun build knobs exported as environment variables: `hooks` (pkgforge hooks deployed via `ADD_HOOKS`, e.g. `fix-namespaces.hook`) and `env` (verbatim variables such as `OPTIMIZE_LAUNCH`, `DEPLOY_OPENGL`, `QUICK_SHARUN_SKIP_DEPS_FOR`) |

### Oracle kinds

- **`apt`** — signed apt repository: pinned key → `InRelease` (verified with
  `gpgv` against a pinned fingerprint) → `Packages` SHA-256 → package
  SHA-256/size; the newest entry per architecture wins, compared with dpkg's
  ordering.
- **`github-release`** — GitHub release assets: the newest non-draft,
  non-prerelease release carrying both architecture `.deb` files with SHA-256
  digests, verified at download time. The versioned-asset flavor (CommandCode)
  pins a tag prefix plus an `assetNameTemplate` (`CommandCode-{version}-{arch}.deb`)
  instead, and resolves each shipped architecture separately.
- **`electron-feed`** — an electron-updater feed whose 302 names the exact
  release tag; the yml supplies the filename, SHA-512 and size, and the GitHub
  API supplies the SHA-256. All three must agree.
- **`cdn-redirect`** — a CDN download redirect that is itself the version
  source; the redirect target's URL shape is pinned, the payload is hashed on
  download (the CDN publishes no checksums).
- **`update-manifest`** — a pinned https JSON endpoint that is itself the
  version source and publishes the per-asset SHA-256/size (e.g. opencode's v2
  desktop update API). The entry for `assetTemplate` (`{arch}` substituted)
  must carry the version as a download-path segment on a pinned
  `downloadHosts` host; the payload is verified against the manifest's digest
  at download time, so `--metadata-only` resolve needs no download.

## `fbr` CLI

```
fbr list-apps [--json]                       app ids with a descriptor
fbr resolve-app --name X                     map an app id or cask token to the app id
fbr descriptor --app X [--field a.b]         validated descriptor (or one field)
fbr descriptor-env --app X [--format env|output]
                                             KEY=VALUE lines for $GITHUB_ENV/$GITHUB_OUTPUT
fbr resolve --app X --arch A ...             resolve upstream metadata
fbr metadata --file F --field version|sha256|url|path
fbr gate --app X --upstream-version V [--release-exists]
     [--release-matches-cask true|false]     cask gate decision; omit the match flag when
                                             the asset comparison could not run
fbr cask --action read|set-version|check     read, re-pin or check casks
fbr neutralize --app X --appdir D            disable the in-AppDir updater
fbr finalize --app X --appdir D              write .env and install the hook
fbr render-desktop --app X --version V --appdir D
fbr version-compare A B                      dpkg-equivalent comparison (-1|0|1)
fbr version-compare --sort A B [C ...]       dpkg-order a list ascending, one per line
```

Every command declares its flags: an unknown or duplicate flag is a usage
error (exit 2) instead of a silently ignored argument.

## Verification model

Nothing is trusted that has not been checked, and each check lives in one
place:

- **Host pinning** — every download validates protocol, host allow-list and
  redirect target. GitHub asset hosts come from one shared list, so an oracle
  cannot forget an edge host.
- **Content** — size caps (`MAX_PAYLOAD_BYTES`), SHA-256 for apt packages,
  GitHub assets and the CDN payload, SHA-512 cross-checks for the
  electron-updater feed, `timingSafeEqual` comparisons, atomic writes.
- **Freshness** — signed apt indexes are rejected when their `Valid-Until` has
  passed or their `Date` is more than 14 days old.
- **Paths** — metadata and key paths must stay inside their output directory
  (or, for keys, inside the repository); descriptor paths must be
  repository-relative.
- **Updater neutralization** — descriptor-declared, then verified: the build
  fails when any declared updater endpoint survives in the AppDir (the
  gitbutler descriptor sets `severity: warning` because a legitimate copy can
  remain in a file that is not the patched binary).
- **Casks** — the cask file is parsed by one module; `fbr cask --action check`
  asserts the cask agrees with its descriptor (URL, asset name, binary
  targets, icon size, desktop entry and zap paths).
- **The build itself** — `smoke_test_appimage` runs the AppImage headless and
  fails on dynamic-loader errors, and the release pins the AppImage SHA-256
  back into the cask.

## Adding an app

1. `packaging/apps/<app>/app.json` — copy a similar descriptor and adjust the
   oracle, payload, icon and updater sections.
2. `packaging/apps/<app>/templates/<name>.desktop`, plus `build.sh` (four lines:
   `exec ../../lib/build-appimage.sh <app>`).
3. `Casks/<cask>.rb` with zero placeholder checksums; the first publish fills
   them in.
4. Nothing else: the build matrix and the dispatch route read the descriptor
   directory, and CI lints/tests globbed paths.

## Build model: sharun/quick-sharun in an Arch container

AppImage builds run inside `ghcr.io/pkgforge-dev/archlinux:<tag>@<digest>` (both
the tag and digest pinned in `build-appimage.yml`; the image rolls, so Renovate
bumps the pair together), mirroring how pkgforge's Anylinux-AppImages are built.
`linuxdeploy` was retired: quick-sharun (wrapping sharun) bundles the app's
dynamic-linker closure **including glibc and ld-linux** and generates the
AppRun, so the resulting AppImages have no host-libc dependency and run on
musl, non-FHS and very old distros. The same setup installs pkgforge's
debloated Arch packages (`get-debloated-pkgs`, flags per app via the
descriptor) so the AppImages carry stripped `libicudata`, mesa without LLVM,
and other size optimizations. The descriptors use `--prefer-nano`, i.e. the
`-Os` variants that archlinux-pkgs-debloated warns can cost stability and
performance — acceptable for these editors/agents, but not a default to copy
into a performance-critical app.

`quick-sharun` hardlinks `sharun` over every nested executable under `bin/`
whose basename also lands in `shared/bin` (`_handle_nested_bins`). sharun
resolves its root from `/proc/self/exe` and loads `shared/bin/<name>`, so only
a wrapper directly under `bin/` resolves; a nested one — for example an
Electron app spawning `bin/resources/opencode-cli` by path — fails at runtime
with `Failed to find '<name>' in PATH or <dir>/shared/bin`.
`pipeline_reconcile_sharun_sidecars` re-points each nested wrapper under `bin/`
at the working `bin/<name>` wrapper with a relative symlink (sharun follows a
symlink that resolves there), then asserts the contract for the whole AppDir:
the only sharun hardlinks left are `sharun` itself and the `bin/<name>`
wrappers, and any other location fails the build as a process path that cannot
start.

The descriptor's `quickSharun` block is exported as environment variables
before quick-sharun runs, so an app's pkgforge knobs (hooks, `OPTIMIZE_LAUNCH`,
`DEPLOY_*`, `QUICK_SHARUN_SKIP_DEPS_FOR`) live with the app instead of in the
workflow, and a local `build.sh` behaves like CI. Every app deploys pkgforge's
`fix-namespaces.hook`, which detects the unprivileged-userns restriction some
distros (Ubuntu 24.04+, secureblue) impose and offers to lift it (the hook is
sourced by the generated `AppRun` and no-ops where userns already work), and
sets `OPTIMIZE_LAUNCH=1` for the DWARFS launch profile.

Three things stay in this pipeline rather than delegating to quick-sharun:
updater neutralization (`fbr neutralize` fails the build when a declared
endpoint survives, which `self-updater.hook` — whose purpose is the opposite —
cannot express), the smoke gate (a superset of `quick-sharun --simple-test`'s
loader-error patterns, run against the packed AppImage), and the appimagetool
invocation itself (`quick-sharun --make-appimage` guesses an update-information
string from `GITHUB_REPOSITORY`, which would embed a zsync updater feed in
artifacts that are deliberately update-free).

The workflow installs the webkit2gtk/GTK deps only for apps whose descriptor
sets `needsWebkit` (gitbutler) — vscode, opencode-desktop and commandcode-desktop are
Electron and ship their own webkit. The other build deps (`gnupg`,
`dpkg`, `patchelf`, `xorg-server-xvfb`) are installed for every app; `nss` is
too, because quick-sharun aborts if an Electron binary's `ldd` closure is
missing the NSS libraries (libnss3, libnspr4, ...) it bundles. The pinned
pkgforge `appimagetool` (uruntime/DWARFS) is invoked by quick-sharun through
the `APPIMAGETOOL` env var with no CLI args; it reads
`APPDIR/OUTPATH/OUTNAME/ARCH/VERSION` from the environment.

`packaging/scripts/install-anylinux-tools.sh` downloads `quick-sharun` and
`get-debloated-pkgs` from a raw URL addressed by a 40-character commit digest
of pkgforge-dev/Anylinux-AppImages. That digest fixes the exact bytes of both
tools, so there is no separate SHA-256 to co-update: Renovate owns the pin end
to end. It also fixes what quick-sharun downloads for itself at build time —
the sharun runtime, onelf and cross-libc-dlopen — so bumping that one commit
moves the runtime with it; only appimagetool is overridden, by the workflow's
own pinned build.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.137.0 packaging/apps/vscode/build.sh
```

`PACKAGE_VERSION` is optional: when unset it comes from the resolved upstream
metadata; when set, the build fails if the resolved version differs (CI always
sets it). Requires an Arch Linux system (or the
`ghcr.io/pkgforge-dev/archlinux` container), `bun` ≥ 1.4, `jq`, the app's own
tooling (`dpkg-deb` for `.deb` payloads, `gpg`/`gpgv` for apt), `quick-sharun`
in `PATH` and `APPIMAGETOOL` pointing at the uruntime `appimagetool`. Output
lands in `<tap>/dist/`.

## Dependency pinning and Renovate

Every version this repository depends on is discoverable by Renovate, which
opens one reviewed PR per dependency (automerge stays off):

| Dependency | Declared in | How Renovate sees it |
| --- | --- | --- |
| `typescript`, `@types/bun` | `package.json` | npm manager over `package.json`, `bun` manager over `bun.lock` (exact pins, no `^`: frozen-lock) |
| GitHub Actions | `uses:` in workflows | built-in manager plus `helpers:pinGitHubActionDigests`: the version in the trailing comment is bumped and the SHA re-pinned |
| Build and test container images | `container:` in workflows | built-in manager (`container` dependency type), digests included. It only reads a job-level `container:`, so the digest nested in `tests.yml`'s `strategy.matrix` is extracted by a `customManagers` regex entry instead; a package rule groups both brew digests into the GitHub Actions PR so the two files move together |
| Runner labels (`ubuntu-24.04-arm`) | `runs-on:` | built-in manager (`github-runner` dependency type) |
| Bun version | `bun-version:` under `oven-sh/setup-bun` | built-in manager (`uses-with` dependency type: npm `bun`) |
| actionlint | `tests.yml` | `customManagers` (github-releases) |
| pkgforge `appimagetool` | `build-appimage.yml` | `customManagers` (github-releases) |
| `quick-sharun`, `get-debloated-pkgs` | `install-anylinux-tools.sh` | `customManagers` (git-refs: the digest of `main`) |

The casks are not Renovate's: `Casks/*.rb` versions and checksums are produced
by this pipeline through `fbr cask`, which is why nothing points Renovate at
them.

Two pins carry a local SHA-256 that Renovate cannot recompute: actionlint's
tarball and appimagetool's per-arch binaries. The version bump still arrives as
a PR; the build then fails printing the hash it measured, so updating the pin
is a copy-paste in that same PR.

Two dependencies are deliberately held back. `typescript` stays on the 6.x line
(`allowedVersions` in `renovate.json`) until this toolchain is ready for 7, and
`@types/bun` stays on the Bun minor the CI actually runs (1.4.x) so the types
cannot describe APIs the tested runtime lacks. Moving the `bun` runtime rule to
a newer minor means widening that rule in the same change.

## Tests and gates

`bun test` runs the unit suite (Bun's runner over `node:test` files, no test
dependencies): dpkg version
ordering, deb822/InRelease parsing and freshness, HTTP retry/cap/atomic-write,
guards and metadata validation, descriptor validation against the real
descriptors, cask read/update/consistency, the gate decision table, updater
neutralization over temporary AppDirs, desktop rendering against the real
templates, and the oracle parsers.

`bun run typecheck` runs `tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `erasableSyntaxOnly`. `packaging/scripts/check-style.sh`
runs the full local gate (shellcheck, typecheck, tests, cask check, brew
style/audit, actionlint); CI runs the same set on every PR.
