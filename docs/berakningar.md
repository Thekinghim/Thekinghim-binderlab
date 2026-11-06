# Binderlab: så räknas siffrorna

Version av beräkningsreglerna: **1.3.0** (`CALC_VERSION` i `src/domain/profitability.ts`, sparas med varje rapport).

Det här dokumentet beskriver hur panelen och rapporterna räknar fram intäkt, inköp, avgifter, VMB-moms, butiksersättning och vinst. Det är skrivet så att en bokhållare ska kunna räkna efter för hand. Alla exempel nedan finns som automatiska tester i `src/domain/*.test.ts` och kontrolleras vid varje ändring.

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

| Post        | Formel                                      | Kommentar                                                                                                                                                                     |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moms        | round(_B_ × momssats / (10 000 + momssats)) | Momsen "ur" ett belopp som inkluderar moms. I dag är momssatsen 0.                                                                                                            |
| Nettointäkt | _B_ − moms                                  | Detta är "intäkt" i panelen.                                                                                                                                                  |
| Kortavgift  | round(_B_ × kortavgift / 10 000)            | På beloppet **inklusive** moms. I dag är kortavgiften 0.                                                                                                                      |
| Provision   | round(netto × provision / 10 000)           | På beloppet **exklusive** moms, enligt det avtal som gällde i den butik där automaten stod den dagen. Vid vinstdelning 0 här: andelen räknas per butik och månad (avsnitt 4). |
| Inköp       | inköpspriset som gällde orderns dag         | Se avsnitt 3. Saknas pris räknas ordern inte in i vinsten (avsnitt 5).                                                                                                        |

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

## 4. Butiksersättning: vinstdelning, provision och hyra

Butiksersättning = andel av vinsten + provision + hyra.

Ett avtal har ett **underlag** (`store_agreements.commission_base`):

| Underlag             | I formuläret (Butiker)            | Andelen (`commission_bp`) räknas på                  |
| -------------------- | --------------------------------- | ---------------------------------------------------- |
| `profit_after_costs` | **Vinstdelning 50/50** (standard) | vinsten efter kostnader, per butik och månad (nedan) |
| `net_excl_vat`       | Andel av försäljning              | beloppet exkl. moms, per order (provision, nedan)    |

Hyra kan läggas till båda och är tom som standard. Nya villkor skapas med **Skapa avtal** (Avtal, Butiker och Expansion): vinstdelning med 50 % (5 000 bp) och förlusthantering `zero`. "Andel av försäljning" går bara att välja när ett gammalt sådant avtal rättas under Butiker. Databasens standardvärde för underlaget är fortfarande `net_excl_vat`, så att rader som läggs in utan underlag (seed, tester, äldre kod) behåller sin betydelse.

### Vinstdelning (`src/domain/profit-split.ts`)

Räknas per **butik, kalendermånad och avtal** (de dagar i månaden avtalet gällde), på butikens order **med inköpspris**:

| Post            | Formel                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Försäljning     | Σ belopp **inklusive** moms                                                                                        |
| Återbetalningar | Σ återbetalt till kunder (kundärenden) med återbetalningsdag i avtalets dagar                                      |
| Inköp           | Σ inköpspris för de sålda packen (avsnitt 3)                                                                       |
| VMB-moms        | 0 (standard); 20 % av (försäljning − återbetalningar − inköp) om positivt bara om avtalet drar av VMB före delning |
| Kortavgifter    | Σ kortavgift per order (avsnitt 2)                                                                                 |
| **Vinst**       | försäljning − återbetalningar − VMB-moms − inköp − kortavgifter                                                    |
| Butikens andel  | round(vinst × andel / 10 000) om vinsten ≥ 0                                                                       |
| Vid förlust     | `zero` (standard): 0 kr. `proportional`: round(vinst × andel / 10 000), negativt                                   |
| Vår andel       | vinst − butikens andel                                                                                             |

- **Utan VMB som standard; knapp för att slå på.** Valet **Dra av VMB-moms före delning** (`store_agreements.vmb_before_split`, per avtal) är **av** som standard, även för alla befintliga avtal: butikens andel = andel × (försäljning − återbetalningar − inköp − kortavgifter), utan VMB-avdrag, och en eventuell VMB-moms bärs helt av oss. På = butikens andel räknas på vinsten efter VMB-moms. Valet görs i Skapa avtal och i avtalsformuläret under Butiker, och står i avtalets text (PDF); i butiksrapportens rad "Avtal" och i Bokföringens sammanfattning per butik står VMB bara när valet är på ("… (VMB-moms dras före delning)").
- VMB-momsen är vinstmarginalbeskattningen: 25 % moms på marginalen inklusive moms = 20 % av marginalen (25/125). Den räknas här på butikens månad, inte på hela redovisningsperioden som i momsdeklarationen (Ekonomi → Bokföring, med underskott som förs vidare); ett underskott förs inte vidare mellan månaderna i butiksavräkningen. Uträkningen är densamma överallt (`src/domain/vmb.ts`: `vmbVat`, `vmbChain`, `vmbVatOfMargin`); bokföringen, butiksavräkningen och vår vinst (avsnitt 5) använder den.
- Avrundning: halva öre bort från noll, **en gång** per butik, månad och avtal (inte per order).
- Liggaren fördelar butikens andel på månadens order med inköpspris i proportion till beloppet inkl. moms, med största-restmetoden, så att alla vyer (titel, automat, dag …) summerar exakt till andelen. Order utan inköpspris bär ingen andel.
- Byts avtalet mitt i månaden räknas en vinstdelning per avtal, var och en på sina dagar.
- **Återbetalningar** (kundärenden med återbetalt belopp) dras från butikens försäljning i den månad pengarna gick tillbaka, på butiken där automaten stod den dagen (`refunds` i liggarens indata). Butiken får alltså inte andel av pengar som gått tillbaka till kunden. Fördelningen på orderna sker som förut på beloppet; återbetalningen ändrar bara summan som fördelas.
- **Kortavgifterna** är den modellerade avgiften (Inställningar, `card_fee_bp`), inte de faktiska avgifterna i utbetalningsfilerna. Sätt avgiften till den verkliga effektiva satsen innan första utbetalningen till en butik.
- **Delmånad är preliminär.** Förlustgolvet och avrundningen gäller hela månaden. En vy över en period som bara täcker en del av månaden (t.ex. "senaste 30 dagarna") räknar vinstdelningen på de dagarna och markerar den (`StoreMonthSplit.partialMonth`); den kan skilja från butiksrapporten för hela månaden, som alltid är den som gäller.
- **Butiksrapport med eget datum** (Rapporter → Period → Eget datum, t.ex. 15–31 okt.; högst ett år, till högst i dag). Vinstdelningen räknas som vanligt **per kalendermånad och avtal** på intervallets dagar, som i liggaren (Butiker, Lönsamhet för samma datum): förlusthanteringen och avrundningen gäller varje månad för sig, och över ett månadsskifte står ett andelssteg per månad. En förlust i en månad kvittas alltså inte mot vinst i en annan. Provisionen räknas per order som vanligt. Hyran räknas per kalendermånad för intervallets dagar (round(månadshyra × dagar / dagar i månaden), ett hyressteg per månad). Jämförelsen görs mot lika många dagar närmast före (`previousPeriod`). Ett intervall som är exakt en hel månad blir den vanliga månadsrapporten. Bokföringsunderlaget kan också ha eget datum (inom ett räkenskapsår); delägarrapporten görs alltid per månad.
- **Bokföringen** (`buildAccountantReport`) räknar `profitSplitUnpricedOrders`: order utan inköpspris i butiker med vinstdelning. Är det fler än 0 säger slutsatsen att butikernas andel inte är färdigräknad och inte ska bokföras förrän priserna finns.
- **Saknat inköpspris stoppar butiksrapporten.** Har någon av butikens order i månaden inget inköpspris räknas rapporten inte (aldrig med en gissning): förhandsvisningen och "Skapa utkast" visar en rad, t.ex. "Butiksrapporten kan inte räknas: 3 order saknar inköpspris (Mystery Pack Premium). Lägg in priserna under Inköpspriser.", med länk till Inköpspriser.
- Butiksportalen ser inga inköpspriser. Där står andelen som "i månadsrapporten" tills rapporten är godkänd; den godkända rapporten visar hela uträkningen.
- Butiksrapporten visar avtalet ("50 % av vinsten efter kostnader, giltigt från …"; med avtalets val på "… (VMB-moms dras före delning) …") och tabellen Försäljning, (Återbetalningar), VMB-moms (bara när avtalet drar av den), Inköp, Kortavgifter, Vinst, Er andel 50 %, (Hyra). Raden "Er ersättning" (andel + hyra) visas bara när det finns hyra eller provision; annars är den samma tal som "Er andel". Inköp och vinst visas bara som månadens summor för butiken, aldrig per titel eller automat.
- Avtalsmallen (`src/reports/contract-pdf.ts`) skriver samma definition. Med `proportional` bär butiken sin andel av en förlust den månaden; förlusten förs inte vidare till kommande månader.
- **Uppskattningar per order** (prisändring i Expansion, `price-change.ts`): butikens nya andel = nuvarande andel + andel × (ny ordervinst − nuvarande ordervinst), ordervinst = belopp − VMB-moms − inköp − avgift. Månadens förlustgolv räknas inte om. Med vyknappen drar vårt nya bidrag VMB-moms: orderns del av månadens VMB-moms + 20 % av ändringen i orderns marginal (aldrig under 0).
- **Nya platser** (Expansion, `estimate.ts`): utan erbjuden hyra används liknande platsers faktiska ersättning (som redan är vinstdelning). Med erbjuden hyra räknas villkoren som vinstdelning 50 % + hyra: andel × max(0, täckningsbidrag) på platsens hela underlag, utan VMB-avdrag som nya avtal (med `vmbBeforeSplit` på: andel × max(0, täckningsbidrag − VMB-moms)). Fältet "Erbjuden provision" finns inte längre.

**Exempel** (kortavgift 2 %, vinstdelning 50 %): två pack à 199,00 kr (inköp 130,00 kr) och ett à 249,00 kr (inköp 165,00 kr).

| Post           | Uträkning               | Öre        |
| -------------- | ----------------------- | ---------- |
| Försäljning    | 2 × 19 900 + 24 900     | 64 700     |
| Inköp          | 2 × 13 000 + 16 500     | 42 500     |
| VMB-moms       | standard: dras inte     | 0          |
| Kortavgifter   | 398 + 398 + 498         | 1 294      |
| Vinst          | 64 700 − 42 500 − 1 294 | 20 906     |
| Butikens andel | 50 % av 20 906          | **10 453** |
| Vår andel      | 20 906 − 10 453         | 10 453     |

Med avtalets val "Dra av VMB-moms före delning" på: VMB-moms 20 % av (64 700 − 42 500 = 22 200) = 4 440, vinst 64 700 − 4 440 − 42 500 − 1 294 = 16 466, butikens andel 8 233.

Förlust: ett pack à 100,00 kr med inköp 130,00 kr ger marginal −30,00 kr, ingen VMB-moms och vinst −30,00 kr; butiken får 0 kr (`zero`).

### Provision (andel av försäljning)

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

Hyran för en butik och månad fördelas på butikens order den månaden (inom perioden) **i proportion till nettointäkten × den månadshyra som gällde orderns dag**, så att varje order bär sin del. En order på en dag då butiken inte hade något hyresavtal (till exempel före ett byte från bara provision till hyra) bär alltså ingen hyra, och efter en hyreshöjning mitt i månaden bär en krona försäljning mer hyra än före. Gäller samma hyra hela månaden blir det helt enkelt i proportion till nettointäkten. Fördelningen görs med **största-restmetoden** så att delarna summerar exakt till hyran:

1. Varje order får heltalsdelen av hyra × orderns vikt / summa vikter, där vikt = netto × dagens månadshyra.
2. De öre som blir över delas ut ett i taget till de order som har störst rest. Lika rest: den order som kommer först i datumordning (sedan order-id).

Exempel: hyra 62,00 kr på fem order à 49,00 och en à 59,00 (netto 30 400). 6 200 × 4 900 / 30 400 = 999,34 och 6 200 × 5 900 / 30 400 = 1 203,29. Heltalsdelarna blir 5 × 999 + 1 203 = 6 198; de två öre som är över går till de två första orderna à 49,00 (rest 0,34 är större än 0,29). Resultat: 1 000, 1 000, 999, 999, 999, 1 203 = 6 200.

Har alla order på dagar med hyra nettointäkt 0 fördelas hyran efter dagens månadshyra (lika när hyran är densamma).

**Exempel: avtalsbyte mitt i månaden.** Butik 1 har bara provision t.o.m. 4 nov. och 300 kr/mån i hyra från 5 nov. Perioden är 1–10 nov., så hyran blir 30 000 × 6 / 30 = 6 000 öre. Order: 4 nov. 59,00, 5 nov. 49,00 och 10 nov. 59,00. Ordern 4 nov. har vikt 0 (ingen hyra den dagen). De andra har vikterna 4 900 × 30 000 och 5 900 × 30 000, det vill säga 4 900 : 5 900. 6 000 × 4 900 / 10 800 = 2 722,2 och 6 000 × 5 900 / 10 800 = 3 277,8 → 2 722 + 3 277 = 5 999; öret går till den största resten → 0, 2 722 och 3 278.

### Ej fördelad hyra

Ej fördelad hyra är hyra som inte bärs av någon order med inköpspris:

- en butik har hyra en månad men inga order på dagar med hyra den månaden i perioden, eller
- hyran har fördelats på en order som saknar inköpspris (avsnitt 5).

Den är ändå en kostnad för perioden och dras alltid från vinsten. Den visas som:

- en egen rad **"Ej fördelad hyra"** (nyckel `unallocated`) per titel och per automat,
- på **butikens rad** i vyn per butik,
- på **månadens rad** i vyn per månad,
- **per dag och per vecka på de dagar den gäller**: butik-månadens hyra fördelas på avtalets dagar i perioden (vikt = månadshyran den dagen, största rest, så att summan är exakt butik-månadens hyra), och hyran på en order utan pris ligger på orderns dag. Staplarna per dag och vecka summerar därför exakt till periodens vinst; ingen rest ligger utanför dem.

## 5. Lönsamhet

### Vinst och marginal

> vår vinst (standard) = intäkt − inköp − avgifter (− VMB-moms med vyknappen "Med VMB"), FÖRE butikernas andel
>
> vår del (med "Visa butikernas andel" eller vald butik) = vår vinst − butikernas andel (butiksersättning = provision/vinstdelning per butikens eget avtal + hyra)
>
> marginal = round(vinst × 10 000 / intäkt) bp

Marginalen visas inte (–) när intäkten är 0. Samma vinst och marginal visas på Hem, Lönsamhet (vattenfall, nyckeltal, tabeller, CSV och utvecklingen per dag/vecka/månad), Butiker, Automater, Enhetsekonomi, Expansion, Värde, Ekonomi (fasta kostnader), i Att göra/Värt att veta och i AI-svaren.

**Vyknappen "Visa butikernas andel"** (standard **av**): av = vår vinst och marginal före butikernas andel; andelen syns inte och avgifterna innehåller den aldrig. På = varje butiks andel enligt dess eget avtal dras (summerad), visas som "Butikernas andel" och vinsten heter "Vår del"; vattenfallet får steget "Till butikerna". En **vald butik** (`?butik=`, butikens sida) drar alltid just den butikens andel, med villkoren i etiketten ("Sega gubben 50 % av vinsten"). Ett automatfilter är ingen vald butik. En källa: `Settings.deductStoreShare` (`src/domain/store-share.ts`), satt av `loadDomainInputFor` från förfrågans header (proxyn: `?andel=1`, annars kakan `binderlab-andel` som knappen sparar, så valet gäller på alla sidor). Utan flaggan (avräkningar, butiksrapporter, revisors- och delägarrapporter, bokföring, portalen) dras andelen som förut: det butikerna ska ha ändras aldrig. Testas i `src/domain/store-share.test.ts` och `test/db/consistency-andel.test.ts` (alla sidor, båda lägena, fyra sorters avtal, mot SQL-facit och avräkningarna).

**Vyknappen "Med VMB"** (kontextraden bredvid period och filter, standard **av**): av = omsättning och vinst före VMB-moms; på = vinsten och marginalen efter VMB-moms i alla vyerna ovan, och vattenfallet får steget VMB-moms. Valet står i URL:en (`?vmb=1`, följer med mellan sidor som perioden) och minns per användare i webbläsaren. Knappen ändrar bara vår vinst: butikens andel följer avtalets val (avsnitt 4) och Bokföringen följer sin egen knapp "VMB i bokföringen" (standard av, avsnitt Bokföringen nedan), oberoende av vyknappen. Delägar- och bokföringsrapporterna räknas utan knappen (vinst före VMB-moms; VMB-momsen står i Bokföringen när "VMB i bokföringen" är på).

**Avstämning** (per butik med vinstdelning 50 %, testas i `src/domain/vmb.test.ts` och `test/db/consistency-vmb.test.ts`):

> vår vinst = försäljning − återbetalningar − inköp − kortavgifter − butikens andel (− VMB-moms med vyknappen)
>
> butikens andel = 50 % × (försäljning − återbetalningar − inköp − kortavgifter − VMB-moms om avtalet drar av den)

Exempel (64 700 sålt, 42 500 inköp, VMB-moms 4 440): avtal på, vy av: andel 8 880, vinst 13 320; avtal på, vy på: 8 880 och 8 880; avtal av, vy av: 11 100 och 11 100; avtal av, vy på: 11 100 och 6 660.

### VMB-moms på vår vinst (`src/domain/ledger.ts`, `src/domain/vmb.ts`)

Bolaget är momsregistrerat. Appen räknar **utan VMB som standard; knapp för att slå på** (vyknappen "Med VMB" här, "VMB i bokföringen" i Bokföringen). VMB räknas som **vinstmarginalbeskattning, samlad per kalendermånad**, och kräver momssats 0 i Inställningar (annars skulle momsen räknas två gånger). Bokföringen kräver momssats 0 även utan VMB (annars skulle momsen bokas som försäljning). Med vyknappen "Med VMB" på dras VMB-momsen från vår vinst (`Settings.vmb` sätts av förfrågan, `vmbApplies`; proxyn läser `?vmb=1`). Med knappen av, eller med en annan momssats, är VMB-momsen på vår vinst 0 och steget visas inte.

Per kalendermånad i den valda perioden, på order **med inköpspris**:

> marginal = Σ belopp inkl. moms − återbetalningar till kunder (återbetalningsdagen) − Σ inköp − underskott från förra månaden
>
> VMB-moms = 20 % av marginalen (= 25/125), avrundad till hela ören (halva bort från noll), om marginalen är positiv; annars 0 och underskottet (−marginal) förs till nästa månad

- **VMB i bokföringen** (Ekonomi → Bokföring, `bookkeeping_settings.vmb_enabled`, standard **av**; knappen "VMB i bokföringen" slår på det, ägare och admin). Av: månadspaketet (SIE 4, PDF, Excel) bokför försäljningen på kontot för försäljning utan VMB (förslag 3000) och resultatet = försäljning − återbetalningar − inköp − kortavgifter − butikernas andel; ingen VMB-moms, ingen rad för utgående moms VMB och inget underskott som förs vidare. På: VMB som nedan (3211/2616, samlad beräkning, underskott förs vidare). PDF:ens rubrikrad säger "med VMB" eller "utan VMB". En månad som markerats som skickad behåller valet den skickades med (ögonblicksbilden; skickade före valet = på). Ändras valet tas nya versioner av de sparade paketen för månader som inte är skickade fram (efter svaret, annars av det schemalagda jobbet eller nedladdningen). En skickad månad med sparat paket får aldrig en ny version (varken av jobbet, nedladdningen eller knappen); ändrade siffror syns som "ändrad sedan skickad", och "Ångra skickad" ger en ny version. Bokföringen kräver momssats 0 i Inställningar, med eller utan VMB.
- **Samma uträkning som Bokföringen** (`vmbVat`/`vmbChain`). För en avslutad hel månad, utan order utan inköpspris och med "Inköpsvärde sålda pack" som underlag, är Lönsamhetens VMB-moms exakt Bokföringens med "VMB i bokföringen" på (testas i `test/db/consistency-vmb.test.ts`).
- **Perioden:** momsen räknas på periodens marginal. Underskottet förs vidare mellan periodens månader och börjar på 0 vid periodens början (ett underskott från före perioden räknas inte; det gör Bokföringen).
- **Preliminär:** täcker perioden bara en del av en månad, eller är en månad i perioden inte slut, är VMB-momsen preliminär (`vmbPreliminary`). Lönsamhet skriver då en rad under vattenfallet ("VMB-momsen är preliminär: perioden är inte en avslutad månad.") och Hem skriver "efter VMB-moms (preliminär)" under vinsten. Den moms som redovisas är Bokföringens, för hela månaden.
- **Fördelning:** månadens VMB-moms fördelas på månadens order med inköpspris i proportion till max(0, belopp − inköp), med största-restmetoden (lika rest: datum, sedan order-id). Därför summerar alla vyer (titel, automat, butik, dag, vecka, månad) exakt till periodens VMB-moms. Order utan inköpspris bär ingen VMB-moms (de ingår inte i vinsten).
- **Filter:** med butiks- eller automatfilter bär urvalets order sin del av hela organisationens VMB-moms (samma fördelning som utan filter, `vmbByOrder`), så att en butiks sida visar samma VMB-moms och vinst som butikens rad. Momsen räknas inte på urvalets egen marginal (VMB redovisas samlat för bolaget).
- **Avstämning (vyknappen på):** försäljning (order med inköpspris) = vår vinst efter återbetalningar + butiksersättning + VMB-moms + inköp + kortavgifter + återbetalningar, exakt på öret. Med knappen av faller VMB-momsen bort ur båda leden.
- **Mot butikens andel (vyknappen på, avtalet drar av VMB):** vid 50/50 är vår vinst efter återbetalningar lika med butikens andel utom för vinsten på order före avtalets startdag (den är helt vår), öresavrundningen per butik och månad och att vår VMB-moms är samlad medan butikens räknas per butik och månad.

**Exempel** (moms 0, kortavgift 0, vinstdelning 50 %, vyknappen på): två pack à 199,00 kr (inköp 130,00 kr) och ett à 249,00 kr (inköp 165,00 kr) i november.

| Post             | Uträkning                                          | Öre    |
| ---------------- | -------------------------------------------------- | ------ |
| Intäkt           | 2 × 19 900 + 24 900                                | 64 700 |
| VMB-moms         | 20 % av (64 700 − 42 500 = 22 200)                 | 4 440  |
| Inköp            | 2 × 13 000 + 16 500                                | 42 500 |
| Butiksersättning | 50 % av (64 700 − 4 440 − 42 500), avtalet på      | 8 880  |
| Vinst            | 64 700 − 4 440 − 42 500 − 8 880                    | 8 880  |
| Fördelning       | vikter 6 900 : 6 900 : 8 400 → 1 380, 1 380, 1 680 |        |

Med en återbetalning på 50,00 kr i oktober och ett pack à 100,00 kr (inköp 130,00 kr) i oktober blir oktobers marginal 10 000 − 5 000 − 13 000 = −8 000: ingen VMB-moms och 8 000 i underskott till november, vars VMB-moms blir 20 % av (22 200 − 8 000) = 2 840.

### Order utan inköpspris

**En order utan inköpspris räknas inte in i vinsten.** Annars skulle vinsten se för hög ut (inköpet saknas). Orderns intäkt, moms, kortavgift och provision hålls därför utanför: i varje rad gäller intäkt, inköp, avgifter och provision **bara prissatta order**.

**Hyran dras däremot alltid i sin helhet.** Hyran är en fast kostnad som butiken ska ha oavsett vad som såldes. Den andel av hyran som fördelats på en order utan pris dras därför från vinsten som **ej fördelad hyra** (avsnitt 4). Annars skulle en saknad inköpspris kunna göra vinsten bättre: i version 1.0.0 gjorde en enda såld order utan pris i en butik med 1 500 kr/mån vinsten 1 500 kr högre än om ingenting alls hade sålts. Nu blir vinsten densamma, −1 500 kr, i båda fallen.

Order utan pris redovisas separat:

| Fält                             | Innehåll                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Order utan pris                  | antal                                                                        |
| Intäkt utan pris                 | deras nettointäkt (och moms separat)                                         |
| Avgifter och provision utan pris | deras kortavgift och provision (ingår inte i vinsten)                        |
| Hyra utan pris                   | deras andel av hyran; **ingår i vinsten** via ej fördelad hyra (informativt) |

Provisionen räknas alltså på alla order (butiken ska ha sin ersättning), men den del som hör till order utan pris ingår inte i vinsten. På så sätt går allt ihop:

- betalt belopp = moms + intäkt + moms utan pris + intäkt utan pris
- all hyra i perioden = hyra (prissatta order + ej fördelad hyra); hyra utan pris är en del av den ej fördelade hyran

Panelen visar hur stor del av intäkten som saknar pris:

> andel utan pris = round(intäkt utan pris × 10 000 / (intäkt + intäkt utan pris)) bp

**Exempel.** Titel A har pris 20,00 kr; titel B och C saknar pris. November, butik 1 med provision 10 % och hyra 100,00 kr. Fyra order av A à 49,00, tre av B à 59,00 och en av C à 129,00. Nettointäkt totalt 50 200, varav 30 600 utan pris: **61,0 % av intäkten saknar inköpspris** (titel B och C). Hyran 10 000 fördelas på alla åtta order; A:s fyra order bär 3 904 och B:s och C:s order 6 096. Raden för A visar vinsten 19 600 − 8 000 − 1 960 − 3 904 = 5 736 öre. B och C visar vinst 0. Raden "Ej fördelad hyra" visar −6 096. Totalt: 19 600 − 8 000 − 1 960 − 10 000 = **−360 öre**.

### Vyer: per titel, automat, butik, dag, vecka och månad

Alla vyer bygger på samma orderliggare (en rad per order med alla belopp ovan). Därför gäller alltid:

- **summan av raderna = totalen**, exakt på öret, för varje kolumn och i varje vy,
- **totalen är densamma** i alla vyer.

Särskilda rader:

| Nyckel        | Var            | Innehåll                                                            |
| ------------- | -------------- | ------------------------------------------------------------------- |
| `unallocated` | titel, automat | ej fördelad hyra                                                    |
| `no-machine`  | automat        | order vars automat i källan inte är kopplad                         |
| `no-store`    | butik          | order från en automat som inte var placerad i någon butik den dagen |

Tidsvyerna (dag, vecka, månad) visar alla dagar/veckor/månader i perioden, även de utan försäljning. Veckor följer ISO 8601 (måndag–söndag, vecka 1 är veckan med årets första torsdag; 2026 har 53 veckor). Veckor och månader som bara delvis ligger i perioden markeras som delvisa.

### Vattenfall

Intäkt → VMB-moms → Inköp → Avgifter → Butiksersättning → Vinst, för prissatta order (steget VMB-moms bara med vyknappen "Med VMB"). Butiksersättningen innehåller all hyra i perioden (även ej fördelad). Avdragen visas som negativa belopp och summerar till vinsten. Bredvid visas intäkten utan pris som "ingår inte".

## 6. Nyckeltal

| Nyckeltal             | Formel                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Intäkt                | Σ nettointäkt (alla order)                                                                     |
| Antal order           | antal order (= antal pack)                                                                     |
| Snittorder            | round(intäkt / antal order)                                                                    |
| Marginal              | round(vinst × 10 000 / intäkt) för prissatta order (efter VMB-moms med vyknappen)              |
| Förändring            | round((nu − före) × 10 000 / \|före\|) bp; visas inte när föregående värde är 0                |
| Största bidragsgivare | raden med störst vinst och dess andel av totala vinsten (visas inte när totala vinsten är ≤ 0) |

## 7. Per titel (sidan Inköpspriser)

För varje titel och vald period, med _n_ = antal order av titeln:

| Post                | Formel                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Snittpris           | round(Σ netto / _n_)                                                                           |
| Aktuellt inköpspris | priset som gäller periodens sista dag                                                          |
| Kvar per order      | round((Σ netto − Σ kortavgift − VMB − _n_ × aktuellt inköpspris) / _n_), före butikens andel   |
| Vår del             | round((Σ netto − Σ kortavgift − Σ provision − Σ hyra − VMB − _n_ × aktuellt inköpspris) / _n_) |
| Butikens andel      | kvar per order − vår del (provision eller vinstdelning + hyra, så att talen går ihop exakt)    |
| Varav hyra          | round(Σ fördelad hyra / _n_)                                                                   |
| Förlustvarning      | vår del ≤ 0                                                                                    |

Med vyknappen "Visa butikernas andel" av och ingen vald butik visas bara kvar per order (före andelen): ingen provision och ingen hyra dras, och kolumnerna för andel, hyra och vår del döljs. Med knappen på eller en vald butik visas butikens andel (hyran ingår, som i Lönsamhet) och vår del.

VMB = med vyknappen "Med VMB" 20 % av max(0, Σ netto − _n_ × aktuellt inköpspris), annars 0.

"Kvar per order" svarar på frågan: vad lämnar nästa sålda pack med dagens inköpspris? Därför används det aktuella priset för alla order i perioden. Snittet av de priser som faktiskt gällde visas också.

Provisionen och hyran är de som faktiskt gällde för titelns order i perioden. Säljs titeln i butiker med olika avtal blir "kvar per order" därför ett snitt över butikerna, vägt efter var titeln faktiskt såldes (till exempel 12 % i en butik och 8 % i en annan). Det är avsiktligt: siffran beskriver titeln som den säljs i dag. Lönsamheten per butik finns i vyn per butik.

**Exempel.** Kortavgift 2,5 %, provision 10 %. Titel B säljs för 49,00 och kostar 48,00: (9 800 − 246 − 980 − 9 600) / 2 = −513 öre per order, alltså **förlustvarning**. Titel A (inköp 20,00): (19 600 − 492 − 1 960 − 8 000) / 4 = 2 287 öre per order.

## 8. Lagerprognos

- Försäljningstakt = sålda pack / antal dagar i fönstret (t.ex. de senaste 7 eller 28 dagarna, kortat om automaten eller titeln är nyare än fönstret).
- Dagar kvar = golv(i lager / takt): hela dagar som lagret räcker. 10 pack och 3 pack/dag → 3 dagar.
- Beräknat tomt = i dag + tak(i lager / takt): dagen då sista packet väntas säljas. 10 pack och 3 pack/dag → om 4 dagar.
- Är takten 0 visas ingen prognos.

### Saldot i automaterna (Lager)

Saldo per plats (titel i automat) = senaste inventeringen + alla händelser efter den (påfyllning, svinn, försäljning
−1 per order). Varifrån inventeringen kommer:

1. **Awish (facit).** Synken läser automatens fack (`Products`) var femte minut (varje schemalagd körning) och vid "Synka nu", för varje
   automat som är kopplad under Datakällor. Facken grupperas per vara (samma namnregel som orderimporten: NFKC,
   blanktecken ihopslagna, gemener; titeln via alias, okänd vara blir ny titel). Antal = summan av
   `current_inventory` i varans fack. Skiljer det sig från saldot, eller har platsen aldrig inventerats, skrivs en
   inventering med källan Awish (`stock_events.source = 'awish'`) vid lästiden. Samma antal ger ingen ny händelse.
   En titel med saldo på platsen som Awish inte listar inventeras till 0 och räknas som utgången (en avslutad
   sortimentsperiod i går om den saknar period). Sortimentet (`machine_slots`) följer Awish från i dag: antal fack per
   titel = antal kanaler; en planerad fördelning från ett senare datum och en genomförd sortimentsändring samma dag
   lämnas orörda. En tom lista från Awish ändrar inget.
2. **Inventering eller påfyllning i Binderlab.**
3. **Ingen av dem: "Saldo okänt".** En plats med bara försäljning visas aldrig som tom. Den räknas inte som Kritisk,
   Låg eller OK, ger inget påfyllningsförslag och står som "Saldo okänt" (antal platser i sidhuvudet, med
   knappen "Koppla Awish" till Datakällor). Samma regel (`isKnownStock` i `src/server/data/core/queries.ts`)
   gäller Att göra, Drift (besöksplanen och maskinhälsan), larmen, Automater, inköpsförslagen och assistenten:
   bara platser med känt saldo räknas.

**Exempel.** Facken A1 (3 st) och A2 (2 st) har "Surging Sparks", saldot i Binderlab är −2 (två order, aldrig
inventerat): inventering 5 från Awish, saldot blir 5. Nästa läsning med A1 = 1: inventering 3. En order efter
läsningen drar 1 (saldo 2) tills nästa läsning.

### Vårt lager (centrallagret)

Vårt eget lager har en egen flik, **Vårt lager** (`/vart-lager`, ägare, admin och läsare; ägare och admin skriver).
Blocket under Prognos & inköp, "Vårt lager & beställ", finns kvar och länkar dit.

| Tal               | Formel                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Antal hemma       | centrallagrets saldo (senaste inventering + händelser efter den). Att skriva antalet = en inventering      |
| + Inköp           | en `receipt`-händelse med det antal som kom hem                                                            |
| I automater       | Σ automaternas kända saldon för titeln (Awish eller inventering), en plats under 0 räknas som 0            |
| Sålt 7 d          | sålda pack de senaste 7 dagarna t.o.m. i dag, alla automater                                               |
| Räcker            | samma som Prognos & inköp: antal hemma / alla automaters takt (14 hela dagar t.o.m. i går), hela dagar     |
| Tar slut inom 7 d | status Kritisk eller Låg: slut och behövs, räcker inte till veckans besök, eller räcker kortare än 7 dagar |
| Värde, inköpspris | Σ max(0, antal hemma) × inköpspriset som gäller i dag (öre). Titlar utan pris räknas inte (visas)          |

**Påfyllning dras automatiskt (Awish).** När Awish-synken läser en automat som redan har lästs förut och en titel
som har ett räknat saldo där har **fler** pack än saldot, är ökningen en påfyllning från vårt lager:

    uttag = Awish antal − max(0, saldot i automaten)      (bara om > 0)

Uttaget skrivs i samma transaktion som inventeringen, som en `adjustment` med negativt antal, `source = 'awish'`
och noteringen "Awish-påfyllning <kod> <butik>". Aldrig vid automatens första läsning, aldrig för en titel som
inte har räknats i automaten än, aldrig vid minskning (försäljning) eller samma antal. En påfyllning som redan
registrerats i appen från vårt lager har höjt saldot, så Awish visar samma antal och uttaget blir 0. Varje
automat räknas för sig. Vårt lager får bli negativt (det är det verkliga värdet för bokföringen): raden visas då
med "Räkna om".

**Synken före Klar.** Registreras påfyllningen i appen först EFTER att synken dragit den (påfyllaren fyller,
synken går, sedan trycks Klar, eller kön skickas senare) räknar `register_refill` av: Awish-uttag för samma
automat och titel som sparades före påfyllningen, inte redan använts och gjordes från 30 minuter före till
2 timmar efter påfyllningens tid täcker den först. Från vårt lager dras bara resten; utan uttag läggs det Awish
drog tillbaka ("Återfört Awish-uttag <kod>"). Migreringen `20261104202000_vart_lager_avrakning_awish.sql`.
Begränsning: två påfyllningar av samma titel i samma automat inom 30 minuter, där bara den andra registreras i
appen, räknas som en.

**Exempel.** 40 Surging Sparks hemma. Sega gubben (BL-001) hade 3, Awish visar 15: uttag 12, hemma 28. Nästa
läsning 11 (fyra sålda): inget. Påfyllaren registrerar +5 i appen (hemma 23, automaten 16), Awish visar 16:
inget uttag.

### Flera egna lager (Hemma, Kontoret …)

Vårt lager kan bestå av flera egna lager (`stock_locations` med `kind = 'warehouse'`). Migreringen
`20261104210000_flera_lager.sql`. Ägare och admin skapar, byter namn på och tar bort lager i Vårt lager
("+ Nytt lager", "Ändra"). Det första lagret heter Hemma (ett ensamt lager med ett allmänt namn som
"Centrallager" döptes om; historiken är orörd). `is_central` är **standardlagret**: det som används när inget
annat är valt (inleverans från en beställning, påfyllning utan val, automat utan eget val).

| Tal / regel           | Formel                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Vårt lager (överallt) | Σ över alla egna lager per titel (Prognos & inköp, besöksplanen, Att göra, dagar kvar, AI, värdet)    |
| Antal i ett lager     | lagrets saldo; att skriva antalet = en inventering i det valda lagret ("Alla": sidan frågar vilket)   |
| Flytta                | `transfer_out` (−n) i det ena och `transfer_in` (+n) i det andra, samma `transfer_group_id`; summan   |
|                       | oförändrad. Aldrig fler än det finns i lagret man flyttar från. Ångra = samma antal tillbaka, en gång |
| Ta bort ett lager     | bara när alla titlar har 0 pack där; det sista lagret kan inte tas bort; Ångra tar tillbaka det       |
| Fylls på från         | automatens lager (`stock_locations.refill_source_id`), annars standardlagret                          |

**Påfyllning.** I Fyll på och Påfyllning väljs lagret med "Från: Hemma ▾" (standard: automatens "Fylls på
från", annars det användaren valde sist, annars standardlagret). `register_refill` drar ur det valda lagret
(`p_from_location`), annars automatens lager. **Awish** drar en påfyllning ur automatens "Fylls på från".
Registreras samma påfyllning sedan i appen från ett annat lager läggs Awish-uttaget tillbaka i det lager det
drogs ur och hela antalet dras ur det valda: packen dras aldrig två gånger. Alla uttag ur egna lager för en
titel tar samma lås (`private.lock_own_stock`).

## 9. Enhetsekonomi per automat

| Post                    | Formel                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Vinst                   | automatens vinst i perioden (efter VMB-moms med vyknappen; samma som i vyn per automat)                         |
| Aktiva månader          | Σ per kalendermånad (dagar då automaten var placerad / dagar i månaden). En hel månad = 1, 15 av 30 dagar = 0,5 |
| Vinst per månad         | round(vinst / aktiva månader)                                                                                   |
| Avskrivning per månad   | round(investering / avskrivningstid i månader), linjärt                                                         |
| Ackumulerad avskrivning | round(investering × hela månader sedan investeringen / avskrivningstid), högst hela beloppet                    |
| Bokfört värde           | investering − ackumulerad avskrivning                                                                           |
| Återbetalningstid       | investering / vinst per månad, i månader med en decimal; visas inte om vinsten per månad är ≤ 0                 |

Ej fördelad hyra ingår inte i automatens vinst (den hör inte till någon automat). Det gäller även hyran på automatens order utan pris, eftersom de orderna inte heller räknas in i automatens intäkt.

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

## 12. Det som inte ingår (i version 1.3.0)

- Moms på hyra och provision (butikens faktura) räknas inte. Försäljningens moms: utan VMB som standard; med VMB när "VMB i bokföringen" är på (avsnitt 5 och Bokföringen); den ingående momsen på övriga kostnader hanteras i bokföringen.
- Kortavgiften räknas på alla order oavsett betalsätt (den är 0 i dag). Vinstdelningen använder samma modellerade avgift, inte de verkliga avgifterna från utbetalningsfilerna.
- Svinn, lagerjusteringar och frakt ingår inte i inköpet; inköp = inköpspris × antal sålda pack.
- Avskrivningar och investeringar ingår inte i vinsten i lönsamhetsvyerna, bara i enhetsekonomin.

## 13. Ändringar

| Version | Ändring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.3.0   | Allt räknas utan VMB som standard; knapp för att slå på. Vyknappen "Med VMB" (standard av): på drar VMB-momsen, samlad per kalendermånad med underskott som förs vidare inom perioden, som egen post från vår vinst i alla vyer, vattenfallet och nyckeltalen (avsnitt 5). Avtalets val "Dra av VMB-moms före delning" (standard av, även befintliga avtal). Bokföringens knapp "VMB i bokföringen" (standard av). En gemensam uträkning för Bokföringen, butiksavräkningen och vår vinst (`src/domain/vmb.ts`). |
| 1.2.0   | Vinstdelning: avtal med underlaget `profit_after_costs` ger butiken en andel av vinsten efter VMB-moms, inköp och kortavgifter, per butik och månad (avsnitt 4). Förlusthantering `zero` (standard) eller `proportional`. Provision på försäljningen räknas som förut.                                                                                                                                                                                                                                           |
| 1.1.0   | Hyran på order utan inköpspris dras från vinsten som ej fördelad hyra (tidigare låg den utanför vinsten, så att en saknad inköpspris kunde göra vinsten bättre). Totalen ändras bara när det finns order utan pris i butiker med hyra.                                                                                                                                                                                                                                                                           |
| 1.1.0   | Hyran fördelas efter netto × den månadshyra som gällde orderns dag. Order på dagar utan hyresavtal bär ingen hyra. Hyran per butik och månad och totalen ändras inte, bara fördelningen mellan raderna när avtalet byts mitt i månaden.                                                                                                                                                                                                                                                                          |
| 1.0.0   | Första versionen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 14. Återbetalningar från kundärenden (`src/domain/refunds.ts`)

Ett kundärende (sidan Inkorg) kan ha ett återbetalt belopp i öre och en återbetalningsdag.
Återbetalningen räknas som en **separat justering** av lönsamheten, inte som en del av
`profitability()`:

> vinst efter återbetalningar = vinst − återbetalt
>
> marginal efter återbetalningar = round(vinst efter återbetalningar × 10 000 / intäkt) bp

- Återbetalningen räknas på **återbetalningsdagen** (affärsdatum), på ärendets automat och
  titel. För butik gäller placeringen den dagen. Bara belopp större än 0 räknas.
- Intäkt, inköp, avgifter och butiksersättning **ändras inte**: ordern är betald och
  importerad, och provisionen räknas på det betalda beloppet enligt avtalet. Därför är
  `profitability()`, `CALC_VERSION` (1.1.0) och alla befintliga totaler oförändrade, och
  alla befintliga tester gäller.
- `applyRefunds(rader, återbetalningar, period, gruppering)` lägger justeringen på
  lönsamhetsrader med samma nycklar (automat, titel, butik eller total). En återbetalning vars
  nyckel saknar rad (t.ex. en automat utan försäljning i perioden) får en egen rad med intäkt
  och vinst 0, så att summan av justeringarna alltid är lika med alla återbetalningar i
  perioden. Ärenden utan automat, titel eller placering hamnar på nyckeln `none`.
- En återbetalning i en stängd månad kan inte läggas till, ändras eller flyttas (databasen,
  BL004), precis som inköpspriser och lagerhändelser.

**Exempel.** Avsnitt 3: intäkt 30 400 öre och vinst 7 660 öre i oktober. En kund fick inget
pack och fick 49,00 kr tillbaka 20 okt.: vinst efter återbetalningar 7 660 − 4 900 = **2 760
öre**, marginal 2 760 / 30 400 = 9,08 % (908 bp). Testerna finns i `src/domain/refunds.test.ts`.

Sidan Lönsamhet visar justeringen som en egen rad under vattenfallet, se avsnitt 17.

## 15. Maskinhälsa: tystnad och importerad försäljning (`src/analytics/health`)

Misstänkt fel härleds ur försäljningen så länge leverantörens maskindata saknas: en automat är
misstänkt fel när sannolikheten för noll försäljning under tystnaden är under 1 % (Poisson,
samma veckodag och timme de senaste 8 veckorna, minst 20 order).

Tystnaden räknas **från senaste försäljning till senaste importerade försäljning i automatens
datakälla**, inte till nu:

> tystnadens slut = min(nu, täckning) där täckning = `sales_data_until.data_until`

- Awish CSV (uppladdning för hand): täckningen är den senaste ordern i källan, i någon automat.
  Filen innehåller all försäljning fram till exporten, så den senaste ordern är en säker undre
  gräns. En automat som är tyst medan andra automater i samma fil säljer larmar alltså; alla
  automater i en källa larmar inte bara för att dagens fil inte är uppladdad.
- Automatiska källor (gRPC): täckningen är senaste hämtningen (eller ordern, om den är senare).
- Automater utan order de senaste 70 dagarna får organisationens senaste täckning.
- Tystnaden börjar vid automatens senaste order oavsett titel (`last_order_at`): en order vars
  titel inte matchats finns inte bland lagrets försäljningshändelser, men automaten har sålt.
- När täckningen slutar före nu står det i förklaringen: "Försäljningen från … är importerad
  till och med …; tystnaden är bedömd fram till dit."

Datat självt bedöms av importregeln: är den senaste försäljningen från en CSV-källa äldre än
36 timmar blir det ett datalarm (`import_failed`, varning) "Försäljningen från … är inte
importerad sedan …". Avvikande dag (i går) bedöms bara när varje källa har försäljning eller en
lyckad import efter midnatt i dag.

Begränsning: en organisation med en enda automat i en CSV-källa kan inte skilja en tyst
automat från en fil utan ny försäljning; där fångar datalarmet efter 36 timmar problemet.
Testerna finns i `src/analytics/health/coverage.test.ts` och `test/db/drift-alerts.test.ts`.

## 16. Att göra (`src/analytics/todos`)

Att göra räknas om vid varje sidvisning ur order, lager, priser, rapporter, avtal och larm.
Varje punkt har en stabil nyckel (samma orsak ger samma nyckel) och ett fingerprint
(orsakens tillstånd). En avbockning gäller så länge fingerprintet är oförändrat.

| Punkt              | Regel                                                                                                                        | Nivå                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Påfyllning         | Lagret räcker under **2,5 dagar** vid snittförsäljningen de **14** senaste hela dagarna (t.o.m. i går)                       | nu under 1 dag, annars snart                       |
| Tyst automat       | Ingen försäljning på **48 timmar**, räknat fram till importens slut som på Drift (`salesDataUntil`)                          | nu                                                 |
| Larm               | Öppet, okvitterat larm om automat (fel, misstänkt fel, ur drift) eller import; inte "titel nära slut" (= påfyllning)         | kritiskt: nu, varning: snart                       |
| Rapportutkast      | Utkast (senaste versionen, inte godkänd, inte skickad), en punkt per rapportmånad                                            | som utskicket                                      |
| Rapport att skicka | Förra månadens rapport till varje aktiv mottagare, senast månadens sista dag                                                 | försenad: nu, 0–3 dagar kvar: snart, annars senare |
| Avtal              | Påminnelse **90 dagar** före sista uppsägningsdag (`contractReminders`, samma som sidan Avtal); uppsagt eller utgånget avtal | ≤ 7 dagar: nu, ≤ 30 dagar: snart, annars senare    |
| Saknat inköpspris  | Titel med försäljning de senaste **30** dagarna utan inköpspris                                                              | minst 10 % av intäkten: snart, annars senare       |
| Möjlig dubblett    | Två titlar med nästan samma namn                                                                                             | senare                                             |

**Belopp i risk** ("I risk 7 d") är bara påfyllning och tysta automater: intäkt per dag ×
(7 − dagar som lagret räcker). En titel utan inköpspris säljer som vanligt (bara vinsten blir
ofullständig) och räknas inte dit.

**Ordning.** Nivån väger alltid tyngst (nu, snart, senare). Inom en nivå sorteras punkterna
efter brådskevärdet:

> brådska = nivå × 10¹² + kronor i risk de närmaste 7 dagarna + förlorad intäkt (öre)

Förlorad intäkt är `@/analytics/lost-sales` för titeln i automaten de senaste 14 hela dagarna
(samma som Prognos visar). Den ändrar bara ordningen och underlaget ("Förlorat 14 d"), inte
nivån och inte "I risk 7 d", så att samma intäkt aldrig räknas två gånger. Menyns räknare och
listan har alltid samma punkter.

**Utgångna titlar.** En titel som har gått ur sortimentet i en automat (alla perioder i
`machine_slots` har slutat och ingen börjar senare, läst via `lager_slot_periods`) fylls inte på
utan säljs ut. Den ger ingen påfyllningspunkt, räknas inte i menyns räknare och planeras inte i
besöksplanen. Regeln är en (`@/analytics/todos/assortment`) och gäller Lager, Drift och Att göra.

**Dagar med tiondelar.** Att göra visar "räcker 0,4 d" med en decimal eftersom gränsen är
2,5 dagar; lagerprognosen (avsnitt 8) visar hela dagar till slutdatum.

**Avbockade.** Listan "Avbockade" visar bara punkter vars orsak finns kvar (punkten skulle stå
i listan utan avbockningen). En avbockning vars orsak är löst döljer inget och visas inte.

**Larm och tyst automat.** Ett öppet larm om en automat som redan står som tyst automat blir
ingen egen punkt (samma orsak). Det avgörs innan avbockningarna tas bort: bockar ägaren av
punkten för den tysta automaten döljs också larmet för automaten i Att göra, tills automaten
säljer igen eller punkten får ett nytt fingerprint. Larmet syns fortfarande på Drift.

**Samma takt överallt.** Påfyllningspunkten, larmet "Titel nära slut" på Drift, matrisen på
Lager och besöksplanen räknar takten på de 14 hela dagarna t.o.m. i går och slutdatumet som
`stockoutDate(i går, saldo, takt)`. Saldot är dagens. Besöksplanen (`weeklyVisitPlan`, samma
för Lager, Drift och Besöksplan) drar försäljning från saldot bara för dagarna från i dag till
besöket, så ett besök i dag får samma packlista som Lagers påfyllningslista.

**Filter.** Hem och Att göra filtrerar med samma regel (`todoInScope`): punkter med automater
följer automaten (och butiken den står i), punkter om en butik (avtal, rapport till butiken)
följer butiken, med bara automatfilter automatens butik. Övriga punkter gäller hela
organisationen.

**Länken till ett rapportutkast** pekar ut det första utkastet för månaden (typ och butik i
adressen), så att Rapporter öppnar just det utkastet i granskningen. Övriga utkast för månaden
står i arkivet på samma sida.

Testerna finns i `src/analytics/todos/*.test.ts` (bland annat `integration.test.ts` för avtal,
utkast, larm och förlorad försäljning) och `test/db/integration-fas7.test.ts`.

## 17. Lönsamhet efter vinsten: återbetalningar och fasta kostnader

Under vattenfallet visar Lönsamhet två avdrag som egna rader. Vattenfallet, tabellerna och
nyckeltalen ändras inte.

> vinst efter återbetalningar = vinst − återbetalningar (avsnitt 14)
>
> resultat = vinst efter återbetalningar − fasta kostnader i perioden

- **Fasta kostnader** (`fixed_costs`, sidan Ekonomi) periodiseras över de dagar de gäller och
  fördelas med `profitabilityWithFixedCosts` (`@/analytics/cashflow`): gemensamma kostnader
  efter nettointäkt per automat (alla order, även utan inköpspris), kostnader för en viss
  automat på den automaten.
- **Automatfilter:** automatens återbetalningar och automatens del av fördelningen, räknad på
  hela organisationen (annars skulle automaten bära alla gemensamma kostnader). Automaten går
  före butiken när båda står i adressen (filtret i skalet lägger alltid till automatens butik).
- **Butiksfilter:** butikens återbetalningar (placeringen på återbetalningsdagen). Fasta
  kostnader fördelas per automat, inte per butik, och visas inte med butiksfilter.
- Per automat summerar vinst, återbetalningar, fasta kostnader och resultat till totalen
  (testas i `src/app/(app)/lonsamhet/_lib/result.test.ts`).

**Vinst på Hem.** Hem visar vinsten (efter VMB-moms med vyknappen) men före återbetalningar och fasta kostnader
("Vinst före fasta kostnader"), samma som raden "Vinst" här och vattenfallets slut. Resultatet efter fasta
kostnader finns här och på Ekonomi.

**Exempel.** Två automater, moms och kortavgift 0, provision 10 %: m1 vinst 300 kr, m2 150 kr.
Återbetalt 40 kr (m1) och 25 kr (m2). Försäkring 300 kr/mån gemensam, service 90 kr/mån på m2.
Vinst 450 − återbetalningar 65 = 385 kr; fasta kostnader 300 (fördelas 200 + 100 efter
intäkten 1 000 : 500) + 90 = 390 kr; resultat **−5 kr**.

**Var reglerna står i koden.** Gränserna är standardvärden i `TODO_DEFAULTS`
(`src/analytics/todos/context.ts`): `refillWindowDays: 14`, `refillThresholdCentidays: 250` (2,5 dagar i
hundradelar), `staleHours: 48`, `unpricedWindowDays: 30` och `contractReminderDays` = 90 (`CONTRACT_DEFAULTS`
i `src/analytics/contracts/contracts.ts`). Horisonten för "I risk 7 d" är `HORIZON_DAYS = 7`. Reglerna per
punkt: `refill.ts` (påfyllning), `stale-machine.ts` (tyst automat, intäkt per dag de 14 dagarna t.o.m. senaste
försäljningsdag × 7), `missing-price.ts` (andel ≥ `MISSING_PRICE_SOON_BP` = 10 % ger "snart"; kronor i
risk = intäkt utan pris × 7 / 30, räknas inte in i "I risk 7 d"), `contracts.ts` (`CONTRACT_NOW_DAYS = 7`,
`CONTRACT_SOON_DAYS = 30`), `reports.ts` (`REPORT_SOON_DAYS = 3`) och `alerts.ts`.

## 18. Förlorad försäljning (`src/analytics/lost-sales`)

Hur mycket intäkt som uteblev för att en titel var slutsåld i en automat. Visas på Prognos & inköp, på Hem
("Slutsålt kostade ca … i oktober", via `lostSalesSummary` i `src/server/purchasing/lost-sales-summary.ts`) och
som ordning och underlag ("Förlorat 14 d") i Att göra.

Per titel × automat och dag:

| Läge                                                              | Bedömning                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Saldo > 0 vid dagens början                                       | fanns                                                                        |
| Saldo ≤ 0 vid dagens början, ingen påfyllning under dagen         | slutsåld hela dagen                                                          |
| Saldo ≤ 0 vid dagens början, påfylld under dagen                  | påfyllningsdag, räknas som en halv slutsåld dag (`refillDayShareBp` = 5 000) |
| Saldo ≤ 0 men order samma dag                                     | fanns (lagret saknar en registrering); dagen listas som avvikelse            |
| Dagen då sista packet säljs                                       | räknas inte (försiktigt)                                                     |
| Saldot okänt (före första inventering eller efter negativt saldo) | heuristik, se nedan                                                          |

- **Saldot** räknas ur lagerhändelserna som vyn `stock_levels`: senaste inventering plus alla händelser efter den
  (`stock.ts`, `replayStockDaily`).
- **Heuristik när saldot är okänt:** minst 2 dagar i rad utan försäljning av titeln, där takten före säger minst
  3 pack (då är chansen under 5 % att det blir 0 av en slump), och automaten sålde andra titlar minst hälften av
  dagarna. Takten måste bygga på minst 7 dagar med data. Kostnaden för dessa dagar redovisas också separat
  (`heuristicLostRevenueOre`).
- **Takt före** = sålda pack / dagar med data de 28 dagarna före periodens första dag (`rateWindowDays`);
  slutsålda dagar räknas inte.
- **Kostnad** = takt × slutsålda dagar (viktade) × snittpris exkl. moms, avrundat en gång per period.
  Bruttoresultat = kostnaden − takt × dagar × inköpspriset som gällde periodens första dag.
- **Långa perioder:** efter 28 slutsålda dagar i rad (`maxOpenDays`) antas titeln vara borttagen ur sortimentet,
  och dagarna därefter kostar inget.
- **Per månad:** periodens kostnad fördelas på månaderna efter slutsålda dagar med största-restmetoden, så att
  månaderna summerar exakt till totalen.

- **Ordning inom dagen:** händelserna ordnas på tidpunkt, sedan `seq`, som vyn `stock_levels`. Tidpunkten måste
  vara ISO 8601: `queryMachineStockEvents` formaterar den i databasen (`to_char … 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`),
  som `queryOrders`. Med Postgres textformat ordnades händelserna bara på `seq` och förlorad försäljning blev för låg
  (rättat i fas 7, `test/db/prestanda.test.ts`).
- **Titeldagar:** summan av slutsålda dagar över alla titlar och automater. En titel slutsåld i två automater samma
  dag är två titeldagar, så totalen kan bli fler än periodens dagar. Perioder som varken kostar dagar eller kronor i
  analysperioden (titlar som togs ur sortimentet före den) räknas inte i texten och visas inte på Prognos.

Standardvärdena står i `LOST_SALES_DEFAULTS` (`lost-sales.ts`). Testerna: `lost-sales.test.ts`.

## 19. Prognos (`src/analytics/forecast`)

Försäljningsprognos per titel × automat för de kommande 4 veckorna (`FORECAST_DEFAULTS.horizonDays = 28`), med
osäkerhetsintervall och träffsäkerhet. Allt räknas i heltal (tusendelar av pack, bp), så samma historik ger alltid
exakt samma prognos.

1. **Historik:** 8 veckor t.o.m. `asOf` (`historyWeeks`). Bara dagar då titeln gick att köpa räknas: automaten i
   drift, serien har startat och dagen är inte slutsåld enligt avsnitt 18 (`stockoutUnavailableDays` i
   `lost-sales/unavailable.ts`). En slutsåld dag är alltså inte efterfrågan 0. En serie startar vid första kända
   saldo över 0 i lagret, tidigast vid första ordern i datan (`src/server/purchasing/series-start.ts`).
2. **Veckodagsfaktorer:** takten per veckodag delat med snittakten, krympt mot 1,0 med 2 "snittdagar" per veckodag
   (`weekdayPriorDays`) och skalade så att snittet är exakt 1,0.
3. **Nivå:** viktat glidande medel av veckorna (vikt 1 för den äldsta, 8 för den senaste) på veckodagsjusterade dagar.
4. **Trend:** takten i senare halvan minus den tidigare, per vecka. Räknas bara när båda halvorna har minst 7 dagar
   och 10 pack, och är begränsad till ±30 % av nivån (`maxTrendBp = 3 000`).
5. **Prognos för dag h** = (nivå + trend × tid sedan nivåns medelpunkt) × veckodagsfaktor, minst 0.
6. **Intäkt** = antal × snittpris exkl. moms de senaste 28 dagarna (seriens, annars titelns i alla automater),
   avrundat per dag.
7. **Intervall (80 %):** summan ± z × √varians med z = 1,282. Dagsvariansen är den största av backtestens
   residualvarians och prognosen själv (Poisson-golv). För k dagar är variansen k × dagsvariansen; serier summeras
   som oberoende.
8. **Träffsäkerhet** (`backtest.ts`): 6 rullande ursprung à 7 dagar, en vecka isär. WAPE = Σ|prognos − utfall| /
   Σ utfall, MAPE per vecka, bias (positiv = för hög) och jämförelse med att gissa snittet de 7 dagarna före.
   Sidan visar WAPE som "fel/dag".

Testerna: `forecast.test.ts` och `purity.test.ts` (samma resultat i tre tidszoner).

## 20. Inköpsplan och lagervärde (`src/analytics/purchasing`)

Periodisk beställning: en order kan läggas var 7:e dag (`reviewPeriodDays`), med servicenivå 95 %
(`serviceLevelBp = 9 500`, z = 1,645) och standardledtid 7 dagar (`PURCHASING_DEFAULTS` i `plan.ts`).

1. **Leverantör:** titelns leverantörsartikel med lägst pris per pack, sedan kortast ledtid. Ledtid = artikelns,
   annars leverantörens standard, annars 7 dagar.
2. **Behov** = prognosen (avsnitt 19, summerad per titel över automaterna, `demandFromForecast`) dag för dag under
   ledtid + intervall, plus säkerhetslager.
3. **Säkerhetslager** = z × √((ledtid + intervall) × dagsvarians), med prognosens dagsvarians.
4. **Lagerposition** = centrallager + lager i automater + beställt som väntas inom ledtid + intervall. Negativa
   saldon räknas som 0. Utkast räknas inte som beställt (`includeDraftOrders: false`).
5. **Antal:** saknade pack avrundade uppåt → minst minsta order → uppåt till hela boxar. Saknas 13,2 pack med
   minsta order 24 och box 12 blir det 24; saknas 25 blir det 36.
6. **Täckning:** dagar som lagerpositionen räcker; senaste beställningsdag = väntat slut − ledtid. Tar lagret slut
   före leverans även vid beställning i dag är raden sen.

**Lagervärde** (`valuation.ts`): (centrallager + automater) × det inköpspris som gäller i dag, annars
leverantörsartikelns pris; titlar utan båda räknas som 0 och listas. Kapitalbindning = lagervärde + kvar att ta emot
på öppna inköpsorder × radens pris. Testerna: `purchasing.test.ts`, `test/db/prognos-inkop.test.ts`.

## 21. Avstämning mot utbetalningar (`src/analytics/reconciliation`)

Per utbetalning från leverantören, med perioden i affärsdagar i datakällans tidszon:

> väntad utbetalning = försäljning − avgifter − återbetalningar
>
> skillnad = utbetalt − väntad utbetalning

- **Försäljning** = betalt belopp för våra order med affärsdatum i perioden. En dag som redan täcks av en tidigare
  utbetalning räknas bara där.
- **Avgifter** = Σ round(belopp × avgift / 10 000) + fast avgift per order (domänens `cardFees`; båda är 0 i dag).
- **Återbetalningar** = kundärendenas `refunded_ore` med `refunded_on` i perioden.
- **Uppdelning:** skillnaden delas upp i avvikelser som summerar exakt till den: dubbletter i vår import, sedan (med
  leverantörens specifikation per order) dubbel utbetalning, beloppsavvikelse, tidszon, annan period och saknade
  order; utan specifikation tidszon för order nära midnatt (bara om det minskar skillnaden, märkt som slutsats),
  överlappande perioder och saknade order om resten är exakt ett antal order à ett vanligt pris. Avgiftsavvikelse
  och rest inom toleransen (standard 0 öre) är avrundning; resten är oförklarad.
- **Utredd avvikelse:** servern räknar om avvikelsen och sparar sitt eget fingerprint i `deviation_reviews`.
  Ändras avvikelsen gäller inte utredningen längre.

Testerna: `reconcile.test.ts`, `common.test.ts`, `test/db/ekonomi.test.ts`.

## 22. Kassaflöde och fasta kostnader (`src/analytics/cashflow`)

Per månad eller vecka, faktiskt (datum ≤ i dag) och prognos (datum > i dag). In: utbetalningar. Ut: inköp,
butiksersättning och fasta kostnader.

- **Utbetalningar:** faktiska på `paid_on`. Väntade följer rytmen och fördröjningen i de registrerade
  utbetalningarna (med färre än två antas en per månad): känd försäljning + snittet de senaste 28 dagarna
  (`forecastWindowDays`) × dagar kvar − avgifter, avrundat en gång per period. En passerad utbetalningsdag utan
  registrerad utbetalning läggs som försenad dagen efter i dag. **Utan källa för utbetalningar** (ingen inläst
  utbetalning och ingen uppladdad utbetalningsfil, `queryHasPayoutSource`; Awish-utbetalningarna importeras inte
  automatiskt) är en passerad utbetalning okänd, inte försenad: den läggs inte in (`payoutsTracked: false`), bara
  kommande prognostiseras. Ekonomis rubrik visar då bara en neutral rad ("Utbetalningarna från Awish är inte inlästa.
  Ladda upp dem som CSV för att stämma av.") och ingen väntad eller saknad utbetalning.
- **Butiksersättning** för månad M = provision (`storeCompensation`) + hyra (`rentByStoreMonth`), betald månad
  M + 1 (`storeCompensationLagMonths`). Faktiska butiksbetalningar ersätter den beräknade ersättningen för sin
  butik och månad.
- **Inköp:** betalda på sitt datum; planerade som prognos (en delvis mottagen inköpsorder delas i mottaget och rest)
  plus påfyllnad av lagret i försäljningstakt.
- **Fasta kostnader** (`fixed-costs.ts`): betalas i förskott på startdagen och sedan var 1, 3 eller 12 månad på
  samma dag (kapad till månadens sista dag; 31 jan → 28 feb → 31 mars). Varje betalning periodiseras på de dagar
  den avser: round(belopp × dagar i perioden / dagar betalningen avser). I lönsamheten bärs kostnader med automat av
  den automaten och övriga fördelas efter nettointäkt med största-restmetoden (avsnitt 17).

Begränsning: kassaflödet tar inte emot kända återbetalningar som egen post (faktiska utbetalningar är redan netto).
Testerna: `cashflow.test.ts`, `fixed-costs.test.ts`.

## 23. Enhetsekonomi sida vid sida (`src/analytics/expansion/unit-economics-compare.ts`)

Bygger på domänens `unitEconomics` (avsnitt 9) och lägger till, per automat:

| Post              | Formel                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Intäkt per dag    | round(intäkt för prissatta order / aktiva dagar)                                           |
| Vinst per dag     | round(vinst före avskrivning / aktiva dagar)                                               |
| Flottans snitt    | Σ vinst / Σ aktiva dagar (viktat efter automatdagar)                                       |
| Mot snitt         | round((automatens − snittet) × 10 000 / \|snittet\|) bp                                    |
| Avkastning per år | vinst per månad × 12 / investering, bp (`annualReturnBp`); visas inte utan investering     |
| Rang              | efter vinst per dag, 1 = bäst; lika → lägst id; automater utan aktiva dagar får ingen rang |

Aktiva månader räknas exakt som bråk med gemensam nämnare 377 580 (`MONTH_LCM`, minsta gemensamma multipel av 28–31),
så en hel kalendermånad är exakt 1. Sidan Enhetsekonomi och Expansion räknar från första ordern när skalets period
börjar tidigare.

## 24. Expansion: uppskattning för en ny plats (`src/analytics/expansion`)

1. **Likhet** (`similarity.ts`): butikstyp 40 %, ort 25 %, öppettimmar per vecka 20 % och yta 15 %
   (`DEFAULT_SIMILARITY_WEIGHTS`). Typ och ort matchar 100 % eller 0; timmar och yta 100 % − |a − b| / max(a, b).
   Ett okänt värde ger 0 för attributet.
2. **Underlag** (`estimate.ts`, `SITE_ESTIMATE_DEFAULTS`): butiker med minst 28 automatdagar, högst 10 % av
   intäkten utan inköpspris och minst 60 % likhet; de 3 mest lika.
3. **Takt per plats:** vinst (efter VMB-moms med vyknappen) och intäkt per automatmånad med samma regel som enhetsekonomin. Anges
   villkor för den nya platsen ersätts platsens provision och hyra med dem; VMB-momsen på vår vinst är kvar.
4. **Förväntat värde** = snittet viktat efter likhet; intervallet = lägsta och högsta platsens takt.
5. **Återbetalningstid** = investering / vinst per månad i tiondels månader (bästa fallet från högsta vinsten, sämsta
   från lägsta; vinst ≤ 0 → återbetalas inte). Avkastning per år som i avsnitt 23.
6. Resultatet märks alltid "Uppskattning". Pipelinen (`pipeline.ts`) sorterar leads med uppskattning först, sedan
   kortast återbetalningstid, högst vinst per månad och id. Scenariot "ny automat" (`src/analytics/scenarios`)
   använder samma regler.

## 25. Effekt mot utgångsläget (`src/analytics/effect`)

| Mått                       | Enhet   | Bättre | Värde per månad                                       |
| -------------------------- | ------- | ------ | ----------------------------------------------------- |
| `profit_per_machine_month` | öre     | högre  | räknas: round(vinst × dagar i månaden / automatdagar) |
| `stockout_days_month`      | dagar   | lägre  | mätvärde (`effect_measurements`)                      |
| `refill_hours_month`       | minuter | lägre  | mätvärde                                              |
| `admin_hours_month`        | minuter | lägre  | mätvärde                                              |

- **Utgångsläget** (`baselines`) gäller en hel månad. En pågående månad jämförs med utgångsläge × dagar hittills /
  dagar i månaden.
- **Förbättring** = värde − utgångsläge (högre är bättre) eller utgångsläge − värde (lägre är bättre); i procent mot
  utgångsläget (visas inte när det är 0).
- **I kronor:** vinst = förbättring per automatmånad × automatmånader; tid = minuter × timkostnad / 60
  (`effect_settings.hourly_cost_ore`); slutsålda dagar = dagar × värde per dag (inställt, annars månadens vinst per
  automat och dag).
- Vinst per automat räknas från första ordern, så dagar utan data räknas inte som automatdagar.

Utan ett utgångsläge som beställaren själv registrerat finns ingen jämförelse att lita på; se `docs/product.md`.
Testerna: `effect.test.ts`, `test/db/expansion-service.test.ts`.

## 26. Skapa avtal: placeringsavtal från mallen (`src/reports/contract-pdf.ts`, `src/server/contracts`)

**Skapa avtal** (knappen överst på Avtal; från en butik eller en rad i pipelinen: `/avtal?skapa=store:{id}` eller `/avtal?skapa=lead:{id}`) tar två uppgifter, butik (eller plats i pipelinen) och startdag, och gör i en transaktion:

| Steg    | Vad                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Butik   | Vald butik, eller en ny butik från platsens uppgifter (namn, adress, kontakt, typ, ort). Platsen kopplas till butiken och flyttas till steget Avtal.                                                                                                                                        |
| Avtal   | `contracts`: "Placeringsavtal", gäller från startdagen tills vidare, uppsägningstid 1 månad, `template` = `placering-vinstdelning-v1`, status utkast.                                                                                                                                       |
| Villkor | `store_agreements` från startdagen tills vidare: `profit_after_costs`, `commission_bp` 5 000, `loss_treatment` `zero`, ingen hyra (villkor som skrivs om samma dag behåller sin hyra, och avtalet skriver ut den), kopplat till avtalet. Butiksrapporten räknar med det direkt (avsnitt 4). |
| Äldre   | Villkor som gäller tills vidare och började före startdagen avslutas dagen före. Villkor som börjar samma dag skrivs om. Villkor som börjar senare, eller har en egen slutdag efter startdagen, stoppar (ändras under Butiker).                                                             |
| PDF     | Mallen skrivs ut med Chromium (`renderHtml`) och sparas i bucketen `contracts` som avtalsfilen. Går det inte sparas avtalet ändå och skrivs ut från `/avtal/{id}/mall`.                                                                                                                     |

- **Ett avtal per butik.** Har butiken redan ett öppet avtal från mallen (inte arkiverat, inte uppsagt, tills vidare) stoppar klicket: "{butik} har redan ett avtal ({status}). Öppna det under Avtal."
- **Förval:** listan börjar med platser i steget Avtal eller Möte, sedan butiker utan avtal; butiker med avtal står sist med "(har avtal)". Har butiken öppna villkor som är andel av försäljningen föreslås deras startdag som "Gäller från", så att ett klick ("Skapa ändå") skriver om dem till vinstdelning bakåt.
- **Startdag före i dag** räknar om butikens ersättning bakåt och kräver ett extra klick ("Skapa ändå"). Stängda månader ändras inte (databasen stoppar).
- **Parter:** organisationens namn och organisationsnumret från Ekonomi → Bokföring (saknas det står en tom rad). Butikens namn, adress, kontakt, e-post och telefon; tomt blir en rad att fylla i.
- **Avtalets ersättning** står i klartext: Butiken får 50 % av vinsten, vinst = försäljning inklusive moms − inköpspris för sålda varor − kort- och betalningsavgifter, per kalendermånad (VMB-moms dras inte före delningen, standard; med avtalets val på står "− moms enligt vinstmarginalbeskattning (VMB)" i definitionen); negativ vinst ger 0 kr (förlusten förs inte vidare). Återbetalningar till kunder dras från försäljningen. Med `proportional` står i stället att butiken bär sin andel av förlusten den månaden (förs inte vidare). Hyra står bara med om villkoren har hyra.
- **Övriga villkor:** vi äger och sköter automat och varor (påfyllning, lager, service, kundärenden); butiken ger plats och el; rapport och utbetalning senast den 15 i månaden efter; vi försäkrar automat och varor, butiken ansvarar för skador den vållar, ingen ansvarar för indirekta skador; tills vidare med 1 månads uppsägning, omedelbar uppsägning vid väsentligt avtalsbrott som inte rättas inom 14 dagar, automaten hämtas inom 14 dagar.
- **Status:** utkast → skickat (`sent_at`, "Markera skickat") → signerat (`signed_at`, när den signerade kopian laddas upp eller "Signerat utan fil"). Avtal som registrerats för hand (`template` null) har ingen status.
- **Mallen är inte juridiskt granskad.** Dialogen säger det tills första avtalet är skapat: låt Talenom läsa den en gång. En ändrad mall får ett nytt namn (`-v2`), så att varje avtal visar vilken text det skapades med.

Testerna: `src/reports/contract-pdf.test.ts`, `src/server/contracts/plan.test.ts`, `test/db/avtal-mall.test.ts`.

## 27. Vad Binderlab gett dig (`src/analytics/value`, sidan `/varde` och månadsrapporten `/rapport/varde`)

Sidan visar för en kalendermånad (`?manad=ÅÅÅÅ-MM`, standard förra månaden) vad Binderlab gett ägaren, räknat ur data som redan finns. Allt är **försiktigt räknat**: när något är osäkert räknas det inte. Bara ägare och admin ser sidan, och bara den egna organisationens data (RLS). En pågående månad räknas till och med i går. Antagandena står på sidan under "Så räknas det" och i rapporten, och alla konstanter finns på ett ställe: `src/analytics/value/assumptions.ts`.

### Slutsålt undvikt (`refills.ts`)

Per automat och titel spelas lagerhändelserna upp i tidsordning (samma saldoregler som avsnitt 8 och förlorad försäljning).

| Begrepp              | Regel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Påfyllning i tid     | En påfyllning (`refill`) när saldot strax före var > 0. Saldo ≤ 0: **efter tomt**. Okänt saldo: räknas inte. Flera påfyllningar av samma titel i samma automat samma dag räknas som en.                                                                                                                                                                                                                                                                                                      |
| Räddade pack         | Efter en påfyllning i tid med saldot _S_ före: de pack som säljs efter påfyllningen utöver _S_ (de hade annars mött ett tomt fack). Bara de första **7 dagarna** från dagen facket hade blivit tomt räknas (`SAVED_SALES_MAX_DAYS`).                                                                                                                                                                                                                                                         |
| När räkningen slutar | Vid nästa inflöde (påfyllning, mottagning, flytt in), en positiv justering, en inventering som visar fler pack än väntat (en påfyllning som inte registrerats) eller en försäljning som gör saldot negativt (packet fanns inte enligt lagret och räknas inte). Räddade pack blir aldrig fler än påfyllningen. En andra påfyllning samma dag är samma besök: var facket tomt vid dagens första påfyllning räddar inte heller den andra något. Svinn ändrar inte _S_ (ger färre räddade pack). |
| Kronor               | Räddade pack × snittpriset utan moms för titeln i automaten (annars titelns snitt i alla automater). Pack utan snittpris räknas inte i kronor.                                                                                                                                                                                                                                                                                                                                               |
| Tomt kostade         | Förlorad försäljning när facket var tomt, exakt som avsnitt 18 (samma siffra som på Inköp).                                                                                                                                                                                                                                                                                                                                                                                                  |

**Vad siffran inte säger.** Slutsålt undvikt är försäljning utan moms, inte vinst, och gäller alla påfyllningar i tid, även de som hade gjorts utan Binderlab. Därför står det "påfyllning i tid räddade", inte "Binderlab räddade", i rubriken; sidan och rapporten säger samma sak under "Så räknas det".

**Exempel.** 10 pack inventerade 1 okt., ett pack säljs varje dag 1–20 okt. Påfyllning +10 den 9 okt. på morgonen: 2 pack kvar, alltså i tid. 9 och 10 okt. säljs de 2 som fanns; 11–17 okt. räknas som räddade (7 pack), 18–20 okt. räknas inte. 7 × 49 kr = 343 kr. Påfyllningen 25 okt. (0 kvar) är efter tomt. Andel i tid: 1 av 2 = 50 %.

### Tid sparad (`time.ts`, RPC `varde_automation_counts`)

Antal uppgifter i månaden × minuter per uppgift. Antalen räknas i databasen (organisationens tidszon):

| Uppgift                | Räknas som en gång                                                                                                                              | Minuter | I stället för att                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| Påfyllning registrerad | automat och dag med minst en påfyllning (`stock_events` kind `refill`)                                                                          | 5       | skriva upp påfyllningen och räkna lagret för hand   |
| Awish uppdaterad       | automat som Binderlab satte i Awish efter en påfyllning (`automation_log`)                                                                      | 3       | logga in på Awish och skriva in antal per fack      |
| Butiksavräkning        | butiksavräkning som räknats fram (`store_settlements`, skapad)                                                                                  | 20      | räkna ut butikens andel i Excel                     |
| Bokföringsunderlag     | bokföringspaket som skapats (`bookkeeping_packages`)                                                                                            | 60      | sammanställa försäljning och inköp till bokföringen |
| Larm skickat           | larm som gått iväg (`alert_deliveries` sent/partial), varje larm en gång oavsett antal mottagare och påminnelser, i månaden det först gick iväg | 5       | själv kolla om en automat står still                |
| Rapport till butik     | rapport som skickats (`report_deliveries` sent/delivered), varje rapport en gång oavsett antal mottagare                                        | 15      | ta fram och mejla siffror till butiken              |

Tiden blir kronor bara om ägaren angett en timkostnad (Effekt): round(minuter × timkostnad / 60). Awish-push loggas från och med denna version (`automation_log`, migreringen `20261111000000_varde.sql`); tidigare pushar räknas inte. Att larm och rapporter räknas en gång var kom med `20261111000100_varde_rakna_en_gang.sql`.

### Marginal och utveckling (`margin.ts`)

Samma regler som Lönsamhet och Inköpspriser (`profitabilityViews`):

- **Försäljning** = nettointäkt utan moms för order med inköpspris.
- **Kvar efter inköp** = försäljning − inköp − kortavgifter − VMB-moms: hela beloppet, **före** butikens andel (som "Kvar per order" på Inköpspriser).
- **Per butik** visas också butikens andel (provision + hyra) och vår del = kvar efter inköp − butikens andel. Butikens andel visas bara per butik.
- **Per automat** och **per månad** (sex månader bakåt). Order utan inköpspris ingår inte och anges separat.
- **Förändring** = changeBp(nu, månaden före). Pågår månaden jämförs samma dagar månaden före (1–10 nov. mot 1–10 okt.).

**Exempel.** 10 order à 49 kr i oktober med inköp 20 kr, provision 10 %: försäljning 490 kr, kvar efter inköp 290 kr, butikens andel 49 kr, vår del 241 kr. September 5 order: kvar 145 kr. Förändring +100 %.

### Bästa åtgärder (`actions.ts`)

Högst tre förslag, värderade i kronor per månad där det går:

| Förslag            | Villkor                                                                      | Värde                                    |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| Fyll på tidigare   | slutsålt kostade minst 50 kr i månaden för titeln i automaten                | förlorad försäljning i månaden           |
| Höj priset         | minst 3 prissatta order och negativt kvar efter inköp i månaden              | förlusten                                |
| Flytta titlar      | sortimentsrådet (Marknad) säger "ändra" för automaten, de senaste 28 dagarna | väntad effekt per vecka × 4              |
| Lägg in inköpspris | order utan inköpspris i månaden                                              | inget (vinsten går inte att räkna), sist |

Först väljs det bästa av varje sort (så att listan blir varierad), sedan fylls listan på efter värde.

Testerna: `src/analytics/value/value.test.ts`, `src/app/(app)/varde/_lib/view.test.ts`, `test/db/varde.test.ts`.
