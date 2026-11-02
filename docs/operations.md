# Drift och överlämning

Hur Binderlab drivs i produktion: daglig drift, övervakning och larm, säkerhetskopior,
återställning, nya organisationer, byte av nycklar och incidenter. Miljöerna, variablerna och
den första uppsättningen står i `docs/miljoer.md`. Den här filen beskriver det som händer
efteråt.

| Del               | Var                                                        | Vem tittar                       |
| ----------------- | ---------------------------------------------------------- | -------------------------------- |
| Webb              | Vercel (Production från `main`, Preview per gren)          | Ansvarig för driften             |
| Databas och filer | Supabase (Postgres 16, Auth, Storage), EU-region           | Ansvarig för driften             |
| Fel               | Sentry (när `SENTRY_DSN` finns) och larm på Drift/Att göra | Ägaren i appen, driften i Sentry |
| Schemalagda jobb  | Vercel Cron (`vercel.json`), skyddade med `CRON_SECRET`    | Larm i appen om de misslyckas    |
| E-post            | Resend (`MAIL_PROVIDER=resend`)                            | Utskicksloggen under Rapporter   |

## Daglig drift

Inget behöver göras för hand. Det som körs av sig självt:

| Jobb                  | Schema (UTC)   | Vad                                                     | Om det misslyckas                     |
| --------------------- | -------------- | ------------------------------------------------------- | ------------------------------------- |
| `/api/cron/larm`      | `*/10 * * * *` | Maskinhälsa, lager, importer, avvikande dag; utskick    | Larm `job:larm` + Sentry, se nedan    |
| `/api/cron/rapporter` | `17 5 1 * *`   | Utkast för förra månadens rapporter (ingenting skickas) | Larm `report_drafts:<månad>` + Sentry |

Kontrollera en gång i veckan (fem minuter):

1. **Drift → Maskinhälsa → Larm**: "Senaste körning" ska vara högst tio minuter gammal. Står det
   "Larmjobbet har inte körts" saknas `CRON_SECRET` eller cron i Vercel.
2. **Sentry → Issues**: nya ärenden sedan förra veckan (filtrera på `environment:production`).
3. **Datakällor**: "Data till" ska vara färsk för varje källa.
4. **Supabase → Database → Backups**: senaste säkerhetskopian är från i natt.

## Felövervakning och larm

Fel som användaren inte ser själv, eller som händer när ingen är inloggad, ska både nå den som
driver tjänsten (Sentry) och den som äger verksamheten (larm i appen). Koden finns i
`src/server/monitoring`.

| Händelse                                          | Larm i appen (`alerts`)                                    | Sentry-händelse (taggar)                        | Stängs när                           |
| ------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| Import misslyckas (uppladdning, inte fel i filen) | `import_failed`, nyckel `import:<källa>`, kritiskt         | `area=import`, `kind=import_failed`, källans id | nästa lyckade import från källan     |
| Rapportutskick: en mottagare fick inte mejlet     | `report_failed`, nyckel `report:<rapport>`, kritiskt       | `area=report`, `report_id`                      | rapporten skickats till alla valda   |
| Rapportutskick avbryts (PDF eller mejl)           | samma som ovan                                             | samma, med felet                                | samma                                |
| Månadsutkasten (schemalagt) misslyckas            | `report_failed`, nyckel `report_drafts:<ÅÅÅÅ-MM>`, varning | `area=report`, `job=rapporter`                  | jobbet går igenom för organisationen |
| Larmjobbet misslyckas för en organisation         | `job_failed`, nyckel `job:larm`, kritiskt                  | `area=job`, `job=larm`                          | nästa lyckade körning                |

- **Var det syns**: Drift → Larm (med underlag) och Att göra (okvitterade, kritiska och
  varningar). Ägare, admin och läsare ser larmen. Påfyllaren ser bara larm om automater och
  lager. Systemlarm skickas inte som push/e-post/sms (prenumerationerna gäller automater,
  lager, import och avvikande dag).
- **Samma problem är ett larm**: högst en öppen rad per nyckel; nya fel räknar upp
  "förekomster" i stället för att skapa nya rader.
- **Misslyckad import**: importens transaktion rullas tillbaka (inga order sparas). Felet
  sparas som en rad i `imports` med status `failed` (syns i Datakällor), och larmjobbet körs
  direkt för organisationen så att regeln `import_failed` skapar larmet med vanliga
  aviseringar. Fel i filen (saknade kolumner, tom fil, fel behörighet) är inga driftfel: de
  visas för användaren och ger inget larm.
- **Sentry** får bara id:n och antal, aldrig e-postadresser (`beforeSend` tar dessutom bort
  e-post, cookies och token). Utan `SENTRY_DSN` skickas ingenting, men larmen i appen skrivs
  ändå. Fel som kastas ut ur en route eller sida fångas av `onRequestError`
  (`src/instrumentation.ts`).
- **Systemroll**: larmen skrivs med `getServiceDb()` (användare får bara kvittera larm). Det
  är ett systemjobb i den mening som `docs/miljoer.md` beskriver: organisationen kommer alltid
  från den verifierade sessionen eller jobbet, och inget läses tillbaka till användaren.
- **Tester**: `test/db/monitoring.test.ts` (import, utskick, utkast, larmjobbet, RLS),
  `src/server/monitoring/sentry.test.ts` (Sentry med och utan DSN) och
  `e2e/06-felovervakning.e2e.test.ts` (larmet på Drift och i Att göra).

Kontrollera att Sentry tar emot händelser efter att `SENTRY_DSN` satts eller bytts: Sentry →
Project Settings → Client Keys, och se att händelser från `environment:production` kommer in
(Sentry visar också "Waiting for events" tills den första händelsen kommit).

## Säkerhetskopior

Två oberoende kopior, eftersom de skyddar mot olika saker:

| Kopia                         | Skyddar mot                                                       | Hur                                                            | Behålls               |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- |
| **Supabase PITR**             | Felaktiga ändringar och borttag: återställ till en sekund         | Supabase → Project Settings → Add-ons → Point in Time Recovery | 7 dagar (eller mer)   |
| **Supabase dagliga backuper** | Samma, med en punkt per dygn                                      | Ingår i Pro-planen                                             | 7 dagar               |
| **Egna dumpar** (`db:backup`) | Att projektet eller kontot försvinner, och återställningsövningar | `npm run db:backup` mot produktionen, lagras utanför Supabase  | 12 månader (se nedan) |

Rekommendation: Pro-plan med PITR i produktionsprojektet. Ta en egen dump en gång i veckan och
den 1:a varje månad (efter att månadens rapporter skickats), kryptera den och lägg den utanför
Supabase (t.ex. en bucket hos en annan leverantör med versionshantering). Behåll veckodumpar i
åtta veckor och månadsdumpar i tolv månader. Bokföringsunderlaget ska enligt bokföringslagen
sparas i sju år; det gör bokföringsbyrån med SIE-filerna, inte den här kopian.

### Ta en egen dump

```sh
# Mot produktionen: anslutning i "session mode" (port 5432 på pooler.supabase.com), som
# migreringarna. Läser bara; skriver aldrig till källan.
npm run db:backup -- --url "$PROD_DATABASE_URL" \
  --schemas public,private,supabase_migrations,auth \
  --out backups/binderlab-$(date +%F).dump
```

Skriptet (`scripts/db/backup.ts`, logiken i `scripts/db/backup-lib.ts`):

1. Öppnar en läsande transaktion och exporterar en ögonblicksbild (`pg_export_snapshot`).
2. Kör `pg_dump --format=custom --snapshot=…`, så att dumpen är exakt den ögonblicksbilden även
   om appen skriver under tiden.
3. Räknar antal rader och en md5-kontrollsumma per tabell i samma ögonblicksbild och skriver
   dem i `<fil>.manifest.json` (med servrar, versioner och senaste migrering, utan lösenord).

Kräver `pg_dump` i samma eller nyare version som servern (16). Sätt `PG_BIN_DIR` om den inte
ligger i `PATH`. Lösenordet lämnas till `pg_dump` via miljön, aldrig på kommandoraden.

**Det som inte ingår i dumpen:** filerna i Supabase Storage (`imports`, `reports`,
`contracts`). Databasen innehåller bara sökvägarna. Kopiera buckets separat (Supabase →
Storage, eller S3-gränssnittet med `aws s3 sync`), samma dag som dumpen. Rapporternas PDF kan
skapas om från ögonblicksbilden i `reports.data_snapshot`; importfilerna och avtalen kan inte
det.

## Återställning steg för steg

Återställ alltid till en **ny** databas och byt sedan. Skriptet vägrar skriva över en
befintlig databas.

### A. En felaktig ändring i produktionen (vanligast): PITR

1. Bestäm tidpunkten strax före felet (ändringsloggen `audit_log` visar vem och när).
2. Supabase → Database → Backups → Point in Time → välj tidpunkten → Restore. Projektet är
   nere under återställningen (minuter till en timme beroende på storlek). Allt som skrivits
   efter tidpunkten försvinner, så notera först det som ska göras om (t.ex. dagens påfyllningar
   under Lager och importer under Datakällor).
3. Kör kontrollerna under D.

Gäller felet bara några rader: återställ i stället en egen dump till en lokal databas (B) och
kopiera tillbaka just de raderna med `psql` som en vanlig ändring, så att resten av
produktionen inte rullas tillbaka.

### B. En egen dump till en ny databas (testat, lokalt och i CI)

```sh
# 1. Återställ till en NY databas på samma server som DATABASE_URL och kontrollera.
npm run db:restore -- --file backups/binderlab-2026-11-02.dump --target binderlab_aterstalld

#    Återställer binderlab från 2026-11-02T12:58:32Z (migrering 20261102181500) …
#      Skapar binderlab_aterstalld …
#      pg_restore binderlab-2026-11-02.dump → binderlab_aterstalld …
#    Kontroll OK: 67 tabeller och 11 108 rader har samma antal och kontrollsumma som när
#    kopian togs.

# 2. Peka appen på den (lokalt: DATABASE_URL i .env.local) och kontrollera enligt D.
```

- Kontrollen jämför varje tabells antal rader och md5 (alla rader som text, sorterade) med
  manifestet. Skiljer något sig avslutas skriptet med kod 2 och listar tabellerna.
- `pg_restore` körs med `--single-transaction` och `--exit-on-error`: antingen kommer allt
  tillbaka eller ingenting. Behörigheter (`grant`), RLS-policyer och triggrar följer med.
- Mot en annan server: `--target-url <url>`; för en server som inte är lokal krävs
  `--allow-remote`, och `--no-owner` om rollerna heter annorlunda där.
- Testat av `test/db/backup-restore.test.ts` (körs med `npm run test:db`, också i CI): seedens
  verksamhet dumpas, återställs till en ny databas, och antal rader och kontrollsummor stämmer i
  alla tabeller; behörigheter, policyer och triggrar är desamma; en ändrad rad upptäcks; och
  återställningen vägrar skriva över en befintlig eller en fjärrdatabas.

### C. Hela Supabase-projektet är borta

1. Skapa ett nytt Supabase-projekt (EU) och gör inställningarna i `docs/miljoer.md` ("Det här
   måste beställaren göra", punkt 1).
2. Återställ den senaste egna dumpen enligt Supabases guide för att flytta en databas
   (roller, schema och data med `psql`/`pg_restore` mot den direkta anslutningen). Användarna
   finns i schemat `auth`, som ingår i dumpen ovan; kontrollera efteråt att inloggning fungerar
   för en ägare. Kör `npm run db:restore -- --file … --target-url <ny> --allow-remote
--no-owner` om projektet är tomt, annars schema för schema enligt guiden.
3. Kopiera tillbaka Storage-filerna till buckets med samma namn och sökvägar.
4. Uppdatera `DATABASE_URL`, `SUPABASE_*` och `NEXT_PUBLIC_SUPABASE_*` i Vercel och GitHub
   (environments `development`/`production`) och driftsätt.
5. Kontrollera enligt D. Detta steg är inte övat mot ett riktigt Supabase-projekt från
   byggmiljön (nätverket är stängt); öva det en gång när produktionen finns.

### D. Kontroller efter en återställning

1. `npm run db:migrate` mot databasen: inga migreringar ska saknas (eller kör de som saknas).
2. Logga in som ägare: Hem visar samma intäkt som före felet för en period som inte berörs.
3. Datakällor: "Data till" stämmer; ladda upp senaste orderlistan igen (dubbletter ändrar
   inget, bara nya order läggs till).
4. Drift: larmjobbet kör ("Senaste körning" uppdateras inom tio minuter).
5. Kör e2e-testerna mot en kopia om tid finns (`npm run test:e2e`, se nedan).

## Nya organisationer

En ny operatör (eget bolag) får en egen organisation. Data delas aldrig mellan organisationer
(RLS på varje tabell, `organization_id` i varje rad).

1. **Användaren**: bjud in personen i Supabase (Authentication → Users → Invite) eller låt en
   befintlig ägare bjuda in via Inställningar → Användare. Nya konton kan inte registrera sig
   själva.
2. **Organisationen**: personen loggar in och kommer till **Kom igång** (`/kom-igang`) eftersom
   hen inte är med i någon organisation. Där skapas organisationen
   (`create_first_organization`: databasen nekar den som redan är med i en organisation eller
   har ett butikskonto). Den som skapar blir ägare.
3. **Kom igång-listan** leder vidare i ordning: första butiken, avtalet med butiken, automaten
   och dess placering, datakällan, första importen och inköpspriserna. Bjud sedan in fler
   användare under Inställningar → Användare (ägare, admin, läsare, påfyllare) och lägg in
   mottagare för rapporterna under Rapporter.
4. **Kontrollera** att Drift visar en körning av larmjobbet inom tio minuter och att Hem visar
   försäljningen efter första importen.

En ägare med flera bolag kan skapa fler organisationer och byta mellan dem i sidomenyn.

## Byte av nycklar

Byt en hemlighet direkt om den kan ha läckt, och annars enligt tabellen. Ordningen är alltid:
skapa den nya → lägg in den där den används → driftsätt → kontrollera → ta bort den gamla.

| Hemlighet                                    | Var den används                                | Hur den byts                                                                                                                               | Följder                                                                                              | Intervall      |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- |
| Databasens lösenord (`DATABASE_URL`)         | Vercel, GitHub environments                    | Supabase → Database → Reset password; uppdatera Vercel (Production och Preview) och GitHub `development`/`production`; driftsätt           | Kort avbrott mellan återställning och driftsättning                                                  | Årligen        |
| `SUPABASE_SECRET_KEY`                        | Vercel (servern)                               | Supabase → API Keys → skapa ny secret key; lägg in; driftsätt; ta bort den gamla                                                           | Inga                                                                                                 | Årligen        |
| JWT-signeringsnyckel (Supabase Auth)         | Supabase; appen läser JWKS                     | Supabase → JWT Keys → skapa standby-nyckel → rotera; den gamla ligger kvar för verifiering tills sessionerna gått ut, återkalla sedan      | Inga (appen hämtar JWKS)                                                                             | Årligen        |
| `CRON_SECRET`                                | Vercel                                         | Ny slumpsträng (`openssl rand -base64 32`); lägg in; driftsätt                                                                             | Cron mellan bytet och driftsättningen får 401                                                        | Vid behov      |
| `RESEND_API_KEY`                             | Vercel                                         | Resend → API Keys → ny nyckel (bara "sending access"); lägg in; driftsätt; ta bort den gamla                                               | Inga                                                                                                 | Årligen        |
| `ANTHROPIC_API_KEY`                          | Vercel (Assistenten)                           | Anthropic Console → ny nyckel; lägg in; driftsätt; ta bort den gamla                                                                       | Inga                                                                                                 | Årligen        |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY`     | Vercel (push)                                  | `npx web-push generate-vapid-keys`; byt båda samtidigt                                                                                     | Alla push-prenumerationer slutar gälla; var och en slår på push igen under Drift → Larminställningar | Bara vid läcka |
| `SENTRY_AUTH_TOKEN`                          | Vercel (bygget)                                | Sentry → Settings → Auth Tokens → ny token (project:releases); byt; återkalla den gamla                                                    | Inga                                                                                                 | Årligen        |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`      | Vercel                                         | Sentry → Client Keys → ny nyckel; byt båda; inaktivera den gamla                                                                           | Inga (DSN är inte hemlig men kan missbrukas för skräp)                                               | Vid behov      |
| Datakällans inloggning (Awish, `secret_ref`) | Där `secret_ref` pekar (byggs med Awish-API:t) | Nytt lösenord hos Awish; uppdatera hemligheten som `secret_ref` pekar på. I dag laddas orderlistan upp som fil och ingen inloggning lagras | Schemalagd import misslyckas tills den är bytt (larm)                                                | Enligt Awish   |
| `DEV_AUTH_SECRET`                            | Bara lokalt och i CI                           | `openssl rand -base64 48` i `.env.local`                                                                                                   | Lokala sessioner loggas ut                                                                           | Vid behov      |

Efter ett byte på grund av läcka: gå igenom `audit_log` och Supabase → Logs för perioden, och
skriv en incidentanteckning (nedan).

## Incidenthantering

**Allvar**

| Nivå | Exempel                                                                 | Svar                   |
| ---- | ----------------------------------------------------------------------- | ---------------------- |
| 1    | Data från en organisation syns för en annan; läckt hemlighet; allt nere | Direkt, även kvällstid |
| 2    | Inloggning eller import fungerar inte; rapporter kan inte skickas       | Samma arbetsdag        |
| 3    | En sida fungerar inte; ett larm som borde komma kommer inte             | Inom en vecka          |

**Gång**

1. **Upptäck**: Sentry-ärende, larm på Drift (`job_failed`, `report_failed`,
   `import_failed`), Vercel → Deployments/Logs, eller en användare som hör av sig.
2. **Bekräfta och avgränsa**: vilka organisationer, sedan när (Sentry "First seen", larmets
   "Sedan", `alert_runs.error`, `imports` med status `failed`)? Kvittera larmet på Drift så att
   andra ser att någon tar hand om det.
3. **Begränsa**:
   - Felaktig driftsättning: Vercel → Deployments → föregående → "Promote to Production"
     (tar under en minut). Databasmigreringar rullas inte tillbaka automatiskt; skriv en ny
     migrering som rättar.
   - Läckt hemlighet: byt den enligt tabellen ovan, först.
   - Misstänkt dataläcka mellan organisationer (nivå 1): sätt Vercel-projektet i underhåll
     (Deployment Protection eller en tom sida), behåll loggar, och kör
     `npm run test:db -- test/db/rls-isolation.test.ts test/db/redteam-isolering.test.ts` mot
     en kopia.
   - Felaktiga data: återställ enligt "Återställning" (A eller B).
4. **Åtgärda** med ett test som visar felet (enhet, databas eller e2e), sedan rättningen.
5. **Efteråt**: skriv en kort anteckning (vad hände, påverkan, tidslinje, orsak, åtgärd, vad
   som ändras) i `docs/incidenter/ÅÅÅÅ-MM-DD-kort-namn.md`. Vid personuppgiftsincident (t.ex.
   en annan organisations kunder eller kontaktuppgifter) ska den personuppgiftsansvarige
   anmäla till IMY inom 72 timmar.

**Vanliga fall**

| Symtom                                  | Troligen                                                  | Gör                                                                                |
| --------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Larmjobbet har inte körts" på Drift    | `CRON_SECRET` saknas, cron avstängt eller Hobby-plan      | Vercel → Settings → Cron Jobs; `curl -H "Authorization: Bearer …" …/api/cron/larm` |
| Larm `job:larm`                         | Databasfel eller trasig data för en organisation          | Läs felet i larmet och `alert_runs.error`; Sentry-ärendet har stackspåret          |
| Larm `import:<källa>` efter uppladdning | Lagringen (bucket `imports`) eller databasen svarade inte | Ladda upp igen; inget sparades. Kvarstår: Supabase → Storage och Logs              |
| Larm `report:<id>`                      | Resend nekar (domän, kvot) eller Chromium för PDF saknas  | Resend → Logs; skicka igen under Rapporter (bara de som inte fått den skickas)     |
| Larm `report_drafts:<månad>`            | Saknade konton för SIE eller en butik utan avtal          | Skapa utkasten under Rapporter; felet står i larmet                                |
| Inloggning misslyckas för alla          | Supabase Auth nere eller JWT-nyckel återkallad            | status.supabase.com; Supabase → JWT Keys                                           |

## E2E-tester

Fem flöden plus felövervakningen går genom webbläsaren med Playwright-biblioteket mot en
körande server: inloggning (rätt och fel lösenord, rollen i kontomenyn), import (seedens
orderlista: förhandsvisning, import, andra gången 0 nya), påfyllning (påfyllaren på 375 px,
nytt saldo, ingen ekonomi), prisändring (Lönsamhet och Hem ändras, ändringsloggen) och
rapportutskick (mottagare, utkast, godkännande, utskick, mejlet i utkorgen).

Servern under test ska ha en egen databas, eftersom testerna ändrar data:

```sh
# 1. En egen server: kopierar arbetskatalogen till ../binderlab-e2e (egen .env.local med
#    DATABASE_URL=…/binderlab_e2e och MAIL_PROVIDER=outbox) och startar next dev på 3210.
npm run e2e:server

# 2. Testerna (E2E_RESET=1 återställer och seedar binderlab_e2e först):
E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54322/binderlab_e2e \
BASE_URL=http://localhost:3210 E2E_OUTBOX_DIR=../binderlab-e2e/.data/outbox E2E_RESET=1 \
npm run test:e2e
```

| Variabel             | Vad                                                                   |
| -------------------- | --------------------------------------------------------------------- |
| `E2E_DATABASE_URL`   | Databasen som servern använder (krävs, lokal)                         |
| `BASE_URL`           | Serverns adress (standard `http://localhost:3200`)                    |
| `E2E_RESET`          | `1` = återställ och seeda databasen före testerna                     |
| `E2E_OUTBOX_DIR`     | Serverns utkorg för mejl (standard `.data/outbox`)                    |
| `E2E_SCREENSHOT_DIR` | Skärmbilder (standard `.data/e2e`)                                    |
| `E2E_TIMEOUT_MS`     | Väntetid per steg (standard 60 000; dev-servern kompilerar vid behov) |

Testerna går att köra flera gånger mot samma databas (varje körning får en egen datakälla,
mottagare och ett nytt pris). Paketet `playwright` är inte ett beroende: lokalt finns det
globalt, i CI installeras det i jobbet `e2e` (`.github/workflows/ci.yml`), som återställer och
seedar en Postgres-container, startar servern och laddar upp skärmbilder, utkorg och serverlogg.
CI-jobbet kör `next dev`: dev-inloggningens spärr stoppar den i ett produktionsbygge
(`next start`), och bygget kontrolleras av jobbet `build`.
