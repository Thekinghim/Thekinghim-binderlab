-- =============================================================================
-- Bokföring: månadspaketet tas fram automatiskt och sparas.
--
-- * public.bookkeeping_packages: en rad per organisation och månad med det senast
--   sparade paketet (ZIP i den privata bucketen 'bookkeeping' under
--   "{organization_id}/{ÅÅÅÅ-MM}/v{version}-{sha256}.zip"). version räknas upp varje gång
--   underlaget ändras (kvitton, siffror, kontoplan). status 'final' = klar att ladda ner,
--   'preliminary' = preliminär (reason säger varför, t.ex. order utan inköpspris hos en
--   butik med vinstdelning). fingerprint = sha256 av underlaget; samma underlag ger inget
--   nytt paket.
-- * Bara servern (systemrollen) skriver. Ägare, admin och läsare läser raden och filen.
-- * private.bokforing_cron_tick: anropas av pg_cron en gång om dagen och gör
--   GET {binderlab_app_url}/api/cron/bokforing med "Authorization: Bearer
--   {binderlab_cron_secret}" via pg_net, som private.awish_cron_tick
--   (20261103090000_awish_api.sql). Lokalt och i CI schemaläggs inget.
-- =============================================================================

create table public.bookkeeping_packages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  version integer not null check (version >= 1),
  status text not null check (status in ('final', 'preliminary')),
  reason text check (reason is null or char_length(reason) between 1 and 300),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  storage_path text not null
    check (private.storage_path_org(storage_path) is not distinct from organization_id
           and char_length(storage_path) <= 300),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 200),
  size_bytes bigint not null check (size_bytes > 0),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, month)
);

comment on table public.bookkeeping_packages is
  'Bokföring: månadens sparade paket (ZIP i bucketen bookkeeping), version och status.';

alter table public.bookkeeping_packages alter column organization_id set statistics 0;

create trigger t00_forbid_org_change before update on public.bookkeeping_packages
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.bookkeeping_packages
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.bookkeeping_packages
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.bookkeeping_packages
  for each row execute function private.audit();

alter table public.bookkeeping_packages enable row level security;

revoke all on table public.bookkeeping_packages from anon, authenticated, service_role;
grant select on table public.bookkeeping_packages to authenticated;
grant select, insert, update on table public.bookkeeping_packages to service_role;

create policy bookkeeping_packages_select on public.bookkeeping_packages for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

-- -----------------------------------------------------------------------------
-- Storage: privat bucket 'bookkeeping'. Ägare, admin och läsare läser; bara servern
-- (secret key) laddar upp. En fil skrivs aldrig över: en ny version får en ny sökväg.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Schemat storage saknas: bucket bookkeeping skapas inte.';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('bookkeeping', 'bookkeeping', false)
  on conflict (id) do nothing;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    execute $q$update storage.buckets
      set file_size_limit = 52428800,
          allowed_mime_types = array['application/zip']
      where id = 'bookkeeping'$q$;
  end if;

  create policy binderlab_bookkeeping_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'bookkeeping'
      and private.has_role(private.storage_path_org(name), 'owner', 'admin', 'viewer')
    );
end
$$;

-- -----------------------------------------------------------------------------
-- pg_cron → GET /api/cron/bokforing en gång om dagen. Inget görs utan adress, hemlighet
-- och pg_net.
-- -----------------------------------------------------------------------------
create or replace function private.bokforing_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if to_regnamespace('net') is null then
    return null;
  end if;
  select btrim(s.decrypted_secret) into v_url
  from vault.decrypted_secrets s where s.name = 'binderlab_app_url';
  select btrim(s.decrypted_secret) into v_secret
  from vault.decrypted_secrets s where s.name = 'binderlab_cron_secret';
  if v_url is null or v_secret is null or char_length(v_secret) < 16
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    return null;
  end if;
  execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := $3)'
    into v_request
    using v_url || '/api/cron/bokforing',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          300000;
  return v_request;
end
$$;

revoke all on function private.bokforing_cron_tick() from public, anon, authenticated, service_role;

-- 03:37 UTC = 04:37/05:37 svensk tid: före AI-rådgivaren, efter nattens Awish-synk.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    begin
      execute $cmd$select cron.schedule('binderlab-bokforing', '37 3 * * *', 'select private.bokforing_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Bokföringens schema (pg_cron) kunde inte sättas upp: %', sqlerrm;
    end;
  elsif exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $cmd$select cron.schedule('binderlab-bokforing', '37 3 * * *', 'select private.bokforing_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Bokföringens schema (pg_cron/pg_net) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;

revoke all on all functions in schema private from public;
