# Bygglogg

Byggets logg: läget per fas i planen och vad som gjordes, i tidsordning. Koden byggdes på grenen `claude/bygge` och
slås ihop med `main` efter varje avklarad fas när hela testsviten är grön. `main` är produktion (`docs/operations.md`).
Beslut som påverkar siffror och datamodell står i `docs/datamodell.md` (Beslut från beställaren) och
`docs/decisions.md`.

## Läge

| Fas                                     | Status | Anteckning                                                                          |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| 1 Designsystem                          | Klar   | Godkänd av beställaren; `/design` och `docs/design.md`                              |
| 1b Granska och komplettera              | Klar   | 31 granskningspunkter åtgärdade                                                     |
| 2 Data, säkerhet, inloggning, import    | Klar   | Datamodell v2 med RLS, dev- och Supabase-inloggning, Awish-import (CSV)             |
| 3 Skal, Hem, Att göra                   | Klar   |                                                                                     |
| 4 Lönsamhet, Inköpspriser               | Klar   |                                                                                     |
| 5 Order, Lager, Automater, Butiker      | Klar   |                                                                                     |
| 6 Rapporter                             | Klar   | Riktiga utskick kräver Resend (`MAIL_PROVIDER=resend`)                              |
| 6b Intelligens                          | Klar   | Assistenten kräver `ANTHROPIC_API_KEY`                                              |
| 7 Kvalitet, drift, överlämning          | Klar   | Se `docs/review/fas-7/slutrapport.md`                                               |
| 8 Drift: maskinhälsa, larm, ärenden     | Klar   | Maskinhälsan härleds ur försäljningen tills Awish maskindata finns                  |
| 9 Ekonomi: avstämning, bokföring, avtal | Klar   | Bokföringsprogram (Fortnox, Visma, Bokio) har gränssnitt men ingen implementation   |
| 10 Butiksportal, expansion              | Klar   |                                                                                     |
| 11 Marknadsintelligens                  | Klar   | Ingen extern priskälla kopplad; beställaren väljer källa (`docs/marknadskallor.md`) |
| 12 Plattform                            | Väntar | Enligt planen först när 2–3 pilotoperatörer finns (README, "Läge och kvarstående")  |

## Arbetsregler under bygget

- Lokal Postgres 16 på `127.0.0.1:54322` med databaserna `binderlab_dev` och `binderlab_test`; dev-server
  `npx next dev -p 3200`.
- Supabase, Awish, Resend, Sentry och Claude API gick inte att nå från byggmiljön (inget nät, inga nycklar). Allt
  byggdes med adaptrar och lokala implementationer för utveckling och test.
- Sammanslagning med `main` bara när `npm test`, `npm run test:db`, `tsc`, lint och `next build` går igenom.

## Logg 2 nov. 2026

### Fas 1b klar och på `main`

- Bygget typkontrollerar bara appens kod (`tsconfig.build.json`); tester och skript kontrolleras av
  `npm run typecheck` i CI.
- Saknad miljö stoppar inte servern: `/design` och `/datamodell` fungerar utan nycklar, inloggade sidor visar att
  konfigurationen saknas (`src/server/config-status.ts`). Dev-inloggningens spärr gäller som tidigare.
- `next build` och `next start` verifierade utan miljövariabler.

### Fas 2–5: alla sidor och slutkontroll (`main` 76cf22a)

- Byggda, granskade och rättade: inloggning, inbjudan, användare, Datakällor, Hem, Att göra, Lönsamhet,
  Inköpspriser, Inställningar, Order, Lager, Automater, Butiker.
- Hela testsviten grön: 1 866 databastester, 2 165 enhetstester, eslint rent. Avstämning mellan vyer
  (`test/db/consistency.test.ts`) och revisorns handräknade test; inga sifferavvikelser.
- Ny migrering `20261102160000_hardening_org_statistics.sql` (statistikskydd på `import_uploads*`).

### Fas 6–11

- Fas 6: Rapporter (butik, bokföring med SIE 4 och Excel, delägare; PDF, utskick, arkiv, schemaläggning).
- Fas 6b: Prognos & inköp, Assistent, Expansion, Enhetsekonomi, Effekt.
- Fas 8: Drift, Inkorg, larm, push, besöksplan och fältläge (PWA). Fas 11: Marknad.
- Fas 9–10: Ekonomi (avstämning, verifikationer, kassaflöde), Avtal och Butiksportal.

### Fas 7

- **Del 1:** demoorganisationen Nordljus Automater AB (demo) med 14 720 order och spärr mot att radera kunders
  organisationer, onboarding (Kom igång) och global sökning (⌘K).
- **Integration:** Hem, Att göra, Lönsamhet, Lager, Drift, Prognos och Rapporter kopplade till samma takt,
  besöksplan, förlorad försäljning, avtalspåminnelser och rapportutkast.
- **Säkerhet:** 505 attacktester (server actions, rutter, RPC:er, storage, IDOR, export, cron); säkerhetshuvuden
  (CSP, X-Frame-Options, HSTS m.m.), gallring bara som ägare, IP via Vercel-huvud, `/design` och `/datamodell`
  kräver inloggning.
- **E2E, backup och övervakning:** 18 e2e-tester i sex flöden mot egen server och databas, säkerhetskopia med
  återställningstest, larm vid misslyckad import, rapport och cron, Sentry Cron Monitors.
- **Genomgång A, B och C** av alla sidor (`docs/review/fas-7/genomgang-*.md`) med rättningar.
- **Dokumentation:** README (snabbstart provad från noll), architecture, datamodell, berakningar, decisions,
  product, operations, licenssammanställning.
- **Öppna punkter:** okänt id ger HTTP 404, diagrammen skalas före mätning, utgångna titlar ger inga
  påfyllningspunkter, demons telefonnummer är PTS fiktionsnummer, Vercel-region `arn1`, temat ur en cookie,
  licensen för `buffers` utredd.
- **Prestanda** med 109 247 order i `next start`: ingen sida över 800 ms TTFB eller målet för färdig sida
  (`docs/review/fas-7/prestanda.md`). Ny migrering `20261102230000_prestanda_stock_levels.sql`.
- **Slutverifiering:** prettier, eslint, tsc; 2 545 enhetstester i tre tidszoner; 2 408 databastester i en hel
  körning; 18 e2e-tester; `next build` utan miljö och med CI:s värden. Krocken mellan `seed.test.ts` och
  demotesterna löst.
- **Styrelsedemo-granskningen** (betyg 7/10) och rättningarna efter den: se `docs/review/fas-7/slutrapport.md`.

## Beställarens krav 2 nov. kväll

- Ingen manuell nedladdning från Awish. Byggs nu: Chrome-tillägg (MV3) som synkar var 10:e minut med användarens Awish-inloggning,
  hela historiken första gången, via ett ingest-API med återkallbar synk-token; larm om synken tystnar. Ersätts av gRPC-adaptern när Awish
  levererat app-ID/token. Frågat beställaren efter koden till det gamla ChatGPT-tillägget.
- Beställaren vill att jag driftsätter allt. Byggs nu: scripts/deploy/* (Supabase Management API, Vercel API, inbjudan av ägaren)
  - docs/driftsattning.md. Kräver SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN och nätverk till api.supabase.com, *.supabase.co, api.vercel.com
    i en ny session. Ägarens e-post bekräftas av beställaren innan inbjudan skickas.
- Arbetsflöde: wf_19bddf0c-b50.

## 2 nov. kväll – klart

- Fas 1–11 klara och på main (3761024). Awish-synk via Chrome-tillägg och driftsättningsskript klara och på main.
- Verifierat: eslint och tsc rena, 2 613 enhetstester, 2 490 databastester, 62 driftsättningstester, next build utan miljö.
- Timkontrollen (schemalagd uppgift) borttagen.
- Väntar på beställaren: nätverksåtkomst till api.supabase.com, *.supabase.co och api.vercel.com för driftsättning;
  ägare bjuds in som wille1452@live.se. De två API-nycklarna som klistrades in i chatten ska bytas efter driftsättningen.

## 3 nov. – driftsatt

- Live på https://thekinghim-binderlab.vercel.app (Vercel, team-projektet `thekinghim-binderlab`, region arn1).
- Supabase: befintliga projektet `ukuuwokxbtwhqfnttzwr` används som produktion (`--prod-ref`), eftersom token bara
  gäller det projektet och inte får skapa nya. 53 migreringar körda, buckets skapade, ES256-signering. Preview har
  ingen egen databas.
- Ägarens konto `wille1452@live.se` skapat (inloggning med länk, inget lösenord).
- Ändringar för att det skulle gå: team-begränsad Vercel-token, skiftlägesoberoende repokoppling, lösenordsbyte via
  Management API, Supabase Free (inga egna mejlmallar: appen tar emot standardlänkens `?code=`, PKCE), Vercel Hobby
  (larmjobbet en gång om dagen kl. 05:07 UTC i stället för var 10:e minut).
- Kvar, valfritt: Resend (mejl till andra än Supabase-organisationens medlemmar, rapportutskick), Sentry,
  ANTHROPIC_API_KEY. De två API-nycklarna från chatten ska bytas.

## 3 nov. – Awish officiella gRPC-API ersätter Chrome-tillägget

- Beställaren lämnade Awish dokumentation (AW-DOC-110) och `provider.proto`. Byggt: gRPC-klient (`src/server/awish`),
  adaptern `awish_grpc`, synk var tionde minut (pg_cron i Supabase → `/api/cron/awish`, eftersom Vercel Hobby bara kör
  cron en gång om dagen), AppId/AppSecret/AppKey i Supabase Vault, kortet Awish i Datakällor (Spara, Testa
  anslutningen, Synka nu) och Vault-hemligheterna i `scripts/deploy`. Se `docs/awish-api.md`.
- Chrome-tillägget, ingest-API:t, zip-filen och `docs/awish-tillagg.md` är borttagna. Tabellen `sync_tokens` och
  enum-värdena ligger kvar oanvända.
- Inte provat mot Awish riktiga server (byggmiljön når inte `49.51.72.74:50051`); provat mot en låtsasserver med samma
  proto. Kvar att kontrollera i drift: token med gemener, tidszonen (order 42780), beloppsformatet och ordningen.
- Granskning (tre granskare) och rättelser: sidantal utan `last_page`/`total` (has_more eller kort sida), flera glapp
  efter flera avbrott, en gemensam tidsgräns för hela cron-körningen (anropens tidsgräns kortas), transportfel efter
  gRPC-kod, belopp utan decimaler stoppar synken tills formatet är känt, API-källan ärver CSV-källans tidszon,
  obetalda loggas inte i varje import, läget skrivs inte över efter ett nytt AppId, inga parametrar (AppSecret) i
  loggen vid databasfel, CRON_SECRET slumpas i databasen, deploy schemalägger pg_cron-jobbet och rensningen,
  AppKey som lösenordsfält, ledtrådar bara för långa hemligheter, synk-token återkallade
  (`20261103120000_awish_api_granskning.sql`). Ny risk dokumenterad: gRPC utan TLS (`docs/awish-api.md`).

## 3 nov. – nya funktioner

- **Vårt lager** (`/vart-lager`): hemmalagret per titel med värde till inköpspris, sålt senaste 7 dagarna och
  registrering av inleveranser och påfyllningar. Awish-uttag vid påfyllning dras av automatiskt och räknas inte
  dubbelt när synken hinner före Klar (`20261104200000_vart_lager_awish_uttag.sql`,
  `20261104202000_vart_lager_avrakning_awish.sql`). Länk från Prognos & inköp.
- **Fyll på** (`/fyll-pa`): mobilsida vid automaten, nås via QR-kod per automat (utskrift för ägare och admin),
  fack för fack med Klar, fungerar utan nät med kö som skickas när nätet är tillbaka
  (`20261104201000_fyll_pa_awish_fack.sql`). Knapp i Drift och flytande knapp för påfyllare.

## 14 nov. – butiksrapporten kort som standard

- Butiksrapporten visar som standard bara det butiken behöver för att räkna efter sin andel: beloppet i rubriken,
  uträkningen (summor), försäljning per vecka, automaterna och "Underlag per titel finns på begäran." Titlar,
  snittköp och service (påfyllningsbesök, flest köp) visas bara med butikens val **Visa detaljer i rapporten**
  (`stores.report_details`, `20261215000000_rapport_detaljer.sql`, ägare och admin, standard av).
- Valet sparas i rapportens ögonblicksbild (`report.details`); utan det innehåller underlaget inga titlar alls. Sidan,
  PDF:en, mejlet, förhandsvisningen, exempelsidan (`/rapport/exempel`, med detaljer på `?detaljer=1`) och portalen
  följer samma regel (`storeReportView` i `src/reports/store-view.ts`).
- Portalen: `portal_sales` lämnar inte ut titlar när valet är av, och översikten och rapportsidan visar då inte
  "Mest sålda titlar" eller snittköp. Nytt: `portal_report_details`.
- Redan godkända och skickade rapporter visas som de skickades. Utkast från före ändringen är gamla och godkänns som
  ny version.
- Granskning: den korta rapporten blev två sidor så fort uträkningen var en vinstdelning med hyra, eller butiken
  hade tre automater (blocket med veckor och automater flyttades då helt till sida två), och rubriken
  "Försäljning" i automatspalten gick 6 px ut i marginalen. Blocket är nu lägre (en rad per automat, lägre
  diagram, ingen "Mest i vecka …" i spalten) och `e2e/10-rapportsidor` kontrollerar ett ark för vinstdelning
  med hyra och tre automater, och att ingen text går utanför brödytan i butiksrapporten.
- Leveranskontroll: butiksmejlet utan detaljer hoppade från "02 / Per automat" till "04 / Bifogat", eftersom
  sektionen Drift och service försvinner och omnumreringen i `email-cleanup.ts` aldrig träffade (mallen skriver
  hårda mellanslag runt snedstrecket). Butiksmejlet numreras nu om; delägarmejlet har samma lucka sedan tidigare och
  är lämnat orört.

## 15 nov. – äldre butiksrapporter: aldrig den gamla mallen utan butikens val

- Felet: en butiksrapport från före den korta rapporten (inget sparat val) visades med detaljer så fort den var
  godkänd, och dess sparade PDF (gamla mallen, två sidor eller fler) lämnades ut av PDF-knappen, av Dela på
  Rapporter (som hämtar `/rapport/[id]/fil/pdf`) och av portalens "Ladda ned PDF". Förhandsvisningen på Rapporter
  var kort, så sidan sa en sak och filen en annan.
- Ny regel (`storeDetailsOf`, `isLegacyUnsent` i `src/reports/store-view.ts`): en rapport utan sparat val visas kort
  överallt. Bara en som faktiskt har skickats (ett genomfört utskick i `report_deliveries`, också "Ja, skickad")
  står kvar som den skickades. En rapport med sparat val följer det, som förut. Inget skrivs i `data_snapshot`.
- Den sparade PDF:en används inte för en äldre rapport som inte är skickad (`ensurePdfFor`): en ny skapas vid varje
  hämtning och sparas inte, eftersom en sparad fil inte kan bytas ut. Läsaren får den också.
- En äldre rapport kan inte godkännas, skickas eller markeras som skickad (annars skulle den byta utseende när den
  blev skickad). Rapporter visar "Rapporten har den gamla mallen."; Dela och "Skapa ny version" gör en ny kort
  rapport, vars PDF sparas vid godkännandet.
- Portalen: äldre rapporter visas korta, "Ladda ned PDF" visas inte för dem och `/portal/rapporter/[id]/pdf` skickar
  butiken till rapportens sida i stället för den gamla filen. Portalen vet inte om en rapport har skickats
  (`portal_report` lämnar inte ut utskicken), så där visas också en äldre skickad rapport kort.
- Ingen migrering. Tester: `store-view.test.ts`, `snapshot.test.ts`, `model.test.ts`, portalens `pdf/route.test.ts`,
  `test/db/rapport-detaljer.test.ts` och `e2e/05-rapportutskick` (äldre godkänd rapport med sparad gammal PDF).
- Granskningen hittade en lucka: portalens rapportsida visade den äldre rapportens slutsats under rubriken, och den
  nämner mest sålda titel ("… och X stod för 30 % av intäkten"). En äldre rapport som visas kort får nu raden om
  ersättningen i stället (`storeSummary` i `src/reports/store-view.ts`, test i `store-view.test.ts`).

## 15 nov. – pris mot kund på Inköpspriser

- Ägarens önskemål: se både vårt inköpspris och priset mot kund (exemplet: 30th Celebration kostar oss 110 kr, mot
  kund 145 kr). Leverantörens prislista har två spalter; `unit_cost_ore` är vår kostnad ("Real Cost").
- **Beslut: visa båda, räkna som i dag.** Ägaren har inte sagt vad priset mot kund ska användas till i
  beräkningarna, så inget räknas på det. Ny kolumn `purchase_prices.customer_price_ore`
  (`20261216000000_kundpris.sql`): valfri, `>= 0`, på samma rad som inköpspriset så att den följer prisperioderna.
  Tillägget är säkert medan den gamla koden kör.
- Inköpspriser: kolumnerna **Vårt pris** och **Pris mot kund** (med skillnaden under, och **Skillnad** som egen
  kolumn i kolumnvalet), titelns huvud med de tre talen och raden "Vinsten räknas på vårt pris. Pris mot kund visas
  bara här.", prishistoriken och ändringsloggen. Formuläret har fältet **Pris mot kund per pack**; fältet för
  inköpspriset heter nu **Vårt pris per pack**. Tomt pris mot kund är ett streck, aldrig 0 kr.
- Sparas ihop med Rätta priset, Nytt inköpspris från i dag och Annat datum, eller för sig med **Spara pris mot kund**
  (ny server action `setCustomerPrice`, ägare och admin). Ett nytt inköpspris utan uppgift (leverans i Vårt lager,
  mystery-kalkylen, Enkel vy) tar över periodens pris mot kund, så att det inte försvinner.
- Fältet lades inte till i: Ny produkt i Awish (formuläret har redan "Försäljningspris: det kunden betalar i
  automaten", två kundpriser bredvid varandra förvirrar), leverans med pris i Vårt lager och Enkel vy (där anges
  vad packet kostade), mystery-kalkylen (kostnaden räknas ut), snabbinköp och onboarding (inget pris skrivs där),
  Enkel vy:s prislista (översatt till flera språk, visar bara vårt pris) och importskriptet för ägarens kostnader.
- Inget annat läser kolumnen. `customer-price-isolation.test.ts` listar filerna som får nämna den (ingen i
  `src/domain`, `src/analytics`, `src/reports` eller `src/server`, ingen SQL utom migreringen) och
  `test/db/kundpris-orord.test.ts` läser beräkningsindata, lönsamheten per titel, automat och butik, Hem, Lönsamhet,
  Automater, Butiker, Prognos med lagervärdet, Bokföring och ögonblicksbilderna för butiks-, delägar- och
  bokföringsrapporten utan pris mot kund, med pris mot kund på varje rad och efter en ändring på sidan: identiska
  svar. Som kontroll ändras ett inköpspris, och då ändras svaren.
- Stängda månader: vakten bevakar bara inköpspriset och datumet. Pris mot kund får ändras också där.
- Butiksportalen och demon: ingen ny yta. Påfyllare och butiksanvändare ser inga prisrader (RLS oförändrad), ingen
  `portal_*`-funktion läser tabellen, och demons seed har inget pris mot kund.
- Granskningen (`980a0ab`) rättade tre saker: Rätta priset lägger nu alltid pris mot kund på perioden som gäller i
  dag (förut hamnade det på en äldre period när dagens period redan hade rätt inköpspris); en ny period efter en
  stängd månad ärver priset mot kund som gällde den dagen i stället för att bli tom; och `import-owner-costs` tar
  med periodens pris mot kund när nya kostnader läses in (skriptet har fortfarande inget eget fält för det).
  Tester: `test/db/kundpris.test.ts` och `test/db/owner-costs.test.ts`.
- Sammanslagningen: med **Pris mot kund** blev titeltabellen 1 064 px i en ram på 968 px (1 280 px skärm). **Kvar
  av pris** är därför dold från start och finns i kolumnvalet (7 av 10 kolumner visas). Kolumnvalet sparas inte, så
  ingen har ett gammalt val som kan ge en trasig tabell.
- Det räckte inte med riktiga data: en titel med statusen "Ingen försäljning" och en lång skillnad ("+100,18 kr ·
  +224 %") gav 1 000 px, och kolumnen Order hamnade utanför ramen. Statusen och skillnaden under pris mot kund får
  nu radbrytas när det är trångt (`StatusTag wrap`, ingen `whitespace-nowrap` på skillnaden): minsta bredd 932 px.
  På 1 440 px bryts inget.
- Med "Visa butikernas andel" rullar tabellen i sidled på 1 280 och 1 440 px (1 184 px), som den gjorde före pris
  mot kund (1 169 px). Inte ändrat.
- Underraden i knappen "Nytt inköpspris från i dag" gick 11 px utanför knappen på 1 280 px: radbrytningen sitter nu
  på knappens text (`Choice` i `price-form.tsx`), eftersom `cn()` inte låter en klass utifrån vinna över knappens
  egen.

## 19 nov. – butiksrapporten som underlag för butikens bokföring

- Anledningen: en butiks revisor godkände inte rapporten som underlag. "Det visar inte från vilket bolag som ni ska
  få ersättning ifrån. Det framgår inte om det är svenskt moms som gäller eller ej." Rapporten namngav oss bara med
  organisationens visningsnamn.
- Rapporten visar nu **Ersättningen betalas av** (företagsnamn, org.nr, momsreg.nr, adress), **Mottagare**,
  **Er faktura** (ersättning exkl. moms, moms 25 %, att fakturera), avtalet ("Enligt … från …, undertecknat ….") och två
  meningar om momsen. Ren modul `src/reports/store-basis.ts`; samma texter på sidan och i PDF:en
  (`store-report.tsx`), i mejlet (`src/emails`, sektionen "Underlag för bokföringen") och i butiksportalen
  (`BasisSection`). Avsändaren i sidhuvudet är bolaget som betalar.
- Uppgifterna läses när rapporten räknas (`queryStoreBasis` i `src/server/reports/sources.ts`) och sparas i
  rapporten (`data_snapshot.report.basis`), så en godkänd eller skickad rapport ändras aldrig. De ligger i `report`
  och inte bredvid, eftersom butiksportalen bara får `report`, och eftersom `sameReport` då gör ett utkast gammalt
  när företagsuppgifterna, avtalet eller momsvalet ändras. Nycklarna innehåller inget av det portalens SQL-kontroll
  stoppar (`private.portal_snapshot_safe`), så ingen portalfunktion behövde ändras.
- `assertStoreReportSafe` undantar `basis` från ordkontrollen: företagsnamn, adress och avtalets namn skrivs av
  människor ("Vinstdelningsavtal" ska inte stoppa rapporten).
- Grinden tog bort påståendet "och redovisar momsen på den försäljningen (vinstmarginalbeskattning)". Appen vet
  inte hur vi redovisar momsen (VMB är en vyknapp, momssatsen kan vara 0 %), sidfoten kan säga "ingen moms tas ut"
  på samma ark, och ordet krävde ett undantag i kontrollen att butiksmejlet aldrig innehåller "vinst" eller
  "marginal". Kvar: "[Bolaget] är säljare av varorna i automaten." Kontrollen är hel igen.
- Migrering `20261217000000_rapport_underlag.sql`: `organization_settings.vat_number` (valfri, `SE` + tio siffror +
  `01`) och `report_vat_mode` (`added` standard, `none`), med kolumnvis `grant update`. Bara tillägg, säker medan
  den gamla koden kör. Momsregistreringsnumret föreslås från organisationsnumret i formuläret men sparas aldrig
  utan att någon har valt det.
- Avtalet: butikens senaste kontrakt som gällde under perioden och är undertecknat (`signed_at`), eller registrerat
  för hand (då utan datum för undertecknandet), samma regel som sidan Kontrakt. Inget sådant: ingen rad.
- Rapporter (granskningen) varnar när rapporten saknar företagsnamn eller organisationsnummer, med länk till
  Inställningar, och när en rapport från förr inte har blocket alls. Godkännandet låses inte av varningen.
- **Vid driftsättningen blir alla utkast av butiksrapporter gamla** ("Rapporten har ändrats sedan utkastet
  skapades."): de saknar underlaget. Skapa ny version och godkänn den. Godkända och skickade rapporter rörs inte.
- En sida: blocket är 145 px högt och fick inte plats under den längsta uträkningen (vinstdelning med hyra och
  VMB-moms; 15 px var lediga). Med vinstdelning står uppgifterna därför bredvid tabellen, som bara har två smala
  kolumner, tabellens rader är något tätare och avstånden mellan avsnitten 3,5 mm i stället för 5. Mätt i
  webbläsaren (e2e 10, arkets brödyta 853 px): tre automater 23 px lediga, en hälsning på tre rader 16 px lediga,
  båda ett ark. Rapporter utan blocket ritas exakt som förut (eget fall i e2e 10).
- Inte bekräftat av ägaren: att butiken ska fakturera med 25 % moms (därav valet "Visa ingen momsrad").
  Butikens eget juridiska namn och organisationsnummer finns
  inte i appen: mottagaren är butikens namn.
- Tester: `src/reports/store-basis.test.ts`, `store-report.test.tsx`, `snapshot.test.ts`,
  `test/db/rapport-underlag.test.ts`, e2e 05 (varningen, Inställningar, förhandsvisningen, mejlet) och e2e 10.

## 19 nov. – butiksrapporten som revisorn ska kunna godkänna

- Anledningen: revisorn frågade också "Är det ett svenskt företag som har/äger Pokemon maskinen? Finns det något
  avtal upprättat mellan er och företaget som reglerar ersättningen?" Ägaren skrev för hand den rapport revisorn
  borde ha fått. Appen gör nu den själv. Fakta från ägaren: bolaget säljer varorna under VMB, avtalet med butiken
  är muntligt (kontraktsraden som står som undertecknad är inte verklig), det juridiska namnet är ett annat än
  "Binderlab", och butiken hade fått ersättningen exklusive moms innan någon faktura fanns.
- **Underlaget har en utgåva** (`report.basis.rev = 2`, `BASIS_REV`). Allt nytt gäller rapporter sparade med den;
  en rapport från före ändringen (utgåva 1 eller inget underlag) visas som den visades då (eget fall i e2e 10).
- **VMB** (`organization_settings.report_vmb`, standard av, Inställningar → Företaget). Första steget tog bort
  meningen för att appen inte kunde veta; nu säger ägaren det genom valet. Kontrollen att inget som når butiken
  innehåller "vinst" eller "marginal" är lika sträng som förut: `withoutVmbStatement` tar bara bort hela den fasta
  texten för rapportens bolag, och bara när valet är på. Ordet någon annanstans stoppas (testat).
- **Ingen motsägelse om moms.** Fotnoten sa "exklusive moms (ingen moms tas ut)" och mejlet "Ingen moms" bredvid
  "Moms 25 %". Nu sägs vad siffran är (`salesNote`, `salesVatLabel`): "inklusive moms" bara med vinstdelning (där
  försäljningen är definierad inklusive moms, berakningar.md avsnitt 4) och momssats 0 %; med provision eller hyra
  och momssats 0 % sägs ingenting om moms, så att fotnoten inte säger emot uträkningens "exkl. moms".
  Butiksportalens sidfot påstår inte längre "exkl. moms".
- **Avtalsform per butik** (`stores.agreement_form`: `written`, `oral` eller null). Muntligt går före en
  kontraktsrad som står som undertecknad (`contract` sparas då som null). Villkoren i klartext sparas i
  uträkningen (`compensation.termsText`). Utan rad om avtalet varnar granskningen (`ArchiveRow.agreementMissing`).
- **Avtalsperioder i följd med samma villkor** i samma kalendermånad slås ihop i uträkningen (`mergeSplits`).
  Ingenting räknas om: radens belopp är delarnas summor, så andelen är exakt liggarens (per avtal och månad).
  Raden slås bara ihop när den går att räkna efter: har en avtalsperiod gått med förlust (0 kr) och nästa med
  vinst står de kvar var för sig. Ett öres skillnad mot andelen av summan skrivs ut ("avrundat per
  avtalsperiod"). Avtalstexten står en gång. Testat mot liggaren på ägarens fall (14–31 okt., 1–2 nov., 3–14 nov.
  blir oktober och november): `src/reports/store-report-merge.test.ts`.
- **Totalrad**: "Er ersättning totalt, exklusive moms" (`totalLabel`), också med bara vinstdelning.
- **Redan betalt** (`report.basis.payments`): betalda avräkningar för rapportens månader, lästa ur
  `store_settlements` (betaldag och belopp; `paid_amount_ore` används när kolumnen finns). Modulen för avräkningar
  är orörd. Visas bara när det går ihop (betalt ≤ beloppet att betala).
- **Juridiskt namn** (`payer.brand`, `brandOf`) och raden "Äger och driver automaten."
- **Migreringar**: `20261218000000_rapport_vmb.sql` och `20261218000100_avtalsform.sql`, bara tillägg (en kolumn
  med standardvärde, en valfri kolumn). Läsningen i rapporten går också innan kolumnerna finns (`to_jsonb`).
- **En sida.** Underlaget blev högre (två rader för betalningen, VMB-texten, raden om automaten, totalraden). I
  utgåva 2 står raden om underlag per titel först i fotnoten, avståndet mellan blocken är 3,5 mm också utan
  vinstdelning, och två perioder med vinstdelning står som kolumner bredvid varandra i stället för tio rader
  under varandra. Mätt i webbläsaren (e2e 10, ledigt på arket): ägarens fall 3,7 mm, provision och hyra 3,3 mm,
  vinstdelning med hyra och tre automater 6,2 mm, med hälsning på tre rader 4,5 mm, bara hyra 12,1 mm. Alla ett
  ark. Marginalen är liten: en längre adress eller ett längre företagsnamn kan ge en rad till.
- **Vid driftsättningen blir alla utkast av butiksrapporter gamla igen** (underlaget har fler uppgifter).
- Inte avgjort: med provision står "exkl. moms" i uträkningen också när momssatsen är 0 % och bolaget säljer med
  VMB (provisionen räknas då på det kunderna betalade). Det är avtalets ordalydelse och ändras inte här. En
  betalning visas inte när den är större än rapportens belopp (en hel månads avräkning mot en rapport för en del
  av månaden); då står blocket som förut.
- Tester: `store-basis.test.ts`, `store-report-merge.test.ts`, `store-report.test.tsx`, `sections.test.tsx`,
  `test/db/rapport-revisor.test.ts`, e2e 05 (varningen, avtalsformen, VMB-knappen, förhandsvisningen, mejlet) och
  e2e 10 (ägarens fall, bara hyra med skriftligt avtal, första utgåvan).

## 19 nov. – rättelser efter granskningen av steg 2

En granskare läste steg 2 som revisorn och godtog två av fyra fall. Rättat:

- **Portalen visade ingen rapport med vinstdelning.** `private.portal_snapshot_safe` stoppade nycklarna för inköp
  och vinst överallt, också i ersättningsdelen där de alltid står vid vinstdelning. Ny migrering
  `20261218000300_portal_vinstdelning.sql`: samma regel som `assertStoreReportSafe` (nycklarna får stå i
  `report.compensation` när `splits` har en rad; listor, andra butikers `storeId` och `orders` som inte är ett tal
  stoppas överallt som förut). Felet fanns före steg 2. Portalens rubrik för eget datum: "Butiksrapport …".
- **Redan betalt** drog av en hel månads avräkning från en rapport för en del av månaden. Nu sparas avräkningens
  månad (`payments[].month`), och bara det som gäller rapportens dagar räknas av (`paymentParts`). Raden säger
  vilken månad betalningen gäller, och en mening säger resten.
- **"exkl. moms" om bruttot.** Med momssats 0 % heter beloppet "kundernas betalning" i uträkningen och i avtalets
  villkor. Rapporter med bara hyra har inget steg "Avtal utan provision". Fotnoten om provisionen står bara när
  ett avtal har provision.
- **Mejlet**: juridiskt namn som avsändare (sidhuvud, sidfot, raden om varför mejlet kommer), "Butiksrapport" och
  perioden för eget datum, organisationens tidszon för "Skapad", uträkningen med totalraden, "exkl. moms" vid
  ersättningen, och bolaget i löptext utan trasiga skiljetecken (`payerText`).
- **Avtalsraden**: "Skriftligt avtal (namn) mellan … och … från …: villkoren." Utan rad står "Avtal saknas i
  underlaget." (rapporten tiger inte). Godkännandet låses fortfarande inte: det hade krävt att alla butiker får
  ett val före nästa utskick.
- **Äger och driver automaten** är ett val (`organization_settings.report_owns_machines`, standard av,
  migrering `20261218000200_rapport_automat.sql`).
- **Momsen**: en mening om att ersättningen gäller platsen och inte är lokalhyra. Med VMB: "Inköp räknas med moms."
- **Mottagaren**: butikens adress (`basis.recipientAddress`). Butikens juridiska namn och org.nr finns inte i appen.
- **Inget att fakturera** står när ersättningen är 0 kr, och "Er andel 50 % (ingen vinst, 0 kr)".
- **Portalens sidhuvud och sidfot** påstår inget om vem som driver eller äger automaterna (verksamhetens namn).
- **En sida med långa namn**: nytt fall i e2e 10 (`LONG_NAMES`: "Kortautomater i Norden Aktiebolag", adress med
  box, lång butiksadress).
- Avvisat: inget. Inte gjort: butikens juridiska namn och org.nr (finns inte i appen), att räkna provisionen på
  beloppet utan VMB-moms (ändrar summor; avtalets ordalydelse är ägarens sak).

## Pengar som inte kan driva (robusthet 1A)

Efter granskningen av produktionen (Sega gubben, oktober: betalt 8 388,08 kr, godkända rapporter 8 072,18 och
7 897,24 kr, dagens uträkning 9 178,28 kr). Sju punkter, en commit per punkt:

- **Månaden stängs av appen.** `close_period`/`reopen_period` fanns men anropades aldrig. Nu stängs månaden när
  sista avräkningen betalas eller bokföringen markeras som skickad (`src/server/periods`), ångra öppnar den, och
  ägaren kan öppna med en anledning (`period_closes.reopened_reason`). Stängd månad visas på Utbetalning och där
  priser, avtal, testköp och återbetalningar ändras. Alla sju vakterna prövas genom appens väg i
  `test/db/manadsstangning.test.ts`. En sen order sparas och flaggas som förut.
- **Kortavgiften gäller från ett datum** (`organization_settings.card_fee_history`). "Ändra till 4,0 %" frågar
  först och säger från vilken dag. Ingen ny tabell: listan ligger på inställningsraden, så RLS, logg och export
  är desamma. Äldre kod som bara skriver `card_fee_bp` tömmer listan (en sats för alla datum, som förut).
- **Betalt mot rapporten mot dagens uträkning** på Utbetalning, med "Lägg på nästa avräkning" (en egen rad,
  aldrig tyst), en fråga om vilket belopp som betalades när rapporten säger ett annat, en varning i den dagliga
  kontrollen och punkten "Betald avräkning skiljer sig från dagens uträkning" i Att göra.
- **Avräkningar för äldre månader** skapas och listas (förut bara förra månaden).
- **En regel för placeringar:** första placeringen gäller från automatens första försäljning också i rapporten,
  avräkningen och bokföringen. Beräkningsversion 1.4.0. `test/db/placering-en-regel.test.ts` är beviset.
- **Signerat kontrakt:** ändrade villkor under Butiker varnar, kräver bekräftelse och märks på raden.
- **Två bokföringsexporter:** underlagets SIE bokför nu återbetalningar som paketet, och båda filerna, LAS-MIG.txt
  och sidorna säger vilken som ska importeras (paketet under Ekonomi → Bokföring).

Vägval och det som är kvar:

- Äldre månader räknas från organisationens **första avräkningsmånad**. Det som såldes innan appen började avräkna
  har betalats utanför appen och dyker inte upp som obetalt.
- Butiksportalens egna försäljningslistor (`portal_sales` med flera, SQL) läser placeringarna som de är sparade.
  Avräkningen och rapporten som butiken ser där följer den nya regeln.
- Jämförelsen mot rapporten gäller rapporter för **hela månaden**. En rapport med eget datum jämförs inte.
- Skillnaden kan bara läggas på en avräkning som finns. Finns ingen obetald för butiken väntar punkten i Att göra
  tills nästa skapas den 1:a.
- Butiksportalen visar avräkningens belopp som betalt också när ägaren betalade rapportens belopp; skillnaden syns
  för butiken först som rättelseraden på nästa avräkning.
- Bokföringsunderlagets PDF och Excel har ingen egen rad för återbetalningar (bara SIE-filen bokför dem).
- Momssatsen är fortfarande en sats för alla datum.
- Vid driftsättningen stängs inga gamla månader i efterhand, och oktober för Sega gubben rättas inte av koden:
  ägaren ser skillnaden på Utbetalning och lägger den på nästa avräkning.

## Ägaren ska höra när något går sönder (robusthet 1B)

Efter granskningen av produktionen: 0 larmprenumerationer, 0 telefoner och 0 utskick medan larmen räknade
"aviserat 10 gånger"; den dagliga kontrollen hade aldrig körts enligt schemat; en synk som inte hämtade något
sparades som lyckad. Sju punkter, en commit per punkt:

- **Larmen når någon.** Ägare och admin får en prenumeration med medlemskapet (trigger och ifyllnad i
  `20261220110000_larm_standardprenumeration.sql`), och larmjobbet använder samma standard för den som saknar rad.
  Vakten (`src/analytics/watch`, `src/server/monitoring/watch.ts`) visar "Ingen får larm just nu" på Hem och Drift.
  Under ett larm står utskick som gått fram, inte räknade aviseringar.
- **Kontrollen körs, och det hörs när den inte gör det.** Fler tillfällen (varje timme 03:52–09:52 UTC) och en
  andra schemaläggare (larmjobbet på Vercel Cron), en kontroll av databasanslutningen först i varje cron-route,
  tidsgränser som alltid sparar en körning, svaren från pg_cron-anropen i `private.cron_calls`, och raden
  "Kontrollen har inte körts sedan …". Orsaken står i `docs/operations.md` (Vakten): trolig, inte bevisad.
- **Synken säger som det är.** En körning utan lästa order är ett fel; tre i rad eller 30 minuter larmar
  kritiskt; Hem visar datans ålder per automat.
- **E-post utan leverantör** sägs rakt ut (`mailCanSend`), och inget står som skickat med e-post.
- **Order att hantera** (återbetald i Awish efter importen, betald men oläslig) blir punkter som står kvar
  (`order_attention`, `src/server/awish/order-attention.ts`).
- **Fyll på** säger vad Awish inte tog emot, och automaten väntar så att saldot inte sänks.
- **Avräknings- och kampanjstegen** larmar (`job:avrakningar`, `job:kampanjer`).

Vägval och det som är kvar:

- Standardprenumerationen är **push och e-post**, samma som sidan alltid har visat. Bara e-post hade stängt av
  felanmälans push för en ägare som har en telefon registrerad men ingen sparad rad (där betyder "rad utan push"
  ett nej). Följden: en ägare med en telefon påslagen får också veckosammanfattningen, som följer Notiser i
  mobilen, om hen inte har valt bort den.
- Läsare och påfyllare får ingen rad av sig själv. Notiser säger "Du får inga notiser om larm ännu." tills de
  sparar.
- "Ingen får larm just nu" visas i produktionen direkt efter driftsättningen och står kvar tills en ägare har
  slagit på notiser i telefonen (eller en e-postleverantör är inställd). Det är meningen.
- Orsaken till att kontrollen inte kördes är en slutsats av det som gick att läsa (frågestatistiken), inte ett
  avläst felsvar. Läs `private.cron_calls` morgonen efter driftsättningen.
- Vakten larmar inte om bokföringsjobbet, AI-jobbet eller veckosammanfattningen (deras svar loggas i
  `private.cron_calls`, men ingen rad eller larm läser dem än).
- En återbetalning som görs senare än 24 timmar efter köpet syns inte: synken läser bara om det senaste dygnets
  order. Fönstret är inte ändrat.
- Fyll på spärrar inte Klar när antalet är fler än facket rymmer eller mystery-facket inte är tomt: beskedet
  kommer efteråt. Raden på automaten ("Awish fick inte antalen …") har samma text som vid ett vanligt fel.
- Regeln `import_failed` ("Ingen hämtning från Awish på …") finns kvar som varning bredvid vaktens kritiska larm:
  två larm om samma sak när hämtningen står still i över en timme.
- Inte sett i en webbläsare mot produktionen. Lokalt: Hem (1 280 och 390 px), Drift, Notiser, Att göra och det
  förifyllda ärendet i Inkorg, med provdata.

## 19 nov. – butiksägare: bolaget bakom butikerna, statistik och rapporter per ägare

- Ägarens önskemål: flera butiker har samma ägare, och statistik och rapporter ska kunna gälla alla dem
  tillsammans; bolagens uppgifter ska finnas i appen. Testerna och seeden har bara påhittade bolag.
- **Datamodell** (`20261219000000_butiksagare.sql`, bara tillägg, säker medan den gamla koden kör): ny tabell
  `store_owners` (juridiskt namn, organisationsnummer `NNNNNN-NNNN`, momsreg.nr `SE…01`, F-skatt, adress,
  kontakt, fakturaadress, bankgiro, anteckning, arkivering) och `stores.owner_id` (sammansatt FK, null = ingen).
  RLS som butiker: ägare och admin skriver, läsare läser, påfyllare och butiksrollen har ingen policy. Ingen
  radering (BL003), ändringar i `audit_log`. Org.nr är unikt bland aktiva ägare. Kontrollsiffran (Luhn) prövas i
  appen (`src/lib/swedish-ids.ts`), formatet i databasen.
- **Butiker → Butiksägare** (`?vy=agare`, ny underflik): korten med uppgifter och butiker, Ny butiksägare,
  Redigera, Arkivera (nekas så länge en aktiv butik har ägaren) och Återställ. Butikens sida: huvudet visar
  ägarens namn och org.nr; Kontakt och rapport → Ägare har valet av ägare och "Ny ägare …" (skapar och kopplar i
  samma transaktion).
- **Statistik:** filtret Butik har ägare med fler än en aktiv butik först. `?agare=<id>` följer med mellan
  sidorna som `?butik=` och löses upp till ägarens butiker (även arkiverade) av `loadPeriod` och laddarna
  (`src/server/data/core/scope.ts`). En vald butik vinner över ägaren. Butikernas andel dras som för en vald
  butik (`storeShareInView` med `ownerId`). Ändrat på Hem, Lönsamhet (även återbetalningar och gratis-pack per
  butik), Automater, Svinn, Butiker, Lager, Order, Prognos, Inköpspriser (och Redigera vara) och Expansion.
  Försäljning (Enkel vy) har inget filter. Ekonomi har en rad "filtret gäller inte här" som inte visas för en
  ägare; filen hör till ett annat arbete och är inte ändrad här.
- **Rapporter:** "En rapport per butik hos ägaren" skapar den vanliga butiksrapporten (utkast) för varje butik som
  ägaren har och som hade automat i perioden. Själva rapporten är oförändrad.
- **Tester:** `test/db/butiksagare.test.ts` (tjänsten, format, raderingsspärr, logg, RLS för alla roller och en
  annan organisation), `test/db/agarfilter.test.ts` (ägaren = summan av butikerna för försäljning, order, pack,
  vinst och andel, med och utan vyknappen, och på Lönsamhet, Hem, Automater och Butiker; en automat som flyttar
  mellan två av ägarens butiker), `test/db/agarrapporter.test.ts`, rödteamets action-katalog, katalogtestet och
  enhetstester (`swedish-ids`, `scope`, `owner-filter`, `period-state`, `store-share`, `nav`, `owner-choices`).
  E2E: `e2e/28-butiksagare.e2e.test.ts` (1 280 och 375 px).
- **Kvar till en samlad ägarrapport:** en rapporttyp för ägaren (t.ex. `owner_store_statement`) med ägarens
  uppgifter i huvudet (namn, org.nr, momsreg.nr, fakturaadress), en rad per butik (försäljning, pack, andel, hyra)
  och summan, ett eget underlag (snapshot) som räknas med samma motor som butiksrapporten per butik så att summan
  stämmer med de enskilda rapporterna, mottagare per ägare (`report_recipients` med `owner_id`), PDF och mejl,
  arkiv och godkännande som de andra typerna, och ett beslut om avräkningen ska göras per ägare (en betalning)
  eller per butik som i dag.
