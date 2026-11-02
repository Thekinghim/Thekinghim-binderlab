-- =============================================================================
-- Sök: trigramindex för kommandopalettens ordersökning (GET /sok).
--
-- Paletten söker ordernummer (external_id) och originaltitel (raw_title) med
-- ILIKE '%…%' och visar de senaste träffarna. Utan index måste Postgres läsa varje
-- order i organisationen när sökordet är ovanligt eller saknas: ~70–150 ms per
-- tangenttryck med 100 000 order (uppmätt i binderlab_test_sok och binderlab_dev).
-- Med index hittas träffarna på under 1 ms. Vanliga sökord ("Destined") går redan
-- fort via orders_ordered_at_idx (nyaste först, avbryts efter sex rader).
--
-- Indexen är sammansatta (organization_id, kolumn): organization_id saknar
-- planerarstatistik (20261102160000_hardening_org_statistics.sql), så planeraren
-- underskattar hur många order en organisation har. Ett trigramindex på bara kolumnen
-- valdes därför bort ibland till förmån för ett btree-index på organization_id (som
-- läser alla organisationens order). Med organization_id i samma GIN-index vinner
-- indexet alltid kostnadsjämförelsen. btree_gin behövs för uuid i ett GIN-index.
--
-- gin_pending_list_limit = 256 (kB): nya order samlas i GIN-indexets väntelista och
-- skrivs in i omgångar. Med standardgränsen (4 MB) räknar planeraren in hela listan i
-- kostnaden och väljer bort indexet efter en stor import tills nästa vacuum (uppmätt:
-- 150 ms i stället för under 1 ms). Med 256 kB väljs indexet alltid, och importen går
-- lika fort (20 000 order: 1,5 s; med fastupdate = off 3,4 s).
--
-- pg_trgm och btree_gin läggs i schemat extensions som övriga tillägg (citext,
-- btree_gist, pgcrypto). Indexen ändrar inga rättigheter: RLS på orders gäller som
-- förut. Frågan körs via private.search_orders (20261102165100_sok_search_orders.sql).
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gin with schema extensions;

create index if not exists orders_external_id_trgm_idx
  on public.orders using gin (organization_id, external_id extensions.gin_trgm_ops)
  with (gin_pending_list_limit = 256);

create index if not exists orders_raw_title_trgm_idx
  on public.orders using gin (organization_id, raw_title extensions.gin_trgm_ops)
  with (gin_pending_list_limit = 256);
