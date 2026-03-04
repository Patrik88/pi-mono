# Fork Agent Rules

These rules are fork-specific and optimize day-to-day work in this fork.

## Branch Intents

- `sync/main`: read-only mirror of `upstream/main`
- `pg/daily`: local integration branch (daily runtime/build branch)
- `pg/core/*`: upstream-PR candidates
- `pg/ext/*`: extension-track work
- `pg/private/*`: private/fork-only features
- `dev/*`: short-lived scratch branches
- `codex/*`: temporary agent work branches (treat like `dev/*`)

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

## Working Tree Safety

- If unexpected edits appear in files you did not touch in this session, pause and ask the user before editing/reverting those files.
- Never use destructive git operations (`reset --hard`, `checkout .`, `clean -fd`) unless explicitly requested.

## Branching Guidance

- New upstream-candidate work starts from `sync/main` into `pg/core/<topic>`.
- Extension/private features start from `sync/main` into `pg/ext/<name>` or `pg/private/<topic>`.
- Integrate finished work into `pg/daily` for daily usage:
  - `pg/core/*` -> prefer `git cherry-pick <commit>` (keep PR history clean)
  - `pg/ext/*` / `pg/private/*` -> prefer `git merge --no-ff <branch>` (keep feature history intact)
- Never commit directly on `sync/main`.

## Worktree Guidance

- Prefer one active task per worktree.
- If parallel agents are working, use separate worktrees per branch/task to avoid accidental cross-edits.
- If the user gives an explicit worktree path, treat it as authoritative.
- Keep branch/worktree mapping clear (for example `pg/ext/<topic>` -> `../pi-mono-pg-ext-<topic>`).
- Do not remove/prune worktrees you did not create unless the user explicitly asks.
