# Awish: import av order

Koden finns i `src/import/`. Adaptern (`awish_csv` nu, `awish_grpc` senare) tolkar källan till `RawOrder`. Allt efter adaptern är gemensamt (`pipeline.ts`): koppling av titlar och automater, dubbletter, konflikter, importlogg och lagerhändelser.

## Kolumnmappning (orderlistan som CSV)

| Awish-kolumn   | Fält                            | Anmärkning                                                                                                                     |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Order No.      | `orders.external_id`            | Unikt per datakälla. Samma nummer igen blir dubblett eller konflikt.                                                           |
| Name           | `orders.raw_title` → titel      | Kopplas via alias (normaliserat: NFKC, gemener, ett mellanslag). En okänd titel blir ny titel + alias och flaggas.             |
| Order Machine  | `source_machines.external_id`   | En okänd automat hamnar i kön (`machine_id` null). Ordern sparas utan automat och får den när automaten kopplas.               |
| Order Amount   | `orders.amount_ore`             | Beloppet märkt "Amount:". Tolkas som text till öre, inga flyttal. Negativa och tvetydiga belopp (t.ex. "1,234") blir felrader. |
| Is Paid        | filter                          | Bara "Paid Success" importeras. Övriga räknas som "ej betalda".                                                                |
| Payment Time   | `orders.ordered_at`             | Lokal tid i datakällans tidszon → UTC. `business_date` är datumet i organisationens tidszon.                                   |
| Payment Method | `orders.payment_method`         | Valfri.                                                                                                                        |
| ID, Date       | sparas bara i `import_rows.raw` |                                                                                                                                |
| Actions        | ignoreras                       |                                                                                                                                |

- Rubrikerna känns igen oavsett skiftläge, mellanslag och skiljetecken, även på svenska (Ordernummer, Produkt, Automat, Belopp, Betald, Betaltid, Betalmetod).
- Användaren kan överstyra mappningen. Den som används sparas i `imports.mapping` och på datakällan (`config.csvMapping`) till nästa fil.
- Avgränsare `,`, `;` eller tab gissas, eller anges. BOM, citattecken, radbrytning inom citat, blandade radslut och tomma rader hanteras. Filer som inte är UTF-8 läses som Windows-1252.
- Radnummer i importloggen är filens radnummer, där rubriken är rad 1.
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

## Vad vi behöver från Awish för gRPC

`awish_grpc` kastar `NotConfiguredError` tills följande finns (`AWISH_GRPC_MISSING` i koden):

1. **.proto-filerna** för order- och automattjänsterna: meddelanden, metoder och paginering eller markör, så att vi kan hämta "allt efter senaste".
2. **Token-beräkningen** för app-ID: algoritm, vilka fält som ingår och i vilken ordning, giltighetstid, och ett exempel med kända in- och utvärden.
3. **TLS**: värdnamn och port, om klientcertifikat krävs, och CA-kedjan.
4. **Det tredje metadatafältet** i anropen: namn, format och hur värdet tas fram.
5. **Webhook-dokumentation**: händelsetyper, hur anropen signeras och verifieras, och hur omförsök fungerar.
6. **Exempelpayload** för en betald order, både gRPC-svar och webhook, med tidszon och beloppsformat (öre eller kronor, valuta).

Hemligheten (token eller nyckel) läggs i Supabase Vault under `{organization_id}/namn` och refereras från `data_sources.secret_ref`. Adaptern kontrollerar namnrymden innan Vault läses.
