-- =============================================================================
-- Bokföring (Ekonomi → Bokföring): månadspaket till Fortnox/Talenom. Ingen automatisk
-- bokföring och ingen koppling till Fortnox: Binderlab sparar underlaget och ägaren
-- laddar ned månadens paket (SIE 4, PDF, Excel, kvitton) och skickar in det.
--
-- * public.bookkeeping_settings: en rad per organisation. Kontoplanen (jsonb, förslag
--   enligt BAS som kontrolleras av Talenom), verifikationsserie, organisationsnummer,
--   inköpsunderlaget för VMB och ett ingående underskott. Ägare och admin skriver.
-- * public.bookkeeping_months: en rad per organisation och månad när månaden markerats
--   som skickad. sent_at null = inte skickad (ångrad). snapshot = månadens siffror när
--   den markerades (VMB-underskottet förs vidare från det som skickades).
-- * public.bookkeeping_receipts: kvitton (PDF/JPG/PNG/HEIC, högst 10 MB) per månad, i
--   den privata bucketen 'receipts' under "{organization_id}/{ÅÅÅÅ-MM}/{sha256}.{ext}".
--   Tas bort genom arkivering (archived_at).
--
-- Läsare (viewer) ser allt men ändrar inget. Påfyllaren och butiksrollen ser ingenting.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bookkeeping_settings
-- -----------------------------------------------------------------------------
create table public.bookkeeping_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- {"settlement": "1580", "sales_vmb": "3211", ...}; saknade nycklar = förslaget.
  account_plan jsonb not null default '{}'::jsonb check (jsonb_typeof(account_plan) = 'object'),
  voucher_series text not null default 'BL' check (voucher_series ~ '^[A-Z0-9]{1,6}$'),
  org_number text check (org_number is null or org_number ~ '^\d{6}-\d{4}$'),
  purchase_basis text not null default 'received_purchases'
    check (purchase_basis in ('received_purchases', 'cost_of_goods')),
  opening_carry_ore bigint not null default 0
    check (opening_carry_ore >= 0 and opening_carry_ore <= 100000000000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

comment on table public.bookkeeping_settings is
  'Bokföring: kontoplan, serie och VMB-inställningar per organisation (ägare och admin).';

-- -----------------------------------------------------------------------------
-- bookkeeping_months
-- -----------------------------------------------------------------------------
create table public.bookkeeping_months (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  sent_at timestamptz,
  sent_by uuid references auth.users (id) on delete set null,
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, month)
);

comment on table public.bookkeeping_months is
  'Bokföring: månader markerade som skickade (datum, vem och siffrorna som skickades).';

-- -----------------------------------------------------------------------------
-- bookkeeping_receipts
-- -----------------------------------------------------------------------------
create table public.bookkeeping_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  storage_path text not null
    check (private.storage_path_org(storage_path) is not distinct from organization_id
           and char_length(storage_path) <= 300),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 200),
  content_type text not null
    check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

-- Samma fil en gång per månad (så länge den inte är borttagen).
create unique index bookkeeping_receipts_once
  on public.bookkeeping_receipts (organization_id, month, file_sha256) where archived_at is null;
create index bookkeeping_receipts_month_idx
  on public.bookkeeping_receipts (organization_id, month) where archived_at is null;

comment on table public.bookkeeping_receipts is
  'Bokföring: kvitton per månad. Filen i den privata bucketen receipts.';

-- organization_id utan planerarstatistik (samma regel som alla tabeller, hardening).
alter table public.bookkeeping_settings alter column organization_id set statistics 0;
alter table public.bookkeeping_months alter column organization_id set statistics 0;
alter table public.bookkeeping_receipts alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Triggers: organisation, stämplar, granskningslogg
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.bookkeeping_settings
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.bookkeeping_settings
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.bookkeeping_settings
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.bookkeeping_settings
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.bookkeeping_months
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.bookkeeping_months
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.bookkeeping_months
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.bookkeeping_months
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.bookkeeping_receipts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.bookkeeping_receipts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.bookkeeping_receipts
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.bookkeeping_receipts
  for each row execute function private.audit();

-- Skickad: vem och när sätts här (inte av klienten). En månad som inte är slut
-- (organisationens tidszon) kan inte markeras som skickad.
create function private.bookkeeping_months_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if new.sent_at is null then
    new.sent_by := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.sent_at is not null then
    -- Redan skickad: tid och användare ligger kvar.
    new.sent_at := old.sent_at;
    new.sent_by := old.sent_by;
    return new;
  end if;
  select o.timezone into v_tz from public.organizations o where o.id = new.organization_id;
  if new.month >= date_trunc('month', (now() at time zone coalesce(v_tz, 'Europe/Stockholm')))::date then
    raise exception 'Månaden är inte slut och kan inte markeras som skickad.' using errcode = '22023';
  end if;
  new.sent_at := now();
  new.sent_by := auth.uid();
  return new;
end
$$;

revoke all on function private.bookkeeping_months_guard() from public, anon, authenticated, service_role;

create trigger t30_guard before insert or update on public.bookkeeping_months
  for each row execute function private.bookkeeping_months_guard();

-- -----------------------------------------------------------------------------
-- Behörigheter och policyer
-- -----------------------------------------------------------------------------
alter table public.bookkeeping_settings enable row level security;
alter table public.bookkeeping_months enable row level security;
alter table public.bookkeeping_receipts enable row level security;

revoke all on table public.bookkeeping_settings from anon, authenticated;
revoke truncate, references, trigger on table public.bookkeeping_settings from service_role;
revoke all on table public.bookkeeping_months from anon, authenticated;
revoke truncate, references, trigger on table public.bookkeeping_months from service_role;
revoke all on table public.bookkeeping_receipts from anon, authenticated;
revoke truncate, references, trigger on table public.bookkeeping_receipts from service_role;

grant select on table public.bookkeeping_settings to authenticated;
grant insert (organization_id, account_plan, voucher_series, org_number, purchase_basis,
              opening_carry_ore)
  on table public.bookkeeping_settings to authenticated;
grant update (account_plan, voucher_series, org_number, purchase_basis, opening_carry_ore)
  on table public.bookkeeping_settings to authenticated;

grant select on table public.bookkeeping_months to authenticated;
grant insert (organization_id, month, sent_at, snapshot) on table public.bookkeeping_months
  to authenticated;
grant update (sent_at, snapshot) on table public.bookkeeping_months to authenticated;

grant select on table public.bookkeeping_receipts to authenticated;
grant insert (organization_id, month, storage_path, file_name, content_type, size_bytes,
              file_sha256)
  on table public.bookkeeping_receipts to authenticated;
grant update (archived_at) on table public.bookkeeping_receipts to authenticated;

create policy bookkeeping_settings_select on public.bookkeeping_settings for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy bookkeeping_settings_insert on public.bookkeeping_settings for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy bookkeeping_settings_update on public.bookkeeping_settings for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

create policy bookkeeping_months_select on public.bookkeeping_months for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy bookkeeping_months_insert on public.bookkeeping_months for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy bookkeeping_months_update on public.bookkeeping_months for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

create policy bookkeeping_receipts_select on public.bookkeeping_receipts for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy bookkeeping_receipts_insert on public.bookkeeping_receipts for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy bookkeeping_receipts_update on public.bookkeeping_receipts for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Storage: privat bucket 'receipts' (kvitton). Samma mönster som contracts:
-- ägare, admin och läsare läser; ägare och admin laddar upp; ingen skriver över.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Schemat storage saknas: bucket receipts skapas inte.';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('receipts', 'receipts', false)
  on conflict (id) do nothing;

  -- Storlek och filtyper i bucketen också (finns kolumnerna, som i Supabase).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    execute $q$update storage.buckets
      set file_size_limit = 10485760,
          allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']
      where id = 'receipts'$q$;
  end if;

  create policy binderlab_receipts_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'receipts'
      and private.has_role(private.storage_path_org(name), 'owner', 'admin', 'viewer')
    );

  create policy binderlab_receipts_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'receipts'
      and private.has_role(private.storage_path_org(name), 'owner', 'admin')
    );
end
$$;

revoke all on all functions in schema private from public;
