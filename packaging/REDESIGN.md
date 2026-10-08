# Redesigning the packaging toolchain

Status: **phases 0–1 landed; the rest proposed**. Phase 0 (the v2 and manifest
schemas) and phase 1 (the pinned builder image) are live on `main`; phases 2–5
are targets, not code. Current behavior lives in [`README.md`](README.md);
where this document and the code disagree, the README and the code are the
truth. Nothing here changes the Homebrew surface — the casks, their install
behavior and the API event contract stay as they are.

## Goals and constraints

- **Goals** — cut pipeline complexity, make adding an app cheap, and cut build
  time and flakiness. The roster grows modestly (roughly a dozen apps), all
  built by repackaging upstream releases.
- **Fixed** — GitHub-hosted runners and the Arch container; Node/TypeScript for
  the toolchain (no runtime dependencies, no build step); GitHub Releases as the
  artifact store; the run-record contract (`schema: 1`,
  `POST /v1/homebrew/tap/events`, OIDC delivery).
- **Not in scope** — building apps from upstream source, arm64 as a redesign
  driver (the descriptor-driven matrix keeps the door open), any API-side
  change.

## Where the current design strains

1. **Orchestration is spread across three languages.**
   `.github/workflows/build-appimage.yml` makes the decisions (gate
   inputs, matrix, record assembly), `packaging/lib/shell/appimage-pipeline.sh`
   executes the stages, and `packaging/lib/**` supplies primitives. Several
   `fbr` commands (`descriptor-env` and friends) exist only to move descriptor
   fields into `$GITHUB_ENV`/`$GITHUB_OUTPUT`, and the workflow re-reads
   descriptor-derived values with `jq`.
2. **Two sources of truth per app.** `apps/<app>/app.json` and
   `Casks/<app>.rb` duplicate the name, binaries, icon and desktop entry, and
   the cask holds data the descriptor has no field for at all: `desc` (several
   casks override it, e.g. vscode's "Repackage of Visual Studio Code as an
   AppImage"), `homepage`, zap paths and vscode's `conflicts_with`.
   `fbr cask --action check` exists to catch the duplication drifting. The v1
   loader now rejects unknown keys; the remaining strain is the duplication
   with the cask, which `fbr cask render` removes.
3. **The build is CI-shaped, not program-shaped.** No single command runs the
   real flow (plan → build → publish → pin → record); `apps/<app>/build.sh`
   stops at the packed AppImage, and the decisions around it live only in YAML.
4. **Half-used source block.** Every descriptor sets `sourceRepo` to this tap
   itself with `sourceDir` + `buildCommand: ./build.sh`, and the build job
   checks out a second copy of the repository to run it. Nothing builds from an
   upstream repo, so the fallback fork, `sourceDir` and `buildCommand` have no
   real job — but `sourceRepo` is not dead: `expectedCaskUrl` uses it as the
   cask's release URL (`packaging/lib/pipeline/cask.ts:157`), so v2 must keep
   that role under a clearer name.
5. **The toolchain was installed per run.** Every build job used to run
   `pacman-key --init`, `pacman -Syy`, `pacman -Syu`, the shared packages, then
   download `appimagetool`, `quick-sharun`, `get-debloated-pkgs` and the
   debloated packages — minutes of network on every build. Phase 1 moved the
   base into the builder image; the per-app debloated packages are still
   fetched per build.
6. **The record is assembled in YAML.** The report job re-derives stage,
   status, code and evidence from job results and `report-code.json` fragments
   with `jq`; the pure builder in `packaging/lib/pipeline/report.ts` is the only
   tested part.

## Target architecture

### Flow

```
dispatch (API / manual)
  │
  ├─ plan    fbr plan --app X                gate + upstream facts
  │            └─ {action, version, cask_version, feed_version, upstream}
  │
  ├─ build   fbr build --app X               stages → AppImage + manifest.json
  │            (builder image, contents: read)      + record fragment
  │
  ├─ publish fbr publish --manifest M        release + notes + prune (contents: write)
  │          fbr cask render --manifest M    regenerate Casks/X.rb (the job commits and pushes)
  │
  └─ report  fbr report compose              fragments + job results → one record
             fbr report deliver              artifact + OIDC POST
```

Each job is a handful of steps that call one command; no job makes a decision
in shell or `jq`.

### The program

`fbr` owns the pipeline; the workflow only sequences it.

| Command | Does |
| --- | --- |
| `fbr plan --app X [--json]` | Resolve upstream metadata and gate it; one JSON plan with the action (`build`/`skip`/`repair-cask`), versions and per-arch upstream facts. |
| `fbr build --app X [--arch A] [--dry-run]` | The stages (below); writes the AppImage, `manifest.json` and a record fragment. |
| `fbr run --app X [--no-publish]` | Local one-shot: `plan` + `build`, then `publish` unless `--no-publish`. CI calls the pieces from separate jobs. |
| `fbr publish --manifest M` | Creates the release with generated notes, attests, prunes old releases, removes a partial release on failure. |
| `fbr cask render --app X --manifest M` | Writes `Casks/X.rb` from descriptor + manifest (see "Generated casks"). |
| `fbr report compose ...` | Merges plan output, per-job results and fragments into one schema-1 record. Pure and unit-tested, replacing the workflow's `jq` assembly. |
| `fbr report deliver --record R` | Fetches the OIDC token and POSTs the record with today's semantics: 2xx delivered, 429 backs off per Retry-After (capped) while other 4xx is a permanent warning, 000/5xx retried to three attempts total with 5/10/15 s sleeps; never logs the token; never fails the run. |
| `fbr check [--app X \| --all]` | Descriptor schema, generated-file freshness (the cask, once casks are generated), toolchain doctor; `--resolve` adds a metadata-only oracle dry-run. |
| `fbr app new --id X [--from Y]` | Scaffolds descriptor, desktop templates, placeholder cask and README row. |

Stages: **resolve → extract → stage → neutralize → render/icon → pack →
verify**, with the oracle's fetch and checksum checks inside `resolve` and the
smoke run inside `verify`. Each external command (`dpkg-deb`, `gpgv`,
`quick-sharun`, `appimagetool`, the smoke run) sits behind one adapter
interface, so stages are unit-testable against fakes and `--dry-run` prints the
exact invocations. The existing behavior, including the sharun sidecar
reconciliation and host-helper stash/restore, moves into stages unchanged;
their tests move to stage tests. The oracle HTTP core is also the API delivery
client — one guarded client, one test strategy.

### Descriptor v2

One schema at `packaging/schema/app.schema.json`, referenced from each
descriptor via `$schema` for editor completion, plus a `schemaVersion` field.
Unknown keys become hard errors with a JSON path; `fbr check` runs the same
validation.

| Change | Detail |
| --- | --- |
| Added | A `homebrew` block for data only the cask needs: `homepage`, `desc` (defaults to `comment`; several casks override it today), `zap`, `conflicts` (vscode) and `caveats` extras. The generated cask's `name` comes from `appName`, and its installed desktop entry is derived from the existing `desktopTemplate` with every `Exec` rewritten to the brew launcher — no second template file. The block is not called `cask` because `cask` is already the token. |
| Required | `architectures` must be declared: no silent amd64+arm64 default. |
| Renamed | `sourceRepo` → `releaseRepo`: the one source-block field with a live consumer, the repo whose releases the cask URL points at (`packaging/lib/pipeline/cask.ts:157`). |
| Removed | `sourceOwner`, `sourceDir`, `buildCommand` and the second checkout — nothing builds from an upstream repo. |
| Demoted | `buildPackages` stays an escape hatch: it forces a build-time package install, which is how little-genius gets its pack-time webkit2gtk/GTK closure. |

Everything else keeps its current meaning, so a v2 descriptor reads like a v1
one minus the source block.

### Manifest

Written by `fbr build`, uploaded with the AppImage, consumed by `publish` and
`cask render`, and available to the API later (additive; the record contract
does not change).

```json
{
  "schema": 1,
  "app": "vscode",
  "version": "1.139.1",
  "architecture": "amd64",
  "descriptor": { "path": "packaging/apps/vscode/app.json", "sha256": "..." },
  "upstream": { "oracle": "apt", "url": "https://...", "sha256": "...", "size": 12345678 },
  "artifact": { "name": "vscode-1.139.1-x86_64.AppImage", "sha256": "...", "size": 98765432 },
  "toolchain": {
    "image": "ghcr.io/edgarcnp/fbr-builder-base:<tag>@sha256:...",
    "quick_sharun": "<commit>",
    "appimagetool": "0.5.2",
    "node": "24.17.0"
  },
  "build": { "commit": "<tap sha>", "started_at": "...", "finished_at": "...", "smoke": "passed" }
}
```

`publish` re-hashes the downloaded artifact and compares it to the manifest
before creating the release, so a corrupted artifact hand-off fails early.

### Record

Unchanged. One schema-1 document per app run, delivered twice from one shape
(artifact for humans, OIDC POST for the API). Failure sites keep writing
fragments (`{code, message, stage?, evidence?}`); `fbr report compose` is the
single place that turns them plus job results into the record, using the
existing stages, statuses and `FAILURE_CODES` table. A new failure site still
means a new code with its verdict and coverage — the classification contract
stays in `packaging/lib/pipeline/report.ts`.

### Generated casks

`fbr cask render` writes the whole file:

- version and per-arch `sha256` from the **released** assets (hashed after
  download, as today), behind the existing trust check (final release, author
  `github-actions[bot]`);
- `name` (from `appName`), `homebrew.desc`, `homebrew.homepage` from the
  descriptor, `url` and `livecheck` from `releaseRepo`/`tagPrefix`/`assetPrefix`;
- `app_image` and `binary` artifacts from `binaryTargets`;
- the installed desktop entry derived from `desktopTemplate`: every `Exec=`
  line (including Desktop Actions) is rewritten to the brew launcher and
  AppImage-only keys such as `X-AppImage-Version` are dropped, so no second
  template file exists; plus the icon (AppDir `<cask>.png` to the descriptor's
  hicolor size), zap paths from `homebrew.zap` plus the two generated defaults,
  and `homebrew.conflicts`;
- a "generated by fbr cask render" header.

`fbr cask check` becomes `fbr cask render --check` (regenerate and diff).
`brew style`/`audit` and cask-smoke stay the gates; a per-app deviation gets a
descriptor field or an explicit escape hatch rather than a hand edit.

### Builder image

`ghcr.io/edgarcnp/fbr-builder-base`, built from
`packaging/builder/Dockerfile` (`FROM` the current pkgforge Arch digest) and
published by a workflow on changes and on a weekly schedule.

- One base image carries the shared toolchain; pack-time-only libraries come
  from each descriptor's `buildPackages` (little-genius's webkit2gtk/GTK
  closure and `libayatana-appindicator`).
- Baked: pacman packages, `quick-sharun`/`get-debloated-pkgs` (via the existing
  pinned `install-anylinux-tools.sh`), `appimagetool`, Node.
- Not baked: the orchestrator itself — it always comes from the checkout, so it
  can never lag the commit under test.
- Pinned by tag+digest in `packaging/builder/pins.json`, which the build job
  reads for its container; the builder workflow's `pin` job commits the new
  reference after every rebuild, so Renovate does not manage these two images.
  Arch freshness is the scheduled rebuild plus a per-run `pacman -Syu` before
  the install steps: the image's database freezes at build time and mirrors
  keep only the current package files, so without the upgrade a dependency that
  moved since the rebuild resolves to a pruned file (a re-dispatch runs the
  same stale image and cannot clear it).
- Result: for the current apps, the per-run network is that upgrade delta plus
  the per-app `get-debloated-pkgs` fetch; a failed image pull is one classified
  toolchain failure instead of four network steps. An app that needs an extra
  package extends the image (preferred) or exercises the `buildPackages`
  escape hatch and pays the install cost deliberately.

### Workflows

- `build.yml` — list apps and plan the matrix (as today), but resolution is
  `fbr plan`; the plan-failure record and its OIDC delivery stay.
- `build-appimage.yml` — `plan` → `build` (builder image, `contents: read`) →
  `publish` + `pin-cask` (`contents: write`, pin serialized on `push-casks`) →
  `report` (`always()`, `id-token: write`). The publish/pin split is
  deliberate: releases stay parallel, cask pushes serialize.
  `.github/actions/update-cask` keeps the key import, commit and push-retry;
  its update step becomes `fbr cask render`.
- `tests.yml` — adds `fbr check --all`; drops shellcheck when the last shell
  script goes.
- `cask-smoke.yml` — unchanged concept; generated placeholder checksums make
  the "not yet published" case explicit.

## Onboarding

```sh
fbr app new --id foo --from vscode      # descriptor, desktop templates, cask, README row
fbr check --app foo                     # schema and generated-cask diff, doctor
fbr run --app foo --no-publish          # the whole build locally
```

`fbr run` is `plan` + `build` with the local defaults (`--no-publish` implied
outside CI). No `build.sh` shim, no workflow edit, no source checkout.

## Deletions

- `packaging/apps/*/build.sh`, `packaging/lib/shell/**`,
  `packaging/tests/shell/**`;
- `descriptor-env`, the `SOURCE_*`/`BUILD_COMMAND` exports and the source
  checkout step;
- `fbr cask --action check|set-version`, replaced by `render`/`render --check`
  (which also updates `tests.yml`, `packaging/scripts/check-style.sh` and the
  update-cask action's update step);
- `jq` from the build workflows; the builder image and `cask-smoke.yml` keep it
  until nothing they run needs it;
- the workflow-side record assembly;
- `metadata` and `arch`, which the shell stages and local `build.sh` consume
  today and the stages replace.

## Migration

Each phase lands on its own with `main` green; the old pipeline is the
reference oracle until its last consumer is gone. **Status:** phases 0 and 1
are landed; the run record is still assembled in the workflows and the shell
pipeline is still the only build path, so phases 2–5 are not started.

| Phase | Lands | Exit check |
| --- | --- | --- |
| 0 Contracts | `app.schema.json`, manifest schema, descriptor v2 example, schema tests. No behavior change. | `pnpm test`, `pnpm run typecheck`; docs mark this file as the plan of record. |
| 1 Builder image | `packaging/builder/Dockerfile`, publish workflow, build jobs switch container. | A dispatch builds with identical facts; no pacman/tool downloads in the job log; digest pinned. |
| 2 Descriptor v2 + plan/report | Migrate the six descriptors (`sourceRepo` → `releaseRepo`, add the `homebrew` block, drop the rest), strict loader, `fbr plan`, `fbr report compose`, `fbr report deliver`, `fbr check` (schema + doctor). The source checkout goes; the build runs from the tap checkout. | Real dispatches for one skip, one build and one repair match today's plan outputs and record key set; delivery semantics covered by a local HTTP fixture; the old shell build still runs from the tap path. |
| 3 Build stages | Port resolve → extract → stage → neutralize → render/icon → pack → verify, simplest first. Dual-run old and new per app and compare tree digests and manifest facts; switch an app's CI path once it passes, leaving the shell pipeline untouched until the last app. | Every app dual-runs green (facts match, smoke passes) and builds through the new program; the shell pipeline has no remaining CI callers. |
| 4 Publish + casks | `fbr publish`, `fbr cask render`; generate all six casks; rework the update-cask action and switch `tests.yml`/`check-style.sh` to `fbr check`. | Cask diffs reviewed per app (`desc`, `homepage`, zap, conflicts preserved); `brew style`/`audit` and cask-smoke green; no hand edits. |
| 5 Cleanup | Delete the shell pipeline, shims, `descriptor-env` and the replaced commands; rewrite `packaging/README.md` and the root `AGENTS.md` layout section. | `grep` finds no removed names; `packaging/scripts/check-style.sh` green; one full dispatch per app. |

## Open questions

- Keep the dormant `publish.yml` (`brew pr-pull`) and `autobump.yml`, or drop
  them with the rest of the template files? **Answered:** keep both;
  `autobump.yml` stays as the tap-new template (inert on a cask-only tap).
- README cask table: generate it in `fbr check`, or leave the table manual?
- Webkit closure: image variant (as proposed) or installed per build; and the
  scheduled rebuild cadence for the builder image. **Answered:** one base image
  with the closure in `buildPackages`, rebuilt weekly (`builder.yml`).
- Does the API ever want the manifest (artifact facts) in the record, or is it
  happy with versions and codes? If it does, that is an additive schema-1 field
  proposed from the API side, not invented here.
- Dual-run comparison target in phase 3: manifest facts (and smoke) only, or an
  attempt at byte-identical AppImages.
