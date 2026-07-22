# Tool call and result display modes

- **Status:** Draft design spec
- **Owner:** `packages/coding-agent` interactive TUI
- **Current behavior:** Tool calls and results share one `ToolExecutionComponent`; tool results use a global `expanded: boolean`, and registered tools without `renderCall` may show only the tool name.
- **Backlog:** Implementation, rendering tests, settings/keybinding decisions, and real-session validation.

## Problem

For agent and extension development, the exact tool call is often more useful than its output. The TUI should expose what the model actually sent—including parameter names such as `offset` and `limit`—without making every tool execution consume a large vertical block.

The current compact presentation can hide the tool protocol:

```text
read ~/project/file.ts:1-280
```

The desired minimal presentation makes the actual arguments visible:

```text
read(path="~/project/file.ts", offset=1, limit=280)  ✓ 280 lines
```

Minimal display must avoid the current shell overhead: no mandatory leading spacer, box margin, or vertical padding.

## Goals

- Make actual model-supplied tool arguments visible by default.
- Keep a completed tool execution to at most one visual terminal row in the default mode.
- Separate tool-call detail from tool-result detail.
- Implement the baseline centrally; built-in and extension tools must not require individual changes.
- Preserve existing specialized result renderers for compact and full output.
- Make all truncation or omission visible.

## Non-goals

- Showing parameters that the model did not send.
- Showing the complete tool schema on every call.
- Changing session JSONL or creating additional persisted entries.
- Changing model-context truncation, output storage, or `ToolOutputPolicy` semantics.

## Display model

```ts
type ToolCallDisplayMode = "minimal" | "full";
type ToolResultDisplayMode = "minimal" | "compact" | "full";
```

Proposed default:

```json
{
  "toolDisplay": {
    "call": "minimal",
    "result": "minimal"
  }
}
```

The exact setting names remain open, but call and result state must be independent.

## Tool call modes

### Minimal

Render the actual supplied arguments as a generic, function-like, no-wrap line:

```text
read(path="~/project/file.ts", offset=1, limit=280)
task_manager(action="bookmark-types")
runtime_preset(action="list")
web_search(query="Pi coding agent", numResults=3, workflow="none")
```

Rules:

1. Preserve real top-level parameter names; do not silently rewrite `offset` and `limit` into `:1-280`.
2. Render short scalar values exactly.
3. Quote and escape strings deterministically.
4. Summarize large strings, arrays, and objects with a visible `…`, item count, or key count.
5. Fit within one visual terminal row. Progressively shorten values before omitting arguments.
6. If all arguments still cannot fit, show an explicit omission marker such as `+3 args`; never omit silently.
7. While arguments stream, update the same row; incomplete data must be visibly marked.
8. Use no vertical spacer, margin, or padding in minimal mode.

Minimal is a transparent serialization of the call, not a semantic paraphrase supplied by each tool.

### Full

Show the complete stored argument object in a lossless, pretty-printed representation:

```text
read
{
  "path": "/Users/pg/project/file.ts",
  "offset": 1,
  "limit": 280
}
```

Small calls may render identically in minimal and full mode if no information is hidden.

## Tool result modes

### Minimal

Render result state as an inline suffix on the call row when possible:

```text
read(path="…", offset=1, limit=280)  …
read(path="…", offset=1, limit=280)  ✓ 280 lines · 14.2 KB
bash(command="rg -n …", timeout=20)  ✗ exit 2 · 0.3s
```

The generic baseline may use:

- running, success, or error state;
- line and byte counts;
- image/content-block counts;
- a bounded first error diagnostic;
- duration or exit code when centrally available.

An empty successful result may use only `✓`. Tool-specific summaries may be added later, but are optional and must not be required for the baseline.

### Compact

Use the existing specialized result renderer with legacy collapsed behavior:

```ts
renderResult(result, { expanded: false }, theme, context)
```

Compact output may occupy multiple rows.

### Full

Use the existing specialized result renderer with expanded behavior:

```ts
renderResult(result, { expanded: true }, theme, context)
```

Full means all output retained and available to the renderer, subject to existing storage/truncation policy.

## Interaction

Proposed controls:

- `Ctrl+O`: cycle result mode `minimal → compact → full → minimal`.
- `Ctrl+Shift+O`: toggle call mode `minimal ↔ full` in the main chat context.
- Show a short status message after changing modes.

The tree view already uses `Ctrl+Shift+O`; contextual keybinding compatibility must be verified.

## Core implementation approach

The baseline belongs in Pi core, primarily `ToolExecutionComponent`:

- It already owns `toolName`, `args`, argument-completion state, result, partial state, and error state.
- Minimal call rendering should serialize `args` centrally.
- Minimal result rendering should bypass extension `renderResult` so core can guarantee one row.
- Minimal mode should bypass the current `Spacer(1)` and `Box(1, 1)` shell.
- Compact/full result modes should retain existing tool renderers.
- Full call rendering should use the stored arguments, independent of whether a tool implements `renderCall`.

Likely touchpoints:

- `src/modes/interactive/components/tool-execution.ts`
- `src/modes/interactive/interactive-mode.ts`
- `src/core/settings-manager.ts`
- `src/core/keybindings.ts`
- `src/core/extensions/types.ts`
- settings/keybindings/TUI documentation and rendering tests

No built-in or extension tool needs modification for the generic MVP.

## Compatibility

Existing result renderers continue to receive the boolean API in compact/full modes:

- compact: `expanded: false`
- full: `expanded: true`
- minimal: renderer is bypassed

For the legacy `setToolsExpanded(boolean)` API, the compatibility mapping should preserve prior meaning:

- `true` → result `full`
- `false` → result `compact`

A new API is required to select `minimal` explicitly. New renderer context may expose the richer display mode without requiring existing renderers to change.

## Data and authority boundaries

- The displayed call must derive from the actual stored/streamed argument object.
- Defaults or optional schema parameters that the model did not send are not added to the call display.
- Schema inspection is a separate possible feature.
- Display modes are TUI projections only.
- `ToolOutputPolicy` remains responsible for byte/line limits, storage, model context, compaction, and truncation strategy; it must not be overloaded with TUI view state.

## Acceptance examples

Default minimal mode should render a successful read in one row total:

```text
read(path="~/Sites/tools/pi-mono/…/output-policy.ts", offset=1, limit=280)  ✓ 280 lines
```

A long command must remain one row with visible truncation:

```text
bash(command="git -C /Users/pg/Sites/tools/pi-mono diff main...pg/daily -- …", timeout=20)  ✓ 323 lines · 0.4s
```

A registered extension tool without `renderCall` must still expose its actual arguments:

```text
task_manager(action="bookmark-types")  ✓ 7 lines
```

Switching result mode to compact/full must reveal existing specialized output without changing the persisted session or model-visible context.
