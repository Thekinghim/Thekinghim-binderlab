-- =============================================================================
-- Oberoende av automatplattform: ny typ av datakälla 'manual_csv' ("Annan automat").
--
-- En operatör vars automater inte är Awish laddar upp sin försäljning som CSV (Datum,
-- Automat, Produkt, Belopp; se src/import/adapters/manual-csv.ts). Orderna går genom
-- samma importpipeline som Awish-orderna.
--
-- Egen migrering: ett nytt enum-värde kan inte användas i samma transaktion som det
-- läggs till i (nästa migrering använder det). Värdet läggs sist, samma ordning som i
-- src/db/schema.ts.
-- =============================================================================

alter type public.data_source_provider add value if not exists 'manual_csv';
