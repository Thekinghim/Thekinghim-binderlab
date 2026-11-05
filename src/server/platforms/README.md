# Automatplattformar

Binderlab behöver bara **order** från en automatplattform. Allt annat (titlar, automater,
lager, lönsamhet, rapporter, ekonomi) räknas i Binderlab. Den här mappen beskriver vad en
plattform är och vilka som finns.

| Fil             | Innehåll                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------- |
| `types.ts`      | Gränssnittet: `MachinePlatform`, `PlatformConnection`, `PlatformCapabilities`               |
| `catalog.ts`    | Plattformarna som ren data: providers, förmågor, `providerAcceptsFiles`, `isManualProvider` |
| `awish.ts`      | Awish: tunt omslag runt `src/server/awish` och `src/import/adapters/awish-*`                |
| `manual-csv.ts` | Annan automat: CSV-uppladdning (`src/import/adapters/manual-csv.ts`)                        |
| `index.ts`      | Registret: `platformFor(provider)`, `parsePlatformFile`                                     |

## Lägga till en ny plattform

Exempel: "Vendon" med ett REST-API för försäljning.

1. **Datakällans typ.** En ny migrering med ett nytt värde i `data_source_provider`
   (`alter type public.data_source_provider add value 'vendon_api';`, egen fil, se
   `supabase/migrations/20261111020000_plattform_manuell_csv.sql`), samma värde sist i
   `dataSourceProvider` i `src/db/schema.ts` och i `DataSourceProvider` i
   `src/import/adapter.ts`. Katalogtestet kontrollerar att de stämmer.
2. **Adaptern för order** i `src/import/adapters/vendon.ts`: tolka plattformens order till
   `FetchResult` (`RawOrder`: ordernummer, titel som plattformen skriver den, automatens id och
   namn, belopp i öre, tid i UTC, betald eller inte). En order = ett pack. Ren funktion, med
   enhetstester. Ingen databas; pipelinen (`src/import/pipeline.ts`) gör resten.
3. **Plattformen** i `src/server/platforms/vendon.ts`: `PLATFORM_INFO`-posten i `catalog.ts`
   (namn, providers, förmågor) och implementationen (`connect` → `readOrders`, och
   `listMachines`/`readSlots` om API:t har dem). Lägg den i registret i `index.ts`.
4. **Hämtning.** Filplattform: lägg providern i `providerAcceptsFiles` och i `fetchFromFile` i
   `src/import/run-import.ts`. API-plattform: ett schemalagt jobb som `src/server/awish/sync.ts`
   (läs inloggningen ur Vault, hämta sidor, kör `classify` och `commitClassification` i en
   transaktion, spara läget i `data_sources.cursor`).
5. **Täckning och larm.** Laddas källan upp för hand: lägg providern i `isManualProvider` och i
   `private.sales_data_until_rows` (ny migrering). Annars sätt hur ofta den hämtas i
   `expectedInterval` (`src/server/alerts/inputs.ts`).
6. **Gränssnittet.** Namnet i `PROVIDER_LABELS` (`src/app/(app)/datakallor/_lib/constants.ts`)
   och i `order-detail.tsx`; ett val i "Lägg till datakälla" om användaren skapar källan själv.
7. **Tester.** Enhetstester för adaptern; ett databastest som importerar genom `runImport`
   (eller synken mot en låtsasserver, aldrig plattformens riktiga API); `npm run typecheck`,
   `npm test` och `npm run test:db`.

Skrivning tillbaka (påfyllning, varor) är valfri: implementera `refill` och sätt
`writeRefill: true` först när plattformen har ett API för det och leverantören godkänt det.
