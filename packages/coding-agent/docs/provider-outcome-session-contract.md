# Provider Outcome and Multi-Provider Session Contract

Status: design proposal only. No production behavior is changed by this document.

## Problem statement

Pi's provider stream contract terminates failures with an `AssistantMessage` whose `stopReason` is `"error"` or `"aborted"`. Providers commonly produce this shape with `content: []`, zero usage, and an `errorMessage`. `AgentSession` then emits the value as `message_end` and persists it through `SessionManager.appendMessage()` as an ordinary `type: "message"` entry.

That representation conflates two different facts:

1. **Provider stream state:** a request terminated, with diagnostics, usage, retry classification, response identifiers, and possibly partial assistant content.
2. **Durable conversation:** content that should be replayed to a later model as an assistant turn.

An empty failed request is operational history, not an empty assistant utterance. Persisting it as conversational history makes provider-local failure shells visible to later providers, extensions, compaction, exports, and compatibility bridges. It also forces retry and overflow code to remove the failed assistant from in-memory context after it has already been treated as a message.

The required boundary is therefore not a provider-specific patch. It is a typed session projection rule: preserve the outcome in the session tree and user interface, but only project actual assistant content into provider-visible conversation history.

## Current-layer inventory

The following inventory separates creation, transport, persistence, projection, policy, rendering, and interchange.

| Layer | Current behavior | Required consequence |
| --- | --- | --- |
| `packages/ai/src/types.ts` | `StreamFunction` encodes terminal failures in `AssistantMessageEvent.error`; `AssistantMessage` carries content, model identity, diagnostics, usage, stop reason, and error text. | Keep this provider-stream contract initially. A failed stream can still contain partial visible assistant content. Do not make provider adapters understand session entries. |
| Provider adapters, including `openai-codex-responses.ts` | Initialize `content: []`; catch request/protocol/abort failures; set `stopReason`, `errorMessage`; emit `error`. Partial blocks may already exist when failure occurs. | Normalize at the agent/session boundary, after the terminal stream value is complete. Preserve partial content when present. |
| `pi-messages.ts` | Reconstructs the same terminal `AssistantMessage`; local HTTP/SSE failures create an empty error assistant. | The wire protocol remains a provider-stream protocol, not the durable session interchange format. Gate any future wire evolution separately. |
| Agent core state/events | Final assistant values participate in `message_start`/`message_end`, turn and agent events, and agent state. | Existing stream listeners need a compatibility phase. Add an outcome event rather than silently changing all message events in one release. |
| `packages/coding-agent/src/core/agent-session.ts` | Every assistant `message_end` is persisted with `appendMessage()`. Retry and overflow inspect the failed assistant, then remove the last assistant from agent state before retry/compaction. It emits retry, compaction, and final-error events from the same value. | This is the primary normalization boundary. Classify terminal provider output before persistence and before the next context is built. Retry/overflow consume the typed outcome directly. |
| `packages/coding-agent/src/core/session-manager.ts` | `SessionMessageEntry` is projected unconditionally by `sessionEntryToContextMessages()`. Branch, resume, fork, list, and compaction operate over the resulting tree/path. Session version is 3. | Introduce a non-context `provider_outcome` entry in session v4. Branch/tree retain it; `buildSessionContext()` omits it. Migration converts only legacy empty failed assistants. |
| `packages/agent/src/harness/session/*` | The newer harness has its own typed session tree, projection, compaction checkpoint, and storage contracts. | Add the same semantic entry and projection rule there; avoid leaving coding-agent and harness formats with different meanings. |
| Overflow/retry (`utils/overflow.ts`, `agent-session.ts`) | Detects overflow from failed assistant error text and usage; transient retry classification also accepts an assistant. | Extract a shared provider-outcome view/classifier accepting either a stream assistant or durable outcome during migration. Preserve one compact-and-retry attempt and retry budgets. |
| Compaction and summarization | Error/aborted assistant usage is ignored, but empty failed messages can still occupy chronology and enter message preparation/context unless removed by special paths. Token estimates see zero content. | Outcomes remain chronological tree entries but never become summary input or retained model tail unless a renderer deliberately summarizes diagnostics for humans. Usage/cost aggregation remains available out of band. |
| Interactive UI | `AssistantMessageComponent` renders partial content and appends error/abort text. Retry UI may later replace/update the visible failure. Tool-call failures have special rendering. | Render `provider_outcome` as a status/error component. If partial assistant content exists, render a normal assistant message plus an associated outcome, not a synthetic error text message. |
| Print mode | Prints error text for failed/aborted assistants, otherwise prints content. | Print the outcome diagnostics; print partial assistant content separately when present. |
| HTML export | Exports session entries and pre-renders tool calls/results found in message entries. Browser templates consume the serialized entry set. | Export outcome entries losslessly and render them as non-conversational timeline items. Sanitized export must use the same diagnostic redaction policy. |
| RPC | `get_entries` returns the `SessionEntry` union; live subscriptions expose agent/session events. | Version RPC capabilities; add `provider_outcome` to entry results and a typed live event. Old clients may display an unknown non-executable entry but must not reinterpret it as a message. |
| Extensions | `message_end` hooks can inspect/replace an assistant with the same role; entry renderers currently target extension custom entries; compaction hooks receive session entries. | Add read-only `provider_outcome` notification and a renderer path. Do not let outcome hooks inject provider-visible content implicitly; extensions must create an explicit `custom_message` or assistant content entry. |
| Resume, fork, branch/tree | Copy or traverse every entry. Model state can currently be inferred from assistant messages, including failures. | Outcome entries stay in the tree and are copied. Model selection state may observe their attempted provider/model only for display; active model derivation remains `model_change` or last conversational assistant, avoiding a failed attempted switch becoming conversational state. |
| Session listing/search | Counts every `message` entry and extracts user/assistant text. Empty failures increase message count but add no searchable text. | Outcomes receive a separate attempt/failure count and activity timestamp; they do not inflate conversational message count. |
| Usage/cost totals | Consumers scan assistant messages and summary usage. | Count reported outcome usage/cost in operational totals, tagged by source, without using it as a context baseline. |

No live provider call is needed to verify this inventory or the proposed boundary.

## Proposed typed contracts

### Provider stream result

Provider adapters continue to emit `AssistantMessageEvent`. At the consumer boundary, a terminal failed assistant is split conceptually into content and outcome:

```ts
interface ProviderOutcomeV1 {
  version: 1;
  status: "error" | "aborted";
  phase: "before_content" | "after_partial_content" | "after_tool_call";
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  errorMessage: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  timestamp: number;
  retry?: {
    classification: "overflow" | "transient" | "terminal" | "unknown";
    attempt?: number;
    maxAttempts?: number;
    willRetry: boolean;
  };
}
```

The field set is intentionally diagnostic and non-executable. It contains no content blocks, roles, tool call arguments, tool results, system instructions, or opaque provider continuation payloads. Diagnostics retain existing redaction and size bounds. `errorMessage` is required after normalization, using the current human-readable fallback when the provider omitted it.

A terminal stream assistant is normalized as follows:

- `stopReason` is successful: persist one normal assistant message.
- failed/aborted with no visible content and no complete tool call: persist one `provider_outcome` entry, no assistant message.
- failed/aborted with text or thinking content: persist the partial assistant message with a non-success completion marker that is not replayed as a completed provider turn unless the target provider adapter explicitly supports partial replay; persist a linked outcome entry.
- failed/aborted after a complete tool call: persist the assistant tool-call message and linked outcome. Tool execution must not begin merely because a call appeared before a failed terminal event unless the existing agent state already accepted that call as complete.

The production design should use an internal normalization result rather than mutating the original stream object:

```ts
type NormalizedProviderTermination =
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "outcome"; outcome: ProviderOutcomeV1 }
  | { kind: "partial_assistant_with_outcome"; message: AssistantMessage; outcome: ProviderOutcomeV1 };
```

### Durable session entry

Session v4 adds:

```ts
interface ProviderOutcomeEntry extends SessionEntryBase {
  type: "provider_outcome";
  outcome: ProviderOutcomeV1;
  assistantEntryId?: string;
  requestEntryId?: string;
}
```

`assistantEntryId` links an outcome to persisted partial content. `requestEntryId` is optional because current sessions do not have a first-class request entry; it is reserved for a later version and must not be synthesized from user entry IDs without a defined request model.

`ProviderOutcomeEntry` participates in chronology, tree navigation, labels, activity timestamps, export, RPC, usage accounting, and human rendering. It never projects to `AgentMessage` in `buildSessionContext()`.

## Session v4 migration

Migration is deterministic and local, but v4 must not use the current in-place `_rewriteFile()` path. Opening a legacy session performs a side-by-side, atomic migration transaction and leaves the legacy source unchanged.

For each v1-v3 `type: "message"` entry whose message has role `assistant`:

1. If `stopReason` is neither `error` nor `aborted`, leave it unchanged.
2. If content is empty or missing after existing null-content normalization, replace the entry in place with `type: "provider_outcome"`, preserving `id`, `parentId`, and entry timestamp. Build `ProviderOutcomeV1` from the assistant fields.
3. If content has any block, leave the message unchanged for backward compatibility. A later explicit migration may split partial content only after provider replay conformance is proven.
4. If malformed usage is absent, supply zero usage and attach a migration diagnostic; do not reject the whole session.
5. Unknown content-bearing assistant shapes fail closed: retain the original entry, exclude unsupported blocks from cross-provider sends, and surface a compatibility warning. Never discard them as if empty.

Replacing the entry in place in the migrated representation preserves child links, labels, branches, leaf IDs, fork paths, and compaction `firstKeptEntryId` references. The legacy file itself is not modified.

### Atomic migration transaction

The v3-to-v4 transaction is an explicit storage operation, not a call to the current truncate-and-rewrite helper:

1. Open the legacy source read-only, capture its device/inode, size, modification time, and a SHA-256 digest of the exact bytes, then parse and validate the complete JSONL stream. Refuse migration if the header is newer than the reader, the tree is structurally invalid, or the source changes before commit.
2. Build and validate the complete v4 representation in memory. Serialize it to a uniquely named temporary file in the same directory as its final v4 snapshot, using exclusive creation. Preserve required ownership metadata, apply restrictive permissions, write every byte, `fsync` the file, close it, reopen it, and parse it again. The reparsed header must be v4 and the recorded source digest and migrated entry/link counts must match the transaction manifest.
3. Re-stat and re-digest the legacy source immediately before publication. If any captured identity or content value changed, delete the temporary file and restart from the new source; never merge concurrent writes heuristically.
4. Atomically rename the verified temporary file to a collision-free v4 snapshot name and `fsync` the containing directory. Publish the active v4 head with a second same-directory write-`fsync`-rename-directory-`fsync` transaction. The head record contains the snapshot name, snapshot digest, source path, and source digest. A head is valid only when its referenced immutable snapshot exists and matches its digest.
5. Only after the head commit succeeds may the loader select v4. A crash before snapshot rename leaves an ignorable temp file; a crash after snapshot rename but before head publication leaves an unreferenced snapshot eligible for cleanup; a crash during head replacement leaves either the old valid head or the new valid head. Startup validates the head and falls back to the unchanged v3 source or previous valid v4 head rather than repairing partial data in place.

No committed session file is ever opened with truncation during migration. Temp-file cleanup is limited to names owned by this transaction protocol and never deletes a referenced snapshot. Migration conformance must inject failures after each write, sync, close, rename, and head-publication boundary and prove that restart selects either the byte-identical v3 source or a fully validated v4 snapshot.

### Enforceable downgrade-corruption protection

A future-version check in v4 code protects v4 from v5, but it cannot constrain an already-installed v3 binary: current v3 accepts a header version greater than 3 and can append or rewrite known structures. Therefore v4 must not publish writable v4 data at a path that v3 discovers or can normally mutate.

The v4 storage namespace uses immutable snapshot files whose suffix does **not** match the legacy `.jsonl` discovery filter, plus a v4-only head record. Committed snapshots are set read-only before publication; every v4 append, branch, fork, migration, or compaction mutation is copy-on-write to a new temp snapshot followed by the atomic head transaction above. V4 never makes a committed snapshot writable in place. Legacy `.jsonl` files remain byte-identical, are excluded once a valid v4 head claims their source digest, and are retained for explicit rollback/export.

This yields an enforceable normal-operation boundary for installed v3 writers:

- v3 automatic resume/list discovery cannot see the v4 snapshot suffix or v4 head namespace;
- a stale v3 process can append only to the unclaimed legacy `.jsonl`, which cannot alter the active immutable v4 history;
- an explicit attempt to open a v4 snapshot under v3 fails on mutation because the committed file is read-only; v3 may inspect it, but must not be given the active head path by v4 UI/RPC;
- v4 detects post-migration writes to the legacy source by digest mismatch and surfaces a divergent-legacy-session warning with an explicit import-as-branch/re-migrate choice. It never silently folds those writes into the active v4 tree;
- rollback to v3 is an explicit export that creates a new legacy session and must either omit outcomes with a warning or encode them in a documented non-conversational compatibility report. It never points v3 at a v4 snapshot.

Same-user administrators can deliberately change permissions or rename files, so protection is against supported binaries and normal filesystem operations, not a security boundary against a malicious local user. Advisory locks, a sidecar marker next to a writable `.jsonl`, and a v4-only `header.version > CURRENT_SESSION_VERSION` check are insufficient and must not be claimed as downgrade protection.

All v4 readers still require an explicit `header.version > CURRENT_SESSION_VERSION` read-only/fail-closed gate before append, migration, branch, fork, compaction, or export-with-rewrite. RPC and extension mutation APIs must open through the same versioned storage owner; no alternate raw-path writer may bypass the head/snapshot checks.

## Context, branch, and compaction semantics

- `sessionEntryToContextMessages(provider_outcome)` returns `[]` in both coding-agent and agent harness.
- `buildContextEntries()` retains outcomes so the active timeline and tree are complete.
- `buildSessionContext()` omits outcomes from `messages` and may expose them in separate typed metadata only if a consumer requests it.
- Context item kinds gain `provider_outcome` only for inspection APIs; it never has an `AgentMessage` value.
- Branching from or after an outcome is valid. The outcome may be a leaf and may have children.
- Fork and branched-session extraction copy outcomes unchanged.
- Compaction cut-point logic ignores outcomes as conversational turn starts. Outcomes before the compacted boundary may be omitted from the active context projection but remain in the append-only file.
- Compaction summaries must not quote provider error diagnostics by default. Extensions may include a bounded operational note in `details`, not in model-visible summary text, unless the user explicitly asks to preserve it as context.
- `retainedTail` in the agent harness must exclude outcomes because its type is model messages. Coding-agent's legacy `firstKeptEntryId` may point across outcomes without changing semantics.
- Overflow and transient retry classification run before context projection and use `ProviderOutcomeV1`. A retry does not require deleting an assistant shell from agent state because none was added for an empty failure.
- Usage from an outcome contributes to cost/activity reports if nonzero, but is not a valid last-context-usage baseline for compaction thresholds.

## UI, event, RPC, and extension semantics

### Live events

Introduce an additive agent-session event:

```ts
{ type: "provider_outcome"; outcome: ProviderOutcomeV1; entryId?: string }
```

Ordering for an empty failure is terminal stream event, normalization, persistence, `provider_outcome`, retry/compaction scheduling, then `agent_end`. For partial content, `message_end` for the partial message precedes the linked `provider_outcome` event.

During one compatibility release, existing `message_end` observers may still receive the raw failed assistant stream value, but persistence must use the normalized result. The event carries a deprecation marker/capability flag so extensions can migrate. In the next semantic event version, empty failures stop generating `message_end`.

### Extension hooks

Add `provider_outcome` as an observation hook. Hook results cannot alter chronology, retry classification, or context. Extensions needing model-visible recovery instructions must explicitly append `custom_message` or enqueue a user message. `registerEntryRenderer` should be generalized or complemented with a core-entry renderer registration that cannot change context projection.

Claude Bridge and similar import/export extensions must negotiate session interchange capability. They may import a provider outcome as an operational entry. They must not translate it to `assistant content: []`, placeholder refusal text, or a user message. If the destination cannot represent outcomes, it should omit them from provider history while recording a bounded import warning outside conversation.

### RPC and JSON

RPC reports a protocol capability such as `sessionEntrySchema: 4` and `events: ["provider_outcome@1"]`. Entry payloads remain JSON objects with discriminated `type` and outcome `version`.

- Readers supporting v4 preserve and render `provider_outcome@1`.
- Readers lacking v4 may inspect/export read-only but cannot append to or rewrite the session.
- Unknown outcome fields are preserved when round-tripping.
- Unknown outcome versions are non-executable and omitted from provider context; render a generic unsupported-outcome item.
- Unknown content-bearing entry types or message blocks cause cross-provider projection to fail closed with a compatibility error.

### Human rendering

The default renderer shows provider/model, error or abort label, sanitized error text, timestamp, retry status, and nonzero usage/cost. Diagnostics are collapsed by default. Empty failures do not create a blank assistant bubble. Partial content remains an assistant bubble followed by the outcome status.

Print and HTML exports use the same ordering and semantics. Machine export includes the full redacted structured outcome. A "conversation-only" export explicitly excludes outcomes; a "session" export includes them.

## Versioned multi-provider interchange rules

The session header version governs durable entry semantics. Individual extensible records also carry a local version. Compatibility is classified by whether a change can alter provider-visible meaning or execution.

### Semantic changes: version and fail closed

The following require a new session/interchange version or a separately negotiated semantic capability:

- new or changed message roles;
- new content block types or changed block meaning;
- tool call/result identity, ordering, arguments, or execution semantics;
- chronology, parent/child, compaction checkpoint, or branch projection changes;
- rules that decide whether an entry enters model context;
- provider continuation/signature fields that affect replay;
- conversion of failures, refusals, partial content, or outcomes into conversational messages;
- any unknown field capable of carrying instructions, content, tool input, or executable references.

A sender must not silently downgrade these. A receiver must reject cross-provider projection or require an explicit lossy-export mode with a human-visible warning.

### Additive non-semantic metadata: forward compatible

Bounded additive numeric metadata is forward compatible when it cannot affect message selection, ordering, tools, or content. Examples include additional token counters, cache subcategories, latency, request counts, and cost components.

Rules:

- fields are finite non-negative numbers with documented units;
- unknown fields are preserved when feasible and ignored for behavior;
- aggregate totals never trust a provider-supplied `total` over validated component rules;
- cost metadata is diagnostic, not authorization or billing truth;
- numeric additions cannot change retry, compaction, or context decisions without a separately versioned policy capability;
- strings, objects, arrays, URLs, opaque signatures, and identifiers are not automatically covered by the additive-numeric exception.

This permits `Usage` to grow without forcing a session version for every bounded counter, while keeping content and execution conservative.

## Conformance fixture plan

All tests use deterministic faux streams and installed provider adapters' conversion helpers; no API keys, network requests, or paid tokens.

Create a shared fixture matrix with these terminal cases:

1. error before start/content, zero usage;
2. abort before content;
3. error after text delta;
4. error after thinking delta/signature;
5. error after complete tool call and before result;
6. context overflow error;
7. transient retryable error followed by success;
8. terminal error with nonzero input/cache/cost usage;
9. malformed legacy empty error assistant;
10. unknown content-bearing block and unknown outcome version.

For every installed provider/API module, either run its event converter against the common terminal fixture or declare a reviewed adapter exemption when its SDK cannot be injected directly. Each fixture must pass through:

- provider stream terminal event;
- AgentSession normalization;
- session v4 persistence and reload;
- `buildContextEntries()` and `buildSessionContext()`;
- switch to a different provider/model and serialize the outbound request;
- retry and overflow classification;
- compaction preparation and retained-tail/checkpoint behavior;
- branch, resume, fork, session list, usage totals, RPC, print, and HTML/session export.

Core assertions:

- empty failures survive as outcomes and never appear in outbound provider messages;
- partial visible content is not lost or converted into placeholder text;
- tool execution is not invented;
- chronology and links survive migration;
- old v3 readers refuse mutation of v4;
- unknown executable/content-bearing shapes fail closed;
- unknown bounded numeric usage fields do not block replay;
- exported/imported sessions preserve outcomes without provider-history pollution.

Provider-specific fixtures should live in `packages/ai/test` for stream normalization and package-owned converter behavior. Session, RPC, UI, retry, compaction, and export fixtures belong in `packages/coding-agent/test`; shared harness/storage conformance belongs in `packages/agent/test`. Faux providers are mandatory for coding-agent suites.

## Alternatives and rejected designs

### Keep failed assistants but filter only in `buildSessionContext()`

Rejected as the final design. It fixes outbound history but leaves message counts, extension hooks, event semantics, exports, model inference, compaction inputs, and bridge interchange semantically wrong. It is acceptable only as a short rollout guard before migration lands.

### Add `excludeFromContext` to `AssistantMessage`

Rejected. This mixes persistence policy into the provider message type, encourages adapters to decide durable semantics, and remains easy for other consumers to ignore. It also does not establish a versioned non-conversational entry.

### Convert failures to user-visible assistant text

Rejected. Placeholder text is provider-visible content, changes chronology and model behavior, can be mistaken for a refusal, and increases cross-provider context pressure.

### Drop empty failures entirely

Rejected. It loses diagnostics, retry evidence, usage/cost, activity, and auditability and makes resume/export disagree with what the user saw.

### Make providers emit `ProviderOutcome` directly

Deferred. It is architecturally clean but widens the public `packages/ai` stream API and every adapter simultaneously. The staged design first normalizes the existing terminal assistant contract at the agent boundary, then may introduce a versioned stream result in a later upstream change.

### Store outcomes as extension `custom` entries

Rejected. Provider failure semantics are core, must be understood by retry/UI/RPC/export, and cannot depend on an extension namespace or renderer.

## Staged rollout

1. **Projection guard:** on a fresh core branch, exclude legacy empty failed assistants from provider context and add future-version mutation refusal. Add fixtures before changing persisted schema. This guard does not claim to protect v4 data from v3 writers.
2. **Versioned storage transaction:** add the v4-only head/immutable-snapshot namespace, atomic write-verify-rename-`fsync` transaction, legacy divergence detection, read-only snapshot enforcement, and crash/fault-injection fixtures before any automatic migration is enabled.
3. **Typed entry and migration:** add session v4, `ProviderOutcomeEntry`, normalization, side-by-side migration, tree/RPC/export support, and outcome-aware usage/listing.
4. **Retry/compaction/UI:** consume outcomes directly, remove last-assistant deletion for empty failures, add interactive/print/HTML rendering, and cover partial-content cases.
5. **Extension and interchange capability:** add outcome hooks, RPC capability negotiation, Bridge compatibility rules, and read-only fallback for older clients.
6. **Event cleanup:** after one deprecation cycle, stop emitting empty failed assistants as `message_end`; consider a public typed provider terminal result in `packages/ai` based on parity evidence.

Each stage must keep v1-v3 load compatibility and must not permit a down-level writer to mutate v4.

## Ownership, upstream assessment, and implementation split

This is upstream-general in problem shape: every provider uses the shared assistant terminal contract, and core session projection is provider-neutral. That conclusion is a design assessment, not evidence that upstream `main` currently has the same exact bug or accepts this schema. Before implementation, refresh `main`, reproduce against upstream parity with faux-provider tests, and inspect upstream session/harness convergence.

Proposed upstream-candidate branch: **`pg/core/provider-outcome-session-contract`**, created from refreshed `main` in a dedicated worktree.

Package ownership and manager-ready tasks:

1. **AI terminal normalization contract (`packages/ai`)**: define/test a pure terminal classifier or shared provider-outcome data type without changing adapters' public stream shape. Review: all provider adapters and public API compatibility.
2. **Session v4 storage and migration (`packages/coding-agent`)**: add the atomic head/immutable-snapshot transaction, entry type, side-by-side migration, legacy-divergence handling, future-version mutation gate, append API, context projection, branch/fork/list/usage behavior. Review: filesystem crash consistency, downgrade isolation, and session-format compatibility.
3. **Harness parity (`packages/agent`)**: add the same entry semantics to storage/session types, context builders, compaction retained tails, and storage conformance. Review: no divergence between the two session implementations.
4. **Agent retry/compaction integration (`packages/coding-agent`)**: normalize terminal events, persist outcomes, retain partial content, update overflow/retry and compaction. Review: retry budgets, tool-call safety, and auto-compaction regressions.
5. **UI/RPC/export/extensions (`packages/coding-agent`)**: render and expose outcomes, add capability negotiation and hooks, update HTML/print/session exports. Review: extension compatibility and no accidental context injection.
6. **Provider conformance matrix (`packages/ai`, `packages/agent`, `packages/coding-agent`)**: faux fixtures for all installed provider APIs and cross-provider replay. Review: provider owners plus an independent session architecture reviewer.
7. **Documentation and migration release note**: update `session-format.md`, public extension/RPC docs, and changelogs only after implementation behavior is settled.

Required reviews are an independent session-format/migration architecture review, provider adapter review, coding-agent retry/compaction review, extension/RPC compatibility review, and security review of diagnostic redaction and unknown executable shapes. Migration risk is medium-high because session files are append-only user data, two session implementations exist, old clients are permissive, and partial tool-call semantics can cause execution errors if normalized incorrectly.

## Decision

Adopt a core `provider_outcome@1` session entry in session v4, normalized at the AgentSession/session boundary. Empty failed or aborted provider attempts are durable operational timeline entries and are never provider-visible conversation. Partial assistant content remains content and is linked to a separate outcome. Semantic interchange changes are versioned and fail closed; only bounded additive numeric usage/cost metadata is forward compatible by default.
