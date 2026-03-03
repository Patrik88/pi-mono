# Extension/Private Profile

Use this profile on `pg/ext/*`, `pg/private/*`, `pg/daily`, `dev/*`, and `codex/*` branches.

## Goal

Optimize for fast iteration and local value while keeping code quality high.

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
- `pg/daily` is the integration/runtime branch; prefer:
  - `git cherry-pick` from `pg/core/*`
  - `git merge --no-ff` from `pg/ext/*` and `pg/private/*`
