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

| Jobb                  | Schema (UTC)   | Vad                                                                                                                                                                       | Om det misslyckas                                                                                  |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/cron/larm`      | `7 5 * * *`    | Maskinhälsa, lager, importer, avvikande dag; utskick                                                                                                                      | Larm `job:larm` + Sentry, se nedan                                                                 |
| `/api/cron/rapporter` | `17 5 1 * *`   | Utkast för förra månadens rapporter (ingenting skickas)                                                                                                                   | Larm `report_drafts:<månad>` + Sentry                                                              |
| `/api/cron/bokforing` | `37 3 * * *`   | Förra månadens bokföringspaket sparas (pg_cron)                                                                                                                           | Nedladdningen tar fram paketet direkt                                                              |
| `/api/cron/kontroll`  | `37 3,4 * * *` | Daglig kontroll (pg_cron), en gång per org från 05:00 lokal tid: samma vinst överallt, Awish = appen, påfyllningar nådde Awish, synk, avräkningar, datahygien. Läser bara | Larm `self_check:<kontroll>` per röd kontroll, stängs när den går igenom; Inställningar → Kontroll |

`/api/cron/bokforing` schemaläggs av pg_cron i Supabase (`binderlab-bokforing`, migreringen
`20261104130000_bokforing_paket.sql`). Paketet sparas i bucketen `bookkeeping`; ändras underlaget
blir det en ny version. Preliminärt när en butik med vinstdelning har order utan inköpspris.

Kontrollera en gång i veckan (fem minuter):

1. **Drift → Maskinhälsa → Larm**: "Senaste körning" ska vara högst ett dygn gammal (larmjobbet
   körs 05:07 UTC varje dag, `vercel.json`). Står det "Larmjobbet har inte körts" saknas
   `CRON_SECRET` eller cron i Vercel.
2. **Sentry → Issues**: nya ärenden sedan förra veckan (filtrera på `environment:production`).
3. **Datakällor**: "Data till" ska vara färsk för varje källa.
4. **Supabase → Database → Backups**: senaste säkerhetskopian är från i natt.

## Fyll på i telefonen (iPhone)

`/fyll-pa` är mobilsidan vid automaten: automaterna står efter behov (tomma fack först, sedan
lägst fyllnadsgrad), och för varje titel visas `nu/kapacitet` från Awish, hur många pack som
föreslås och hur många som finns hemma. Klar registrerar påfyllningen (samma väg som
Påfyllning: `register_refill_once`), så Vårt lager minskar direkt och Awish-synken drar inte
samma pack en gång till. Fler pack än hemma registreras utan uttag. Utan nät sparas allt i
telefonen och skickas när nätet kommer tillbaka. Ägare, admin och påfyllare.

Installera som app (ingen App Store, inga nycklar):

1. Öppna Binderlab i **Safari** på iPhone och logga in.
2. Tryck **Dela** (rutan med pilen) → **Lägg till på hemskärmen** → **Lägg till**.
3. Öppna Binderlab från hemskärmen och **logga in en gång till**: appen på hemskärmen har egna
   cookies, skilda från Safari. Inloggningen ligger sedan kvar (sessionens cookie gäller i 400
   dagar och förnyas när appen används).

Appen startar i Fyll på (`start_url` i `src/app/manifest.ts`). I menyn nås den via Drift →
**Fyll på** och knappen **Fyll på** nere till höger på telefonen. **QR för påfyllning** på en
automats sida (Automater) ger en utskrivbar kod som öppnar Fyll på för just den automaten
(`/fyll-pa/<id>`).

Kapaciteten och de tomma facken kommer från Awish-läsningen (`stock_locations.awish_fill`, var
femte minut). En automat utan Awish visar saldot men inget förslag. Räkna om (per titel) sparar en
inventering i automaten och kräver uppkoppling.

## Felövervakning och larm

Fel som användaren inte ser själv, eller som händer när ingen är inloggad, ska både nå den som
driver tjänsten (Sentry) och den som äger verksamheten (larm i appen). Koden finns i
`src/server/monitoring`.

| Händelse                                                                                 | Larm i appen (`alerts`)                                    | Sentry-händelse (taggar)                                                         | Stängs när                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Import misslyckas (uppladdning, inte fel i filen)                                        | `import_failed`, nyckel `import:<källa>`, kritiskt         | `area=import`, `kind=import_failed`, källans id                                  | nästa lyckade import från källan                                                       |
| Rapportutskick: en mottagare fick inte mejlet                                            | `report_failed`, nyckel `report:<rapport>`, kritiskt       | `area=report`, `report_id`                                                       | rapporten, eller en nyare version av den (typ, månad, butik), skickats till alla valda |
| Rapportutskick avbryts (PDF eller mejl)                                                  | samma som ovan                                             | samma, med felet                                                                 | samma                                                                                  |
| Månadsutkasten (schemalagt) misslyckas                                                   | `report_failed`, nyckel `report_drafts:<ÅÅÅÅ-MM>`, varning | `area=report`, `job=rapporter`                                                   | jobbet går igenom, eller de saknade utkasten har skapats för hand under Rapporter      |
| Jobbet för månadsutkast kraschar för en organisation                                     | `job_failed`, nyckel `job:rapporter`, kritiskt             | `area=job`, `job=rapporter`                                                      | nästa lyckade körning (de andra organisationerna körs ändå)                            |
| Larmjobbet misslyckas för en organisation                                                | `job_failed`, nyckel `job:larm`, kritiskt                  | `area=job`, `job=larm`                                                           | nästa lyckade körning                                                                  |
| Ett jobb körs inte alls (cron av, fel `CRON_SECRET`, Vercel nere) eller tar för lång tid | inget (appen kör ju inte)                                  | Sentry Cron Monitors: `binderlab-larm`, `binderlab-rapporter`, `binderlab-awish` | nästa lyckade incheckning                                                              |

- **Var det syns**: Drift → Larm (med underlag) och Att göra (okvitterade, kritiska och
  varningar). Ägare, admin och läsare ser larmen. Påfyllaren ser bara larm om automater och
  lager.
- **Aviseringar**: ett nytt systemlarm läggs i utskickskön (`alert_deliveries`) till dem som
  prenumererar under Drift → Larminställningar, med samma regler som övriga larm (typ, lägsta
  allvar, tysta timmar; kritiska larm går igenom tysta timmar om prenumerationen tillåter
  det). Larmjobbet skickar kön en gång per dygn (05:07 UTC), även när utvärderingen
  för organisationen misslyckas; däremellan utvärderas larmen och kön skickas efter varje
  Awish-synk (var femte minut, pg_cron) för organisationer där det behövs, t.ex. när en automat
  går offline (`src/server/awish/offline-alerts.ts`). Samma öppna larm aviseras inte igen. Påfyllaren får aldrig systemlarm
  (`src/server/monitoring/notify.ts`).
- **När jobben inte körs alls**: larmen i appen förutsätter att appen kör. Därför checkar båda
  cron-routerna in hos Sentry Cron Monitors (`src/server/monitoring/cron-monitor.ts`) när
  `SENTRY_DSN` finns: "in_progress" när ett behörigt anrop börjar, sedan "ok" eller "error".
  Monitorerna skapas automatiskt vid första incheckningen med schemat från `vercel.json`
  (`binderlab-larm` varje dag 05:07 UTC, marginal 5 min; `binderlab-rapporter` den 1:a 05:17 UTC,
  marginal 30 min; `binderlab-awish` var femte minut via pg_cron, marginal 5 min). Uteblir en incheckning, till exempel för att `CRON_SECRET` är fel (401)
  eller saknas (503) eller cron är avstängt, skapar Sentry ett ärende. **Vid överlämning:**
  Sentry → Crons → kontrollera att båda monitorerna finns efter första körningen, och lägg en
  larmregel (Alerts → "Cron monitor missed or failed check-in") som mejlar och sms:ar den som
  har driften.
- **Samma problem är ett larm**: högst en öppen rad per nyckel; nya fel räknar upp
  "förekomster" i stället för att skapa nya rader.
- **Misslyckad import**: importens transaktion rullas tillbaka (inga order sparas). Felet
  sparas som en rad i `imports` med status `failed` (syns i Datakällor), och larmjobbet körs
  direkt för organisationen så att regeln `import_failed` skapar larmet med vanliga
  aviseringar. Fel i filen (saknade kolumner, tom fil, fel behörighet) är inga driftfel: de
  visas för användaren och ger inget larm.
- **Sentry** får bara id:n och antal, aldrig e-postadresser (meddelandet och `extra` tvättas
  innan de skickas, och `beforeSend` tar dessutom bort e-post, cookies och token ur hela
  händelsen; båda testas i `src/server/monitoring/sentry.test.ts`). Varje händelse väntar
  högst 2 s på att skickas (`Sentry.flush`), eftersom Vercel fryser funktionen när svaret är
  skickat. Samma sorts fel grupperas till ett ärende (fingeravtrycket innehåller inte
  feltexten). Utan `SENTRY_DSN` skickas ingenting, men larmen i appen skrivs
  ändå. Fel som kastas ut ur en route eller sida fångas av `onRequestError`
  (`src/instrumentation.ts`).
- **Systemroll**: larmen skrivs med `getServiceDb()` (användare får bara kvittera larm). Det
  är ett systemjobb i den mening som `docs/miljoer.md` beskriver: organisationen kommer alltid
  från den verifierade sessionen eller jobbet, och inget läses tillbaka till användaren.
- **Tester**: `test/db/monitoring.test.ts` (import, utskick, utkast, larmjobbet, RLS),
  `test/db/monitoring-closing.test.ts` (nya versioner, utkast för hand, fel per organisation i
  månadsjobbet, aviseringar), `src/server/monitoring/sentry.test.ts` (Sentry med och utan DSN,
  tvätt) och `cron-monitor.test.ts` (incheckningarna), samt
  `e2e/06-felovervakning.e2e.test.ts`: ett framkallat databasfel i ett riktigt anrop till
  `/api/cron/larm` och i en riktig import genom gränssnittet ger larm på Drift och i Att göra,
  och nästa lyckade körning stänger jobblarmet.
- **Inte testat här**: Sentry mot en riktig DSN (ingen nätåtkomst i utvecklingsmiljön). Gör
  det en gång vid överlämningen: sätt `SENTRY_DSN` i Preview, ladda upp en trasig fil eller
  kör `/api/cron/larm` och se att händelsen och incheckningen kommer in.

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
3. Räknar antal rader och en kontrollsumma per tabell i samma ögonblicksbild och skriver dem i
   `<fil>.manifest.json` (format `binderlab-backup/2`, med servrar, versioner och senaste
   migrering, utan lösenord). Kontrollsumman är en md5 per rad (raden som text), summerad, så
   den kräver konstant minne oavsett tabellens storlek och beror inte på radernas ordning.
   Manifest från den första versionen (`/1`) läses inte; ta en ny dump.

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

- Kontrollen jämför varje tabells antal rader och kontrollsumma (md5 per rad, summerad) med
  manifestet. Skiljer något sig avslutas skriptet med kod 2 och listar tabellerna.
- `pg_restore` körs med `--single-transaction` och `--exit-on-error`: antingen kommer allt
  tillbaka eller ingenting. Behörigheter (`grant`), RLS-policyer och triggrar följer med.
- Misslyckas `pg_restore` (trasig eller avbruten dump) tas den nyss skapade databasen bort
  igen, så att nästa försök inte stoppas av "finns redan". Kan den inte tas bort säger
  felmeddelandet det; ta då bort den för hand.
- Mot en annan server: `--target-url <url>`; för en server som inte är lokal krävs
  `--allow-remote`, och `--no-owner` om rollerna heter annorlunda där.
- Testat av `test/db/backup-restore.test.ts` (körs med `npm run test:db`, också i CI): seedens
  verksamhet dumpas, återställs till en ny databas, och antal rader och kontrollsummor stämmer i
  alla tabeller; behörigheter, policyer och triggrar är desamma; en ändrad rad och två värden
  som bytt plats upptäcks men inte en annan radordning; en trasig dump lämnar ingen databas
  efter sig; och återställningen vägrar skriva över en befintlig eller en fjärrdatabas.

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
4. Drift: larmjobbet kör ("Senaste körning" uppdateras vid nästa körning 05:07 UTC, eller direkt
   med `curl -H "Authorization: Bearer …" …/api/cron/larm`).
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
4. **Kontrollera** att Drift visar en körning av larmjobbet (senast nästa morgon 05:07 UTC) och att Hem visar
   försäljningen efter första importen.

En ägare med flera bolag kan skapa fler organisationer och byta mellan dem i sidomenyn.

## Byte av nycklar

Byt en hemlighet direkt om den kan ha läckt, och annars enligt tabellen. Ordningen är alltid:
skapa den nya → lägg in den där den används → driftsätt → kontrollera → ta bort den gamla.

| Hemlighet                                    | Var den används                                                                  | Hur den byts                                                                                                                                                                                                                                                                                                            | Följder                                                                                              | Intervall      |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------- |
| Databasens lösenord (`DATABASE_URL`)         | Vercel, GitHub environments                                                      | Supabase → Database → Reset password; uppdatera Vercel (Production och Preview) och GitHub `development`/`production`; driftsätt                                                                                                                                                                                        | Kort avbrott mellan återställning och driftsättning                                                  | Årligen        |
| `SUPABASE_SECRET_KEY`                        | Vercel (servern)                                                                 | Supabase → API Keys → skapa ny secret key; lägg in; driftsätt; ta bort den gamla                                                                                                                                                                                                                                        | Inga                                                                                                 | Årligen        |
| JWT-signeringsnyckel (Supabase Auth)         | Supabase; appen läser JWKS                                                       | Supabase → JWT Keys → skapa standby-nyckel → rotera; den gamla ligger kvar för verifiering tills sessionerna gått ut, återkalla sedan                                                                                                                                                                                   | Inga (appen hämtar JWKS)                                                                             | Årligen        |
| `CRON_SECRET`                                | Vercel och Supabase Vault (`binderlab_cron_secret`, pg_cron → `/api/cron/awish`) | Vault är källan. Supabase SQL-redigeraren: `delete from vault.secrets where name = 'binderlab_cron_secret';` och kör sedan `scripts/deploy` (slumpar ett nytt i databasen, lägger samma i Vercel och driftsätter). Byt aldrig bara i Vercel: nästa deploy skriver tillbaka Vault-värdet, och pg_cron får 401 tills dess | Awish-synken och cron får 401 mellan bytet och driftsättningen                                       | Vid behov      |
| `RESEND_API_KEY`                             | Vercel                                                                           | Resend → API Keys → ny nyckel (bara "sending access"); lägg in; driftsätt; ta bort den gamla                                                                                                                                                                                                                            | Inga                                                                                                 | Årligen        |
| `ANTHROPIC_API_KEY`                          | Vercel (Assistenten)                                                             | Anthropic Console → ny nyckel; lägg in; driftsätt; ta bort den gamla                                                                                                                                                                                                                                                    | Inga                                                                                                 | Årligen        |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY`     | Vercel (push)                                                                    | `npx web-push generate-vapid-keys`; byt båda samtidigt                                                                                                                                                                                                                                                                  | Alla push-prenumerationer slutar gälla; var och en slår på push igen under Drift → Larminställningar | Bara vid läcka |
| `SENTRY_AUTH_TOKEN`                          | Vercel (bygget)                                                                  | Sentry → Settings → Auth Tokens → ny token (project:releases); byt; återkalla den gamla                                                                                                                                                                                                                                 | Inga                                                                                                 | Årligen        |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`      | Vercel                                                                           | Sentry → Client Keys → ny nyckel; byt båda; inaktivera den gamla                                                                                                                                                                                                                                                        | Inga (DSN är inte hemlig men kan missbrukas för skräp)                                               | Vid behov      |
| Datakällans inloggning (Awish, `secret_ref`) | Supabase Vault, `{organisation}/awish_grpc:{datakälla}`                          | Byt AppSecret/AppKey hos Awish (Developer Center) och spara de nya under Datakällor → Awish                                                                                                                                                                                                                             | Schemalagd import misslyckas tills den är bytt (larm)                                                | Enligt Awish   |
| `DEV_AUTH_SECRET`                            | Bara lokalt och i CI                                                             | `openssl rand -base64 48` i `.env.local`                                                                                                                                                                                                                                                                                | Lokala sessioner loggas ut                                                                           | Vid behov      |

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
| "Larmjobbet har inte körts" på Drift    | `CRON_SECRET` saknas eller cron avstängt                  | Vercel → Settings → Cron Jobs; `curl -H "Authorization: Bearer …" …/api/cron/larm` |
| Sentry: "missed check-in" för en cron   | Jobbet anropas inte, eller svarar 401/503 (`CRON_SECRET`) | Vercel → Logs för `/api/cron/*`; jämför `CRON_SECRET` i Vercel med hemligheten     |
| Larm `job:larm`                         | Databasfel eller trasig data för en organisation          | Läs felet i larmet och `alert_runs.error`; Sentry-ärendet har stackspåret          |
| Larm `job:rapporter`                    | Oväntat fel i månadsjobbet för en organisation            | Sentry-ärendet; skapa utkasten under Rapporter (då stängs månadens utkastlarm)     |
| Larm `import:<källa>` efter uppladdning | Lagringen (bucket `imports`) eller databasen svarade inte | Ladda upp igen; inget sparades. Kvarstår: Supabase → Storage och Logs              |
| Larm `report:<id>`                      | Resend nekar (domän, kvot) eller Chromium för PDF saknas  | Resend → Logs; skicka igen under Rapporter (bara de som inte fått den skickas)     |
| Larm `report_drafts:<månad>`            | Saknade konton för SIE eller en butik utan avtal          | Skapa utkasten under Rapporter; felet står i larmet                                |
| Inloggning misslyckas för alla          | Supabase Auth nere eller JWT-nyckel återkallad            | status.supabase.com; Supabase → JWT Keys                                           |

## Personuppgifter och biträden

Binderlab är i första hand ett verktyg för försäljning och ekonomi, men det lagrar personuppgifter om användare,
butikskontakter och ibland kunder. Den som driver panelen är personuppgiftsansvarig; tjänsterna nedan är biträden.
**Inga personuppgiftsbiträdesavtal (DPA) är tecknade än**, och ingen konsekvensbedömning är gjord.

**Vad som lagras** (kolumnnamn ur databasen):

| Vem                       | Uppgifter                                                                                 | Var                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Användare                 | E-post, lösenordshash (Supabase Auth), visningsnamn, roll, vem som gjort vad              | `auth.users`, `profiles`, `memberships`, `invitations`, `audit_log` |
| Användare                 | Frågor till assistenten och svaren                                                        | `assistant_logs`                                                    |
| Användare                 | Telefonnummer för sms-larm, push-endpoint och webbläsarens user agent                     | `alert_subscriptions.phone`, `push_subscriptions`                   |
| Butikskontakter           | Namn, e-post, telefon, adress; mottagare av rapporter och vart varje rapport skickats     | `stores`, `report_recipients`, `report_deliveries`                  |
| Leverantörer och platser  | Kontaktnamn, e-post och telefon; kontaktuppgifter för tänkbara platser                    | `suppliers`, `expansion_leads`                                      |
| Delägare                  | Namn och andel                                                                            | `owner_shares.holder_name`                                          |
| Kunder (bara kundärenden) | Kontaktuppgift (högst 200 tecken) och beskrivning som skrivs in för hand i ett kundärende | `incidents.customer_contact`, `incidents.description`               |
| Avtal                     | Avtalsfilerna kan innehålla namn och underskrifter                                        | Storage-bucket `contracts`                                          |

Orderna från Awish innehåller inga uppgifter om köparen (tid, belopp, betalsätt, titel och automat). Fritextfälten
(anteckningar) kan innehålla vad som helst som någon skriver in.

**Biträden och vad de får:**

| Tjänst                                       | Får                                                                                                                                                                                                          | Region och att göra                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase (Postgres, Auth, Storage)           | Allt ovan                                                                                                                                                                                                    | Projekt i en EU-region (`docs/miljoer.md`). Teckna Supabases DPA.                                                                                             |
| Vercel (webb och cron)                       | Allt som passerar en förfrågan, loggar                                                                                                                                                                       | Funktionerna (sidor, server actions, API och cron) körs i London: `"regions": ["lhr1"]` i `vercel.json` (se nedan). Teckna Vercels DPA.                       |
| Anthropic (Claude API)                       | Assistentens frågor i fritext, organisationens namn, frågarens roll och verktygens resultat (titlar, automater, butiksnamn och belopp; inga e-postadresser eller telefonnummer)                              | Behandlas utanför EU. Teckna Anthropics DPA (ingår i de kommersiella villkoren), informera användarna, och sätt inte `ANTHROPIC_API_KEY` förrän det är klart. |
| Resend (e-post)                              | Mottagarens adress och mejlets innehåll (rapporter, larm)                                                                                                                                                    | Välj EU-region för avsändardomänen. Teckna Resends DPA.                                                                                                       |
| Sentry (fel)                                 | Felhändelser utan e-postadresser, cookies, Authorization-rubriker och inbjudningstoken (`sendDefaultPii = false` och `scrubEvent` i `src/server/observability/sentry-options.ts`); användarens id finns kvar | Använd EU-regionen (`ingest.de.sentry.io`, som i `.env.example`). Teckna Sentrys DPA.                                                                         |
| Web Push (Google, Mozilla, Apple, Microsoft) | Krypterade aviseringar till användarens enhet                                                                                                                                                                | Innehållet är krypterat från servern till enheten.                                                                                                            |

**Region för Vercels funktioner.** `vercel.json` sätter `"regions": ["lhr1"]` (London, eu-west-2). Alla serverfunktioner, alltså
sidorna, server actions, API-routerna och cron-jobben, körs där. Utan inställningen kör Vercel
funktionerna i USA (`iad1`), och då skulle varje förfrågan med personuppgifter (användare,
butikskontakter, kundärenden) behandlas utanför EU. Inställningen i filen gäller före den i Project
Settings → Functions, så den följer med varje driftsättning och varje Preview.

- Funktionerna ligger i samma region som produktionens Supabase-projekt (eu-west-2, London), så
  att varje fråga mot databasen stannar i regionen. Flyttas databasen ska funktionerna följa med.
- Byt inte region utan att uppdatera tabellen ovan och `docs/decisions.md` (ADR 26). Testet
  `src/app/api/cron/vercel-cron.test.ts` kontrollerar att regionen ligger i EU.
- Vercels CDN serverar statiska filer från närmaste kant (globalt); de innehåller inga
  personuppgifter.

**Lagringstider.** Ekonomiska rader (order, lagerhändelser, utbetalningar, rapporter, godkännanden) raderas inte och
ska sparas i 7 år enligt bokföringslagen. Rådata från importen (`import_rows`) ska gallras efter 24 månader. Databasen
har spärren för gallring (`private.purge_allowed()`, bara databasägaren), men **inget jobb som gallrar är byggt**:
inget raderas efter 7 år eller 24 månader, och `assistant_logs`, `audit_log`, `alert_deliveries` och
`report_deliveries` har ingen lagringstid alls. Bestäm lagringstider för dem, och för användare och butikskontakter
som slutat, innan panelen tas i drift för fler operatörer.

**Den registrerades rättigheter.** Det finns ingen funktion för att lämna ut eller radera en persons uppgifter. En
användare tas bort ur organisationen under Inställningar → Användare, men kontot i Supabase Auth, profilen, frågorna i
`assistant_logs` och spåren i `audit_log` finns kvar och får hanteras för hand i Supabase.

## Inför en visning

En visning för ledning, köpare eller investerare görs lokalt eller i Preview med demon, så att de riktiga siffrorna
inte syns.

1. Återställ utvecklingsdatabasen: `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo`. Den tar bort
   testposter från bygget (bland annat ett rapportutkast för september med `calc_version` "integrationstest" som inte
   får godkännas, och utgångslägen på Effekt som inte kommer från beställaren).
2. Logga in som `demo@binderlab.local` (Nordljus Automater AB (demo)) eller, för verksamhetens egen försäljning,
   `agare@binderlab.local`. Lösenord `binderlab-dev`.
3. Demon har redan larm: `db:seed-demo` kör larmjobbet en gång för demoorganisationen. För att köra jobbet igen
   (till exempel för Binderlab-organisationen), sätt `CRON_SECRET` (minst 16 tecken, `openssl rand -hex 24`) i
   `.env.local`, starta om dev-servern och kör
   `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3200/api/cron/larm`. Utan hemligheten svarar routen
   503 och gör ingenting; med fel hemlighet 401.
4. Visa i den här ordningen: Hem → Att göra → Lönsamhet → Prognos & inköp → Drift på mobilen → Rapporter (en
   butiksrapport som PDF) → Ekonomi. Siffrorna och hur de räknas står i `docs/product.md` och `docs/berakningar.md`.
5. Kör `next dev` (inte `next start`: dev-inloggningen spärras i ett produktionsbygge). Next.js dev-indikator är
   avstängd (`devIndicators: false` i `next.config.ts`), så inget ligger över sidomenyn eller mobilmenyn.
6. Säg att demon är påhittad: alla namn, telefonnummer (PTS serier för fiktiva nummer) och siffror kommer från
   `src/seed/demo/catalog.ts`, och utgångsläget på Effekt (+119 % i oktober) är också påhittat.
7. Återställ demon efter visningen om någon har skapat rapporter, inbjudningar eller ändrat något:
   `npm run db:seed-demo -- --aterstall`. Har någon gått med via en inbjudan (till exempel ett butikskonto i
   portalen) vägrar återställningen tills den medlemmen är borttagen ur demoorganisationen (`docs/demo.md`).

## Överlämning till en ny ägare

Checklista när panelen lämnas över (till en köpare eller en ny driftansvarig):

| Steg            | Vad                                                                                                                                                                  | Var                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Kod             | Repot, med `main` som produktion. Läs `README.md`, `docs/architecture.md` och `docs/decisions.md` först.                                                             | GitHub                      |
| Konton          | Överför eller bjud in den nya ägaren i Vercel, Supabase (båda projekten), Sentry, Resend, GitHub och Anthropic Console. Ta bort tidigare personers åtkomst efteråt.  | Respektive tjänst           |
| Hemligheter     | Byt alla hemligheter enligt "Byte av nycklar" ovan när de tidigare ägarna inte längre ska ha åtkomst.                                                                | Vercel, GitHub environments |
| Ägare i appen   | Bjud in den nya ägaren som `owner` under Inställningar → Användare och ta bort eller nedgradera de tidigare. Databasen ser till att det alltid finns minst en ägare. | Appen                       |
| Säkerhetskopior | Kontrollera PITR och dagliga backuper, och flytta de egna dumparna till den nya ägarens lagring.                                                                     | Supabase, extern lagring    |
| Övervakning     | Larmregeln för Sentry Cron Monitors och prenumerationerna under Drift → Larminställningar ska gå till den nya driftansvarige.                                        | Sentry, appen               |
| Leverantörer    | Avtal och kontaktpersoner hos Awish (orderlista, framtida API), automatleverantörens utbetalningar och bokföringsbyrån (SIE-serie och startnummer).                  | Utanför appen               |
| Prova           | Kör kontrollerna under "Återställning steg för steg", D, och e2e-testerna mot en kopia.                                                                              | Lokalt eller Preview        |

Kända brister och vad som återstår står sist i `README.md`.

## E2E-tester

Sex flöden plus felövervakningen går genom webbläsaren med Playwright-biblioteket (inte
`@playwright/test`) och vitest mot en körande server:

| Fil                 | Flöde                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-inloggning`     | fel och rätt lösenord, rollen i kontomenyn, utloggning, läsaren når inte Datakällor                                                                                                  |
| `02-import`         | körningens orderlista: förhandsvisning, 12 nya order, ordern under Order, andra gången 0 nya                                                                                         |
| `03-pafyllning`     | påfyllaren på 375 px: registrera, nytt saldo, ingen ekonomi (och Lönsamhet, Ekonomi, Inköpspriser, Rapporter skickar vidare)                                                         |
| `04-prisandring`    | nytt inköpspris: Lönsamhet och Hem (seedens fasta period i adressen) ändras, ändringsloggen                                                                                          |
| `05-rapportutskick` | mottagare, utkast, godkännande (PDF), utskick, mejlet i utkorgen med PDF och hälsning; mottagaren pausas efteråt                                                                     |
| `06-felovervakning` | framkallat databasfel i `/api/cron/larm` och i en import genom gränssnittet: larm på Drift och i Att göra, påfyllaren ser det inte (375 px, mörkt), nästa körning stänger jobblarmet |
| `07-fyll-pa`        | Fyll på på iPhone 15 (Playwrights `devices["iPhone 15"]`): automaten med tomma fack först, −, Klar, toasten "Sparat – …", vårt lager och automaten i databasen                       |

Varje test kontrollerar att sidan inte haft sidfel eller konsolfel (t.ex. Reacts
hydreringsfel), utom en kort lista kända och ofarliga (`ALLOWED_CONSOLE_ERRORS` i
`e2e/support/browser.ts`). Inga väntetider utan villkor.

Servern under test ska ha en egen databas, eftersom testerna ändrar data:

```sh
# 1. En egen server: kopierar arbetskatalogen till ../binderlab-e2e (egen .env.local med
#    DATABASE_URL=…/binderlab_e2e, CRON_SECRET och MAIL_PROVIDER=outbox) och startar
#    next dev på 3210. Förra kopians kod tas bort först, så borttagna filer inte testas.
npm run e2e:server

# 2. Testerna (E2E_RESET=1 återställer och seedar binderlab_e2e först):
E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54322/binderlab_e2e \
E2E_CRON_SECRET="$(grep ^CRON_SECRET= ../binderlab-e2e/.env.local | cut -d= -f2)" \
E2E_OUTBOX_DIR=../binderlab-e2e/.data/outbox E2E_RESET=1 \
npm run test:e2e
```

| Variabel             | Vad                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `E2E_DATABASE_URL`   | Databasen som servern använder (krävs): lokal, "e2e" eller "test" i namnet, inte den i `.env.local` |
| `E2E_BASE_URL`       | Serverns adress (standard `http://localhost:3210`; port 3200, den vanliga dev-servern, vägras)      |
| `E2E_CRON_SECRET`    | Serverns `CRON_SECRET`, för att köra larmjobbet (i CI samma som `CRON_SECRET`)                      |
| `E2E_RESET`          | `1` = återställ och seeda databasen före testerna                                                   |
| `E2E_OUTBOX_DIR`     | Serverns utkorg för mejl (standard `.data/outbox`)                                                  |
| `E2E_SCREENSHOT_DIR` | Skärmbilder (standard `.data/e2e`)                                                                  |
| `E2E_TIMEOUT_MS`     | Väntetid per steg (standard 60 000; dev-servern kompilerar vid behov)                               |

Skydden i `e2e/global-setup.ts` och `e2e/support/fixture.ts`:

- Databasen måste vara lokal, ha "e2e" eller "test" i namnet och får inte vara samma som
  `DATABASE_URL` i `.env.local`; `E2E_RESET=1` raderar den annars inte.
- Servern måste använda den databasen: påfyllaren får ett nytt lösenord för varje körning och
  loggar in innan testerna börjar. Läser servern en annan databas stoppas körningen med ett
  tydligt fel.

**Data mellan körningar.** CI börjar alltid från en nyss seedad databas. Lokalt går testerna
att köra flera gånger mot samma databas utan att den försämras: importen använder körningens
egen orderlista (12 rader ur seedens CSV med nya ordernummer) i den fasta källan "E2E-import",
priset ersätter samma dags pris, mottagaren pausas efter utskicket, felen tas bort efter testet.
Varje körning lägger alltså till 12 order, 3 misslyckade importrader, ett pris, en rapportversion
och en pausad mottagare. Kör med `E2E_RESET=1` när du vill börja om.

**Kopian i `../binderlab-e2e`.** `node_modules` är hårda länkar till projektets (Turbopack
följer inte en symlänk utanför projektet), och länkas om när `package-lock.json` ändrats. Kör
aldrig `npm install` i kopian: det skriver i projektets filer.

Paketet `playwright` är inte ett beroende: lokalt finns det globalt, i CI installeras det i
jobbet `e2e` (`.github/workflows/ci.yml`), som återställer och seedar en Postgres-container,
startar servern på 3210 och laddar upp skärmbilder, utkorg och serverlogg. CI-jobbet kör
`next dev`: dev-inloggningens spärr stoppar den i ett produktionsbygge (`next start`), och
bygget kontrolleras av jobbet `build`. Jobbet har inte körts på GitHub än; första körningen
kan behöva längre `E2E_TIMEOUT_MS` eller `testTimeout` (300 s) om dev-servern kompilerar
långsamt.
