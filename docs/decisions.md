# Tekniska beslut

Viktiga val i Binderlab, skrivna som korta ADR:er (Architecture Decision Records): kontext, beslut och
konsekvenser. Varje beslut hänvisar till koden där det syns. Arkitekturen i sin helhet står i
`docs/architecture.md`.

Status för alla: **gäller** (2 nov. 2026). Ett beslut som ändras får en ny post som ersätter den gamla, så att
historiken finns kvar.

---

## ADR 1. Next.js App Router med server actions, ingen separat API-tjänst

**Kontext.** Panelen är ett internt verktyg för en operatör och dess personal. Nästan allt är läsning av egna data
och små ändringar. En separat API-tjänst skulle ge två kodbaser, två driftsättningar och ett extra ställe där
behörigheten måste kontrolleras.

**Beslut.** Next.js 16 med App Router. Sidor är serverkomponenter som laddar data på servern; ändringar är server
actions (`actions.ts` per sida); filer, cron och strömmade svar är route handlers. Ingen webbläsarklient mot
Supabase.

**Konsekvenser.** En kodbas och en driftsättning (Vercel). All dataåtkomst sker på servern med användarens session,
så ingen nyckel till databasen når webbläsaren. Server actions är publika POST-ändpunkter, så varje action måste
själv kontrollera roll och indata (`requireRole`, zod); attacktesterna i `test/db/redteam-fas7-actions.test.ts`
prövar det. Next 16 skiljer sig från tidigare versioner (proxy i stället för middleware, `react-dom/server` är inte
tillåtet i serverkomponenter); dokumentationen i `node_modules/next/dist/docs` gäller.

## ADR 2. Drizzle ORM över postgres.js, inte Prisma

**Kontext.** Säkerheten bygger på RLS. Varje fråga på uppdrag av en användare måste köras i en transaktion där
rollen är `authenticated` och JWT-claims är satta (`set local role`, `request.jwt.claims`), precis som Supabase gör.
Appen körs på Vercel mot Supabase-poolern i transaktionsläge, där prepared statements inte fungerar. Mycket av logiken
ligger i SQL (policyer, triggrar, RPC:er) och ska skrivas och granskas som SQL.

**Beslut.** Drizzle ORM med postgres.js (`src/db/client.ts`). Schemat i `src/db/schema.ts` och `src/db/schema/*`
ger typer och frågebyggare; komplexa frågor skrivs med `sql`-mallar. `withRls(claims, fn)` öppnar transaktionen och
sätter roll och claims. Prepared statements stängs av automatiskt mot port 6543.

**Konsekvenser.** Ingen motor eller genererad klient att paketera på Vercel, full kontroll över transaktionen och
samma SQL som i migreringarna. Drizzle-schemat måste hållas i takt med migreringarna för hand;
katalogtestet `test/db/catalog.test.ts` jämför Drizzles tabeller, kolumner och enum-värden med databasen. Drizzles egna
migreringar används inte (se ADR 3).

## ADR 3. SQL-migreringar med RLS i samma fil, egen körare

**Kontext.** Tabell, policyer, triggrar och rättigheter hör ihop. En policy som glöms bort när en tabell skapas är en
dataläcka. Supabase CLI bokför migreringar i `supabase_migrations.schema_migrations`.

**Beslut.** Varje ändring är en ny, tidsstämplad SQL-fil i `supabase/migrations` med tabellen, RLS, grants, triggrar
och kommentarer i samma fil. En befintlig migrering ändras inte; en rättelse blir en ny fil. Körs av
`src/db/migrator.ts` (`npm run db:migrate`, `db:reset`), som bokför i samma tabell som Supabase CLI. Lokalt körs
dessutom `supabase/local/auth-shim.sql`, som efterliknar schemat `auth`. Drift: GitHub Actions ("Migrera databasen").

**Konsekvenser.** Granskningen sker på SQL. Katalogtesterna (`test/db/catalog.test.ts`, `hardening.test.ts`)
kontrollerar att varje tabell har RLS, `organization_id` utan statistik, rätt grants och policyer och att
påfyllarens tillåtlista är oförändrad, så att en ny migrering som glömmer något blir röd. Ordningen avgörs av
tidsstämpeln, så parallella spår måste välja en tidsstämpel efter alla befintliga. Rollback finns inte; en felaktig
migrering rättas framåt.

## ADR 4. Flera organisationer från dag ett, med sammansatta FK:er

**Kontext.** Beställaren har ett bolag i dag, men planen är att andra operatörer ska kunna använda panelen. Att lägga
till organisationer i efterhand kräver att varje tabell, fråga och policy görs om.

**Beslut.** Alla datatabeller har `organization_id uuid not null`. FK:er mellan datatabeller är sammansatta:
`(organization_id, x_id)` refererar `(organization_id, id)`, och valfria referenser använder
`on delete set null (x_id)` så att `organization_id` aldrig nollas. Triggern `private.forbid_org_change()` hindrar
att `organization_id` ändras, även för service role.

**Konsekvenser.** En rad kan aldrig peka på en annan organisations rad; det stoppas av databasen och inte bara av
koden. Det kostar en extra kolumn i varje FK och index. `rls-isolation.test.ts` och `redteam-isolering.test.ts`
prövar isoleringen tabell för tabell.

## ADR 5. Behörighet i två lager: `requireRole` i koden och RLS i databasen

**Kontext.** En glömd kontroll i en server action, eller en action som flyttas utanför proxyn, får inte läcka data.

**Beslut.** All dataåtkomst för användare går via `withUserDb` (RLS med claims från den verifierade sessionen).
Varje ändring kontrollerar dessutom rollen med `requireRole`. `getServiceDb()` kringgår RLS och används bara av
systemjobb och skript, och i två dokumenterade steg före inloggning (`docs/miljoer.md`). Policyerna använder
`organization_id = any (array(select private.orgs_with_role(...)))`, som Postgres räknar en gång per fråga.

**Konsekvenser.** Koden ger tydliga svenska fel tidigt, databasen är det som skyddar. `orgs_with_role` var ungefär 60
gånger snabbare än `has_role` per rad (17 ms mot 1,1 s på 200 000 order). Planeraren underskattar ibland antalet rader
per organisation (statistiken för `organization_id` är avstängd, se ADR 20), vilket ordersökningen löser med en egen
funktion (`private.search_orders`).

## ADR 6. Påfyllaren styrs av en tillåtlista

**Kontext.** Påfyllaren behöver se lager och automater men aldrig belopp, priser, avtal eller rapporter. Med en
förbudslista blir varje ny tabell synlig tills någon kommer ihåg att stänga den.

**Beslut.** Policyn för varje tabell som inte står på listan är "ägare, admin, läsare". Påfyllaren får läsa
uttryckligen uppräknade tabeller (organisation, egen profil, butiker, automater, placeringar, titlar, lager, larm om
automater och lager, egna prenumerationer och assistentfrågor, lagerpunkter i Att göra). Försäljning syns i lagret
som `stock_events` med typen `sale` och antal, utan belopp.

**Konsekvenser.** En ny tabell är stängd för påfyllaren som standard; katalogtestet kontrollerar listan.
Assistenten och Att göra måste välja verktyg och punkter per roll, eftersom påfyllaren inte kan läsa ekonomi.

## ADR 7. Belopp i öre och procent i baspunkter, avrundning på ett ställe

**Kontext.** Rapporterna ska kunna räknas efter för hand av en bokhållare och stämma på öret mellan vyer.

**Beslut.** Belopp lagras och räknas i hela öre (`bigint`, `*_ore`), procentsatser i baspunkter (`integer`, `*_bp`).
Flyttal används aldrig för pengar. Avrundning sker i `src/domain/money.ts` (halva öre bort från noll) per order eller
per butik och månad, aldrig på summor; fördelningar använder största-restmetoden.

**Konsekvenser.** Summan av raderna är alltid totalen, i varje vy (kontrolleras av 200 slumpade scenarier i
`src/domain/*.test.ts` och `test/db/consistency.test.ts`). Varje nytt belopp måste följa samma regler; `purity.test.ts`
stoppar flyttalsformatering i beräkningslagret.

## ADR 8. Affärsdatum i databasen och tidszon per datakälla

**Kontext.** Awish-exporten har klockslag i leverantörens tidszon (troligen Asia/Shanghai), servern kör i UTC och
verksamheten i svensk tid. Pris, avtal och perioder gäller per kalenderdag i Sverige.

**Beslut.** Tidpunkter lagras i UTC (`timestamptz`). Varje order och lagerhändelse får `business_date` i
organisationens tidszon, räknat av databasen. Källans tidszon är en inställning per datakälla
(`data_sources.source_timezone`) och används bara när filen tolkas; förhandsvisningen visar alltid tolkad svensk tid
för första raden.

**Konsekvenser.** Beräkningarna arbetar bara med datum och påverkas inte av serverns tidszon (CI kör dem i tre
tidszoner). Organisationens tidszon kan inte ändras när det finns stängda månader (BL004). Avstämningen mot
utbetalningar räknar varje källa i sin egen tidszon.

## ADR 9. Order ändras aldrig, append-only och ingen hård radering

**Kontext.** Order och lagerhändelser är underlag för bokföring och butiksersättning. Bokföringslagen kräver att
underlag sparas i sju år.

**Beslut.** En importerad order ändras aldrig (bara titel och automat kan kopplas). En avvikande källrad blir en
konflikt i loggen. Lagret är händelser (`stock_events`), och saldot räknas i vyn `stock_levels`; inget saldo lagras
separat. Loggar och underlag är append-only (se `docs/architecture.md`). Ekonomiska rader arkiveras i stället för att
raderas; gallring kräver databasägaren och `binderlab.allow_purge = 'on'`.

**Konsekvenser.** Fel rättas med nya rader (justering, ny rapportversion, arkivering och ny import). Historiken går
alltid att återskapa. En sammanslagning av titlar kräver ett kontrollerat undantag i append-only-regeln för
försäljningshändelsens titel, som bara gäller inne i en trigger och loggas.

## ADR 10. Månadsstängning i stället för låsta poster

**Kontext.** Beställaren vill kunna rätta priser och avtal, men en månad som rapporterats till butiker och bokhållare
får inte ändras i efterhand.

**Beslut.** `period_closes` med en rad per stängning. När en månad är stängd stoppar databasen ändringar som påverkar
den: inköpspriser, lagerjusteringar, avtal, placeringar, fasta kostnader och återbetalningar (BL004). Påverkade dagar
räknas exakt. Ägare och admin stänger, bara ägaren öppnar, och allt loggas. Sent importerade order sparas och
flaggas.

**Konsekvenser.** Öppna månader kan rättas fritt. En stängning sparar en ögonblicksbild (`snapshot`), så att
siffrorna för månaden kan jämföras efteråt. Moms och kortavgift är inte tidsversionerade och gäller bakåt utom i
stängda månader.

## ADR 11. Adaptrar med lokala implementationer för allt externt

**Kontext.** Under bygget gick varken Supabase, Awish, Resend eller Claude API att nå, och flera leverantörer är inte
valda (sms, bokföringsprogram, marknadspriser). Appen måste ändå kunna byggas, köras och testas fullt ut.

**Beslut.** Varje extern tjänst har ett gränssnitt och minst en lokal implementation, valda med miljövariabler
(tabellen i `docs/architecture.md`). Lokala varianter skriver till `.data/` (utkorg för e-post, push och sms, filer,
PDF). En adapter som inte kan byggas än kastar ett tydligt fel med vad som saknas (`awish_grpc`, `awish_api`).

**Konsekvenser.** Allt testas utan nät. En ny leverantör är en ny klass mot samma gränssnitt. Det riktiga
beteendet hos Supabase-lägena (PostgREST, storage-policyer, JWKS), Resend och Sentry är inte provat från
byggmiljön och ska provas vid överlämningen.

## ADR 12. Egen dev-inloggning lokalt, Supabase Auth i drift

**Kontext.** Lokal utveckling och CI ska inte kräva ett Supabase-projekt, men inloggningen i drift ska vara Supabases.

**Beslut.** `AuthProvider` med två implementationer: `supabase` (verifierar JWT mot JWKS, ES256) och `dev`
(scrypt-hashade lösenord i auth-shimmens `auth.users`, HS256-session i en httpOnly-cookie). Dev-inloggningen har en
hård spärr: den vägrar starta om `APP_ENV` inte är `development`, i `next start`, på Vercel eller mot en databas som
inte är lokal.

**Konsekvenser.** Samma RLS-kod körs lokalt och i drift (claims sätts likadant). E2E i CI kör `next dev` eftersom
dev-inloggningen inte startar i ett produktionsbygge; bygget kontrolleras i ett eget jobb.

## ADR 13. Rena beräkningslager och en orderliggare

**Kontext.** Samma siffra visas på Hem, Lönsamhet, i rapporter, i assistentens svar och i Att göra. Om varje sida
räknar själv kommer de att skilja sig.

**Beslut.** All räkning sker i `src/domain`, `src/analytics` och `src/reports`: rena funktioner utan databas, klocka
eller miljö. Lönsamheten bygger på en orderliggare (en rad per order med alla belopp), som alla vyer summerar.
Beräkningsreglerna har en version (`CALC_VERSION` i `src/domain/profitability.ts`) som sparas med varje rapport.

**Konsekvenser.** Raderna summerar till totalen i alla vyer, och vyerna har samma total. Ändrade regler syns som en
ny version och påverkar inte redan godkända rapporter (de räknas ur sin ögonblicksbild). Indata måste laddas på
servern och skickas in; det görs i `src/server/data/core` och områdenas laddare.

## ADR 14. Egna diagram med d3 för matematiken

**Kontext.** Panelen har ett eget formspråk (`docs/design.md`): en signalfärg, status med form och text, tabulära
siffror, båda lägena. Diagrambibliotek styr utseende, tillgänglighet och storlek på sitt eget sätt.

**Beslut.** Diagrammen i `src/components/charts` (linje, yta, stapel, vattenfall, värmekarta, andelsstapel,
sparkline) ritas som egen SVG. `d3-scale`, `d3-shape`, `d3-array` och `d3-format` används bara för skalor, kurvor och
tal.

**Konsekvenser.** Full kontroll över tokens, text för skärmläsare och utskrift (samma diagram i rapportens PDF). Varje
ny diagramtyp måste byggas för hand.

## ADR 15. Egen virtualisering i tabellerna

**Kontext.** Order, prognos och lager kan ha tiotusentals rader (testat med 100 000 order). Tabellen ska ändå sortera,
välja kolumner, exportera CSV och fungera med tangentbordet.

**Beslut.** `DataTable` (`src/components/ui/data-table.tsx`) virtualiserar själv: över 200 rader (`AUTO_VIRTUALIZE`)
används fast tabellayout med en scrollyta på 560 px och bara synliga rader renderas. Inget tabell- eller
virtualiseringsbibliotek finns i beroendena. Stora listor (Order) sidas dessutom på servern.

**Konsekvenser.** Ett beroende mindre och samma utseende som övriga tabeller. Kolumner i virtualiserat läge behöver
fasta bredder.

## ADR 16. PDF och mejl skrivs av headless Chromium från samma sida

**Kontext.** Rapporten ska se likadan ut i webbläsaren, i PDF:en och i mejlet. Next 16 tillåter inte
`react-dom/server` i serverkomponenter och route handlers.

**Beslut.** PDF:en skapas av puppeteer-core som öppnar `/rapport/[id]` med den inloggades cookies (lokalt en
installerad Chromium, på Vercel `@sparticuz/chromium`). Mejlet renderas på samma sätt från `/rapport/[id]/epost`.
PDF:en skapas och sparas före godkännandet; går det inte godkänns rapporten inte.

**Konsekvenser.** En mall för skärm, PDF och mejl. Utan fungerande Chromium kan rapporter inte godkännas eller
skickas (sidan säger det). Funktionen behöver minne och tid på Vercel (rapportjobbet har `maxDuration = 300`).

## ADR 17. Rapporter som ögonblicksbild med godkännande före utskick

**Kontext.** Rapporter till butiker och bokhållare är underlag för betalningar och bokföring. Ett mejl som gått iväg
går inte att ta tillbaka.

**Beslut.** En rapport skapas som utkast med `data_snapshot` och `calc_version`. En ägare eller admin godkänner just
den versionen (`report_approvals`). Utskick loggas per mottagare och försök (`report_deliveries`). Databasen stoppar
utskick av en rapport som inte är godkänd. Månadens utkast skapas av ett schemalagt jobb, men inget skickas
automatiskt.

**Konsekvenser.** Det som skickas är exakt det som godkändes; Excel och SIE räknas ur ögonblicksbilden. En ändring
kräver en ny version. Butiksportalen visar bara den senaste godkända versionen.

## ADR 18. Assistent med verktyg mot beräkningslagret

**Kontext.** Ledningen vill ställa frågor på svenska ("vilken automat tjänade mest i oktober?"). En språkmodell som
skriver SQL eller räknar själv kan ge fel siffror och kringgå behörigheten.

**Beslut.** Assistenten (`src/server/assistant`) använder Claude API med tio verktyg (nyckeltal, lönsamhet,
iakttagelser, prognos, inköpsförslag, sålda pack, lager, räckvidd, Att göra, sök i stamdata). Varje verktyg läser via
serverladdarna som användaren (RLS) och räknar med `@/domain` och `@/analytics`. Verktygen väljs per roll och
kontrolleras igen innan de körs. Efter svaret kontrolleras att varje tal i texten finns i ett verktygsresultat; annars
markeras svaret och loggas som `unverified`. Varje fråga loggas i `assistant_logs` (append-only).

**Konsekvenser.** Assistenten kan bara säga det beräkningslagret räknat, med samma behörighet som användaren. Den
kräver `ANTHROPIC_API_KEY`; utan nyckel är fältet avstängt. Gränsen 60 frågor per användare och timme gäller per
serverinstans.

## ADR 19. Maskinhälsa härleds ur försäljningen tills leverantörens maskindata finns

**Kontext.** Awish maskindata (felkoder, ur drift) går inte att hämta ännu. En automat som slutar sälja är ofta
trasig eller tom.

**Beslut.** `@/analytics/health` bedömer en automat som misstänkt fel när sannolikheten för noll försäljning under
tystnaden är under 1 % (Poisson mot samma veckodag och timme de senaste 8 veckorna). Tystnaden räknas bara fram till
hur långt importerad försäljning räcker (`sales_data_until`).

**Konsekvenser.** Larm fungerar utan maskindata. En fil som inte laddats upp larmar inte alla automater (det blir ett
datalarm efter 36 timmar i stället). En organisation med en enda automat i en CSV-källa kan inte skilja en tyst
automat från en fil utan ny försäljning.

## ADR 20. Inga läckor via planerarens statistik och felkoder

**Kontext.** En röd granskning visade att Postgres estimat (PostgREST `Prefer: count=planned`) och felkoder från
triggrar kunde avslöja ungefär hur många rader en annan organisation har och om ett id finns.

**Beslut.** `organization_id` har `set statistics 0` i alla tabeller. Kontroller som läser organisationens data körs
efter RLS (AFTER-triggrar eller spärren `t05_rls_gate` före BEFORE-triggrar som räknar fram värden). Inga klientroller
har rättigheter på sekvenser, och lagrets ordningsnummer räknas per organisation.

**Konsekvenser.** Planeraren kan välja sämre index; ordersökningen kör därför i en egen funktion med ett enda
organisationsvillkor och sammansatta GIN-index (`20261102165000`, `20261102165100`).

## ADR 21. Uppladdning i bitar till databasen

**Kontext.** En orderlista med hela historiken kan vara 50 MB. Vercel tar emot högst 4,5 MB per förfrågan, och
serverns disk är skrivskyddad och delas inte mellan instanser.

**Beslut.** Webbläsaren laddar upp i bitar om 768 KiB till `import_uploads`/`import_upload_chunks` (egna rader,
ägare och admin). Bitarna tas bort efter import, vid avbrott och efter ett dygn.

**Konsekvenser.** Fungerar med flera serverinstanser och på Vercel. Avtalsfiler laddas fortfarande upp i ett stycke
och stoppas av Vercel över cirka 4,4 MB (känd brist).

## ADR 22. Butiksportalen via egna funktioner, inte via RLS

**Kontext.** En butik ska se sin egen försäljning, ersättning och sina godkända rapporter, men aldrig operatörens
inköpspriser, vinst eller andra butiker. Att lägga en butiksroll i varje policy skulle öppna tabeller som innehåller
mer än butiken får se.

**Beslut.** Rollen `store` har inga rättigheter i appens tabeller. Allt i `/portal` går via `portal_*`-funktionerna
(security definer, `search_path = ''`) som först kontrollerar att anroparen är butiksanvändare för just den butiken
och bara lämnar ut de fält portalen behöver. Ersättningen räknas med samma `buildStoreReport` som månadsrapporten.

**Konsekvenser.** Det butiken ser är en uttrycklig lista. Varje ny uppgift i portalen kräver en ny funktion och ett
isoleringstest (`test/db/portal-isolation.test.ts`).

## ADR 23. Fältläget som PWA med kö och idempotent registrering

**Kontext.** Påfyllning sker i butiker med dålig täckning. En påfyllning som skickas två gånger blir fel lager.

**Beslut.** Manifest och service worker (`src/app/manifest.ts`, `public/sw.js`). Påfyllning och besöksplan fungerar
utan nät; påfyllningar köas i IndexedDB och skickas med ett id från webbläsaren till `register_refill_once`, som ger
samma lagerhändelse för samma id. Cachen är per inloggad användare.

**Konsekvenser.** Inga dubbla lagerhändelser vid omförsök. Utloggning som server action syns inte för service
workern; cachen rensas när inloggningssidan visas eller en annan användare loggar in.

## ADR 24. Prognos och inköp med en egen, förklarbar modell

**Kontext.** Historiken är kort (veckor till månader), titlarna få och sälj per automat litet. Operatören måste
förstå varför panelen föreslår ett inköp.

**Beslut.** Veckodagsjusterat, viktat glidande medel med begränsad trend, intervall från backtestens residualer,
slutsålda dagar borttagna ur historiken (`src/analytics/forecast`). Inköpsförslaget är periodisk beställning med
säkerhetslager (`src/analytics/purchasing`). Allt i heltal, och varje siffra har sitt underlag.

**Konsekvenser.** Samma historik ger exakt samma prognos, och träffsäkerheten visas (WAPE). Modellen fångar inte
kampanjer eller släpp; släpp hanteras separat under Marknad.

## ADR 25. E2E med Playwright-biblioteket och vitest mot en egen server

**Kontext.** Flödena genom webbläsaren (inloggning, import, påfyllning, prisändring, utskick, felövervakning) ska
testas utan att röra utvecklingsdatabasen och utan ytterligare ett testramverk.

**Beslut.** `e2e/*.e2e.test.ts` använder `playwright` som bibliotek och vitest som körare, mot en egen server på port
3210 och en egen databas. Skydd i `e2e/global-setup.ts` vägrar fel databas och fel server.

**Konsekvenser.** Ett testramverk i hela projektet. Paketet `playwright` är inte ett beroende (globalt lokalt,
installeras i CI-jobbet).

## ADR 26. Vercel och Supabase i EU för drift

**Kontext.** En liten organisation utan egen driftpersonal. Personuppgifter (användare, butikskontakter) ska i första
hand lagras i EU.

**Beslut.** Vercel för webb och cron (Production från `main`, Preview per gren), Supabase i en EU-region för
Postgres, Auth och Storage, Sentry för fel och cron-övervakning, Resend för e-post. Två Supabase-projekt (utveckling
och produktion).

**Konsekvenser.** Ingen server att underhålla. Larmjobbet går en gång per dygn (`vercel.json`), vilket ryms i Vercel Hobby; Awish-synken
var femte minut (från 12 nov. 2026; tidigare var tionde) körs av pg_cron i Supabase. Funktioner har gränser
(4,5 MB per förfrågan, tid per anrop). Egna dumpar (`npm run db:backup`) behövs utöver Supabases backuper, se
`docs/operations.md`.

Allt stannar inte i EU. Databasen, filerna och inloggningen ligger i Supabases EU-region, men:

- **Assistenten** skickar frågorna i fritext och verktygens resultat (titlar, automater, butiksnamn, belopp) till
  Claude API hos Anthropic, som behandlar dem utanför EU. Inga e-postadresser eller telefonnummer ingår i verktygens
  resultat, men en användare kan skriva vad som helst i en fråga. Assistenten är avstängd tills `ANTHROPIC_API_KEY`
  sätts.
- **Vercel** skulle köra funktionerna i USA om ingen region väljs; `vercel.json` sätter därför `"regions": ["lhr1"]`
  (London, samma region som Supabase-projektet), se `docs/operations.md`.
- **Resend och Sentry** har EU-regioner som måste väljas.

Inga personuppgiftsbiträdesavtal är tecknade. Biträdena, vad var och en får, lagringstider och vad som återstår står i
`docs/operations.md` (Personuppgifter och biträden).

## ADR 27. En slutdag för alla sidor, med veckans form ur en gemensam laddare

**Kontext.** Runda 2 gav sidorna en gemensam funktion för slutdagen (`sellOut()` i `src/analytics/sellout`) som
räknar med att helgen säljer mer. Men sidorna laddar olika mycket historik: Att göra 45 dagar, Lager, Drift → Besök,
Automater och Mystery ungefär 15. Veckans form kräver 28 dagar. Utan åtgärd hade Att göra sagt "tar slut på fredag"
och Lager "lördag" för samma fack.

**Beslut.** Alla sidor hämtar formen på samma sätt: `weekShapesInRequest(viewer, today)` i
`src/server/data/week-shapes.ts` (en läsning per förfrågan, som den inloggade). Kartan skickas till `computeTodos`,
`weeklyVisitPlan`, `planVisits`, Lagers matris, Automaters Lager-flik, Mystery-facken och assistentens verktyg.
Alla anropar `sellOut()` med takten de senaste 14 hela dagarna (eller sedan automaten togs i drift) och från i går.
Mystery säger "tom" dagen EFTER slutdagen, som är dagen besöksplanen sätter för ett mystery pack (facket fylls bara
när det är tomt). Går formen inte att läsa räknar alla sidor med platt snitt: fortfarande samma dag överallt.

**Konsekvenser.** En fråga till per sidladdning (28 dagars försäljningshändelser, bara dag och automat).
`src/server/data/samma-slutdag.test.ts` ger varje sida 15 dagars order plus formerna och kräver samma dag från alla.
Rådgivarens ögonblicksbild (`src/server/assistant/advisor/snapshot.ts`) räknar fortfarande dagar med platt snitt;
den nämner ingen dag.

## ADR 28. Mystery: ett antal att packa nu, och delarna köps för ledtiden

**Kontext.** Två tal fanns för samma mystery pack. Mystery-sidan räknar från facken: ett fack som är tomt eller blir
tomt inom 7 dagar behöver en omgång ("Packa 1 omgång före fredag"). Inköpsplanen räknar behovet över ledtid + dagar
till nästa beställning (ca 14 dagar) och sa "Packa 3 omgångar" på Vårt lager och Inköp. Planen för runda 2 ville
koppla fackens tal rakt in i inköpsplanen. Det hade köpt för få delar: delar tar ca 7 dagar att få hem, och fackens
tal ser bara 7 dagar fram.

**Beslut.** `PurchasingInput.mysteryBatches` bär fackens tal (`src/server/purchasing/mystery-pack-now.ts`, samma
funktion `toPackFromSlots` som Mystery-sidan), och planen använder det på två sätt:

1. Raden för mystery packet visar det (`PurchaseLine.packNow`, `purchaseQty()`), så att Mystery, Vårt lager, Inköp
   och delägarens inköpslista säger samma antal.
2. Delarna köps för det STÖRSTA av fackens tal och planens eget antal. Fackens tal kan alltså höja det som köps
   (en ny automat utan försäljning ger 0 i planen men 1 omgång från facket) men aldrig sänka det.

**Konsekvenser.** "Packa 1 omgång" kan stå bredvid "Köp 24 Pokémon 151, 16 av dem går till Mystery Pack" (delar till
fler omgångar än den som packas nu). Underlaget på Inköp visar båda talen. Inköpsplanen läser fackens fakta (några
små frågor till).

## ADR 29. Granskningen av runda 2: ett inskick per inköp, en regel för minus, färre larm

**Kontext.** Fyra granskare gick igenom hela produkten efter sammanslagningen av runda 2. De hittade bland annat
att "Kom fram" tryckt två gånger lade in leveransen två gånger, att ett minus hemma gav olika besked på Mystery och
på inköpslistan, och att varje fack som tog slut drog med sig påminnelser om alla andra tomma fack.

**Beslut.**

1. **Inköp skrivs en gång.** Formulären ("Beställt", "Kom fram", "Köpt, har dem här", "+ Inköp", delägarens
   leverans) skickar ett eget id (`clientId`, `useSubmitIds`) och behåller det tills svaret kommit. Servern
   (`src/server/purchasing/quick.ts`) sparar id:t och svaret i `purchase_requests` i samma transaktion som inköpet;
   samma id en gång till ger samma svar och ingen ny order eller lagerhändelse. "Kom fram" på en rad där inget
   längre är på väg vägras ("Leveransen är redan inlagd"). Utan id (en äldre flik) gäller det gamla skyddet på 60
   sekunder för "Beställt".
2. **Minus hemma för ett mystery pack avgörs på ett ställe** (`packWithMinus` i
   `src/app/(app)/vart-lager/mystery/_lib/model.ts`). Står exakt ett lager på minus i hela omgångar läggs de
   omgångarna ihop med fackens, och talet går in i inköpsplanen (`packNowFor`, `PurchaseLine.packNow.fixPlaceId`).
   Mystery, Vårt lager, Inköp och delägarens lista säger då samma "Packa N omgångar" med samma knapp (packa i det
   lagret), och delarna köps för alla N. Ett udda minus (−1) eller minus i flera lager: "Räkna om" på alla sidor.
3. **Startklar-raden i Att göra gäller bara nya automater:** inget köp än, eller första köpet för mindre än 30
   dagar sedan (`NEW_MACHINE_DAYS`). En automat i drift kallas aldrig "inte startklar"; listan på automatens sida
   finns kvar.
4. **Larm.** En utvärdering som startas av att ett fack just blev tomt skickar inga påminnelser
   (`evaluateOrganization(…, { reminders: false })`); de kommer från det dagliga larmjobbet. Utskick till samma
   person med samma sändtid slås ihop till ett (`mergeDeliveries` i `enqueueDeliveries`), och en påminnelse ersätter
   aldrig en avisering som inte hunnit gå ut.
5. **Vårt lager och Inköp** visar fackets egna dagar (Lagers "N d", `WarehouseRow.machinesDaysLeft`) när inget
   ligger hemma. Med pack hemma: allt vi har delat på takten, som förut.
6. **Fyll på:** packas en omgång i samma besök tar den sina delar först, och en del som också fylls på lös får det
   som är kvar (`afterPacking`). Sidan säger det före Ja.
7. **Värde** räknar bara rapporter som appen skickat (`channel = 'email'`), inte dem ägaren delat för hand.

**Konsekvenser.** Två nya migreringar: `20261210000000_inkop_en_gang.sql` (tabellen `purchase_requests`,
append-only, ägare och admin) och `20261210000100_varde_bara_mejl.sql`. Båda ska köras innan koden går live:
"Beställt" och "Kom fram" skriver i den nya tabellen. Mystery säger fortfarande "tom om ca N dagar" räknat till
dagen EFTER slutdagen (ADR 27); Lager, Vårt lager och Inköp säger dagarna packen räcker. Talen kan därför skilja
en dag mellan Mystery och de andra.

## ADR 30. Nayax betalar ut: månadsrapporten (PDF) läses in på Ekonomi

**Bakgrund.** Kortbetalningarna betalas ut av Nayax, inte av Awish. Nayax mejlar en rapport i PDF varje månad
("Reimbursement Statement"). Ekonomi tog bara emot CSV och frågade "Vad betalade Awish?".

**Beslut.**

1. **Uppladdningen på Ekonomi tar PDF** (och CSV som förut). En PDF läses som Nayax-rapport: period, försäljning,
   avgifter, justeringar med orsak, moms, belopp att betala ut, sista utbetalningsdag, antal köp och raderna per
   automat (`src/server/accounting/nayax-statement.ts`). Saknas en siffra, eller går summan inte ihop på en krona
   när, nekas filen med ett svenskt besked och inget sparas. Tabellerna (avgifter, justeringar, automater) används
   bara när raderna summerar till rapportens egen summa.
2. **PDF-texten läses av egen kod** (`pdf-text.ts`, bara Nodes zlib): inget nytt paket, ingen inbyggd binär och
   ingen worker att bunta. Den förstår den sortens PDF som Nayax skickar (wkhtmltopdf/Qt); annat nekas.
3. **Raden i `payouts`**: belopp = det som kommer in på kontot, avgifter = rapportens avgifter, utbetalningsdag =
   sista utbetalningsdag, referens "Nayax ÅÅÅÅ-MM". Rapportens övriga siffror sparas i den nya kolumnen
   `payouts.statement` (jsonb). Företagets namn, kundnummer och e-post sparas inte i raden (filen sparas som
   underlag som en CSV).
4. **Avstämningen** jämför Nayax försäljning och kortavgift med appens. Det Nayax drog därutöver (bankavgift,
   engångsavgift) är kända avdrag (`Payout.deductionsOre`): de dras från det väntade och visas som egna rader
   ("Engångsavgift hos Nayax: 824,72 kr"), inte som en avvikelse. I bokföringen läggs justeringarna ihop med
   avgifterna.
5. **Samma rapport två gånger** ger ingen ny rad. Dagar som redan har en utbetalning nekas ("Arkivera den
   först"); är den inskriven för hand får ägaren frågan "Ersätt med rapporten", som arkiverar den med anteckning.
6. **Kortavgiften ändras aldrig av uppladdningen.** Skiljer rapportens kortavgift sig från inställningen visas
   "Nayax tar 4,0 % i kortavgift. Appen räknar med 0 %." med knappen "Ändra till 4,0 %" (ägare och admin, genom
   inställningarnas egen funktion).
7. **Orden**: texterna om pengar säger Nayax ("Vad betalade Nayax?"). Awish är fortfarande namnet på automat- och
   lagersystemet.

**Konsekvenser.** En ny migrering: `20261211000000_nayax_rapport.sql` (kolumnen `payouts.statement`, får vara
tom). Den kan köras medan den gamla koden är live. Rapportens automater kopplas inte till appens automater: de
visas med Nayax egna namn så att en automat som saknas i appen syns.
