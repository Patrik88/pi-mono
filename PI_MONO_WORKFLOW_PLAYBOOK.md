# Pi Mono - Workflow Playbook (User Guide)

Detta är en mänsklig arbetsguide för din fork.  
Regler för agenter finns i `AGENTS*.md` och är överordnade om något krockar.

## 0) Mental modell

- `main` = ren spegel av `upstream/main` (ingen egen feature-utveckling här).
- `pg/daily` = din fork-runtime och source of truth för vad du faktiskt kör.
- `pg/core/*` = rena upstream-kandidater.
- `pg/ext/*` = extension-spår.
- `pg/private/*` = privata features.
- `dev/*` = kortlivade spikes.

## 1) Branch-baser (viktigaste regeln)

Skapa nya brancher från rätt bas:

```bash
# Upstream-kandidat
git checkout -b pg/core/<topic> main

# Daglig fork-utveckling (default)
git checkout -b pg/ext/<topic> pg/daily
git checkout -b pg/private/<topic> pg/daily
git checkout -b dev/<topic> pg/daily
```

Undantag: använd `main` även för `pg/ext/*` eller `pg/private/*` bara om du vill ha clean-slate-isolering.

## 2) Daglig rutin

### A. Synca spegeln

```bash
git checkout main
git fetch upstream --prune --tags
git merge --ff-only upstream/main
git push origin main
```

### B. Uppdatera din runtime-branch

```bash
git checkout pg/daily
git rebase main
```

### C. Synka dependencies efter upstream-uppdatering

Om `package.json`/`package-lock.json` ändrats uppströms, eller om `npm ls` visar `invalid`/stale dependencies:

```bash
npm install
```

Detta behövs ibland innan build, annars kan TypeScript läsa gamla dependency-typer trots att branchen är uppdaterad.

### D. Standardord: "refresh"

I denna fork betyder `refresh` följande:

- `refresh main`
  - synca `main` mot `upstream/main`
- `refresh pg/daily`
  - `refresh main`, sedan rebase:a `pg/daily` på `main`
- `refresh pg/core/<topic>`
  - `refresh main`, sedan rebase:a branchen på `main`
- `refresh pg/ext/<topic>`, `pg/private/<topic>`, `dev/<topic>`
  - `refresh main`, sedan rebase:a `pg/daily` på `main`, sedan rebase:a topic-branchen på `pg/daily`
  - därefter gör du en compatibility pass innan refreshen räknas som klar

Compatibility pass betyder:

1. läs relevanta ändringar i nya basen (`upstream/main` och/eller `pg/daily`) för det område du jobbar i,
2. kontrollera om det tillkommit nya hooks, extension-API:er, provider-seams, config-vägar, tester eller kontrakt som din fork/plugin bör använda,
3. uppdatera branchen om den nya basen gör det rimligt att integrera eller förenkla implementationen,
4. landa alltid i ett explicit svar:
   - `no integration changes needed`, eller
   - exakt vad som integrerades och varför.

Exempel:

```text
Refresh pg/ext/openai-native-web-search, then rebuild for runtime testing.
Refresh pg/ext/openai-native-web-search, run a compatibility pass, then rebuild for runtime testing.
```

## 3) Commit och integrera klart arbete till pg/daily

- Agenter committar färdiga logiska ändringar efter obligatorisk validering utan att invänta en separat commit-begäran.
- Arbetet görs i ett dedikerat topic-worktree; `pg/daily`-worktreet används för integration och verifiering.
- Integrera först när hela uppgiften är klar.
- Från `pg/core/*`: `cherry-pick` när ändringen ska in i daily-runtime (ren PR-historik).
- Från `pg/ext/*` och `pg/private/*`: `merge --no-ff` (behåll feature-spår).

Exempel:

```bash
git checkout pg/daily
git cherry-pick <core-commit>
git merge --no-ff pg/ext/<topic>
```

## 4) Build och lokal körning

```bash
cd packages/ai && npm run build
cd ../agent && npm run build
cd ../coding-agent && npm run clean && npm run build
npm link
which pi
pi --version
```

Notera: byter du branch i samma worktree behöver du ofta bygga om innan test.

## 5) Worktree-mönster

Låt `/pi-mono` vara det stabila integrations-/runtime-worktreet på `pg/daily`. Vanliga feature-, fix-, docs-, config- och policyändringar görs i ett dedikerat topic-worktree, även när bara en agent arbetar:

```bash
git worktree add ../pi-mono-pg-core-<topic> -b pg/core/<topic> main
git worktree add ../pi-mono-pg-ext-<topic> -b pg/ext/<topic> pg/daily
git worktree add ../pi-mono-pg-private-<topic> -b pg/private/<topic> pg/daily
```

Committa och validera i topic-worktreet. När hela uppgiften är klar, integrera den via `cherry-pick` eller `merge --no-ff` enligt branchtypen och verifiera resultatet i det stabila worktreet.

## 6) PR-readiness (för pg/core/*)

Kör:

```bash
npm run check
./test.sh
```

Snabb diff-koll mot upstream-bas:

```bash
git diff --name-only main...HEAD
```

Undvik fork-brus i PR-diffen: `AGENTS*.md`, personliga TUI-ändringar, lokala anteckningar.

## 7) Beslutsregel (när du tvekar)

- "Ska detta kunna bli PR till upstream?" -> `pg/core/*` från `main`.
- "Det här är för min fork/dagliga användning" -> `pg/ext/*` eller `pg/private/*` från `pg/daily`.
- "Jag testar bara snabbt" -> `dev/*` från `pg/daily`.
