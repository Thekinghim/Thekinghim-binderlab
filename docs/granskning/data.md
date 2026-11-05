# Data

## Vad som sparas och var

All data ligger i **Supabase** (Postgres och Storage) i produktionsprojektets region
(eu-west-2, London, enligt `docs/operations.md`); funktionerna körs i samma region (`lhr1`).
London ligger i Storbritannien, alltså **utanför EU/EES**: datat stannar inte i EU. Överföringen
dit vilar på EU-kommissionens adekvansbeslut för Storbritannien; kontrollera att det gäller när
avtalet skrivs (eller byt region).

| Område             | Tabeller (urval)                                                                   |
| ------------------ | ---------------------------------------------------------------------------------- |
| Organisation       | `organizations`, `organization_settings`, `memberships`, `profiles`, `invitations` |
| Platser            | `stores`, `store_agreements`, `contracts`, `machines`, `machine_placements`        |
| Sortiment och pris | `titles`, `title_aliases`, `purchase_prices`, `machine_slots`                      |
| Försäljning        | `orders` (en rad per sålt pack), `imports`, `import_rows`, `data_sources`          |
| Lager              | `stock_locations`, `stock_events` (append-only), vyn `stock_levels`                |
| Ekonomi            | `store_settlements`, `payouts`, `payout_lines`, `fixed_costs`, `period_closes`     |
| Rapporter          | `reports`, `report_deliveries`, `report_files`; PDF och filer i Storage            |
| Drift              | `alerts`, `incidents`, `alert_subscriptions`, `push_subscriptions`                 |
| Loggar             | `audit_log`, `assistant_logs`, `data_exports`                                      |

Alla 84 tabeller i `public` och deras kolumner: [docs/datamodell.md](../datamodell.md) och sidan
`/datamodell` i appen. Orderna innehåller inga uppgifter om köparen (tid, belopp, betalsätt,
titel, automat). Personuppgifter som finns (användare, butikskontakter, kundärenden):
[docs/operations.md](../operations.md#personuppgifter-och-biträden).

## Ägande

- Varje rad hör till en organisation (`organization_id`, kontrollerat av katalogtesterna).
  Organisationens data är kundens; koden och tjänsten är Binderlabs ([agande.md](agande.md)).
- Den som driver panelen åt andra operatörer är personuppgiftsbiträde åt dem; operatören är
  personuppgiftsansvarig för sina användare och butikskontakter. **Inget standardavtal eller
  biträdesavtal finns ännu** (ägaren behöver ta fram ett innan fler operatörer släpps in).

## Export: kunden kan ta med sig sin data

**Inställningar → Din data → Exportera all data** (bara ägaren) ger en ZIP med en CSV-fil per
tabell: organisation, inställningar, butiker, butiksavtal, kontrakt, automater, placeringar,
investeringar, fack, titlar, alias, inköpspriser, datakällor, källautomater, importer, order,
lagerplatser, lagerhändelser, avräkningar, utbetalningar, fasta kostnader, leverantörer,
inköpsordrar, ägarandelar och stängda månader, plus `LASMIG.txt` som förklarar formatet.

- **Format**: UTF-8 med BOM, semikolon (öppnas direkt i svenskt Excel), en rubrikrad med
  kolumnernas namn, belopp i öre, tider i UTC (ISO 8601), id:n som kopplar ihop filerna.
- **Säkerhet**: ägaren kontrolleras i appen och i databasen (`start_data_export`), data läses
  med ägarens RLS och filtreras på organisationen, högst 3 exporter per timme, och varje export
  loggas i `data_exports`. Inloggningar i Vault och interna fält (`config`, `secret_ref`,
  `cursor`, `storage_path`) tas inte med.
- **Kod och tester**: `src/server/export`, `src/app/(app)/installningar/export/route.ts`,
  `src/server/export/export.test.ts` (ZIP, CSV) och `test/db/granskning.test.ts` (behörighet,
  isolering, gräns, logg).
- **Inte med**: filer i Storage (avtals-PDF:er, rapporter; laddas ner i appen),
  användarkonton och lösenord, ändringsloggen (`audit_log`), larm och assistentens frågor.

Dessutom: orderlistan som CSV (Order → Exportera), SIE 4 och Excel till bokföringen
(Ekonomi → Bokföring) och rapporternas PDF.

## GDPR: läge

| Punkt                          | Läge                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Region                         | London (Storbritannien, utanför EU) för databas och funktioner; Anthropic utanför EU  |
| Biträdesavtal (DPA)            | Inte tecknade med Supabase, Vercel, Resend, Sentry eller Anthropic                    |
| Lagringstider och gallring     | Spärr finns i databasen (`private.purge_allowed()`), men inget gallringsjobb är byggt |
| Registrerades rätt till utdrag | Ingen funktion per person; organisationens export ovan täcker organisationens data    |
| Radering av en person          | För hand i Supabase (kontot, profilen, `assistant_logs`)                              |
| Personuppgiftsincident         | Gång i [docs/operations.md](../operations.md#incidenthantering) (IMY inom 72 timmar)  |
