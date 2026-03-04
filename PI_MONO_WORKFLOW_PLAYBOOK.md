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

## 3) Integrera klart arbete till pg/daily

- Från `pg/core/*`: `cherry-pick` (ren PR-historik).
- Från `pg/ext/*` och `pg/private/*`: `merge --no-ff` (behåll feature-spår).

Exempel:

```bash
git checkout pg/daily
git cherry-pick <core-commit>
git merge --no-ff pg/ext/<topic>
```

## 4) Build och lokal körning

När typer/dist känns osynkade mellan paket:

```bash
cd packages/ai && npm run build
cd ../agent && npm run build
cd ../coding-agent && npm run clean && npm run build
```

Länka lokal `pi`:

```bash
cd packages/coding-agent
npm run clean
npm run build
npm link
which pi
pi --version
```

Notera: byter du branch i samma worktree behöver du ofta bygga om innan test.

## 5) Worktree-mönster

Du kan låta `/pi-mono` vara din default-worktree på `pg/daily`.  
Lägg till extra worktrees bara för samtidiga topic-spår:

```bash
git worktree add ../pi-mono-pg-core-<topic> -b pg/core/<topic> main
git worktree add ../pi-mono-pg-ext-<topic> -b pg/ext/<topic> pg/daily
```

Valfritt: skapa en separat `pg/daily`-worktree bara om du vill låsa en stabil runtime-path för `npm link`.

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
