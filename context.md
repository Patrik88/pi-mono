# Code Context

## Files Retrieved
1. `packages/coding-agent/src/core/agent-session.ts` (upstream/main: lines 1849-1875, 2968-3011) - compaction boundary guard and `getContextUsage()`; this is the main stale-context fix.
2. `packages/coding-agent/src/modes/interactive/components/footer.ts` (upstream/main: lines 85-115) - built-in footer now reads `session.getContextUsage()` and renders `?/window` after compaction.
3. `packages/coding-agent/src/core/extensions/types.ts` (upstream/main: lines 281-287, 608-613, 947-1008, 1214-1230, 1530-1542) - `ContextUsage`, extension event union, `appendEntry` action, and extension context actions; useful to confirm there is no `context_usage_changed`/session-mutation event.
4. `packages/coding-agent/src/core/extensions/runner.ts` (upstream/main: lines 617-675, 827-858) - extension context plumbing and message-only `emitContext()`.
5. `packages/coding-agent/src/core/sdk.ts` (upstream/main: lines 349-353) - `transformContext` still forwards only message arrays into `runner.emitContext()`.
6. `packages/coding-agent/src/core/compaction/compaction.ts` (upstream/main: lines 186-214, 747-845) - `estimateContextTokens()` still derives from last assistant usage plus trailing messages; used by compaction prep/error-path estimates.

## Key Code

### 1) Upstream changes that *do* partially solve the context-window issues
- Upstream/main contains commit `7eb969dd` (“show unknown context usage after compaction, fix multi-compaction boundary”).
- `ContextUsage.tokens` and `ContextUsage.percent` are now nullable:
  - `packages/coding-agent/src/core/extensions/types.ts:281-287`
- `AgentSession.getContextUsage()` now returns `{ tokens: null, percent: null }` after compaction until a post-compaction assistant response exists:
  - `packages/coding-agent/src/core/agent-session.ts:2968-3011`
- The interactive footer stopped reading the last assistant message directly and now uses session-derived context usage:
  - `packages/coding-agent/src/modes/interactive/components/footer.ts:85-115`
- `_checkCompaction()` avoids stale overflow detection by checking the latest compaction boundary and rejecting pre-compaction usage:
  - `packages/coding-agent/src/core/agent-session.ts:1849-1875`
- Upstream also added extension compaction helpers in commit `9d3f8117` and exposed session-level context usage in commit `835296b1`:
  - `packages/coding-agent/src/core/extensions/runner.ts`
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/core/agent-session.ts`

### 2) Problems still unsolved upstream
- There is still **no explicit invalidation / change event** for context-affecting extension state.
- I found no `context_usage_changed` API/event in upstream/main.
- The extension event model still only has `context` (message transform) and no session/context mutation event in the event union:
  - `packages/coding-agent/src/core/extensions/types.ts:947-1008`
- `appendEntry` exists only as an action, not as an observable mutation event:
  - `packages/coding-agent/src/core/extensions/types.ts:1214-1230`
- `runner.ts` still exposes `getContextUsage()` to extensions, but there is no push notification when that value becomes stale:
  - `packages/coding-agent/src/core/extensions/runner.ts:617-675`
- `sdk.ts` still sends only `messages` through `transformContext`, so context-affecting extension state changes are not propagated as a distinct invalidation signal:
  - `packages/coding-agent/src/core/sdk.ts:349-353`

### 3) Refresh impact
- **If your local checkout predates `7eb969dd`, refreshing to upstream/main should immediately improve the footer and compaction behavior** by hiding stale post-compaction usage.
- **On the branch I inspected, that fix is already present**, so refresh will not materially change the first two issues.
- **Refresh will not solve the remaining invalidation/event gap**, because upstream/main still lacks a dedicated context-change or session-mutation event.

## Architecture
- `AgentSession` is the source of truth for current context usage and compaction checks.
- `FooterComponent` consumes `session.getContextUsage()` for UI display.
- Extensions can query `ctx.getContextUsage()` and trigger `ctx.compact()`, but upstream/main does not notify extensions when context-affecting state changes.
- `sdk.ts` still feeds only transformed message arrays into the extension runner, so the context pipeline is still message-centric rather than event-driven for session-state invalidation.

## Start Here
Open `packages/coding-agent/src/core/agent-session.ts` first. It contains both the stale-usage guard in `_checkCompaction()` and the authoritative `getContextUsage()` logic that the footer and extensions rely on.
