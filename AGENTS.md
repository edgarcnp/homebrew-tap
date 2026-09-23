# AGENTS.md — edgarcnp/homebrew-tap

Repo-specific rules. Global agent policy lives in `~/.config/opencode/AGENTS.md`
and takes precedence over this file except where a rule here is more specific.

## Commits

Conventional Commits, matching the existing history:

- `feat(packaging): ...` — new apps, descriptors, pipeline changes
- `chore(cask): update <app> to <version>` — automated cask bumps
- `fix(cask): ...` / `fix(packaging): ...` / `fix(ci): ...`

**Never add a `Co-Authored-By` trailer to commits in this repository.** That
includes `Co-Authored-By: OpenCode <noreply@opencode.ai>` and any other
agent-attribution trailer. Attribution trailers here belong to the bots that
open their own commits (renovate, dependabot, copilot); hand-authored commits
carry none. Ask before adding any trailer at all.
