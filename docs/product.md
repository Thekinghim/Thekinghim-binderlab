# Binderlab: vad panelen löser

## Problemet

En operatör med varuautomater för samlarkortspack (Pokémon med flera) har automater utställda i butiker. Butiken får
provision och ibland hyra. Automatleverantörens system (Awish) visar bara en orderlista. Allt annat görs för hand:
vad som sålt, vad som tjänades efter inköp och butikens ersättning, vilka automater som snart är tomma, vad butiken ska
ha i månaden, vad bokhållaren behöver och om en automat har slutat fungera.

Följden är att vinsten per automat inte är känd förrän i efterhand, att titlar tar slut innan någon märker det, att
månadsrapporterna tar tid och att det inte går att säga om en ny plats lönar sig.

## För vem

| Vem                 | Använder                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ägaren (operatören) | Hela panelen: Hem, Att göra, Lönsamhet, Prognos & inköp, Rapporter, Ekonomi, Expansion, Assistenten                                                                     |
| Delägare (läsare)   | Samma siffror utan att kunna ändra; delägarrapporten                                                                                                                    |
| Påfyllaren          | Lager, Att göra (bara påfyllning), fältläget i mobilen med besöksplan och packlista; ser aldrig belopp                                                                  |
| Butiken             | Butiksportalen: egen försäljning, ersättningen steg för steg, godkända månadsrapporter, felanmälan. Mest sålda titlar och snittköp bara med "Visa detaljer i rapporten" |
| Bokhållaren         | Bokföringsunderlag med SIE 4 och Excel, utbetalningar avstämda mot försäljningen                                                                                        |

## Vad panelen gör

- **Hem och Lönsamhet:** intäkt, vinst och marginal efter inköp och butiksersättning för valfri period, per titel,
  automat, butik, dag, vecka och månad. Order utan inköpspris räknas inte in i vinsten och pekas ut.
- **Att göra:** en lista som räknas om vid varje sidvisning: vilka titlar som tar slut inom 2,5 dagar, automater som
  inte sålt på 48 timmar, rapporter att godkänna och skicka, avtal att säga upp, titlar utan inköpspris. Varje punkt
  har sitt underlag och kronor i risk.
- **Prognos & inköp:** försäljningsprognos för fyra veckor med intervall och träffsäkerhet, förlorad försäljning när en
  titel var slutsåld, inköpsförslag i hela boxar och kapitalbindning.
- **Drift:** maskinhälsa härledd ur försäljningen, larm (e-post, push), besöksplan och påfyllning från mobilen, även
  utan nät.
- **Rapporter:** butiksrapport, bokföringsunderlag och delägarrapport varje månad som utkast, godkännande och utskick,
  med PDF, Excel och SIE 4.
  - **Butiksrapporten är kort som standard** (en A4-sida): rubriken med beloppet ("Er ersättning för oktober:
    7 493 kr."), nyckeltalen Försäljning, Sålda pack och Er ersättning, uträkningen (samma tabell som förut, bara
    summor), försäljning per vecka, butikens automater med dagar i butiken och raden "Underlag per titel finns på
    begäran." Butiken ska kunna räkna efter sin andel, men får inte försäljningen per titel, snittköp eller våra
    servicebesök utan att be om det. Rubriken säger inget utbetalningsdatum: rapportens underlag har inget.
    Upp till tre automater står bredvid veckodiagrammet, en rad per automat ("I butiken 31 av 31 dagar · 63 pack ·
    sålt för 4 047 kr"). Rapporten får plats på en sida också med den längsta uträkningen (vinstdelning med hyra
    och VMB-moms) och tre automater; med fler automater, eller tre automater och en hälsning på flera rader, blir
    den två sidor.
  - **Visa detaljer i rapporten** (Butiker → butiken → Kontakt och rapport; ägare och admin; standard av): på =
    den butikens rapport visar också titlarna och service (påfyllningsbesök, flest köp, snittköp), som förut. Sidan,
    PDF:en, mejlet, förhandsvisningen på Rapporter och butiksportalen följer samma val.
  - **Valet sparas i rapporten när den skapas.** En godkänd eller skickad rapport ändras inte när valet ändras. Ett
    utkast blir gammalt ("Rapporten har ändrats sedan utkastet skapades.") och godkänns som ny version. Rapporter
    från före valet fanns: godkända och skickade visas som de skickades (med detaljer), utkast enligt den nya
    standarden (skapa ny version för att godkänna).
- **Ekonomi och avtal:** avstämning av leverantörens utbetalningar mot försäljningen, verifikationer, kassaflöde, fasta
  kostnader, avtal med påminnelse före sista uppsägningsdag.
- **Enhetsekonomi och expansion:** vinst per automat och dag, återbetalningstid, och uppskattning för en ny plats från
  liknande befintliga.
- **Assistenten:** frågor på svenska som besvaras med panelens egna beräkningar, med kontroll av varje tal.

Hur varje siffra räknas står i `docs/berakningar.md`.

## Siffror ur panelen

Källa: en nyskapad databas efter `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo`, alltså exakt
snabbstarten i README. `db:seed` importerar verksamhetens riktiga försäljning 13 okt.–1 nov. 2026 genom samma import
som Datakällor (`src/seed/catalog.ts`, tre exempelbutiker och tre automater); demon ligger i en egen organisation och
påverkar inte siffrorna nedan. Siffrorna är hämtade 2 nov. 2026 kl. 16.33 från panelen inloggad som
`agare@binderlab.local` och kontrollerade mot SQL utan beräkningslagret (460 order och 79 987,00 kr). Vinsten 21 858 kr
(2 185 845 öre) stämmer med en fristående SQL-uträkning dag för dag och låses av
`test/db/consistency-revision.test.ts` (7 av 7 gröna 2 nov. 2026).

Intäkt, vinst, butiksersättning, vinst per automat och återbetalningstid gäller perioden "Allt" (13 okt.–2 nov.).
**Att göra, förlorad försäljning och prognosen räknas från dagens datum** (försäljningstakten de senaste 14 dagarna,
prognos för de kommande fyra veckorna), så samma databas ger andra tal en annan dag. Hem och Lönsamhet visar som
standard 30 dagar (4 okt.–2 nov.); då är vinsten 21 205 kr och marginalen 27,8 %, eftersom hyran räknas för alla
dagar i perioden (2 182 kr i stället för 1 529 kr), även dagarna före första ordern.

| Mått                                 | Värde                                                          | Var i panelen             |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------- |
| Intäkt 13 okt.–2 nov. (21 dagar)     | 79 987 kr, 460 order, snitt 174 kr per order                   | Hem                       |
| Vinst före fasta kostnader           | 21 858 kr, 28,7 % marginal på order med inköpspris             | Hem, Lönsamhet            |
| Butiksersättning                     | 7 090 kr (provision 5 561 kr, hyra 1 529 kr)                   | Lönsamhet                 |
| Intäkt utan inköpspris               | 3 825 kr (4,8 %, 25 order av två titlar), ingår inte i vinsten | Hem, Lönsamhet, Att göra  |
| Vinst per automat och dag            | 348 kr i snitt; 419, 381 och 245 kr för de tre automaterna     | Automater → Enhetsekonomi |
| Vinst per automat och månad, oktober | 10 701 kr (räknat från första ordern 13 okt.)                  | Effekt                    |
| Återbetalningstid                    | 3,3, 3,4 och 4,6 månader (investerat 117 200 kr)               | Automater → Enhetsekonomi |
| Att göra 2 nov.                      | 8 punkter: 6 påfyllningar och 2 titlar utan inköpspris         | Att göra, Hem             |
| Intäkt i risk de närmaste 7 dagarna  | 12 405 kr för de 6 påfyllningarna, 2 nov.                      | Att göra                  |
| Varav i dag                          | 6 368 kr: två titlar räcker 0,3 och 0,5 dagar, en är slut      | Att göra                  |
| Förlorad försäljning 4 okt.–1 nov.   | 0 kr: ingen titel var slutsåld enligt lagret och försäljningen | Prognos & inköp           |
| Prognos 2–29 nov.                    | ca 115 700 kr (80 %-intervall 105 400–125 900 kr), ca 664 pack | Prognos & inköp           |
| Prognosens träffsäkerhet             | 32 % fel per dag, prövat bakåt på veckor modellen inte sett    | Prognos & inköp           |
| Maskinhälsa                          | alla 3 automater i drift                                       | Drift                     |

Förbehåll:

- Perioden är tre veckor med tre automater. Det räcker för att visa att siffrorna stämmer, inte för att dra slutsatser
  om säsong eller trend.
- Investeringarna (39 900, 39 900 och 34 900 kr plus 2 500 kr installation) kommer från seeden och är inte bekräftade
  av beställaren. Återbetalningstiden beror helt på dem.
- Lagret i seeden (397 lagerhändelser) är planerat, inte inventerat: `src/seed/stock.ts` lägger en inventering 12 okt.,
  påfyllningar och en leverans 27 okt. kring de riktiga orderna, så att några par (automat, titel) med avsikt har 1–2
  pack kvar och ett är slut. Påfyllningarna i Att göra visar därför hur listan fungerar, inte vad som faktiskt står i
  automaterna.
- Utvecklingsdatabasen `binderlab_dev` på byggmaskinen ska inte användas för siffror eller skärmbilder. Under bygget
  lades testposter in där med ägarkontot: lagerhändelser (påfyllningar, inventeringar, inleveranser och justeringar
  utöver seedens), en återbetalning på 199 kr, en fast kostnad (försäkring 1 200 kr per kvartal), en investering på
  1 200 kr på BL-001, ett rapportutkast för september (`calc_version` "integrationstest") och utgångslägen och
  mätvärden på Effekt. De ändrar Att göra, intäkten i risk, Lönsamhet efter vinsten, Enhetsekonomi, Effekt och Hem
  (punkten "Granska rapportutkastet för september"). Intäkten och vinsten före fasta kostnader påverkas inte. Kör
  `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo` före en visning och ta siffrorna samma dag.

## Effekt: vad som mäts och hur

**Utgångsläget är ännu inte registrerat av beställaren. Effekten av Binderlab kan därför inte bevisas än.**

Sidan Effekt (`/effekt`) jämför varje månad med läget före Binderlab. Efter snabbstarten har organisationen Binderlab
inget utgångsläge och inga mätvärden, och sidan säger "Utgångsläget före Binderlab är inte registrerat". Vinst per
automat och månad räknas ändå ur orderna: 10 701 kr i oktober (från första ordern 13 okt.) och 6 557 kr i november
hittills; talen syns på sidan när ett utgångsläge finns.

Två ställen visar en effekt som inte ska användas:

- `binderlab_dev` på byggmaskinen har tre utgångslägen med källan "Egen uppskattning, sommaren 2026" (vinst per
  automat och månad 4 500 kr, 6 slutsålda dagar och 14 timmars påfyllning per månad) och mätvärden för oktober och
  november. De lades in med ägarkontot under bygget för att prova sidan, inte av beställaren. Sidan visar därför
  "+138 %" för vinst per automat i oktober.
- Demoorganisationen (Nordljus Automater AB) har påhittade utgångslägen och mätvärden från `npm run db:seed-demo`.

Det här mäts:

| Resultat                     | Mått (`baseline_metric`)   | Hur värdet tas fram                                                                                                                                              | Vad beställaren behöver lägga in                                                     |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Vinst per automat            | `profit_per_machine_month` | Räknas ur orderna: vinst × dagar i månaden / automatdagar (samma vinst som Lönsamhet)                                                                            | Vinst per automat och månad före Binderlab, med källa (bokslut, Excel) och mätperiod |
| Minskad förlorad försäljning | `stockout_days_month`      | Mätvärde per månad. Kronorna värderas med vinst per automat och dag (eller ett inställt värde). Förlorad intäkt räknas också direkt ur lagret på Prognos & inköp | Slutsålda dagar per månad före Binderlab                                             |
| Tid sparad, påfyllning       | `refill_hours_month`       | Mätvärde per månad i minuter, värderat med timkostnaden (`effect_settings`)                                                                                      | Tid för påfyllning per månad före, och den faktiska tiden varje månad                |
| Tid sparad, administration   | `admin_hours_month`        | Mätvärde per månad i minuter (rapporter, avstämning, Excel)                                                                                                      | Tid för administration per månad före, och den faktiska tiden varje månad            |

Så blir effekten bevisbar:

1. Ta bort testvärdena (`npm run db:reset` före drift, eller Effekt → Ta bort i den databas som ska användas).
2. Beställaren registrerar utgångsläget under Effekt → Nytt utgångsläge, med källa och mätperiod (till exempel "Excel
   jan–sep 2026"). Utan källa går värdet inte att granska.
3. Varje månad läggs slutsålda dagar och tid in under Effekt → Nytt mätvärde. Vinst per automat räknas av sig själv.
4. Efter tre hela månader finns en jämförelse som går att lita på. En pågående månad jämförs med lika många dagar av
   utgångsläget, så den varken lyfter eller sänker snittet bara för att den är kort.

Reglerna för jämförelsen står i `docs/berakningar.md` (avsnitt 25) och koden i `src/analytics/effect`.
