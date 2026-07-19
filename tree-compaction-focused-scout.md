# Findings

A) **Built-in `/tree` is not extensible in-place.** `showTreeSelector()` instantiates `TreeSelectorComponent` directly and the only post-select behavior is navigate-then-summary flow; there is no callback surface for extra actions (`interactive-mode.ts:4170-4253`). Inside the selector, `handleInput()` hardwires built-in keybinding IDs like `app.tree.foldOrUp`, `app.tree.filter.*`, and `app.tree.editLabel`; it only calls `onSelect`, `onCancel`, or `onLabelEdit` (`tree-selector.ts:899-990`, `tree-selector.ts:1152-1170`). Extension shortcuts are wired only to the default editor, not to the tree selector (`interactive-mode.ts:1675-1684`).

B) **Yes, a pure extension can open its own tree UI and operate on selected leaves, but only by building the UI itself.** Extensions get an arbitrary UI surface via `ctx.ui.custom(...)` and generic controls like `select`, `input`, `notify`, and editor replacement (`interactive-mode.ts:1977-2008`). The public package root exports `TreeSelectorComponent`, so an extension can import/reuse the same component (`index.ts:320-338`). Extensions also get read-only tree data through `ctx.sessionManager.getTree()` / `getBranch()` / `getEntry()` / `getLeafId()` (`session-manager.ts:152-199`, `session-manager.ts:1071-1113`). In command handlers, `ExtensionCommandContext` adds `navigateTree(...)` and `compact(...)` (`extensions/types.ts:337-364`, `extensions/types.ts:1134-1183`, `extensions/runner.ts:650-682`). Event-handler context does **not** include `navigateTree`, so navigation requires a registered command or some other command-capable path.

C) **Built-in compaction targets only the active branch.** `AgentSession.compact()` always uses `this.sessionManager.getBranch()` with no target argument, then passes that active path to `prepareCompaction(...)` (`agent-session.ts:1756-1773`, `compaction.ts:614-689`). The TUI command just forwards to `this.session.compact(customInstructions)` (`interactive-mode.ts:5426-5446`). So arbitrary leaf compaction is **not** possible without first changing the active leaf or adding a core API. `navigateTree()` can move the active leaf via `sessionManager.branch()` / `resetLeaf()` and then rebuild the session context (`agent-session.ts:2821-2978`), but that is still a state-changing navigation step, not leaf-targeted compaction.

D) **Best extension-only path is a custom tree/command overlay that navigates first, then compacts.** **Ideal core patch** would be a leaf-targeted compaction entry point so extensions can compact a chosen node directly, without mutating the user’s active position.

# Feasible Designs (ranked)

1. **Extension command + custom tree overlay + navigate-then-compact**  
   Use `pi.registerCommand(...)` and `ctx.ui.custom(...)` to show a tree picker built from `ctx.sessionManager.getTree()`; on selection, call `ctx.navigateTree(entryId, { summarize: false })` and then `ctx.compact(customInstructions)`. This is feasible now with no core changes, but it changes the active leaf and therefore the visible session state (`extensions/types.ts:337-364`, `session-manager.ts:1071-1113`, `agent-session.ts:2821-2978`, `agent-session.ts:1756-1836`).

2. **Extension command + flat chooser**  
   Simpler to implement with `ctx.ui.select(...)` or a custom list built from `getTree()`. Same navigation/compact limitation, less UX work.

3. **Core patch: target-aware compaction API + optional tree action hook**  
   Add `compactAt(entryId, ...)` or `ctx.compact({ leafId: ... })`, and expose a tree action callback in the built-in selector so extensions can request compaction on the currently highlighted node. This makes the built-in `/tree` view directly extensible and removes the need to reimplement a tree UI.

# Recommended MVP

Build an extension command that opens a custom overlay using the exported `TreeSelectorComponent`, reads tree data from `ctx.sessionManager.getTree()`, and on selection performs `navigateTree(..., { summarize: false })` followed by `compact(...)`. This is the smallest change that can ship without touching core, and it preserves the existing tree selector visuals/behavior as much as possible (`index.ts:320-338`, `interactive-mode.ts:1977-2008`, `tree-selector.ts:1152-1170`).

# Core Patch Wishlist

- Add a **targeted compaction API** that compacts a specific leaf/entry ID rather than the current leaf (`agent-session.ts:1756-1773`).
- Plumb that API through `ExtensionCommandContext` and maybe `ExtensionContext` if appropriate (`extensions/types.ts:327-330`, `extensions/types.ts:354-364`).
- Add a **tree action hook** or action registry to `TreeSelectorComponent` so the built-in `/tree` can trigger extension-defined actions on the selected entry (`tree-selector.ts:899-990`, `interactive-mode.ts:4170-4253`).
- Optional: expose a convenience API that returns to the previous leaf after target compaction if that matches desired UX.

# Risks / Open Questions

- `navigateTree(..., { summarize: false })` still mutates session state; if the UX requires “compact this leaf without moving me,” the core patch is mandatory.
- If navigation uses summarization, it will create branch-summary entries and may be surprising (`agent-session.ts:2842-2971`, `branch-summarization.ts:98-236`).
- `TreeSelectorComponent` currently has only select/cancel/label-edit hooks, so any extra action surface needs an API design change rather than a small flag.
- The current public API exposes read-only session tree data, but not arbitrary branch mutation or leaf-targeted compaction (`session-manager.ts:184-199`, `extensions/types.ts:300-330`).