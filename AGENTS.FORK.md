# Fork Agent Rules

These rules are fork-specific and optimize day-to-day work in this fork.

## Branch Intents

- `main`: read-only mirror of `upstream/main`
- `pg/daily`: local integration branch (daily runtime/build branch)
- `pg/core/*`: upstream-PR candidates
- `pg/ext/*`: extension-track work
- `pg/private/*`: private/fork-only features
- `dev/*`: short-lived scratch branches

## Source of Truth

- For fork runtime and local behavior, `pg/daily` is the source of truth.
- `main` is the source of truth only for upstream parity.
- `pg/core/*` is disposable PR-prep surface, not runtime source of truth.

## Upstream Safety

For work that may go upstream:

1. Treat `CONTRIBUTING.md` as authoritative.
2. Keep diffs minimal and functional.
3. Do not include fork-local policy noise in PR branches.

## Validation Policy

- Always run `npm run check` after code changes.
- If the user asks for PR readiness (or references CONTRIBUTING), also run `./test.sh`.
- `npm run build` is allowed in this fork when needed to validate runtime behavior or fix stale cross-package type outputs.

## Cross-Package Build Order

When type mismatches suggest stale `dist/*.d.ts`:

1. `cd packages/ai && npm run build`
2. `cd packages/agent && npm run build`
3. `cd packages/coding-agent && npm run clean && npm run build`

When runtime behavior or an interactive-mode crash touches TUI code, also build:

1. `cd packages/tui && npm run build`
2. then rebuild `packages/coding-agent` so the linked `pi` runs against fresh package outputs

## Upstream Update Routine

When updating the fork to the latest upstream `main`:

1. Sync `main` from `upstream/main`.
2. Rebase `pg/daily` onto `main`.
3. If upstream changed `package.json`/`package-lock.json`, or `npm ls` reports invalid/stale dependencies, run `npm install` before builds.
4. Rebuild in the cross-package order above if the linked/runtime `pi` should reflect the update.
5. If upstream changed `packages/tui` or the issue being debugged is in interactive rendering, rebuild `packages/tui` before `packages/coding-agent`.

Important:
- `packages/ai/src/models.generated.ts` may change during `packages/ai` build because the model catalog is fetched live.
- `package-lock.json` may change during `npm install`.
- Do not commit those files as part of a routine fork update unless the task explicitly includes dependency-lock refresh or model-catalog refresh.

## Working Tree Safety

- If unexpected edits appear in files you did not touch in this session, pause and ask the user before editing/reverting those files.
- Never use destructive git operations (`reset --hard`, `checkout .`, `clean -fd`) unless explicitly requested.

## Branching Guidance

- Branch origin matrix (mandatory):
  - `pg/core/<topic>`: create from `main`
  - `pg/ext/<topic>`: create from `pg/daily` (default)
  - `pg/private/<topic>`: create from `pg/daily` (default)
  - `dev/<topic>`: create from `pg/daily` unless user asks to spike from another branch
- Use `main` as base for `pg/ext/*`/`pg/private/*` only when user explicitly asks for clean-slate isolation.
- Integrate finished work into `pg/daily` for daily usage:
  - `pg/core/*` -> prefer `git cherry-pick <commit>` (keep PR history clean)
  - `pg/ext/*` / `pg/private/*` -> prefer `git merge --no-ff <branch>` (keep feature history intact)
- Never commit directly on `main`.

## Worktree Guidance

- Prefer one active task per worktree.
- If parallel agents are working, use separate worktrees per branch/task to avoid accidental cross-edits.
- If the user gives an explicit worktree path, treat it as authoritative.
- Keep branch/worktree mapping clear (for example `pg/ext/<topic>` -> `../pi-mono-pg-ext-<topic>`).
- Do not remove/prune worktrees you did not create unless the user explicitly asks.
