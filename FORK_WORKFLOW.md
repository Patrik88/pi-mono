# Fork Workflow

This workflow keeps your fork productive for local/custom work while keeping upstream PRs clean.

## Branch Strategy

- `sync/main`: mirror of `upstream/main` (no fork-specific changes)
- `pg/daily`: local integration branch for day-to-day runtime/builds
- `pg/core/<topic>`: candidate work that may become upstream PRs
- `pg/ext/<name>`: extension work (public or internal)
- `pg/private/<topic>`: private features (never intended for upstream)
- `dev/<topic>`: short-lived scratch branches
- `codex/*`: temporary agent work branches

## AGENTS.md Policy

- Fork-specific agent rules are allowed on `pg/ext/*`, `pg/private/*`, `pg/daily`, `dev/*`, and `codex/*`.
- Avoid fork-specific `AGENTS.md` edits on `pg/core/*`.
- Before opening an upstream PR, ensure `AGENTS.md` and other policy files are not in the diff.
- Profile files:
  - `AGENTS.FORK.md` (fork baseline)
  - `AGENTS.CORE_PR.md` (strict upstream-PR profile)
  - `AGENTS.EXTENSION.md` (extension/private profile)

## Daily Flow

1. Sync baseline:
   - `git checkout sync/main`
   - `git fetch upstream --prune --tags`
   - `git merge --ff-only upstream/main`
   - `git push origin sync/main`
2. Start work:
   - `git checkout -b pg/core/<topic> sync/main`
   - or `git checkout -b pg/ext/<name> sync/main`
   - or `git checkout -b pg/private/<topic> sync/main`
3. Keep your daily integration branch current:
   - `git checkout pg/daily`
   - `git rebase sync/main`
4. Integrate finished work into `pg/daily`:
   - `pg/core/*` via `git cherry-pick <commit>`
   - `pg/ext/*` / `pg/private/*` via `git merge --no-ff <branch>`

## PR-Clean Branch Prep

For upstream PR branches (`pg/core/*`):

1. Keep only functional changes.
2. Remove fork-local policy noise:
   - `AGENTS.md`
   - `CONTRIBUTING.md`
   - `.husky/*` (unless explicitly part of PR scope)
   - local notes/docs used only for your fork workflow
3. Verify diff:
   - `git diff --name-only upstream/main...HEAD`

## Extension/Private Work

- Prefer `pg/ext/*` for feature ideas that likely do not belong in core.
- Keep `pg/private/*` for personal workflows and experiments.
- Do not force these into `pg/core/*` unless scope is explicitly approved.
