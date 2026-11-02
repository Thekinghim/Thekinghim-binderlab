# Fas 7: prestanda med 100 000 order

**Mätning och optimering av varje sida i menyn med 109 247 order, 2 nov. 2026.** Kravet var att sidorna laddar snabbt även med 100 000 order: TTFB under 800 ms, färdig sida under 2 s för perioden 30 d och under 3 s för Allt.

| Utfall                                         |                Före |                 Efter |
| ---------------------------------------------- | ------------------: | --------------------: |
| Sidor med TTFB över 800 ms (av 40 mätningar)   |                  27 |                     0 |
| Sidor över målet för färdig sida (30 d / Allt) |               7 / 8 | 0 / 0 (en på gränsen) |
| Längsta färdiga sida, 30 d                     |    9,56 s (Prognos) |      2,00 s (Ekonomi) |
| Längsta färdiga sida, Allt                     |   15,47 s (Prognos) |      2,81 s (Ekonomi) |
| Median färdig sida, 30 d / Allt                |     1,30 s / 1,55 s |       1,03 s / 1,04 s |
| Största HTML-svar                              | 12,4 MB (Expansion) |      1,8 MB (Marknad) |

Alla beräkningar ger samma svar som före optimeringarna. Det är kontrollerat med tester (se [Samma svar](#samma-svar)) och genom att jämföra laddarnas svar mot den stora demon före och efter.

De största orsakerna var:

1. **Ett undantag per jämförelse vid sortering av lagerhändelser.** Tidpunkten i lagerhändelserna till Prognos & inköp kommer i Postgres textformat, så `tryParseInstant` kastade och fångade ett `DomainError` (med stackspårning) i varje jämförelse. Det var 18 av 25 s i Prognos-laddaren.
2. **Menyns räknare för Att göra höll tillbaka hela sidan.** Layouten väntade på Att göra (order, lager, regler, cirka 0,5–1 s) innan något skickades. Det gav varje sida TTFB på 0,6–3 s.
3. **Liggaren byggdes om många gånger på samma order.** Expansion, Hem, Automater och Effekt räknar flera vyer och scenarier på samma order och period, och varje order kontrollerades på nytt i varje vy.
4. **12 MB order-id i HTML.** Underlaget på Expansion och Effekt skickade id för varje order till klientkomponenterna, fast de bara visar antalet.
5. **Intl per order.** Tidszonsomräkningen (`localParts`) anropade `Intl.DateTimeFormat.formatToParts` en gång per order i Ekonomi (avstämning och kassaflöde).

## Uppställning

- **Data:** egen databas `binderlab_perf` (lokal Postgres 16): auth-shim, alla migreringar, `npm run db:seed` och `npm run db:seed-demo -- --stor`. Organisationen Nordljus Automater AB (demo, stor) har 109 247 order (18,3 Mkr) från 1 feb. till 2 nov. 2026, 120 581 lagerhändelser, 10 automater och 7 butiker.
- **Bygge:** produktionsbygge (`next build` och `next start` på port 3330) i en separat worktree med `APP_ENV=development` och `AUTH_PROVIDER=dev`. Dev-inloggningen stoppas annars i ett produktionsbygge (`src/server/auth/dev-guard.ts`). För mätningen släpptes den spärren bara i worktreen, med en egen variabel; ändringen finns inte i projektet.
- **Mätning:** Playwright (Chromium, 1 440 × 900) inloggad som `demo@binderlab.local` med den stora organisationen vald. Varje sida i menyn laddades med `?period=30d` och `?period=allt`, en uppvärmning och tre mätningar. Tabellen visar medianen.
  - **TTFB:** `responseStart` i webbläsarens navigationstid.
  - **Färdig:** från navigeringen tills `load` har kommit och inget element med `aria-busy="true"` finns kvar. Det betyder att alla strömmade sektioner och menyns räknare har kommit fram.
- **Maskin:** 4 kärnor, delad med andra agenters dev-servrar och tester. Lasten var 1–3 under efter-mätningen och 2–6 under före-mätningen. Skillnader under cirka 0,2 s är brus.
- **Efter:** samma worktree, byggd om från arbetskopian med alla ändringar i slutsteget (även andra spårs). Databasen fick den nya migreringen. En `vacuum analyze` av `stock_events` kördes, vilket autovacuum också gör i drift.

## Före och efter per sida

TTFB i ms, färdig sida i sekunder. "Mål" betyder TTFB under 800 ms och färdig sida under 2 s (30 d) eller 3 s (Allt).

| Sida                             | 30 d: TTFB före | Färdig före | TTFB efter | Färdig efter | Mål   | Allt: TTFB före | Färdig före | TTFB efter | Färdig efter | Mål |
| -------------------------------- | --------------: | ----------: | ---------: | -----------: | ----- | --------------: | ----------: | ---------: | -----------: | --- |
| Hem (`/`)                        |           1 104 |        3,74 |        146 |         1,18 | ja    |           1 731 |        7,97 |         60 |         2,10 | ja  |
| Att göra (`/att-gora`)           |             962 |        1,34 |        104 |         0,55 | ja    |             676 |        0,83 |        142 |         0,58 | ja  |
| Lönsamhet (`/lonsamhet`)         |             840 |        0,95 |         49 |         1,00 | ja    |           1 896 |        2,06 |         98 |         1,08 | ja  |
| Order (`/order`)                 |             628 |        0,77 |         96 |         0,61 | ja    |             633 |        0,79 |        100 |         0,55 | ja  |
| Lager (`/lager`)                 |             702 |        1,25 |         51 |         1,09 | ja    |           1 001 |        1,51 |         49 |         1,05 | ja  |
| Automater (`/automater`)         |           1 106 |        1,59 |         94 |         1,09 | ja    |           2 578 |        2,75 |         49 |         1,58 | ja  |
| Butiker (`/butiker`)             |             691 |        0,86 |        105 |         0,59 | ja    |           1 152 |        1,32 |         56 |         1,04 | ja  |
| Inköpspriser (`/inkopspriser`)   |             709 |        0,95 |        123 |         0,64 | ja    |           1 792 |        2,16 |         49 |         1,01 | ja  |
| Rapporter (`/rapporter`)         |           1 138 |        1,58 |         43 |         1,48 | ja    |           1 389 |        1,58 |         48 |         1,50 | ja  |
| Prognos & inköp (`/prognos`)     |             807 |    **9,56** |         44 |         1,54 | ja    |           1 101 |   **15,47** |         45 |         2,11 | ja  |
| Expansion (`/expansion`)         |           1 509 |    **6,53** |         54 |         1,51 | ja    |           6 282 |    **7,58** |         57 |         2,08 | ja  |
| Drift (`/drift`)                 |           1 071 |        1,53 |         96 |         1,10 | ja    |             882 |        1,35 |         35 |         1,02 | ja  |
| Inkorg (`/inkorg`)               |             529 |        0,66 |        103 |         0,38 | ja    |             622 |        0,81 |        120 |         0,38 | ja  |
| Ekonomi (`/ekonomi`)             |           3 132 |    **3,38** |         52 |         2,00 | gräns |           5 429 |    **5,79** |         45 |         2,81 | ja  |
| Avtal (`/avtal`)                 |           1 216 |        1,39 |         40 |         1,05 | ja    |           1 209 |        1,39 |         45 |         1,03 | ja  |
| Marknad (`/marknad`)             |           1 132 |        1,89 |         44 |         1,18 | ja    |           1 052 |        2,47 |         38 |         2,07 | ja  |
| Effekt (`/effekt`)               |             989 |        1,26 |         69 |         0,60 | ja    |           3 042 |    **3,60** |         41 |         1,04 | ja  |
| Assistent (`/assistent`)         |             735 |        0,89 |        117 |         0,38 | ja    |             773 |        0,99 |        102 |         0,35 | ja  |
| Datakällor (`/datakallor`)       |             786 |        0,97 |        102 |         0,40 | ja    |             621 |        0,77 |        102 |         0,43 | ja  |
| Inställningar (`/installningar`) |             609 |        0,80 |        101 |         0,33 | ja    |             718 |        0,94 |        122 |         0,36 | ja  |

Fetstil: över målet före. TTFB var över 800 ms på 27 av 40 mätningar före och på ingen efter.

**Ekonomi 30 d ligger på gränsen.** Medianen blev 2,00 s, och i två tidigare körningar 2,07 och 2,14 s. Den tunga delen är kassaflödet (cirka 0,75 s), som räknar butiksersättningen per månad från första ordern, och bokföringen (cirka 0,6 s), som bygger revisorsunderlaget för varje månad i räkenskapsåret för att numreringen ska löpa. Bokföringen strömmar nu in i sin sektion. Rubriken väntar ändå på kassaflödet. Se Kvarstående.

## Åtgärder

### Beräkningslagret (samma svar, mindre arbete)

| Fil                                     | Ändring                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/analytics/todos/time.ts`           | `tryParseInstant` kastar inte längre internt (samma tolkning utan undantag). `localParts` räknar väggtiden med förskjutningen för timmen och anropar bara Intl en gång per tidszon och timme. Gäller 1972–2099 och bara när förskjutningen är densamma i timmens båda ändar; annars som förut.                                   |
| `src/analytics/lost-sales/stock.ts`     | Sorteringen av lagerhändelser tolkar tidpunkten en gång per händelse i stället för vid varje jämförelse. Ordningen är densamma som `compareStockEvents`.                                                                                                                                                                         |
| `src/domain/ledger.ts`                  | `buildLedger` sparar liggaren per orderlista (WeakMap). Samma orderlista, period, priser, avtal, placeringar och inställningar (samma objekt) och lika många order ger samma liggare. Kontrollen av orderna (assertOrder och dubbletter) görs en gång per lista. Hyran fördelas med vanliga tal när produkterna är säkra heltal. |
| `src/domain/money.ts`                   | `allocateLargestRemainder` räknar med vanliga tal när det är exakt (alla mellanresultat är säkra heltal), annars med bigint som förut.                                                                                                                                                                                           |
| `src/domain/dates.ts`                   | Tolkade datum och formaterade dagnummer sparas (högst 20 000 var). Samma sträng ger alltid samma svar.                                                                                                                                                                                                                           |
| `src/domain/economics.ts`, `metrics.ts` | `assertOrders`: intäkt, moms och kortavgift kontrollerar en orderlista en gång per lista.                                                                                                                                                                                                                                        |
| `src/analytics/todos/common.ts`         | `uniqueSorted` använder standardsorteringen. Den ger samma ordning som `<` på strängar, utan ett JS-anrop per jämförelse.                                                                                                                                                                                                        |

Liggaren sparas bara så länge orderlistan finns (WeakMap). Listorna kommer från laddarna, som är memoiserade per förfrågan, så inget sparas mellan förfrågningar eller mellan användare. Indatan är `readonly`. Ändras en lista ändå efter anropet upptäcks det bara om antalet order ändrats; det står i kommentaren.

### Servern och sidorna

| Fil                                                                                                                   | Ändring                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app/(app)/layout.tsx`, `app-frame.tsx`, `src/components/shell/{app-shell,side-nav,mobile-nav}.tsx`               | Menyns räknare för Att göra skickas som ett löfte (`TodoCountSource`) och strömmar in med `use()` och Suspense. Skalet och sidan väntar inte på den. Det är den största enskilda förbättringen av TTFB.                                                            |
| `src/server/data/core/queries.ts`                                                                                     | `queryOrders` läser med rå SQL. Tidpunkten formateras i databasen precis som `Date.toISOString()`, och beloppet kontrolleras som säkert heltal. Det är 25–40 % snabbare än Drizzles radomvandling med 109 000 rader.                                               |
| `src/server/purchasing/queries.ts`                                                                                    | `queryMachineStockEvents` sorterar inte i databasen. Genomspelningen ordnar händelserna själv med en total ordning, så sorteringen på disk (13 MB) behövdes inte. Frågan gick från 290–380 ms till 105–135 ms.                                                     |
| `src/app/(app)/expansion/_lib/slim.ts`, `expansion/page.tsx`, `effekt/page.tsx`, `expansion/_components/evidence.tsx` | `withOrderCounts` byter order-id mot antalet (`orderCount`) innan underlaget går till klientkomponenterna (mål, pipeline, effektserier). Länkarna räknas på servern före bytet. Expansion gick från 12,4 MB till 0,56 MB HTML och Effekt från 4,7 MB till 0,36 MB. |
| `src/app/(app)/ekonomi/page.tsx`                                                                                      | Bokföringen strömmar in i sin sektion (Suspense med skelett). Rubriken, avstämningen och kassaflödet skickas utan att vänta på den. Bokföringens status i rubrikens metablock läses direkt från adaptern.                                                          |

### Databasen

Ny migrering: `supabase/migrations/20261102230000_prestanda_stock_levels.sql`.

- **Delindex** `stock_events_last_count_idx` på `(organization_id, location_id, title_id, occurred_at desc, seq desc) where kind = 'count'`. Den senaste inventeringen per lagerplats och titel blir en uppslagning.
- **Vyn `stock_levels`** skrivs om med samma kolumner och samma regel. Den tidigare definitionen sorterade alla händelser (DISTINCT ON och en sammanslagning). Den nya slår upp senaste inventeringen i delindexet och summerar bara händelserna efter den, som ett intervall i `stock_events_level_idx`. Saldot läses på varje sida (Att göra i menyn, Lager, Drift, Prognos). Frågan gick från 160–240 ms (sortering på disk) till 45–60 ms.

Inga nya tabeller, så isoleringsfixturen (`seedTenantFixture`) behövde inte ändras. Katalogtestet (`test/db/catalog.test.ts`) kontrollerar vyerna: `stock_levels` har kvar `security_invoker = true` och `organization_id`, och det testet är grönt.

Databasen var inte flaskhalsen. Med 109 000 order tar en sidladdning 50–250 ms i databasen. Resten var beräkningar och omvandling i Node.

## Samma svar

| Test                                           | Vad det kontrollerar                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/analytics/todos/time-fast.test.ts`        | `localParts` mot Intl (`intlParts`) i tio tidszoner: 4 000 slumpade tidpunkter 1971–2101 per zon, och varje minut runt sommartidsskiftena 2026, plus långsamma vägen före 1972 och efter 2099. `tryParseInstant` mot `parseInstant`. |
| `src/analytics/lost-sales/stock-order.test.ts` | Ordningen i `replayStockDaily` mot sortering med `compareStockEvents`. Testet använder slumpade händelser med saknade, ogiltiga (Postgres textformat) och lika tidpunkter.                                                           |
| `src/domain/ledger-cache.test.ts`              | Sparad liggare mot nybyggd: samma indata ger samma objekt, och annan period, prislista eller färre order räknas om. Lönsamhet i fem vyer för åtta slumpade scenarier ger samma resultat med och utan sparande.                       |
| `src/domain/allocate-fast.test.ts`             | Talvägen i `allocateLargestRemainder` mot bigint-vägen: 3 000 slumpade fördelningar, gränsen för säkra heltal, lika rester och negativa belopp. Felen är desamma som förut.                                                          |
| `src/analytics/todos/common-sort.test.ts`      | `uniqueSorted` mot sortering med `<`, även med versaler, å/ä och tecken utanför BMP.                                                                                                                                                 |
| `src/app/(app)/expansion/_lib/slim.test.ts`    | `withOrderCounts` byter bara `orderIds` mot antalet, på alla nivåer, och ändrar inte originalet.                                                                                                                                     |
| `test/db/prestanda.test.ts`                    | `queryOrders` (rå SQL) mot den tidigare Drizzle-frågan, med samma tidpunkt på flera order, mikrosekunder, order utan titel och utan automat och ett belopp över 2^31. Vyn `stock_levels` mot den tidigare definitionen.              |

Utöver testerna jämfördes laddarnas svar med den stora demon före (koden i `82370b9`) och efter, som JSON. Jämförelsen gällde lönsamhet per automat och titel, förlorad försäljning, hela Prognos & inköp, Att göra (med och utan rankning), avstämningen, fasta kostnader, platshistorik, Värt att veta, bokföring, kassaflöde, Marknad och automaternas hälsa, för 30 d och Allt. Allt var identiskt utom två textändringar från andra spår i slutsteget: ordfogning i periodtexter och kronor utan ören i avstämningens sammanfattning. Vyns rader var identiska före och efter migreringen.

## Kvarstående

1. **Fel ordning inom dagen i Prognos & inköp och förlorad försäljning (hög, påverkar siffror).** `queryMachineStockEvents` (`src/server/purchasing/queries.ts`) skickar `occurred_at` som Postgres-text (`"2026-09-01 06:58:00+00"`). `tryParseInstant` godtar bara ISO 8601, så tidpunkten ignoreras och händelserna inom en dag ordnas bara på `seq`. Lager, Drift och rapporterna skickar ISO och ordnar på tid, som vyn `stock_levels` gör.
   - **Belägg:** i den stora demon ger genomspelningen (`stockLevels`) samma saldo som vyn för 42 av 138 automatserier med dagens kod. Med ISO-tid stämmer alla 138.
   - **Rättning:** `occurredAt: new Date(r.occurred_at).toISOString()`, eller `to_char(… at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` som i `queryOrders`.
   - **Effekt:** siffrorna ändras. I den stora demon blir förlorad försäljning för Allt cirka 350 400 kr i stället för cirka 40 500 kr, och för 30 d cirka 33 000 kr i stället för 0 kr. Det rör Hem ("Slutsålt kostade …"), Prognos & inköp och rankningen i Att göra, och siffrorna i `docs/product.md` och `docs/demo.md` behöver ses över.
   - Ändringen är inte gjord här, eftersom prestandaspåret ska ge samma svar. Den bör göras och granskas i slutsteget.
2. **Ekonomi 30 d ligger på 2,0 s.** Förslag i ordning:
   - Låt kassaflödet räkna butiksersättningen per månad i en genomgång av liggaren i stället för en liggare per månad.
   - Spara antalet verifikationer per stängd månad, så att bokföringen bara bygger den valda månaden.
   - Strömma kassaflödessektionen och låt rubriken bygga på avstämningen. Det kräver en ny formulering av rubriken.
3. **Marknad och Prognos skickar 1,7–1,8 MB HTML** (prognosrader och diagramdata till klientkomponenter). Det är inte order-id utan riktiga rader. Tiden är under målet, men på ett långsamt mobilnät märks det. Det går att minska genom att skicka färre punkter till diagrammen.
4. **Att göra-räknaren i menyn** strömmar nu in efter skalet. Det syns som en tom plats i någon tiondels sekund på sidor där Att göra tar längre tid än sidan. Det är avsiktligt (ingen layoutförskjutning, räknaren står sist på raden).
5. **Hem för Allt läser alla order två gånger.** Gången för Hem och gången för förlorad försäljning har olika intervall (förlorad försäljning läser 60 dagar före perioden). Det är cirka 0,3 s. Förlorad försäljning kan läsa via den memoiserade laddaren om intervallet anpassas till första ordern.
6. **Mätspärren:** dev-inloggningen kan inte köras i `next start`. För att mäta ett produktionsbygge lokalt släpptes spärren bara i mätningens worktree. Vill köparen kunna upprepa mätningen behövs ett eget sätt att logga in i ett lokalt produktionsbygge, till exempel Supabase Auth mot en lokal Supabase.

## Så mäter man om

1. Skapa en egen databas med auth-shim och migreringar. Använd `resetDatabase` i `src/db/migrator.ts` med egen URL, eller `npm run db:reset -- dev` med `DATABASE_URL` satt till den.
2. Kör `npm run db:seed -- --url <url>` och sedan `npm run db:seed-demo -- --url <url> --stor`, vilket tar cirka 2 minuter.
3. Bygg (`next build`) och starta (`next start`) mot databasen.
4. Logga in som `demo@binderlab.local`, välj Nordljus Automater AB (demo, stor) och ladda varje sida med `?period=30d` och `?period=allt`.

Profilering: starta servern med `NODE_OPTIONS="--cpu-prof --cpu-prof-dir=<katalog>"`, ladda sidan några gånger och stoppa servern med SIGTERM. Profilen går att läsa tillbaka till källkoden med källkartorna i `.next/server/chunks/**/*.js.map`.
