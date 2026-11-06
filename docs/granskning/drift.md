# Drift

Fullständig driftmanual: [docs/operations.md](../operations.md); miljöer och variabler:
[docs/miljoer.md](../miljoer.md).

## Driftsättning

- **Vercel** bygger och driftsätter från GitHub. Produktion: `https://thekinghim-binderlab.vercel.app`.
  Funktionerna körs i `lhr1` (London, `vercel.json`), samma region som Supabase-projektet.
- **Databasen** ändras bara med nya migreringsfiler (`supabase/migrations`, append-only; en
  gammal fil ändras aldrig). De körs med GitHub Actions → "Migrera databasen"
  (`.github/workflows/migrate.yml`); produktion kräver godkännande och grenen `main`.
- **Tillbaka:** Vercel → Deployments → föregående → "Promote to Production". Migreringar rullas
  inte tillbaka; en rättning är en ny migrering.
- **Ny organisation:** inbjudan i Supabase och "Kom igång" i appen
  ([docs/operations.md](../operations.md#nya-organisationer)).

## Övervakning

| Vad                   | Hur                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Fel i kod             | Sentry (`onRequestError`, server actions, jobb), tvättat från personuppgifter              |
| Jobb som inte körs    | Sentry Cron Monitors för larm, rapporter och Awish-synken                                  |
| Fel som ägaren ska se | Larm i appen (Drift och Att göra): misslyckad import, rapportutskick, jobb, inaktuell data |
| Automater             | Maskinhälsa ur försäljningen och Awish anslutning (online/offline)                         |
| Aviseringar           | Mejl och push enligt Drift → Larminställningar                                             |

Schemana står i [arkitektur.md](arkitektur.md#schemalagda-jobb).

## Incidenter

Allvarsnivåer, gång (upptäck, avgränsa, begränsa, åtgärda med test, anteckning efteråt) och
vanliga fall: [docs/operations.md](../operations.md#incidenthantering). Misstänkt läcka mellan
organisationer är nivå 1: stäng tjänsten och kör isoleringstesterna mot en kopia.

## Avvikelser mellan dokumentation och konfiguration (hittade i granskningen, rättade)

`vercel.json` är facit, och dokumentationen följer den nu:

- Larmjobbet körs `7 5 * * *` (en gång per dygn, 05:07 UTC), inte var 10:e minut. Dessutom
  utvärderas larmen och utskicken efter varje Awish-synk (var femte minut, pg_cron) för
  organisationer där det behövs, t.ex. när en automat går offline
  (`src/server/awish/offline-alerts.ts`). Rättat i `docs/operations.md`, README, `docs/miljoer.md`,
  `docs/driftsattning.md`, `docs/decisions.md` och `docs/architecture.md`.
- Funktionsregionen är `lhr1` (London). README, `docs/decisions.md` och `docs/driftsattning.md`
  sa `arn1`; rättat. (`docs/bygglogg.md` är en historisk logg och lämnas som den var.)
