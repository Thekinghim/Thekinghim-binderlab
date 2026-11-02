-- =============================================================================
-- Härdning: ingen planerarstatistik för organization_id i nya tabeller.
--
-- Regeln från 20261102101200_privileges.sql: Postgres använder MCV-listan för
-- organization_id i estimat även när RLS döljer raderna, så via PostgREST
-- "Prefer: count=planned" skulle en klient kunna läsa ungefär hur många rader en
-- annan organisation har. Därför sätts statistiken till 0 för kolumnen i varje
-- tabell. Datakällornas mellanlagring (20261102133644_datakallor_import_uploads.sql,
-- import_uploads och import_upload_chunks) skapades utan det; katalogtestet
-- test/db/hardening.test.ts ("planerarens statistik") fångade det.
--
-- Samma loop som i privileges, så att även andra tabeller som saknar inställningen
-- (t.ex. från migreringar som skrivs parallellt) täcks. Idempotent.
-- =============================================================================

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
      and coalesce(a.attstattarget::int, -1) <> 0
  loop
    execute format('alter table %s alter column organization_id set statistics 0', v_table);
  end loop;
end
$$;
