# AGENTS.md — edgarcnp/homebrew-tap

A starting point for anyone who lands in this repository and has not been here
before, whether they are reading it by hand or through an automated assistant.
It covers what the repo is, how it is organized, how to verify a change, and
what belongs to automation rather than to you.

This file is a map, not the terrain: where it and the code disagree, the code
wins and this file is stale — say so instead of following it.

The deep reference is [`packaging/README.md`](packaging/README.md): the layout,
every descriptor field, the oracle kinds, the `fbr` CLI, the run record, the
verification and build models, and the steps for adding an app. Read the
section you are about to change rather than guessing at it.

## What this repo is

A Homebrew tap of **Linux-only** casks, each shipping an AppImage built by the
toolchain in `packaging/`. One pipeline serves every app — what differs per app
is **data** (`packaging/apps/<app>/app.json`), never a forked script.

- The app id is one string end to end: directory name, `id`, `cask`,
  `assetPrefix`, and `Casks/<app>.rb`.
- Every cask is amd64-only: one `x86_64` AppImage each, and
  `depends_on arch: :x86_64` refuses the install on arm64 up front.
- TypeScript runs directly on Bun — no build step, no runtime dependencies.
  `typescript` and `@types/bun` are dev-only; adding a dependency is a decision,
  not a convenience.
- `packaging/lib/` is a library with no import-time side effects;
  `packaging/bin/fbr.ts` is the only entry point and `lib/cli.ts` composes it.
- Cask versions and checksums are produced by this pipeline, never by hand.

## Layout

| Path | What lives there |
| --- | --- |
| `Casks/<app>.rb` | the cask: version and `sha256` pinned |
| `packaging/apps/<app>/` | `app.json` descriptor, `build.sh` shim, templates, key material |
| `packaging/bin/fbr.ts` | the CLI; `packaging/lib/{core,pipeline,oracles,schema,shell}/` its library |
| `packaging/builder/` | the pinned builder image: `Dockerfile`, `pins.json` (the ref the build job reads) |
| `packaging/lib/shell/` | the bash pipeline the build runs |
| `packaging/schema/` | the descriptor v2 and manifest JSON Schemas, with examples |
| `packaging/tests/` | unit suite, mirroring `lib/` |
| `packaging/scripts/` | repo tooling: `check-style.sh`, `install-anylinux-tools.sh`, `pin-builder-image.sh` |
| `.github/workflows/`, `.github/actions/` | build, publish, dispatch, tests, cask pinning |
| `dist/` | build output, gitignored |

## Prerequisites

- `bun` 1.4 (the version CI pins), `shellcheck`, and a Homebrew install for
  `brew style` and `brew audit`.
- JS dev dependencies: `bun install --frozen-lockfile --ignore-scripts`.
- A *local AppImage build* additionally needs an Arch Linux system or the
  pkgforge container, plus `jq`, `dpkg-deb`, `gpg`/`gpgv`, `quick-sharun` on
  `PATH` and `APPIMAGETOOL` pointing at the uruntime `appimagetool`. See "Local
  run" in `packaging/README.md`. Most changes do not need a full build.

## Checks

Run these before committing. CI runs the same set on every PR
(`.github/workflows/tests.yml`), so skipping them locally only moves the
failure to CI.

```sh
bun install --frozen-lockfile --ignore-scripts   # once
bun run typecheck                                # tsc --noEmit, strict
bun test                                         # unit suite
bun packaging/bin/fbr.ts cask --action check     # each cask matches its descriptor
bun run style                                    # brew style: rubocop, shellcheck, shfmt, actionlint
packaging/scripts/check-style.sh                 # everything above plus brew audit per cask
```

`packaging/scripts/check-style.sh` is the whole gate in one command, and can be
installed as a pre-push hook:

```sh
ln -sf ../../packaging/scripts/check-style.sh .git/hooks/pre-push
```

Take commands from this file, `package.json`, or the workflows — not from
memory or habit.

### Shell specifics

- `brew style` is the authority, not bare `shfmt`. Homebrew runs shfmt and then
  re-wraps `then`/`do` onto their own line, so write `if ...` newline `then`.
  Running `shfmt -w` directly collapses them and fights the same check.
- shfmt wants no space after a redirect: `>"${file}"`, not `> "${file}"`.
- `shellcheck` runs with `-x -P packaging` so the sourced libraries resolve.
- 2-space indent, LF, final newline, no trailing whitespace (`.editorconfig`;
  markdown is exempt from trailing-whitespace trimming).

### TypeScript and tests

- Strict `tsc --noEmit`; the CLI rejects unknown or duplicate flags with exit 2
  rather than ignoring them.
- Tests use Bun's built-in runner, live in `packaging/tests/` beside the group
  they cover, and must stay deterministic: the HTTP suites bind a local
  `127.0.0.1` server and every other URL in the tests is a string fixture. Do
  not add a test that reaches the real network.
- Cover the failure path, not only the happy path. Classified failures exit 3
  (upstream unavailable), 4 (guard), 5 (checksum), 6 (updater residue) and
  write a `--failure-out` fragment; everything else exits 1 / UNCLASSIFIED. A
  new code needs a site, a record entry and coverage — the contract tests scan
  the emission shapes.

## Making changes

- Smallest diff that does the job: no drive-by refactors, reformatting, renames
  or dependency bumps inside a change that does not need them.
- Adding an app needs three things — descriptor, desktop template plus a
  four-line `build.sh`, and a cask with placeholder checksums. The build matrix
  and dispatch route read the descriptor directory, so no workflow edit.
- Keep the docs true when behavior changes: descriptor fields, oracle kinds,
  CLI flags and gates belong in `packaging/README.md`; the root README's cask
  table stays complete and sorted by cask name.
- Report findings outside the requested scope instead of fixing them.

## Automation you should not fight

- **Cask versions and checksums** — written by the pipeline
  (`.github/actions/update-cask` → `fbr cask --action set-version`), never
  hand-edited, and not Renovate's to bump.
- **CI pins** — workflow `uses:` SHAs, container digests, the actionlint and
  `appimagetool` versions, and the digests in `install-anylinux-tools.sh` are
  Renovate's. Do not re-pin or tidy them.
- **`bun.lock`** — changes only alongside a deliberate dependency change.
- **Run-record delivery over OIDC** — a dispatched run posts `accepted` (from
  the `plan` job in `build.yml`), then one final `succeeded`/`failed`/`skipped`
  (from the `report` job in `build-appimage.yml`), to
  `api.edgarcnp.dev/v1/homebrew/tap/events` through
  `.github/actions/deliver-report`. Every attempt fetches a fresh GitHub OIDC
  token (audience `api.edgarcnp.dev`) from
  `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`; a token may
  deliver one body, so a retry reuses the body and its `event_id` with a new
  token. The API accepts tokens only from `refs/heads/main`, `workflow_dispatch`
  runs whose workflow file is `dispatch.yml`, `build.yml` or
  `build-appimage.yml`: a new workflow that posts events needs the API's
  allowlist extended first. There is no shared secret to set or rotate. The
  delivery is best-effort (`continue-on-error`) on purpose: it must never fail
  a run. Do not remove the grants or the action.
- **Build retries** — `retry.yml` owns failures: it re-runs a completed run's
  failed jobs when the run record's verdict says the failure is retryable, and
  opens an issue when it is terminal. The API owns readiness and re-asks after
  a not-ready skip, so the tap does not re-run skips. The budget lives in
  `packaging/lib/pipeline/retry.ts`; do not add a second retry path or move the
  budget into another workflow.

## CI map

| Workflow | What it does |
| --- | --- |
| `tests.yml` (`brew test-bot`) | PR gate: typecheck, tests, cask check, shellcheck, actionlint, `brew style`/`audit`, tap syntax |
| `build.yml` | build one app or all of them; the app list comes from the descriptors |
| `build-appimage.yml` | the reusable per-app build (container, toolchain, pack, smoke test) |
| `retry.yml` | on completion of a build run, re-runs it when the run record says a failure is retryable; opens an issue otherwise |
| `builder.yml` | rebuilds the `fbr-builder-base` image on Dockerfile changes and weekly, then pins it |
| `dispatch.yml` | entry point for API-dispatched builds (`request_id`, `app`, `version`); the run posts its own `accepted` report |
| `cask-smoke.yml` | installs and smoke-tests the casks on push to `main` and weekly |
| `publish.yml` (`brew pr-pull`) | pulls and publishes a named PR |
| `autobump.yml` (`brew bump`) | Homebrew's autobump, triggered only when the workflow file itself changes; inert on a cask-only tap |

## Where to read more

- [`README.md`](README.md) — installing, uninstalling, requirements, the cask
  table.
- [`packaging/README.md`](packaging/README.md) — the pipeline itself.
- `packaging/apps/<app>/README.md` — per-app build notes where an app has any.
