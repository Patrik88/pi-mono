# Core PR Profile

Use this profile on `pg/core/*` branches (or any branch intended for upstream PR).

## Goal

Produce a clean, reviewable upstream-ready diff.

## Required Behavior

1. Follow `CONTRIBUTING.md` exactly.
2. Keep scope tight to the user task.
3. Prefer small, comprehensible commits.
4. Explain edge cases and tradeoffs in technical terms.
5. Branch base should be `main` (not `pg/daily`).
6. Do not merge `pg/daily` into `pg/core/*`; cherry-pick only the required commits.

## Mandatory Checks Before "ready"

1. `npm run check`
2. `./test.sh`

If either fails, fix or clearly report blockers.

## Diff Hygiene

Do not include fork-local policy/workflow files unless explicitly requested:

- `AGENTS.md`
- `AGENTS.FORK.md`
- `AGENTS.CORE_PR.md`
- `AGENTS.EXTENSION.md`
- `PI_MONO_WORKFLOW_PLAYBOOK.md`
- local scratch notes

## Core-Minimalism Gate

If the change smells like product customization, integration preference, or policy-specific behavior, propose extension/private-track alternative and ask user which path to continue.
