# Binderlab: vad panelen löser

## Problemet

En operatör med varuautomater för samlarkortspack (Pokémon med flera) har automater utställda i butiker. Butiken får
provision och ibland hyra. Automatleverantörens system (Awish) visar bara en orderlista. Allt annat görs för hand:
vad som sålt, vad som tjänades efter inköp och butikens ersättning, vilka automater som snart är tomma, vad butiken ska
ha i månaden, vad bokhållaren behöver och om en automat har slutat fungera.

Följden är att vinsten per automat inte är känd förrän i efterhand, att titlar tar slut innan någon märker det, att
månadsrapporterna tar tid och att det inte går att säga om en ny plats lönar sig.

## För vem

| Vem                 | Använder                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Ägaren (operatören) | Hela panelen: Hem, Att göra, Lönsamhet, Prognos & inköp, Rapporter, Ekonomi, Expansion, Assistenten    |
| Delägare (läsare)   | Samma siffror utan att kunna ändra; delägarrapporten                                                   |
| Påfyllaren          | Lager, Att göra (bara påfyllning), fältläget i mobilen med besöksplan och packlista; ser aldrig belopp |
| Butiken             | Butiksportalen: egen försäljning, ersättningen steg för steg, godkända månadsrapporter, felanmälan     |
| Bokhållaren         | Bokföringsunderlag med SIE 4 och Excel, utbetalningar avstämda mot försäljningen                       |

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
- **Ekonomi och avtal:** avstämning av leverantörens utbetalningar mot försäljningen, verifikationer, kassaflöde, fasta
  kostnader, avtal med påminnelse före sista uppsägningsdag.
- **Enhetsekonomi och expansion:** vinst per automat och dag, återbetalningstid, och uppskattning för en ny plats från
  liknande befintliga.
- **Assistenten:** frågor på svenska som besvaras med panelens egna beräkningar, med kontroll av varje tal.

Hur varje siffra räknas står i `docs/berakningar.md`.

## Siffror ur panelen

Källa: utvecklingsdatabasen `binderlab_dev` efter `npm run db:seed`, som importerar verksamhetens riktiga försäljning
13 okt.–1 nov. 2026 genom samma import som Datakällor (`src/seed/catalog.ts`, tre exempelbutiker och tre automater).
Siffrorna är hämtade 2 nov. 2026 från panelen inloggad som ägare (period "Allt") och kontrollerade mot SQL utan
beräkningslagret (460 order och 79 987,00 kr). Vinsten 21 858 kr (2 185 845 öre) stämmer med en fristående
SQL-uträkning dag för dag, och samma tal låses av `test/db/consistency-revision.test.ts`.

| Mått                                 | Värde                                                          | Var i panelen             |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------- |
| Intäkt 13 okt.–2 nov. (21 dagar)     | 79 987 kr, 460 order, snitt 174 kr per order                   | Hem                       |
| Vinst före fasta kostnader           | 21 858 kr, 28,7 % marginal på order med inköpspris             | Hem, Lönsamhet            |
| Butiksersättning                     | 7 090 kr (provision 5 561 kr, hyra 1 529 kr)                   | Lönsamhet                 |
| Intäkt utan inköpspris               | 3 825 kr (4,8 %, 25 order av två titlar), ingår inte i vinsten | Hem, Lönsamhet, Att göra  |
| Vinst per automat och dag            | 348 kr i snitt; 419, 381 och 245 kr för de tre automaterna     | Automater → Enhetsekonomi |
| Vinst per automat och månad, oktober | 10 701 kr (räknat från första ordern 13 okt.)                  | Effekt                    |
| Återbetalningstid                    | 3,4, 3,4 och 4,6 månader                                       | Automater → Enhetsekonomi |
| Intäkt i risk de närmaste 7 dagarna  | 7 518 kr i fyra påfyllningar (titlar som räcker 1,6–2,3 dagar) | Att göra                  |
| Förlorad försäljning 4 okt.–1 nov.   | 0 kr: ingen titel var slutsåld enligt lagret och försäljningen | Prognos & inköp           |
| Prognos 2–29 nov.                    | ca 115 700 kr (80 %-intervall 105 400–125 900 kr), ca 664 pack | Prognos & inköp           |
| Prognosens träffsäkerhet             | 32 % fel per dag (WAPE i backtest)                             | Prognos & inköp           |
| Maskinhälsa                          | alla 3 automater i drift                                       | Drift                     |

Förbehåll:

- Perioden är tre veckor med tre automater. Det räcker för att visa att siffrorna stämmer, inte för att dra slutsatser
  om säsong eller trend.
- Investeringarna (39 900, 39 900 och 34 900 kr plus 2 500 kr installation) kommer från seeden och är inte bekräftade
  av beställaren. Återbetalningstiden beror helt på dem.
- Under bygget lades testposter in med ägarkontot i `binderlab_dev`: en återbetalning på 199 kr, en fast kostnad
  (försäkring 1 200 kr per kvartal), en investering på 1 200 kr, ett rapportutkast för september (`calc_version`
  "integrationstest") och de utgångslägen och mätvärden som beskrivs nedan. De påverkar Lönsamhet efter vinsten,
  Enhetsekonomi, Att göra och Effekt, men inte intäkten, vinsten före fasta kostnader eller prognosen. Kör
  `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo` före en visning.

## Effekt: vad som mäts och hur

**Utgångsläget är ännu inte registrerat av beställaren. Effekten av Binderlab kan därför inte bevisas än.**

Sidan Effekt (`/effekt`) jämför varje månad med läget före Binderlab. I `binderlab_dev` står tre utgångslägen med
källan "Egen uppskattning, sommaren 2026" (vinst per automat och månad 4 500 kr, 6 slutsålda dagar och 14 timmars
påfyllning per månad), men de lades in med ägarkontot under bygget för att prova sidan, inte av beställaren. Sidan
visar därför "+138 %" för vinst per automat i oktober; den siffran ska inte användas. Detsamma gäller mätvärdena för
oktober och november (2 slutsålda dagar, 9 h 30 min och 1 h påfyllning).

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
