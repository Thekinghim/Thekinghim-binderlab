# Awish: import av order

Koden finns i `src/import/`. Adaptern (`awish_grpc` automatiskt via Awish API, se [awish-api.md](awish-api.md), och `awish_csv` för uppladdade filer) tolkar källan till `RawOrder`. Allt efter adaptern är gemensamt (`pipeline.ts`): koppling av titlar och automater, dubbletter, konflikter, importlogg och lagerhändelser.

## Kolumnmappning (orderlistan som CSV)

| Awish-kolumn   | Fält                            | Anmärkning                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order No.      | `orders.external_id`            | Unikt per datakälla, NFKC-normaliserat. Samma nummer igen blir dubblett eller konflikt. Exponentform från Excel ("4.27801E+11") blir felrad.                                                                                                                                                |
| Name           | `orders.raw_title` → titel      | Kopplas via alias (normaliserat: NFKC, gemener, ett mellanslag). En okänd titel blir ny titel + alias och flaggas.                                                                                                                                                                          |
| Order Machine  | `source_machines.external_id`   | Nyckeln är namnet, NFKC-normaliserat (samma automat i NFC och NFD). En okänd automat hamnar i kön (`machine_id` null). Ordern sparas utan automat och får den när automaten kopplas.                                                                                                        |
| Order Amount   | `orders.amount_ore`             | Beloppet märkt exakt "Amount:" eller "Order Amount:" först på sin rad i cellen; "Discount Amount:", "Refund Amount:" och "Paid Amount:" tas aldrig. Flera olika "Amount:" blir felrad. Tolkas som text till öre, inga flyttal. Negativa och tvetydiga belopp (t.ex. "1,234") blir felrader. |
| Is Paid        | filter                          | Bara "Paid Success" importeras. Övriga räknas som "ej betalda". En ej betald rad för en order som redan finns (eller är betald längre upp i filen) loggas som konflikt. En rad med fler kolumner än rubriken är alltid en felrad, eftersom Is Paid då kan stå i fel kolumn.                 |
| Payment Time   | `orders.ordered_at`             | Lokal tid i datakällans tidszon → UTC. `business_date` är datumet i organisationens tidszon.                                                                                                                                                                                                |
| Payment Method | `orders.payment_method`         | Valfri. Saknas kolumnen (eller mappas bort) jämförs betalmetoden inte mot sparade order.                                                                                                                                                                                                    |
| ID, Date       | sparas bara i `import_rows.raw` |                                                                                                                                                                                                                                                                                             |
| Actions        | ignoreras                       |                                                                                                                                                                                                                                                                                             |

- Rubrikerna känns igen oavsett skiftläge, mellanslag och skiljetecken, även på svenska (Ordernummer, Produkt, Automat, Belopp, Betald, Betaltid, Betalmetod).
- Användaren kan överstyra mappningen. Den som används sparas i `imports.mapping` och på datakällan (`config.csvMapping`) till nästa fil.
- Avgränsare `,`, `;` eller tab gissas, eller anges. BOM, citattecken, radbrytning inom citat, blandade radslut och tomma rader hanteras. Filer som inte är UTF-8 alls läses som Windows-1252. En UTF-8-fil med en trasig byte avvisas med radnumret (i stället för att hela filen blir "PokÃ©mon").
- Radnummer i importloggen är filens radnummer, där rubriken är rad 1.
- Dubblett eller konflikt avgörs av fälten (belopp, tid, titel, automat, betalmetod) efter NFKC-normalisering och ihopslagna mellanslag, alltid först mot den sparade ordern och sedan mot samma ordernummer längre upp i filen. `orders.source_hash` (version `sh2`, NFKC) sparas som spårbarhet.
- En automat som döps om i Awish blir en ny, okopplad källautomat, och redan importerade order med det gamla namnet blir konflikter om de importeras igen. CSV-filen saknar automat-id, så det går inte att följa ett namnbyte.
- Samma Awish-konto som två datakällor: ordernumret är unikt per datakälla. Synken från Awish API hoppar över en betald order vars betaltid och belopp redan finns i en annan Awish-källa ([awish-api.md](awish-api.md)), men CSV-importen jämför bara mot sin egen källa. Ladda inte upp fler orderlistor när API:t är kopplat.
- Det finns ingen kolumn för antal (alltid 1 pack per order), utmatning eller återbetalning.

## Tidszon: verifiering mot order 42780

Datakällans tidszon (`data_sources.source_timezone`) är `Asia/Shanghai` tills den har verifierats.

Order 42780 betalades **1 nov. 2026 17:17 svensk tid**. Awish visar då Payment Time **2026-11-02 00:17:00** om källan är i Shanghai-tid. Då ger importen:

- `ordered_at` = `2026-11-01T16:17:00Z`
- `business_date` = `2026-11-01`

Gör så här vid första riktiga importen:

1. Ladda upp en orderlista som innehåller 42780 och välj **förhandsvisning**.
2. Förhandsvisningen visar alltid den första betalda raden i både källans tid och svensk tid (`firstRow`). Leta upp 42780 i radlistan.
3. Om svensk tid visar 1 nov. 17:17 stämmer Shanghai.
   - Visar den något annat är källans zon fel, och skillnaden i timmar är felet. Ändra `source_timezone` innan något importeras.
   - Exempel: Awish visar Payment Time 2026-11-01 17:17:00 (källan är redan i svensk tid). Med Shanghai blir det 1 nov. 10:17 i förhandsvisningen, sju timmar fel. Byt då till `Europe/Stockholm`.

Shanghai har ingen sommartid. Om källan någon gång ligger i en zon med sommartid gäller två regler. En tid som förekommer två gånger (25 okt. 2026 02:00–02:59 i Stockholm) tolkas som den tidigaste och loggas på raden. En tid som inte finns (29 mars 2026 02:00–02:59) flyttas fram en timme och loggas.

## Awish API (gRPC)

Den automatiska hämtningen beskrivs i [awish-api.md](awish-api.md). Kontrollen mot order 42780 ovan görs på samma
sätt för API:t: `pay_time` tolkas i datakällans `source_timezone`.

### Takt och belastning på Awish

Synken körs var femte minut (pg_cron `*/5 * * * *`, migreringen
`20261112000000_awish_synk_var_femte_minut.sql`). Tidigare gick den var tionde minut och läste facken bara var 30:e
minut; nu läser varje körning både order och fack. Anrop till Awish per körning och datakälla:

| Anrop                  | Per körning                                                                   | Per dygn (288 körningar)       |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| `Machines`             | 1 per sida (50 automater per sida)                                            | 288 för en källa med ≤ 50      |
| `Orders`               | 1 per sida (50 order), tills en order äldre än ett dygn har setts; oftast 1–2 | ca 300–600                     |
| `Products(machine_id)` | 1 per kopplad automat                                                         | 288 × antal kopplade automater |
| `Merchant`             | högst 1 per dygn                                                              | 1                              |

Med 10 kopplade automater blir det 2 `Products`-anrop i minuten per källa (förut 10 var 30:e minut, en tredjedel i
minuten) och totalt ungefär 3 500–3 800 anrop per dygn, mot ungefär 900–1 200 förut. Anropen görs i följd, aldrig
parallellt, inom körningens tidsbudget (`TIME_BUDGET_MS`, 40 s för alla källor tillsammans). Hinns inte alla automater
med läses de som lästes längst sedan först nästa körning, så antalet anrop per körning har ett tak oavsett antal
automater. Låset per källa (`LEASE_MS`, 3 min) och funktionens `maxDuration` (60 s) är kortare än intervallet, så
körningar överlappar inte. "Synka nu" läser alltid facken; en schemalagd körning mindre än 2,5 minuter efter en
läsning läser inte om dem (`STOCK_DUE_MARGIN_MS` i `src/server/awish/stock.ts`).

Awish har inte publicerat någon gräns för antal anrop. Svarar Awish med fel eller för långsamt tas det som inte hanns
med nästa körning; det finns ingen extra backoff mellan körningar. Blir belastningen ett problem kan
`STOCK_SYNC_INTERVAL_MS` (`src/server/awish/stock.ts`) höjas till 10 eller 15 minuter utan att orderna påverkas.

I Binderlab skriver varje körning automatens läge (`source_machines.awish_*`) och facken. Läget loggas inte i
`audit_log` (migreringen `20261112000100_awish_anslutning_utan_audit.sql`), annars skulle varje tick ge en rad per
automat; kopplingen till en automat loggas som förut.
