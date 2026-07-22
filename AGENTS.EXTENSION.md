# Extension/Private Profile

Use this profile on `pg/ext/*`, `pg/private/*`, `pg/daily`, and `dev/*` branches.

## Goal

Optimize for fast iteration and local value while keeping code quality high.

## Branch Origin Rules

- `pg/daily` is the fork runtime/source-of-truth branch.
- For extension/private-track work, create new branches from `pg/daily` by default:
  - `pg/ext/<topic>` from `pg/daily`
  - `pg/private/<topic>` from `pg/daily`
  - `dev/<topic>` from `pg/daily` unless the user asks otherwise
- Use `main` as a base for extension/private work only if the user explicitly asks for clean-slate isolation.

## Allowed Focus

1. Extension-first implementations
2. Private workflow features
3. Experiments/prototypes
4. Fork-local tooling and policy improvements

## Validation Policy

- Always run `npm run check` after code changes.
- Run targeted tests for touched packages.
- Run `./test.sh` when user asks for full confidence or release/PR readiness.

## Runtime Validation

`npm run build` is allowed when needed for:

1. local runtime testing,
2. dist/type sync across workspaces,
3. reproducing user-reported build/runtime errors.

Recommended order for cross-package consistency:

1. `packages/ai`
2. `packages/agent`
3. `packages/coding-agent`

## Change Management

- Fork-local documentation and guardrails are welcome here.
- If the user later wants upstream PR, create/switch to `pg/core/*` and strip fork-only files from the PR diff.
- `pg/daily` is the integration/runtime branch:
  - use `git cherry-pick` from `pg/core/*` when daily-runtime integration is intended
  - use `git merge --no-ff` from completed `pg/ext/*` and `pg/private/*` branches
- Perform mutating extension/private/docs/config/policy tasks in dedicated topic worktrees, commit after required validation, and merge into `pg/daily` only when the complete task is ready.
