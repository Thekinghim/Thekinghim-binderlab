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

## Avvikelser mellan dokumentation och konfiguration (hittade i granskningen)

- `docs/operations.md` säger att larmjobbet körs var 10:e minut; `vercel.json` kör det
  `7 5 * * *` (en gång per dygn, 05:07 UTC). Dessutom utvärderas larmen och utskicken efter
  varje Awish-synk (var 10:e minut) för organisationer där det behövs, t.ex. när en automat
  går offline (`src/server/awish/offline-alerts.ts`).
- README:s avsnitt "Innan andra operatörer" nämner region `arn1`; `vercel.json` och
  `docs/operations.md` säger `lhr1`.

Ägaren väljer vilket som ska gälla; ingen av dem ändras i den här granskningen.
