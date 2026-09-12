# AppImage packaging pipeline

Build tooling for the AppImage casks in this tap. One pipeline serves every
app: what differs between apps is **data** (`packaging/apps/<app>/app.json`),
not a forked script. The TypeScript runs directly on Node's type stripping, so
there is no build step and no runtime dependency — `typescript` and
`@types/node` are dev-only, used for `tsc --noEmit` and editor support.

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
  lib/*.test.ts              unit tests (node --test)
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
| `binaryTargets` | Names the cask must expose on `PATH` (checked by `fbr cask --action check`) |
| `oracle` | Where the version and payload come from (below) |
| `payload` | How the upstream package is staged into `AppDir/bin` |
| `icon` | Icon path inside the payload plus its hicolor size directory |
| `desktopTemplate` | Desktop entry template relative to the app directory |
| `updater` | Updater neutralization: JSON key removal, endpoint patch, feed removal, `.env` entries, runtime hook, residual scan |

### Oracle kinds

- **`apt`** — signed apt repository: pinned key → `InRelease` (verified with
  `gpgv` against a pinned fingerprint) → `Packages` SHA-256 → package
  SHA-256/size; the newest entry per architecture wins, compared with dpkg's
  ordering.
- **`github-release`** — GitHub release assets: the newest non-draft,
  non-prerelease release carrying both architecture `.deb` files with SHA-256
  digests, verified at download time.
- **`electron-feed`** — an electron-updater feed whose 302 names the exact
  release tag; the yml supplies the filename, SHA-512 and size, and the GitHub
  API supplies the SHA-256. All three must agree.
- **`cdn-redirect`** — a CDN download redirect that is itself the version
  source; the redirect target's URL shape is pinned, the payload is hashed on
  download (the CDN publishes no checksums).

## `fbr` CLI

```
fbr list-apps [--json]                       app ids with a descriptor
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
fbr version-compare A B                      dpkg-equivalent comparison
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

AppImage builds run inside `ghcr.io/pkgforge-dev/archlinux:<tag>` (pinned in
`build-appimage.yml`), mirroring how pkgforge's Anylinux-AppImages are built.
`linuxdeploy` was retired: quick-sharun (wrapping sharun) bundles the app's
dynamic-linker closure **including glibc and ld-linux** and generates the
AppRun, so the resulting AppImages have no host-libc dependency and run on
musl, non-FHS and very old distros. The same setup installs pkgforge's
debloated Arch packages (`get-debloated-pkgs`, flags per app via the
descriptor) so the AppImages carry stripped `libicudata`, mesa without LLVM,
and other size optimizations.

The workflow installs the webkit2gtk/GTK deps only for apps whose descriptor
sets `needsWebkit` (gitbutler) — vscode, opencode-desktop and freebuff are
Electron and ship their own webkit. The other build deps (`nodejs`, `gnupg`,
`dpkg`, `patchelf`, `xorg-server-xvfb`) are installed for every app; `nss` is
too, because quick-sharun aborts if an Electron binary's `ldd` closure is
missing the NSS libraries (libnss3, libnspr4, ...) it bundles. The pinned
pkgforge `appimagetool` (uruntime/DWARFS) is invoked by quick-sharun through
the `APPIMAGETOOL` env var with no CLI args; it reads
`APPDIR/OUTPATH/OUTNAME/ARCH/VERSION` from the environment.

`packaging/scripts/install-anylinux-tools.sh` downloads `quick-sharun` and
`get-debloated-pkgs` pinned to a commit of pkgforge-dev/Anylinux-AppImages and
verifies both by SHA-256; bumps are manual PRs that update the commit and both
hashes together.

## Local run (verification only)

```sh
TARGET_ARCH=amd64 PACKAGE_VERSION=1.137.0 packaging/apps/vscode/build.sh
```

`PACKAGE_VERSION` is optional: when unset it comes from the resolved upstream
metadata; when set, the build fails if the resolved version differs (CI always
sets it). Requires an Arch Linux system (or the
`ghcr.io/pkgforge-dev/archlinux` container), `node` ≥ 24, `jq`, the app's own
tooling (`dpkg-deb` for `.deb` payloads, `gpg`/`gpgv` for apt), `quick-sharun`
in `PATH` and `APPIMAGETOOL` pointing at the uruntime `appimagetool`. Output
lands in `<tap>/dist/`.

## Tests and gates

`npm test` runs the unit suite (`node --test`, no dependencies): dpkg version
ordering, deb822/InRelease parsing and freshness, HTTP retry/cap/atomic-write,
guards and metadata validation, descriptor validation against the real
descriptors, cask read/update/consistency, the gate decision table, updater
neutralization over temporary AppDirs, desktop rendering against the real
templates, and the oracle parsers.

`npm run typecheck` runs `tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `erasableSyntaxOnly`. `packaging/scripts/check-style.sh`
runs the full local gate (shellcheck, typecheck, tests, cask check, brew
style/audit, actionlint); CI runs the same set on every PR.
