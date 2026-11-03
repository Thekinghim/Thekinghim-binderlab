# Binderlab

Kontrollpanel för operatörer av varuautomater med samlarkortspack. Binderlab läser in försäljningen från
automatleverantören (Awish), räknar vinsten per titel, automat och butik efter inköp och butiksersättning, säger vad
som ska fyllas på innan det tar slut, larmar när en automat slutar sälja och skapar månadsrapporterna till butiker,
bokhållare och delägare.

**För vem:** ägaren och delägarna i ett bolag som har automater utställda i butiker, påfyllaren i fält (mobilen,
fungerar utan nät), butikerna (egen portal) och bokhållaren (SIE 4 och Excel). Vad panelen löser och vilka siffror den
visar står i [docs/product.md](docs/product.md).

## Skärmbilder

En nyskapad databas efter snabbstarten nedan (`db:reset`, `db:seed`, `db:seed-demo`: verksamhetens riktiga
försäljning 13 okt.–1 nov. 2026 med exempelbutiker), inloggad som ägare och tagna 2 nov. 2026. Hem, Lönsamhet och
Enhetsekonomi visar perioden "Allt"; Att göra och Prognos räknas från dagens datum och ser därför annorlunda ut en
annan dag.

|                                                                                                           |                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ![Hem i mörkt läge, period Allt: intäkt 79 987 kr och vinst 21 858 kr på 21 dagar](docs/img/hem-mork.png) | ![Lönsamhet i ljust läge: vattenfall från intäkt till vinst](docs/img/lonsamhet-ljus.png)           |
| **Hem (period Allt):** intäkt, vinst, marginal, Att göra och mest sålda titlar                            | **Lönsamhet:** från intäkt till vinst, order utan inköpspris och butiksersättning                   |
| ![Att göra i mörkt läge: åtta punkter, tre i dag, 12 405 kr i risk](docs/img/att-gora-mork.png)           | ![Prognos och inköp i ljust läge: prognos för fyra veckor med intervall](docs/img/prognos-ljus.png) |
| **Att göra:** påfyllningar med lager, räckvidd och intäkt i risk                                          | **Prognos & inköp:** utfall och prognos per vecka med 80 %-intervall                                |
| ![Enhetsekonomi i mörkt läge: vinst per automat och dag](docs/img/enhetsekonomi-mork.png)                 | ![Drift på en mobil i ljust läge](docs/img/drift-mobil-ljus.png)                                    |
| **Enhetsekonomi:** vinst per automat och dag, investering och återbetalning                               | **Drift på mobilen (375 px):** maskinhälsa, besöksplan och påfyllning                               |

## Snabbstart lokalt

Krav: Node 22, Postgres 16 och (för PDF) en Chromium som puppeteer-core hittar. Kör inte mot en databas som inte är
lokal: `db:reset` och dev-inloggningen vägrar allt annat än `127.0.0.1`/`localhost`.

```sh
# 1. Postgres 16 på port 54322, till exempel i Docker:
docker run -d --name binderlab-pg -p 54322:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16

# 2. Beroenden och miljö
npm ci
cp .env.example .env.local
#    Sätt DEV_AUTH_SECRET i .env.local:  openssl rand -base64 48
#    DATABASE_URL och DATABASE_URL_TEST pekar redan på 127.0.0.1:54322.

# 3. Databasen: skapa om (auth-shim + alla migreringar), seeda och lägg in demon
npm run db:reset -- dev
npm run db:seed        # 460 riktiga order 13 okt.–1 nov. 2026, tre exempelbutiker och automater
npm run db:seed-demo   # valfritt: Nordljus Automater AB (demo), påhittad data feb.–nov. 2026

# 4. Starta
npx next dev -p 3200   # http://localhost:3200
```

Inloggning lokalt (lösenord `binderlab-dev`, ändras med `DEV_SEED_PASSWORD`):

| Användare                                                       | Roll              | Organisation                   |
| --------------------------------------------------------------- | ----------------- | ------------------------------ |
| `agare@binderlab.local`                                         | Ägare             | Binderlab (seedad försäljning) |
| `delagare@binderlab.local`                                      | Läsare (delägare) | Binderlab                      |
| `demo@binderlab.local`                                          | Ägare             | Nordljus Automater AB (demo)   |
| `demo-lasare@binderlab.local`, `demo-pafyllare@binderlab.local` | Läsare, påfyllare | Demo                           |

Lokalt lämnar inget mejl servern. Inbjudningar skrivs som `.eml`-filer i `.data/mail/` (dev-inloggningen har bara
lösenord, inga inloggningslänkar), rapport- och larmmejl i `.data/outbox/<id>/`, push i `.data/outbox/push/` och sms i
`.data/outbox/sms/`. Allt som behöver en extern tjänst har en lokal ersättare; vilka variabler som styr vad står i
[docs/miljoer.md](docs/miljoer.md). Demon beskrivs i [docs/demo.md](docs/demo.md).

**Prova butiksportalen** (det finns inget seedat butikskonto):

1. Logga in som `agare@binderlab.local`, öppna **Butiker** och en butik, och fyll i **E-post till butiken** under
   butiksportalen (till exempel `butik@binderlab.local`) → **Bjud in till portalen**.
2. Öppna den nyaste filen i `.data/mail/` och kopiera länken `http://localhost:3200/inbjudan/<token>`.
3. Öppna länken i ett privat fönster, välj ett lösenord (minst 12 tecken) och gå med. Du hamnar på `/portal` och ser
   bara den butikens försäljning, ersättning, godkända rapporter och felanmälan.

**Larmjobbet lokalt:** `/api/cron/larm` och `/api/cron/rapporter` svarar 503 tills `CRON_SECRET` (minst 16 tecken,
till exempel `openssl rand -hex 24`) är satt i `.env.local` och dev-servern startats om. `db:seed-demo` kör redan
larmjobbet en gång för demoorganisationen.

## Tester

| Kommando                                                    | Vad                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                  | Enhetstester (vitest, `src/**/*.test.ts`), cirka 2 550 tester på under en minut                                                                            |
| `npm run test:db`                                           | Databastester mot riktig Postgres (`test/db`, cirka 2 400 tester: RLS, isolering, triggrar, tjänster, attacktester). Återställer `DATABASE_URL_TEST` först |
| `npm run test:domain:tz`, `test:import:tz`, `test:seed:tz`  | Beräkningar, import och seed under UTC, Europe/Stockholm och Asia/Shanghai                                                                                 |
| `npm run e2e:server` och sedan `npm run test:e2e`           | Sex flöden i webbläsaren (Playwright) mot en egen server på port 3210 och en egen databas                                                                  |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | tsc i strikt läge, ESLint, Prettier                                                                                                                        |

Databastesterna använder `DATABASE_URL_TEST` och återställer den (drop/create och alla migreringar) en gång per
körning. Kör flera spår samtidigt med var sin databas:
`DATABASE_URL_TEST=postgres://postgres@127.0.0.1:54322/binderlab_test_<namn> npm run db:reset -- test` och samma
variabel för `npm run test:db -- <filer>`. E2E kräver variablerna i [docs/operations.md](docs/operations.md#e2e-tester).
CI (`.github/workflows/ci.yml`) kör format, lint, typer, enhetstester i tre tidszoner, databastester, `next build`
och e2e.

## Driftsättning

Vercel (webb och cron) och Supabase i EU (Postgres, Auth, Storage), med Sentry för fel och Resend för e-post.

1. **Supabase:** ett projekt för utveckling och ett för produktion. Kräv bekräftad e-post, stäng av egen
   registrering, använd asymmetriska JWT-nycklar (ES256) och sätt mallarna för inbjudan och inloggningslänk.
2. **Vercel:** importera repot och sätt variablerna enligt `.env.example` för Preview och Production
   (`APP_ENV`, `AUTH_PROVIDER=supabase`, `APP_URL`, `DATABASE_URL` mot poolern på port 6543, `DATABASE_POOL_MAX=3`,
   Supabase-, Sentry-, VAPID- och `CRON_SECRET`-värden). Cron-jobben står i `vercel.json`; larmjobbet var 10:e minut
   kräver Vercel Pro.
3. **E-post (Resend):** sätt `MAIL_PROVIDER=resend`, `RESEND_API_KEY` och `MAIL_FROM` (en avsändare på en domän som
   är verifierad i Resend). **Standardvärdet är `outbox` även i production**: utan `MAIL_PROVIDER=resend` skrivs
   rapport- och larmmejlen till serverns disk och når aldrig mottagarna. Inbjudningar och inloggningslänkar skickas av
   Supabase Auth (SMTP och mallar ställs in där).
4. **Assistenten:** sätt `ANTHROPIC_API_KEY` (Claude Console → API Keys), och vid behov `ANTHROPIC_MODEL`. Utan nyckel
   visar `/assistent` att nyckeln saknas och skickar ingenting. Frågorna och verktygens resultat skickas till
   Anthropic; se avsnittet om personuppgifter i [docs/operations.md](docs/operations.md#personuppgifter-och-biträden).
5. **Migreringar:** GitHub Actions → "Migrera databasen" → välj `development` eller `production` (kör
   `npm run db:migrate` med `DATABASE_URL` från GitHub Environment; produktion kräver godkännande och `main`). Nya
   ändringar i databasen görs alltid som en ny fil i `supabase/migrations` med en tidsstämpel efter alla befintliga.
6. **Första ägaren:** bjud in i Supabase, logga in och skapa organisationen under Kom igång.

Steg för steg i [docs/miljoer.md](docs/miljoer.md) ("Det här måste beställaren göra"). Daglig drift, larm,
säkerhetskopior, återställning, nyckelbyten och incidenter i [docs/operations.md](docs/operations.md).

## Mappstruktur

```
src/app/            Next.js App Router: (app)/ panelens sidor, portal/ butiksportalen, rapport/ PDF- och mejlsidan,
                    api/cron/ schemalagda jobb, logga-in/ och inbjudan/
src/server/         Serverkod: session och behörighet (session.ts, access.ts), laddare (data/), tjänster och
                    adaptrar per område (reports, accounting, alerts, assistant, purchasing, market, portal, …)
src/domain/         Rena beräkningar: öre, baspunkter, datum, priser, hyra, provision, lönsamhet, enhetsekonomi
src/analytics/      Rena analyser: Att göra, maskinhälsa, larm, prognos, förlorad försäljning, inköp, avstämning,
                    kassaflöde, avtal, expansion, effekt, marknad, besöksplan
src/reports/        Rapportmodeller, SIE 4 och Excel
src/import/         Importen: adaptergränssnitt, Awish (API och CSV) och den gemensamma pipelinen
src/db/             Drizzle-schema, anslutning (withRls, getServiceDb) och migreringskörare
src/components/     ui/, charts/ (egna SVG-diagram), shell/ (sidomeny och period), report/, pwa/
src/seed/           Seed (riktig försäljning) och demo/
supabase/           migrations/ (SQL med RLS, triggrar och RPC:er) och local/auth-shim.sql
scripts/db/         reset, migrate, seed, seed-demo, backup, restore
test/db/            Databastester
e2e/                Webbläsartester
docs/               Dokumentationen (nedan)
```

## Dokumentation

| Fil                                                                                                                      | Innehåll                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [docs/product.md](docs/product.md)                                                                                       | Vad Binderlab löser, för vem, siffror ur panelen och hur effekten mäts |
| [docs/architecture.md](docs/architecture.md)                                                                             | Lager, adaptrar, jobb, dataflöden, säkerhetsmodell, tider och pengar   |
| [docs/decisions.md](docs/decisions.md)                                                                                   | Tekniska beslut (ADR) och varför                                       |
| [docs/datamodell.md](docs/datamodell.md)                                                                                 | Tabeller, roller, RLS och alla funktioner, per område                  |
| [docs/berakningar.md](docs/berakningar.md)                                                                               | Hur varje siffra räknas, med exempel som också är tester               |
| [docs/miljoer.md](docs/miljoer.md)                                                                                       | Miljöer, variabler, inloggning, adaptrar och beställarens steg         |
| [docs/operations.md](docs/operations.md)                                                                                 | Drift, övervakning, säkerhetskopior, återställning, incidenter, e2e    |
| [docs/design.md](docs/design.md)                                                                                         | Designsystemet: tokens, komponenter, regler                            |
| [docs/demo.md](docs/demo.md)                                                                                             | Demoorganisationen                                                     |
| [docs/awish-api.md](docs/awish-api.md), [docs/awish.md](docs/awish.md), [docs/marknadskallor.md](docs/marknadskallor.md) | Awish API och CSV-importen; underlag för val av marknadspriskälla      |
| [docs/bygglogg.md](docs/bygglogg.md)                                                                                     | Byggets logg och läge per fas                                          |

## Läge och kvarstående

Läget 2 nov. 2026, efter fas 7:s sista rättningar. Sammanfattning av fas 7 med testsiffror, säkerhet och prestanda:
[docs/review/fas-7/slutrapport.md](docs/review/fas-7/slutrapport.md).

### Klart

- **Fas 1–11 i planen är byggda och granskade:** designsystem; datamodell med RLS, inloggning och import; Hem, Att
  göra, Lönsamhet, Inköpspriser, Order, Lager, Automater, Butiker; Rapporter med PDF, Excel, SIE 4, godkännande och
  utskick; Prognos & inköp, Assistent, Expansion, Enhetsekonomi och Effekt; Drift med larm, push, besöksplan och
  fältläge (PWA); Ekonomi med avstämning, verifikationer och kassaflöde; Avtal; Butiksportal; Marknad.
- **Fas 7 (kvalitet, drift, överlämning):** demoläge, onboarding (Kom igång), global sökning, integration mellan
  sidorna, säkerhetsgranskning med attacktester, e2e-tester, säkerhetskopiering med återställningstest,
  felövervakning, prestanda med 109 000 order, genomgång av alla sidor och dokumentationen.
- **Styrelsedemo-granskningen** (oberoende, betyg 7/10) är åtgärdad för alla punkter med allvar hög och medel:
  förlorad försäljning räknas med rätt ordning inom dagen, Ekonomi nämner utbetalningens egen period, tystnaden är
  densamma på Hem, Att göra och Drift, Att göra skiljer den första punktens belopp från summan, gränssnittet är på
  svenska, dev-indikatorn är borta, butiksrapporten visar avsändaren och en rad för övriga titlar, och mejl och PDF
  säger samma sak. Detaljer i slutrapporten.
- **Koden** ligger på `main` (produktion enligt `docs/operations.md`), sammanslagen från `claude/bygge` efter en grön
  körning av hela testsviten.

### Kända brister

- **Inte provat mot riktiga tjänster** (byggmiljön hade inget nät): Supabase-lägena (PostgREST, storage-policyer,
  JWKS, inbjudningsmejl), Resend, Sentry, Vercel Cron, Web Push, PDF-visning i en vanlig Chrome och CI-jobbet för e2e
  på GitHub. Allt har lokala ersättare och tester, men ingen extern integration har körts en enda gång.
- **Awish:** orderna hämtas från Awish officiella gRPC-API var tionde minut (`docs/awish-api.md`), men det är bara
  provat mot en låtsasserver; byggmiljön når inte Awish. Uppladdning av orderlistan (CSV) finns kvar som reserv.
  Utbetalningarnas API och maskindata kräver dokumentation från Awish. Maskinhälsan härleds ur försäljningen.
- **Säkerhet:** CSP:n tillåter `'unsafe-inline'` för skript (nonce-CSP kräver dynamisk rendering), HSTS saknar
  `includeSubDomains`, det finns ingen gräns för hur ofta inbjudningar och rapporter kan skickas, och gränserna för
  inloggning, assistent, sökning, provlarm och felanmälan räknas per serverinstans (`docs/architecture.md`).
- **Mejl till mottagare utan konto:** butiksmejlet länkar till butiksportalen och säger att rapporten är bifogad;
  bokföringsmejlets länk kräver inloggning (allt underlag är bifogat).
- **Vercel:** avtalsfiler över cirka 4,4 MB stoppas av plattformen (gräns 4,5 MB per förfrågan); orderlistan laddas
  upp i bitar och påverkas inte.
- **Prestanda:** Ekonomi 30 d ligger på målet (2,0 s i `next start` med 109 000 order). Demon visas i `next dev`
  (dev-inloggningen spärras i `next start`), där första laddningen av en sida tar flera sekunder medan den
  kompileras; granskningen mätte 3,9–4,4 s för Ekonomi och Assistent. Ladda sidorna en gång före visningen.
- **Inte valda eller inte byggda leverantörer:** sms (telefonnumret måste verifieras innan en leverantör kopplas),
  bokföringsprogram (Fortnox, Visma, Bokio har gränssnittet men ingen implementation), marknadspriser (beställaren
  väljer källa) och status "öppnad" för mejl (kräver Resends webhook).
- **Ekonomi:** kassaflödet tar inte emot kända återbetalningar som egen post, en uppladdad utbetalning kopplas till
  den äldsta aktiva datakällan, butiksersättningen antas betalas sista dagen månaden efter, och moms och kortavgift
  är inte tidsversionerade.
- **Effekt:** beställarens utgångsläge är inte registrerat, och slutsålda dagar och tid matas in för hand per månad.
  Effekten för verksamheten kan därför inte visas än. Demons +119 % bygger på ett påhittat utgångsläge.
- **Övrigt:** assistenten använder inte filtren för butik och automat, antalet fack per automat på Marknad är fast 6
  (`SLOTS_PER_MACHINE`), Lönsamhet med bara butiksfilter visar inga fasta kostnader, säkerhetskopian av databasen
  innehåller inte filerna i Storage, och inget gallras automatiskt efter lagringstiden.
- **Utvecklingsdatabasen** `binderlab_dev` på byggmaskinen innehåller testposter från bygget. Siffrorna och
  skärmbilderna i dokumentationen är tagna i en nyskapad databas. Kör
  `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo` före en visning (`docs/operations.md`,
  "Inför en visning").
- **Licens och avtal:** repot har ingen LICENSE-fil och inga personuppgiftsbiträdesavtal är tecknade (se
  [Licens och ägande](#licens-och-ägande) och
  [docs/operations.md](docs/operations.md#personuppgifter-och-biträden)).

### Innan andra operatörer kan börja använda panelen

Panelen fungerar i dag för en operatör (en organisation) åt gången, driftsatt av beställaren. Innan fler operatörer
släpps in behövs:

1. **Driftsättning och nycklar.** Projekt i Supabase (EU, helst Stockholm `eu-north-1`), Vercel (funktionerna i
   `arn1`, redan satt i `vercel.json`, Pro för larmjobbet var 10:e minut), Sentry (EU-region), Resend (verifierad
   avsändardomän), VAPID-nycklar för push, `CRON_SECRET` och `ANTHROPIC_API_KEY`. Steg för steg i
   [docs/miljoer.md](docs/miljoer.md) ("Det här måste beställaren göra").
2. **Prova varje extern tjänst en gång:** inloggning och inbjudan via Supabase, import till Storage, rapportutskick
   via Resend, ett fel i Sentry, en cron-körning och push till en telefon. Kör e2e-jobbet i GitHub Actions.
3. **Avtal.** Personuppgiftsbiträdesavtal med Supabase, Vercel, Resend, Sentry och Anthropic; lagringstider och
   gallring (i dag gallras inget efter 7 år eller 24 månader); ett standardavtal med operatörerna (personuppgifts-
   ansvar, villkor); avtal med Awish om API-åtkomst; och vid en försäljning köpeavtal och LICENSE-fil.
4. **Awish-integrationen** (`awish_grpc`): kontrollera den mot Awish riktiga server enligt
   `docs/awish-api.md` (token, tidszon, belopp, ordning), och maskindata när Awish kan leverera den.
5. **Gränser för utskick** (inbjudningar, rapporter) och gemensamma gränser för inloggning och assistent för alla
   serverinstanser (till exempel i databasen).
6. **Leverantörer per operatör:** bokföringsprogram och sms-leverantör, eller stäng av funktionerna för operatörer
   som inte har dem. Välj marknadspriskälla.
7. **Plattformsfasen (fas 12)**, som enligt planen byggs när det finns 2–3 pilotoperatörer: hur en ny operatör kommer
   in (i dag inbjudan i Supabase och Kom igång), plan och automatgräns (`organizations.machine_limit`), fakturering,
   administration av flera operatörer och support.
8. **Effekten:** låt beställaren registrera utgångsläget och mäta tre hela månader, så att effekten går att visa för
   nästa operatör med riktiga siffror.

## Licens och ägande

Det finns ingen LICENSE-fil. `package.json` har `"private": true` och ingen `license`, så koden är inte öppen
källkod och får inte spridas utan ägarens tillstånd. Vem som äger koden och vad en köpare får (överlåtelse eller
licens) ska stå i köpeavtalet och sedan i en LICENSE-fil i roten.

Beroendena har egna licenser. Sammanställning ur `package-lock.json` (2 nov. 2026): 436 paket som inte är
utvecklingsberoenden, inklusive plattformsbinärer som bara installeras på sin plattform. 327 MIT, 34 Apache-2.0, 31 ISC,
och resten BSD, 0BSD, BlueOak-1.0.0, Unlicense, MIT-0 och liknande tillåtande licenser. Det här behöver en köpare titta
på:

| Paket                                                                        | Licens                               | Varifrån och vad det betyder                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@img/sharp-libvips-*`, `@img/sharp-win32-*` (0.35.5)                        | LGPL-3.0-or-later (libvips)          | Bildbehandlingen `sharp` som Next.js använder. Dynamiskt länkat bibliotek; LGPL-villkoren gäller om det distribueras. |
| `web-push` (3.6.7)                                                           | MPL-2.0                              | Web Push. Ändringar i paketets egna filer ska delas; resten av koden påverkas inte.                                   |
| `sentry` (0.45.0, Sentry CLI)                                                | FSL-1.1-Apache-2.0                   | Via `@sentry/nextjs` vid bygget (källkartor). Fri att använda men inte för en konkurrerande tjänst.                   |
| `jszip` (3.10.2)                                                             | MIT eller GPL-3.0-or-later           | Via `exceljs`. Välj MIT.                                                                                              |
| `@grpc/grpc-js` (1.14.6), `@grpc/proto-loader` (0.8.1), `protobufjs` (7.6.6) | Apache-2.0, Apache-2.0, BSD-3-Clause | Awish gRPC-API (3 nov. 2026). Tillåtande; Apache-2.0 kräver att licens- och NOTICE-texten följer med vid spridning.   |
| `buffers` (0.1.1)                                                            | anges inte i paketet                 | Se nedan. Kan tas bort med en `overrides` i `package.json`.                                                           |
| `caniuse-lite`                                                               | CC-BY-4.0                            | Webbläsardata vid bygget.                                                                                             |
| `geist`                                                                      | SIL Open Font License                | Typsnitten; får bäddas in men inte säljas separat.                                                                    |

**`buffers`.** `npm ls buffers` ger `exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1`.
Paketet (James Halliday, 2011) saknar både `license` i `package.json` och licenstext, så det är formellt "alla
rättigheter förbehållna". Binderlab använder aldrig koden: `unzipper` behövs bara av exceljs strömmande läsare
(`stream.xlsx.WorkbookReader`), och appen skriver bara Excel (`src/reports/excel.ts`, `xlsx.writeBuffer`)
och läser i testerna med `xlsx.load`, som går via `jszip`. Filen följer ändå med i driftsättningen, eftersom
`exceljs` laddar läsaren när paketet importeras. Två sätt att bli av med det:

1. **Rekommenderat:** `unzipper` 0.12 har inte `binary` och `buffers` som beroenden. Lägg till
   `"overrides": { "exceljs": { "unzipper": "^0.12.3" } }` i `package.json`, kör `npm install` och sedan
   `npm test` (Excel-testerna i `src/reports`) och `npm run build`. Det är inte gjort, eftersom beroendena inte
   uppdaterades under överlämningen.
2. Byt Excel-biblioteket mot ett utan `unzipper` (till exempel att skriva XLSX med `jszip` direkt). Större ändring.

Sammanställningen är räknad med ett skript över `package-lock.json` och paketens `package.json`, inte granskad av
jurist. Ta om den efter varje uppdatering av beroendena, till exempel med `npx license-checker-rseidelsohn --production
--summary` efter `npm ci`.
