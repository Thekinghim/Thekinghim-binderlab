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

-- Sekvenser: ingen klientroll får läsa eller flytta en sekvens. Med UPDATE
-- (som Supabase ger som standard) kunde authenticated köra setval och stoppa
-- alla organisationers inserts. stock_events.seq räknas per organisation med
-- sekvenser i private (se private.ensure_stock_seq), som skapas utan
-- rättigheter för klienter.
revoke all on all sequences in schema public from authenticated, service_role;
revoke all on all sequences in schema private from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated, service_role;

-- Planerarens statistik: Postgres använder MCV-listan för organization_id i
-- estimat även när RLS döljer raderna (likhet på uuid räknas som
-- läckagesäker). Via PostgREST "Prefer: count=planned" skulle en klient då
-- kunna läsa ungefär hur många rader en annan organisation har. Utan statistik
-- för kolumnen får alla id samma standardestimat.
do $$
declare
  v_table regclass;
begin
  for v_table in
    select c.oid::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attname = 'organization_id'
      and not a.attisdropped
  loop
    execute format('alter table %s alter column organization_id set statistics 0', v_table);
  end loop;
end
$$;
