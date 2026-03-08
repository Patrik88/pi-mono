# OpenAI Native Web Search Extension

Project-local pi extension that re-enables OpenAI Responses native `web_search` for `openai` and `openai-codex` models without patching core provider code.

## What it does

- Enables native OpenAI web search by default per session
- Injects `{ type: "web_search" }` only for eligible requests
- Preserves OpenAI Responses/Codex streaming while surfacing web-search progress/results as TUI-readable thinking blocks
- Counts `webSearchCalls` and adds per-call cost to total usage
- Cleanly bypasses native web search for unsupported cases

## Eligibility

Native web search is enabled only when all of these are true:

1. the extension state is enabled (default on unless explicitly turned off in the session),
2. the current model is `openai`/`openai-codex` on the Responses APIs,
3. the model is not `gpt-4.1-nano`,
4. the model is not a `gpt-5*` model running with `minimal` reasoning.

## Usage

Toggle for the current session:

```text
/native-web-search
```

Enable explicitly:

```text
/native-web-search on
```

Disable explicitly:

```text
/native-web-search off
```

Check current status without toggling:

```text
/native-web-search status
```

CLI flag:

```bash
pi --native-web-search
```

The extension is auto-discovered from `.pi/extensions/openai-native-web-search/index.ts`.
