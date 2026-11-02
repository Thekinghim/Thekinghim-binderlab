-- Lastprov för /order: en egen organisation "Binderlab (orderprov)" med 100 000 genererade
-- order (3 butiker, 3 automater, 10 titlar, en order var 315:e sekund i ett år) och
-- användaren orderprov@binderlab.local (samma lösenord som agare@binderlab.local).
-- Rör inte andra organisationer. Kräver att seeden körts (agare@binderlab.local finns).
--
--   psql postgres://postgres@127.0.0.1:54322/binderlab_dev -f scripts/db/order-perf-seed.sql
--
-- Organisationen går inte att radera (raderingsskydd i triggers); den försvinner vid
-- nästa `npm run db:reset dev`. Kör den inte två gånger mot samma databas.
\set ON_ERROR_STOP on
insert into auth.users (email, encrypted_password, raw_user_meta_data)
select 'orderprov@binderlab.local', encrypted_password, '{}'::jsonb from auth.users where email = 'agare@binderlab.local'
on conflict do nothing;
select id as uid from auth.users where email = 'orderprov@binderlab.local' \gset
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'uid', 'email', 'orderprov@binderlab.local', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('Binderlab (orderprov)', 'orderprov') as org \gset
insert into public.stores (organization_id, name) values (:'org', 'ICA Kvantum Prov'), (:'org', 'Coop Forum Prov'), (:'org', 'Pressbyrån Prov');
insert into public.machines (organization_id, code, name, active_from)
  values (:'org', 'BL-101', 'Provautomat 1', '2025-01-01'), (:'org', 'BL-102', 'Provautomat 2', '2025-01-01'), (:'org', 'BL-103', 'Provautomat 3', '2025-01-01');
insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
  select :'org', m.id, s.id, '2025-01-01' from
    (select id, row_number() over (order by code) n from public.machines where organization_id = :'org') m
    join (select id, row_number() over (order by name) n from public.stores where organization_id = :'org') s using (n);
insert into public.titles (organization_id, name, series)
  select :'org', t, 'Prov' from unnest(array['Ascended Heroes','Mystery Pack','30th Celebration','Surging Sparks','Prismatic Evolution','Destin Rivals','Phantasmal Flames','Black Bolt','White Flare','Pokémon 151']) t;
insert into public.data_sources (organization_id, provider, name) values (:'org', 'awish_csv', 'Awish prov');
select id as ds from public.data_sources where organization_id = :'org' \gset
insert into public.imports (organization_id, data_source_id, trigger, file_name, storage_path, parser_version, rows_total, rows_new, status)
  values (:'org', :'ds', 'upload', 'prov-100000.csv', :'org' || '/imports/prov-100000.csv', 'awish-csv@1', 100000, 100000, 'succeeded');
select id as imp from public.imports where organization_id = :'org' \gset
create temp table tt as select id, row_number() over (order by name) - 1 as n, name from public.titles where organization_id = :'org';
create temp table mm as select id, row_number() over (order by code) - 1 as n from public.machines where organization_id = :'org';
insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at, amount_ore, payment_method, machine_id, import_id, source_hash)
select :'org', :'ds', (200000 + g)::text, tt.name, tt.id,
       timestamptz '2025-11-02 06:00:00+00' + (g * interval '315 seconds'),
       (12900 + (g % 8) * 1000), case when g % 4 = 0 then 'Swish' else 'Card' end,
       mm.id, :'imp', md5(g::text)
from generate_series(1, 100000) g
join tt on tt.n = g % 10
join mm on mm.n = (g / 7) % 3;
commit;
select count(*) from public.orders where organization_id = :'org';
