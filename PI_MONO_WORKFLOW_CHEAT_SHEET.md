# Pi Mono - Workflow Cheat Sheet (Solo & Daily Driver Edition)

Snabbguide för dagligt arbete i din fork av `pi-mono`. Optimerad för en ren historik mot upstream, samtidigt som du har en fungerande lokal miljö med alla dina anpassningar aktiva.

> Human-facing quick guide. Non-authoritative for agents.
> If this file conflicts with `AGENTS*.md`, `AGENTS*.md` wins.

## Branchmodell

- **Spegeln:** `sync/main` (ren spegel av `upstream/main`, inga egna commits här).
- **Arbetsytan:** `pg/daily` (din integrationsbranch där du kodar, bygger och kör agenten dagligen).
- **Kategorierna:**
  - `pg/core/<topic>`: upstream-PR-kandidater (kirurgiska och rena fixar).
  - `pg/ext/<topic>`: fork-extensioner.
  - `pg/private/<topic>`: privata features (teman, egna inställningar).
  - `dev/<topic>`: kortlivade spikes och experiment.

---

## 1. Daglig sync (Uppdatera spegeln säkert)

```bash
git checkout sync/main
git fetch upstream --prune --tags
git merge --ff-only upstream/main
git push origin sync/main
```

## 2. Håll din arbetsyta uppdaterad (Rebase)

När `sync/main` har uppdaterats och du vill ha in Marios nya kod i din dagliga miljö:

```bash
git checkout pg/daily
git rebase sync/main
```

## 3. Starta nytt strukturerat arbete

Om du vet att du bygger en specifik fix för upstream eller en dedikerad extension, bryt ut den från spegeln:

```bash
# Core-kandidat (för upstream-PR)
git checkout -b pg/core/<topic> sync/main

# Extension
git checkout -b pg/ext/<topic> sync/main

# Privat feature
git checkout -b pg/private/<topic> sync/main
```
*När du har committat klart på din specifika branch, byter du tillbaka till `pg/daily` och plockar in din nya kod där via `git merge` eller `git cherry-pick` för att faktiskt kunna använda den!*

*Defaultregel för integration till `pg/daily`:*
- `pg/core/*` -> `git cherry-pick <commit>` (håller upstream-fixar isolerade).
- `pg/ext/*` och `pg/private/*` -> `git merge --no-ff <branch>` när du vill få in hela funktionsspåret.

---

## Build (när du vill testa runtime)

Se till att du står på `pg/daily` (eller branchen du vill testa) när du bygger. Om typer/build är ur synk mellan paket:

```bash
cd packages/ai && npm run build
cd ../agent && npm run build
cd ../coding-agent && npm run clean && npm run build
```

## npm link (lokal runtime av `pi`)

När du vill köra din lokala `packages/coding-agent` som global `pi`:

```bash
cd packages/coding-agent
npm run clean
npm run build
npm link
```

Verifiera vilken binär som används:

```bash
which pi
pi --version
```

Viktigt:
- `npm link` pekar på den worktree-path där du körde kommandot.
- Byter du branch i samma worktree måste du bygga igen innan test.
- Vill du ha en stabil länkad runtime medan du jobbar på andra brancher, använd en separat worktree för den länkade branchen.

## Worktrees (rekommenderat vid parallella uppgifter)

Skapa en separat worktree för en ny uppgift/agent:

```bash
git fetch upstream --prune --tags
git worktree add ../pi-mono-pg-ext-<topic> -b pg/ext/<topic> sync/main
```

Använd befintlig branch i ny worktree:

```bash
git worktree add ../pi-mono-pg-daily pg/daily
```

Översikt och städning:

```bash
git worktree list
git worktree remove ../pi-mono-pg-ext-<topic>
git worktree prune
```

## Verifiering före PR

Körs bäst från den isolerade `pg/core/*`-branchen innan du pushar.

```bash
npm run check
./test.sh
```

Riktade tester via vitest (exempel):

```bash
cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/openai-responses-web-search.test.ts
cd ../coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/sdk-web-search-warning.test.ts
```

## PR-clean check

Kontrollera att upstream-kandidat (`pg/core/*`) inte innehåller brus från din dagliga miljö:

```bash
git diff --name-only sync/main...HEAD
```

Undvik detta i `pg/core/*`-diffen:
- Anpassningar av startskärmen/TUI
- Privata `keybindings.json`-ändringar
- `AGENTS.md` & `CONTRIBUTING.md`
- `.husky/*`
- lokala arbetsfiler/noteringar

## Push-regler

- Pusha normalt till `origin`.
- Pusha inte direkt till `upstream` (guard finns i `.husky/pre-push`).
- För PR-brancher: håll diffen funktionell och minimal.

## Snabb felsökning: TS-fel om saknad option mellan paket

**Symptom:** `property X does not exist in type ...` trots att koden finns i `src`.  
**Orsak:** stale `dist/*.d.ts` i beroendepaket.  
**Fix:**

```bash
cd packages/ai && npm run build
cd ../agent && npm run build
cd ../coding-agent && npm run clean && npm run build
```
