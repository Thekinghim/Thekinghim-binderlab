-- =============================================================================
-- Tillägg (Awish Chrome-tillägg): nya värden i två uppräkningstyper.
--
-- * data_source_provider 'awish_extension': datakälla som fylls av
--   Binderlabs Chrome-tillägg, som läser Awish-panelen (dash.awish.vip) med
--   användarens egen inloggning och skickar ordrarna till
--   POST /api/ingest/awish. Se docs/awish-tillagg.md.
-- * import_trigger 'extension': en import som är en batch från tillägget.
--
-- Egen migrering: ett nytt enum-värde kan inte användas i samma transaktion som
-- det läggs till i (sync_tokens och dess kontroller i nästa migrering använder
-- dem). Värdena läggs sist, samma ordning som i src/db/schema.ts.
-- =============================================================================

alter type public.data_source_provider add value if not exists 'awish_extension';
alter type public.import_trigger add value if not exists 'extension';
