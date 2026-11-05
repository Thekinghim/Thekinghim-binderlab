# Säkerhet

Detaljer: [docs/architecture.md](../architecture.md) (säkerhetsmodellen),
[docs/datamodell.md](../datamodell.md) (roller och policyer) och granskningarna i
`docs/review/`.

## Inloggning

- **Supabase Auth** i drift: e-post och lösenord eller inloggningslänk. Sessionens JWT
  verifieras mot projektets JWKS (`src/server/auth/supabase-jwt.ts`). Egen registrering ska vara
  avstängd; nya användare kommer in via inbjudan (README, Driftsättning).
- **Lösenord** minst 12 tecken (`MIN_PASSWORD_LENGTH`, `src/server/auth/password.ts`).
- **Dev-inloggningen** (lokalt) har en hård spärr: den vägrar om `APP_ENV` inte är
  `development` eller om databasen inte är lokal (`src/server/auth/dev-guard.ts`, testad).
- **Begränsning av försök** för inloggning, sökning, assistent, provlarm och felanmälan räknas
  i minnet per serverinstans (`src/server/rate-limit.ts`), alltså ungefärligt på Vercel.
  "Exportera all data" räknas i databasen (3 per timme och organisation, gäller alla instanser).

## Roller och behörighet

| Roll      | Får                                                                                 |
| --------- | ----------------------------------------------------------------------------------- |
| Ägare     | Allt, inklusive ägarandelar och "Exportera all data"                                |
| Admin     | Drift, ekonomi, datakällor och användare; inte ägarandelar och export               |
| Läsare    | Läsa ekonomi och drift, inte ändra                                                  |
| Påfyllare | Lager, påfyllning och automater; inga belopp (testat i `test/db/rls-roles.test.ts`) |
| Butik     | Bara sin egen butik i butiksportalen (`test/db/portal-isolation.test.ts`)           |

Rollen läses ur databasen i varje förfrågan (aldrig ur en kaka). Server actions och routes
kontrollerar rollen, och databasen kontrollerar den igen.

## Row Level Security (RLS)

- Varje förfrågan från en användare körs i en transaktion med `role authenticated` och
  användarens JWT-claims (`withRls`, `src/db/client.ts`). Policyerna släpper bara igenom rader
  vars `organization_id` är en organisation där användaren har rätt roll
  (`private.orgs_with_role`).
- **Katalogtesterna** (`test/db/catalog.test.ts`) läser Postgres-katalogen och fallerar om en
  tabell saknar RLS, en select-policy, `unique (organization_id, id)`, FK till organisationen
  med `on delete restrict`, eller triggern som stoppar flytt mellan organisationer. Varje
  `security definer`-funktion måste ha `search_path = ''` och får inte kunna köras av `anon`.
- **Systemjobb** (cron) använder databasägaren (`getServiceDb`) och tar organisationen från
  jobbet, aldrig från en förfrågan.

## Hemligheter

- **Awish-inloggningar** (gRPC AppSecret/AppKey, webbpanelens e-post och lösenord) sparas i
  **Supabase Vault** via RPC:erna `awish_save_credentials` och `awish_save_web_credentials`.
  Tabellen har bara namnet (`data_sources.secret_ref`, kontrollerat till organisationens
  namnrymd); värdet lämnar aldrig databasen till webbläsaren.
- **Tjänstnycklar** (Supabase, Resend, Sentry, Anthropic, VAPID, `CRON_SECRET`) ligger som
  miljövariabler i Vercel; `.env.example` listar dem utan värden. Byte av nycklar:
  [docs/operations.md](../operations.md#byte-av-nycklar).
- **Sentry** får inga e-postadresser, kakor eller token (`beforeSend` tvättar, testat).

## Loggar

- **`audit_log`**: append-only (trigger), skrivs bara av triggern `private.audit()` på 58
  tabeller; ingen klientroll kan skriva i den, inte ens `service_role` (katalogtest).
- Också append-only (trigger, inga update/delete-rättigheter, katalogtestat): importens rader
  (`import_rows`), lagerhändelser (`stock_events`), rapportutskick och godkännanden
  (`report_deliveries`, `report_approvals`, `report_files`), utbetalningar (`payout_imports`,
  `payout_lines`), assistentens frågor (`assistant_logs`) och dataexporter (`data_exports`,
  bara ägaren läser).

## Säkerhetskopior

Supabase PITR och dagliga backuper (Pro-plan) plus egna dumpar med `npm run db:backup`.
Återställningen är provad i ett test (`test/db/backup-restore.test.ts`, körs i CI med
`pg_dump` 16). Gång och lagringstider: [docs/operations.md](../operations.md#säkerhetskopior).
Dumpen innehåller inte filerna i Storage (känd brist, README).

## Vad som är testat

- **Isolering mellan organisationer**: `rls-isolation`, `redteam-isolering`,
  `portal-isolation`, `rls-storage` (filer).
- **Attacktester** ("rödteam") per område: varje server action anropas av varje roll, en
  utomstående och en utloggad (`redteam-fas7-actions.test.ts` med katalogen
  `redteam-fas7-catalog.ts`), alla exporter och filer (`redteam-fas7-routes.test.ts`),
  sökningen, assistenten, portalen, onboarding och demon.
- **Dataexporten**: bara ägaren, aldrig en annan organisations rader, gränsen 3 per timme och
  loggen (`test/db/granskning.test.ts`).
- Antal och körning: [kvalitet.md](kvalitet.md).

## Kända brister (ur README och granskningarna)

- CSP tillåter `'unsafe-inline'` för skript (nonce kräver dynamisk rendering)
  (`src/lib/security-headers.ts`).
- Gränser för försök per serverinstans, inte gemensamma (se ovan); ingen gräns för hur ofta
  inbjudningar och rapporter skickas.
- Inga personuppgiftsbiträdesavtal tecknade; inget gallringsjobb ([data.md](data.md)).
- Inga externa tjänster provade från byggmiljön (inget nät); se README "Kända brister".
