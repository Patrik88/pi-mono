# PR-readiness punch list (lokalt arbetsunderlag, ej commit)

Datum: 2026-03-02
Branch: `pg/complete-web-search`
Bas: `upstream/main` + 2 commits

## 1) First-time approval gate

Status: Delvis blockerad, kräver manuell maintainer-bekräftelse.

- `gh issue view 1432 --json title,body,comments,labels,state` returnerar: `the 'badlogic/pi-mono' repository has disabled issues`.
- `CONTRIBUTING.md` kräver issue + maintainer-`lgtm` för first-time contributors.
- `.github/APPROVED_CONTRIBUTORS` innehåller just nu bara `barapa`.

Praktisk konsekvens:
- Den formella issue-baserade approval-vägen går inte att verifiera i repo:t just nu.
- Behöver explicit klartecken från maintainer (t.ex. Discord/PR-kommentar) innan PR skickas.

## 2) “The One Rule” (förklara ändringarna + edge cases)

### Vad som ändrats och varför

- Native `web_search` injiceras nu i OpenAI Responses/Codex endast när:
  - `enableNativeWebSearch === true`
  - modellen stödjer native web search (`supportsNativeWebSearch`)
  - och för GPT-5 inte med `reasoningEffort === "minimal"` (OpenAI limitation).
- Stream-hanteringen mappar web-search-progress/resultat till giltiga `thinking_*` event så TUI får synliga block istället för tyst drop.
- `contentIndex` för web search stabiliseras per `sequence_number` (map) för att undvika index-glapp vid interleaving.
- `usage.webSearchCalls` räknas från `response.output_item.done` (`web_search_call`) och kostnad räknas via `webSearchPerCall`.
- Azure-kloner ärver inte längre `webSearchPerCall` från OpenAI-modeller i generatorn.

### Viktiga edge cases

- GPT-5 + minimal reasoning: web_search bypassas medvetet.
- `gpt-4.1-nano`: explicit blockerad i capability-gating.
- Modeller som `o4-mini`: tillåts (denylist istället för snäv allowlist).
- Interleavade reasoning/web_search-events: web-search-delta går till dedikerat blockindex per sekvens.
- SDK är nu utan `console.warn`-side effect; varning returneras strukturerat och CLI printar endast i interactive mode.

## 6) PR-beskrivning (kort, konkret, i min röst)

### Problem

OpenAI native `web_search` ignorerades i praktiken och agenten föll tillbaka till bash/curl-flöde. Web-search event tappades i streamen, och kostnaden för web search spårades inte konsekvent.

### Lösning

- Lagt till riktig injektion av `{ type: "web_search" }` i OpenAI Responses/Codex-path när explicit opt-in är aktiv och modellen stöds.
- Lagt till gating för kända begränsningar (`gpt-5 + minimal`, `gpt-4.1-nano`).
- Fångar och emitterar web-search-progress/resultat i streamen utan att tappa event.
- Stabiliserat `contentIndex` för web-search block vid interleaving.
- Spårar och prissätter `webSearchCalls`.
- Förhindrar att Azure-kloner ärver OpenAI `webSearchPerCall`.
- Exponerar CLI-kontroll via `--no-native-web-search`.

### Tradeoffs

- Capability-gating bygger på lokal denylist för kända undantag. Nya upstream-modelländringar kan kräva uppdatering.
- Startup-varning om minimal reasoning visas bara vid sessionstart (inte dynamiskt mitt i sessionen).

### Verifiering (körda kommandon + resultat)

- `npm run check` -> PASS
- `./test.sh` -> PASS
- `cd packages/ai && npm test -- test/openai-responses-web-search.test.ts` -> PASS (7 tester)
- `cd packages/ai && npm test -- test/openai-codex-stream.test.ts` -> PASS (7 tester)
- `cd packages/coding-agent && npm test -- test/sdk-web-search-warning.test.ts` -> PASS (4 tester)

### Kända begränsningar

- First-time approval gate kan inte verifieras via issues eftersom issues är avstängda i repo:t.

## 8) Core-minimalism-check

Varför detta hör hemma i core:

- Felet ligger i kärnflödet för provider-request/stream-översättning (`packages/ai` + `coding-agent` bootstrap), inte i en valfri feature ovanpå.
- En extension kan inte robust ersätta intern stream-normalisering, usage-prissättning och providerverktygsmappning utan att duplicera core-protokoll och riskera drift.
- Flagga för on/off (`--no-native-web-search`) håller beteendet kontrollerbart utan att blåsa upp arkitekturen.
