# AGENTS.md — edgarcnp/homebrew-tap

A guide for LLM agents working in this repository. LLM assistance in this repo
is not going away, so this file exists to steer it: toward small, reviewable
changes a human can check afterwards, and away from volume for its own sake.
Read it before touching anything, and prefer what the repository says over what
you assume.

Global agent policy lives in `~/.config/opencode/AGENTS.md` and takes
precedence over this file except where a rule here is more specific.

## What this repo is

A Homebrew tap of **Linux-only** casks, each shipping an AppImage built by the
toolchain in `packaging/`. One pipeline serves every app — what differs per app
is **data** (`packaging/apps/<app>/app.json`), never a forked script.

[`packaging/README.md`](packaging/README.md) is the reference: layout, every
descriptor field, the oracle kinds, the `fbr` CLI, the run record, the
verification and build models, and the steps to add an app. Read the section you
are about to change instead of guessing at it.

Facts worth holding onto:

- The app id is one string end to end: directory name, `id`, `cask`,
  `assetPrefix`, and `Casks/<app>.rb`.
- TypeScript runs directly on Bun — no build step, no runtime dependencies.
  `typescript` and `@types/bun` are dev-only. A new dependency needs asking first.
- `packaging/lib/` is a library: no import-time side effects. `bin/fbr.ts` is the
  only entry point, `lib/cli.ts` composes it.
- Casks are not Renovate's: versions and checksums come from this pipeline.

## Layout

| Path | What lives there |
| --- | --- |
| `Casks/<app>.rb` | the cask: version and `sha256` pinned |
| `packaging/apps/<app>/` | `app.json` descriptor, `build.sh` shim, templates, key material |
| `packaging/bin/fbr.ts` | the CLI; `packaging/lib/{core,pipeline,oracles,shell}/` its library |
| `packaging/lib/shell/` | the bash pipeline the build runs |
| `packaging/tests/` | unit suite, mirroring `lib/` |
| `packaging/scripts/` | repo tooling: `check-style.sh`, `install-anylinux-tools.sh` |
| `.github/workflows/`, `.github/actions/` | build, publish, dispatch, tests, cask pinning |
| `dist/` | build output, gitignored |

## Gates

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

Take commands from this file, `package.json`, or CI — never from memory.

### Shell specifics

- `brew style` is the authority, not bare `shfmt`. Homebrew runs shfmt and then
  re-wraps `then`/`do` onto their own line, so write `if ...` newline `then`.
  Running `shfmt -w` directly collapses them and fights the same check.
- shfmt wants no space after a redirect: `>"${file}"`, not `> "${file}"`.
- `shellcheck` is run with `-x -P packaging` so the sourced libraries resolve.
- 2-space indent, LF, final newline, no trailing whitespace (`.editorconfig`;
  markdown is exempt from trailing-whitespace trimming).

## Changing pipeline code

- Smallest diff that does the job: no drive-by refactors, reformatting, renames
  or dependency bumps inside a change that does not need them.
- The failure path is part of the change. Classified failures exit 3 (upstream
  unavailable), 4 (guard), 5 (checksum), 6 (updater residue) and write a
  `--failure-out` fragment; everything else is exit 1 / UNCLASSIFIED. A new code
  needs a site, a record entry and coverage — the contract tests scan the
  emission shapes.
- Tests live next to the group they cover. They must stay deterministic: the
  HTTP suites bind a local `127.0.0.1` server, and every other URL in the tests
  is a string fixture. Do not add a test that reaches the real network, and
  cover the failure path, not only the happy path.
- Keep the docs true when behavior changes: descriptor fields, oracle kinds,
  CLI flags and gates belong in `packaging/README.md`; the root README's cask
  table stays complete and sorted by cask name.

## Hands off

- **Cask versions and checksums** — written by the pipeline
  (`.github/actions/update-cask` → `fbr cask --action set-version`), never
  hand-edited, and not Renovate's to bump.
- **CI pins** — workflow `uses:` SHAs, container digests, the actionlint and
  `appimagetool` versions, and the digests in `install-anylinux-tools.sh` are
  Renovate's. Do not re-pin or tidy them.
- **`bun.lock`** — changes only alongside a deliberate dependency change.
- Anything outside the requested scope: report the finding, do not fix it.

## Commits

Conventional Commits, matching the existing history:

- `feat(packaging): ...` — new apps, descriptors, pipeline changes
- `chore(cask): update <app> to <version>` — automated cask bumps
- `fix(cask): ...` / `fix(packaging): ...` / `fix(ci): ...`
- `docs: ...` — documentation only

Commit only when the user asks, and push only when asked.

**Never add a `Co-Authored-By` trailer to commits in this repository.** That
includes `Co-Authored-By: OpenCode <noreply@opencode.ai>` and any other
agent-attribution trailer. Attribution trailers here belong to the bots that
open their own commits (renovate, dependabot, copilot); hand-authored commits
carry none. Ask before adding any trailer at all.
