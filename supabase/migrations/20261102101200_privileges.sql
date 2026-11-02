-- =============================================================================
-- Sista svep över rättigheterna, efter att alla objekt skapats.
--   * anon har inga rättigheter på något i public (tabeller, vyer, sekvenser,
--     funktioner), varken nu eller för framtida objekt.
--   * Ingen klientroll kan tömma tabeller (truncate kringgår RLS och triggers)
--     eller skapa triggers/FK:er mot dem.
--   * Funktioner i private kan bara köras av dem som uttryckligen fått rätt.
-- Katalogtesterna (test/db/catalog.test.ts) kontrollerar att detta håller.
-- =============================================================================

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from public, anon;
revoke truncate, references, trigger on all tables in schema public from authenticated, service_role;
revoke all on all functions in schema private from public, anon;

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from public, anon;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated, service_role;

-- RPC:erna ska kunna köras av authenticated (revoke från public ovan påverkar
-- inte de uttryckliga grants som sattes i 20261102101000_rpc.sql).
