# Binderlab: så räknas siffrorna

Version av beräkningsreglerna: **1.0.0** (`CALC_VERSION` i `src/domain/profitability.ts`, sparas med varje rapport).

Det här dokumentet beskriver hur panelen och rapporterna räknar fram intäkt, inköp, avgifter, butiksersättning och vinst. Det är skrivet så att en bokhållare ska kunna räkna efter för hand. Alla exempel nedan finns som automatiska tester i `src/domain/*.test.ts` och kontrolleras vid varje ändring.

## 1. Grundregler

| Regel                  | Innebörd                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Belopp i öre           | Alla belopp räknas i hela öre (49,00 kr = 4 900 öre). Decimaltal används aldrig för pengar.                                                                                                                                        |
| Procent i baspunkter   | 1 % = 100 bp, 100 % = 10 000 bp. Provision 10 % = 1 000 bp.                                                                                                                                                                        |
| Affärsdatum            | Varje order har ett datum i svensk tid (Europe/Stockholm). Alla regler (pris, avtal, placering, period) gäller per kalenderdag. Klockslag och tidszoner påverkar inte beräkningen.                                                 |
| Perioder och intervall | Start- och slutdag ingår alltid. "1–30 nov." är 30 dagar. Ett avtal "giltigt till 15 nov." gäller hela 15 nov.                                                                                                                     |
| Avrundning             | Halva öre avrundas uppåt (bort från noll): 122,5 → 123, 122,49 → 122. Avrundning sker **per order** (moms, kortavgift, provision) eller **per butik och månad** (hyra), aldrig på summor. Summor är summor av redan avrundade öre. |
| Ett pack per order     | Varje order är ett sålt pack.                                                                                                                                                                                                      |
| Ordrar ändras inte     | En importerad order ändras eller återbetalas aldrig.                                                                                                                                                                               |

## 2. Varje order för sig

För en order med betalt belopp _B_ (inklusive eventuell moms):

| Post        | Formel                                      | Kommentar                                                                                             |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Moms        | round(_B_ × momssats / (10 000 + momssats)) | Momsen "ur" ett belopp som inkluderar moms. I dag är momssatsen 0.                                    |
| Nettointäkt | _B_ − moms                                  | Detta är "intäkt" i panelen.                                                                          |
| Kortavgift  | round(_B_ × kortavgift / 10 000)            | På beloppet **inklusive** moms. I dag är kortavgiften 0.                                              |
| Provision   | round(netto × provision / 10 000)           | På beloppet **exklusive** moms, enligt det avtal som gällde i den butik där automaten stod den dagen. |
| Inköp       | inköpspriset som gällde orderns dag         | Se avsnitt 3. Saknas pris räknas ordern inte in i vinsten (avsnitt 5).                                |

**Exempel** (moms 25 %, kortavgift 2,5 %, provision 10 %, order på 49,00 kr):

- Moms = round(4 900 × 2 500 / 12 500) = 980 öre
- Netto = 4 900 − 980 = 3 920 öre
- Kortavgift = round(4 900 × 250 / 10 000) = round(122,5) = 123 öre
- Provision = round(3 920 × 1 000 / 10 000) = 392 öre

Med dagens inställningar (moms 0, kortavgift 0) blir netto = betalt belopp och provisionen 10 % av det betalda beloppet: 490 öre.

**Vilken butik?** Automatens placering avgör: den butik automaten stod i på orderns datum. Flyttar en automat mitt i perioden räknas order före flytten på den gamla butiken och dess avtal, order efter flytten på den nya. Order från en automat som inte var placerad någonstans den dagen (eller som inte är kopplad till någon automat) får ingen provision och ingen hyra, och visas på egna rader (se avsnitt 5).

## 3. Inköpspriser

Varje titel har inköpspriser per order (= per pack) med ett **giltig från**-datum. För en order gäller **det senaste priset med giltig från ≤ orderns datum**. Finns inget sådant pris saknar ordern inköpspris.

Det betyder att:

- en prisändring gäller från och med sitt datum; order på själva ändringsdagen får det nya priset,
- gamla perioder räknas alltid med de priser som gällde då, även om priset har ändrats senare,
- ett pris som läggs in i efterhand med ett tidigt giltig från-datum slår igenom direkt på alla order från det datumet, även i gamla perioder (stängda månader skyddas av databasen, inte av beräkningen),
- prishistoriken visar varje pris med "giltig till" = dagen före nästa pris.

**Exempel: prisändring mitt i perioden.** Titel A kostar 20,00 kr från 1 sep. och 25,00 kr från 16 okt. Automat 1 står i butik 1 hela oktober, avtal med provision 10 % och hyra 62,00 kr/månad, ingen moms och ingen kortavgift.

| Order | Datum   | Belopp | Inköp                                |
| ----- | ------- | ------ | ------------------------------------ |
| o1    | 5 okt.  | 49,00  | 20,00                                |
| o2    | 10 okt. | 49,00  | 20,00                                |
| o3    | 15 okt. | 49,00  | 20,00 (sista dagen med gamla priset) |
| o4    | 16 okt. | 49,00  | 25,00 (ändringsdagen)                |
| o5    | 20 okt. | 49,00  | 25,00                                |
| o6    | 31 okt. | 59,00  | 25,00                                |

| Post             | Uträkning                   | Öre               |
| ---------------- | --------------------------- | ----------------- |
| Intäkt           | 5 × 4 900 + 5 900           | 30 400            |
| Inköp            | 3 × 2 000 + 3 × 2 500       | 13 500            |
| Avgifter         | 0                           | 0                 |
| Provision        | 5 × 490 + 590               | 3 040             |
| Hyra             | hel månad                   | 6 200             |
| Butiksersättning | 3 040 + 6 200               | 9 240             |
| **Vinst**        | 30 400 − 13 500 − 0 − 9 240 | **7 660**         |
| Marginal         | 7 660 / 30 400 = 25,197 %   | 2 520 bp (25,2 %) |

Samma order med moms 25 % och kortavgift 2,5 %: intäkt 24 320, inköp 13 500, avgifter 763, provision 2 432, hyra 6 200, vinst 1 425, marginal 5,9 %.

## 4. Butiksersättning: provision och hyra

Butiksersättning = provision + hyra.

### Provision

Räknas per order (avsnitt 2) med avtalet för orderns butik och dag. Byts avtalet mitt i månaden får order före bytet den gamla satsen och order efter bytet den nya. Avtal utan provision (bara hyra) ger provision 0.

### Hyra

Hyran räknas **per butik och kalendermånad**, för de dagar i månaden som ligger i den valda perioden och där ett avtal med hyra gällde:

> hyra = round( Σ (månadshyra × antal dagar med den månadshyran) / antal dagar i månaden )

- En hel månad med samma avtal ger exakt månadshyran (även februari).
- Delmånad räknas per dag: 10–20 nov. (11 dagar) med 1 000 kr/månad = round(100 000 × 11 / 30) = 36 667 öre.
- Byts avtalet mitt i månaden vägs hyrorna efter dagar och avrundas en gång. 1–15 nov. 30 000 kr/mån och 16–30 nov. 45 000 kr/mån: (3 000 000 × 15 + 4 500 000 × 15) / 30 = 3 750 000 öre.
- En period över månadsskiftet ger en hyra per månad: 20 okt.–10 nov. med 310 kr/mån = 12 000 öre för oktober (12 av 31 dagar) och 10 333 öre för november (10 av 30 dagar).
- Hyran gäller enligt avtalet, oavsett om automaten sålde något. Avtal med bara provision ger ingen hyra.

Eftersom hyran avrundas per butik och månad kan två halvor av en månad tillsammans skilja ett öre från hela månaden. Månadsrapporter räknar alltid hela månader och påverkas inte.

### Fördelning av hyran på order

Hyran för en butik och månad fördelas på butikens order den månaden (inom perioden) **i proportion till nettointäkten**, så att varje order bär sin del. Fördelningen görs med **största-restmetoden** så att delarna summerar exakt till hyran:

1. Varje order får heltalsdelen av hyra × orderns netto / summa netto.
2. De öre som blir över delas ut ett i taget till de order som har störst rest. Lika rest: den order som kommer först i datumordning (sedan order-id).

Exempel: hyra 62,00 kr på fem order à 49,00 och en à 59,00 (netto 30 400). 6 200 × 4 900 / 30 400 = 999,34 och 6 200 × 5 900 / 30 400 = 1 203,29. Heltalsdelarna blir 5 × 999 + 1 203 = 6 198; de två öre som är över går till de två första orderna à 49,00 (rest 0,34 är större än 0,29). Resultat: 1 000, 1 000, 999, 999, 999, 1 203 = 6 200.

Har alla order i butik-månaden nettointäkt 0 fördelas hyran lika.

### Ej fördelad hyra

Har en butik hyra en månad men inga order den månaden i perioden kan hyran inte fördelas. Den är ändå en kostnad för perioden och dras från vinsten. Den visas som:

- en egen rad **"Ej fördelad hyra"** (nyckel `unallocated`) per titel, per automat, per dag och per vecka,
- på **butikens rad** i vyn per butik,
- på **månadens rad** i vyn per månad.

## 5. Lönsamhet

### Vinst och marginal

> vinst = intäkt − inköp − avgifter − butiksersättning
>
> marginal = round(vinst × 10 000 / intäkt) bp

Marginalen visas inte (–) när intäkten är 0.

### Order utan inköpspris

**En order utan inköpspris räknas inte in i vinsten.** Annars skulle vinsten se för hög ut (inköpet saknas). I varje rad gäller därför intäkt, inköp, avgifter, butiksersättning, vinst och marginal **bara prissatta order**. Order utan pris redovisas separat:

| Fält                                   | Innehåll                                       |
| -------------------------------------- | ---------------------------------------------- |
| Order utan pris                        | antal                                          |
| Intäkt utan pris                       | deras nettointäkt (och moms separat)           |
| Avgifter, provision och hyra utan pris | deras kortavgift, provision och andel av hyran |

Provisionen och hyran räknas alltså på alla order (butiken ska ha sin ersättning), men den del som hör till order utan pris ingår inte i vinsten. På så sätt går allt ihop:

- betalt belopp = moms + intäkt + moms utan pris + intäkt utan pris
- all hyra i perioden = hyra (prissatta + ej fördelad) + hyra utan pris

Panelen visar hur stor del av intäkten som saknar pris:

> andel utan pris = round(intäkt utan pris × 10 000 / (intäkt + intäkt utan pris)) bp

**Exempel.** Titel A har pris 20,00 kr; titel B och C saknar pris. November, butik 1 med provision 10 % och hyra 100,00 kr. Fyra order av A à 49,00, tre av B à 59,00 och en av C à 129,00. Nettointäkt totalt 50 200, varav 30 600 utan pris: **61,0 % av intäkten saknar inköpspris** (titel B och C). Hyran 10 000 fördelas på alla åtta order; A:s fyra order bär 3 904. Vinsten (bara A) = 19 600 − 8 000 − 1 960 − 3 904 = 5 736 öre.

### Vyer: per titel, automat, butik, dag, vecka och månad

Alla vyer bygger på samma orderliggare (en rad per order med alla belopp ovan). Därför gäller alltid:

- **summan av raderna = totalen**, exakt på öret, för varje kolumn och i varje vy,
- **totalen är densamma** i alla vyer.

Särskilda rader:

| Nyckel        | Var                        | Innehåll                                                            |
| ------------- | -------------------------- | ------------------------------------------------------------------- |
| `unallocated` | titel, automat, dag, vecka | ej fördelad hyra                                                    |
| `no-machine`  | automat                    | order vars automat i källan inte är kopplad                         |
| `no-store`    | butik                      | order från en automat som inte var placerad i någon butik den dagen |

Tidsvyerna (dag, vecka, månad) visar alla dagar/veckor/månader i perioden, även de utan försäljning. Veckor följer ISO 8601 (måndag–söndag, vecka 1 är veckan med årets första torsdag; 2026 har 53 veckor). Veckor och månader som bara delvis ligger i perioden markeras som delvisa.

### Vattenfall

Intäkt → Inköp → Avgifter → Butiksersättning → Vinst, för prissatta order. Avdragen visas som negativa belopp och summerar till vinsten. Bredvid visas intäkten utan pris som "ingår inte".

## 6. Nyckeltal

| Nyckeltal             | Formel                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Intäkt                | Σ nettointäkt (alla order)                                                                     |
| Antal order           | antal order (= antal pack)                                                                     |
| Snittorder            | round(intäkt / antal order)                                                                    |
| Marginal              | round(vinst × 10 000 / intäkt) för prissatta order                                             |
| Förändring            | round((nu − före) × 10 000 / \|före\|) bp; visas inte när föregående värde är 0                |
| Största bidragsgivare | raden med störst vinst och dess andel av totala vinsten (visas inte när totala vinsten är ≤ 0) |

## 7. Per titel (sidan Inköpspriser)

För varje titel och vald period, med _n_ = antal order av titeln:

| Post                | Formel                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Snittpris           | round(Σ netto / _n_)                                                                     |
| Aktuellt inköpspris | priset som gäller periodens sista dag                                                    |
| Kvar per order      | round((Σ netto − Σ kortavgift − Σ provision − _n_ × aktuellt inköpspris) / _n_)          |
| Hyra per order      | round(Σ fördelad hyra / _n_), visas separat och ingår inte i "kvar per order"            |
| Kvar efter hyra     | round((Σ netto − Σ kortavgift − Σ provision − Σ hyra − _n_ × aktuellt inköpspris) / _n_) |
| Förlustvarning      | kvar per order ≤ 0                                                                       |

"Kvar per order" svarar på frågan: vad lämnar nästa sålda pack med dagens inköpspris? Därför används det aktuella priset för alla order i perioden. Snittet av de priser som faktiskt gällde visas också.

**Exempel.** Kortavgift 2,5 %, provision 10 %. Titel B säljs för 49,00 och kostar 48,00: (9 800 − 246 − 980 − 9 600) / 2 = −513 öre per order, alltså **förlustvarning**. Titel A (inköp 20,00): (19 600 − 492 − 1 960 − 8 000) / 4 = 2 287 öre per order.

## 8. Lagerprognos

- Försäljningstakt = sålda pack / antal dagar i fönstret (t.ex. de senaste 7 eller 28 dagarna, kortat om automaten eller titeln är nyare än fönstret).
- Dagar kvar = golv(i lager / takt): hela dagar som lagret räcker. 10 pack och 3 pack/dag → 3 dagar.
- Beräknat tomt = i dag + tak(i lager / takt): dagen då sista packet väntas säljas. 10 pack och 3 pack/dag → om 4 dagar.
- Är takten 0 visas ingen prognos.

## 9. Enhetsekonomi per automat

| Post                    | Formel                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Vinst                   | automatens vinst i perioden (samma som i vyn per automat)                                                       |
| Aktiva månader          | Σ per kalendermånad (dagar då automaten var placerad / dagar i månaden). En hel månad = 1, 15 av 30 dagar = 0,5 |
| Vinst per månad         | round(vinst / aktiva månader)                                                                                   |
| Avskrivning per månad   | round(investering / avskrivningstid i månader), linjärt                                                         |
| Ackumulerad avskrivning | round(investering × hela månader sedan investeringen / avskrivningstid), högst hela beloppet                    |
| Bokfört värde           | investering − ackumulerad avskrivning                                                                           |
| Återbetalningstid       | investering / vinst per månad, i månader med en decimal; visas inte om vinsten per månad är ≤ 0                 |

Ej fördelad hyra ingår inte i automatens vinst (den hör inte till någon automat).

**Exempel.** En automat säljer ett pack om dagen i sep.–nov. (91 order × 29,00 kr kvar = 2 639,00 kr på exakt 3 månader = 879,67 kr/månad). Inköp 20 000 kr med 36 månaders avskrivning och installation 1 000 kr: avskrivning 555,56 kr/månad, ackumulerat per 30 nov. (2 hela månader) 1 111,11 kr, återbetalningstid 21 000 / 879,67 = 23,9 månader.

## 10. Fördelning mellan ägare

Ägarandelarna ska summera till 100 % (10 000 bp). Varje ägare utom den med störst andel får belopp × andel avkortat till helt öre; ägaren med störst andel får resten. Summan stämmer alltid exakt, och de öre som avrundningen ger över hamnar hos den största andelen.

Exempel: 999,99 kr fördelat 60/30/10 → 30 % = 299,99 kr (av 299,997), 10 % = 99,99 kr (av 99,999), 60 % = 600,01 kr.

## 11. Kontroller

Beräkningarna kontrolleras automatiskt (`npm test`, `npm run test:domain:tz`):

- **Avstämning:** 200 slumpade men återskapbara scenarier (prisändringar, avtal som byts mitt i månaden, automater som flyttar, butiker utan order, saknade priser, moms och kortavgift från 0 till höga värden, stora belopp). För varje scenario och vy kontrolleras att raderna summerar exakt till totalen, att totalen är densamma i alla vyer och att den stämmer med en fristående, enklare uträkning dag för dag.
- **Handräkningar:** exemplen i det här dokumentet.
- **Tidszon:** samma beräkningar ger identiska resultat när servern går i UTC, Europe/Stockholm och Asia/Shanghai.
- **Ordning:** resultatet beror inte på i vilken ordning orderna läses in.

## 12. Det som inte ingår (i version 1.0.0)

- Moms på hyra och provision (butikens faktura) räknas inte. Bolaget är i dag inte momsregistrerat.
- Kortavgiften räknas på alla order oavsett betalsätt (den är 0 i dag).
- Svinn, lagerjusteringar och frakt ingår inte i inköpet; inköp = inköpspris × antal sålda pack.
- Avskrivningar och investeringar ingår inte i vinsten i lönsamhetsvyerna, bara i enhetsekonomin.
