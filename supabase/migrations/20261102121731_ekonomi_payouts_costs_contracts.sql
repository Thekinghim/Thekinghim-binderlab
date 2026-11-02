-- =============================================================================
-- Fas 9 Ekonomi: utbetalningar från automatleverantören, utredda avvikelser,
-- fasta kostnader och avtalsfiler.
--
-- * payout_imports   Varje uppladdad utbetalningsfil (CSV) med antal och
--                    filens sha256. Append-only: importen är underlag.
-- * payouts          En utbetalning från leverantören (betalväxeln): period,
--                    utbetalt belopp, avgifter, återbetalningar och dag. Unik
--                    per referens; samma referens igen räknas som dubblett.
--                    Ändras aldrig (bara arkivering), raderas aldrig.
-- * payout_lines     Leverantörens specifikation per order (om den finns):
--                    ordernummer och belopp. Append-only.
-- * deviation_reviews Loggen över utredda (och återöppnade) avvikelser i
--                    avstämningen. Append-only: senaste raden per nyckel gäller.
-- * fixed_costs      Fasta kostnader (försäkring, programvara, transport …)
--                    som räknas in i kassaflödet och lönsamheten efter fasta
--                    kostnader. Arkiveras i stället för att raderas; ändringar
--                    som påverkar en stängd månad stoppas; ändringar loggas.
-- * contracts        Får villkor, rubrik, förlängning och uppgifter om den
--                    bifogade avtalsfilen. Ändringar loggas. Ett butiksavtal
--                    (store_agreements.contract_id) kan bara kopplas till ett
--                    avtal för samma butik (BL041).
-- * storage          Ny privat bucket 'contracts' med samma policymönster som
--                    imports och reports. Påfyllaren har ingen åtkomst.
--
-- Påfyllaren ser ingen av tabellerna (tillåtlistan nämner dem inte).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- payout_imports
-- -----------------------------------------------------------------------------
create table public.payout_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 255),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text,
  format text not null check (format in ('payouts', 'lines')),
  rows_total integer not null default 0 check (rows_total >= 0),
  rows_new integer not null default 0 check (rows_new >= 0),
  rows_duplicate integer not null default 0 check (rows_duplicate >= 0),
  rows_conflict integer not null default 0 check (rows_conflict >= 0),
  rows_error integer not null default 0 check (rows_error >= 0),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete set null (data_source_id),
  check (storage_path is null or private.storage_path_org(storage_path) is not distinct from organization_id)
);

create index payout_imports_org_idx on public.payout_imports (organization_id, created_at desc);

-- -----------------------------------------------------------------------------
-- payouts
-- -----------------------------------------------------------------------------
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid,
  import_id uuid,
  reference text not null check (char_length(btrim(reference)) between 1 and 100),
  period_start date not null,
  period_end date not null,
  paid_on date,
  amount_ore bigint not null,
  fees_ore bigint not null default 0 check (fees_ore >= 0),
  refunds_ore bigint check (refunds_ore >= 0),
  currency text not null default 'SEK' check (currency = 'SEK'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  note text check (note is null or char_length(note) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, reference),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete set null (data_source_id),
  foreign key (organization_id, import_id) references public.payout_imports (organization_id, id)
    on delete set null (import_id),
  check (period_end >= period_start),
  check (period_end - period_start <= 366)
);

create index payouts_period_idx on public.payouts (organization_id, period_start, period_end);

-- Utbetalningen ändras aldrig: bara arkivering (och anteckning) är tillåten.
create function private.payouts_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(old) - array['archived_at', 'note', 'updated_at', 'created_by'])
     is distinct from (to_jsonb(new) - array['archived_at', 'note', 'updated_at', 'created_by']) then
    raise exception using
      errcode = 'BL002',
      message = 'En importerad utbetalning ändras inte. Arkivera den och importera en rättad rad.';
  end if;
  return new;
end
$$;

revoke all on function private.payouts_guard() from public;

-- -----------------------------------------------------------------------------
-- payout_lines
-- -----------------------------------------------------------------------------
create table public.payout_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  payout_id uuid not null,
  import_id uuid,
  external_id text not null check (char_length(btrim(external_id)) between 1 and 100),
  amount_ore bigint not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, payout_id, external_id),
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict,
  foreign key (organization_id, import_id) references public.payout_imports (organization_id, id)
    on delete set null (import_id)
);

-- -----------------------------------------------------------------------------
-- deviation_reviews
-- -----------------------------------------------------------------------------
create table public.deviation_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  deviation_key text not null check (char_length(deviation_key) between 1 and 300),
  fingerprint text check (fingerprint is null or char_length(fingerprint) between 1 and 500),
  action text not null check (action in ('investigated', 'reopened')),
  note text check (note is null or char_length(btrim(note)) between 1 and 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  check (action <> 'investigated' or note is not null)
);

create index deviation_reviews_key_idx
  on public.deviation_reviews (organization_id, deviation_key, created_at desc);

-- -----------------------------------------------------------------------------
-- fixed_costs
-- -----------------------------------------------------------------------------
create table public.fixed_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  category text not null default 'other'
    check (category in ('insurance', 'software', 'transport', 'storage', 'other')),
  amount_ore bigint not null check (amount_ore >= 0 and amount_ore <= 100000000000),
  interval text not null check (interval in ('month', 'quarter', 'year')),
  starts_on date not null,
  ends_on date,
  machine_id uuid,
  note text check (note is null or char_length(note) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  check (ends_on is null or ends_on >= starts_on)
);

create index fixed_costs_org_idx on public.fixed_costs (organization_id, starts_on);

-- Månadsstängning: en fast kostnad påverkar lönsamheten de dagar den gäller.
-- Ny eller arkiverad kostnad: hela intervallet. Ändrade villkor (belopp,
-- intervall, automat): båda intervallen. Bara ändrat intervall: de dagar som
-- läggs till eller tas bort. Namn, kategori och anteckning påverkar inget.
-- AFTER-trigger, så att RLS först har godkänt raden.
create function private.fixed_costs_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta text[] := array[
    'id', 'name', 'category', 'note', 'starts_on', 'ends_on',
    'created_at', 'created_by', 'updated_at'
  ];
  v_old datemultirange;
  v_new datemultirange;
  v_affected datemultirange;
begin
  if tg_op = 'UPDATE' then
    v_old := datemultirange(daterange(old.starts_on, old.ends_on, '[]'));
  end if;
  v_new := datemultirange(daterange(new.starts_on, new.ends_on, '[]'));

  if tg_op = 'INSERT' then
    v_affected := v_new;
  elsif (old.archived_at is null) <> (new.archived_at is null) then
    v_affected := v_old + v_new;
  elsif (to_jsonb(old) - v_meta) is distinct from (to_jsonb(new) - v_meta) then
    v_affected := v_old + v_new;
  else
    v_affected := (v_old - v_new) + (v_new - v_old);
  end if;

  perform private.assert_period_open(new.organization_id, v_affected, 'Den fasta kostnaden');
  return null;
end
$$;

revoke all on function private.fixed_costs_period_guard() from public, anon;

-- -----------------------------------------------------------------------------
-- contracts: villkor, rubrik, förlängning och avtalsfilen
-- -----------------------------------------------------------------------------
alter table public.contracts
  add column title text check (title is null or char_length(btrim(title)) between 1 and 200),
  add column terms text check (terms is null or char_length(terms) <= 4000),
  add column renewal_months integer check (renewal_months between 1 and 120),
  add column file_name text check (file_name is null or char_length(btrim(file_name)) between 1 and 255),
  add column file_content_type text
    check (file_content_type is null or file_content_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  add column file_size_bytes bigint check (file_size_bytes >= 0),
  add column file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint contracts_file_complete check (
    (storage_path is null) = (file_name is null)
    and (storage_path is null) = (file_sha256 is null)
  );

-- Ett butiksavtal kan bara höra till ett avtal för samma butik.
create function private.store_agreements_contract_store() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_store uuid;
begin
  if new.contract_id is null then
    return null;
  end if;
  select c.store_id into v_store
  from public.contracts c
  where c.organization_id = new.organization_id and c.id = new.contract_id;
  if v_store is distinct from new.store_id then
    raise exception using
      errcode = 'BL041',
      message = 'Villkoren och avtalet gäller olika butiker.';
  end if;
  return null;
end
$$;

revoke all on function private.store_agreements_contract_store() from public, anon;

-- Avtalets butik kan inte bytas när villkor är kopplade till det.
create function private.contracts_keep_store() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.store_id is distinct from old.store_id and exists (
    select 1 from public.store_agreements a
    where a.organization_id = new.organization_id and a.contract_id = new.id
  ) then
    raise exception using
      errcode = 'BL041',
      message = 'Avtalet har villkor kopplade till sin butik. Koppla bort dem först.';
  end if;
  return null;
end
$$;

revoke all on function private.contracts_keep_store() from public, anon;

create trigger t45_contract_store after insert or update of contract_id, store_id
  on public.store_agreements
  for each row execute function private.store_agreements_contract_store();
create trigger t45_keep_store after update of store_id on public.contracts
  for each row execute function private.contracts_keep_store();
create trigger t90_audit after insert or update on public.contracts
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.payout_imports
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.payout_imports
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.payout_imports
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.payout_imports
  for each row execute function private.stamp_insert();

create trigger t00_forbid_org_change before update on public.payouts
  for each row execute function private.forbid_org_change();
create trigger t10_guard before update on public.payouts
  for each row execute function private.payouts_guard();
create trigger t20_stamp_insert before insert on public.payouts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.payouts
  for each row execute function private.stamp_update();
create trigger t90_audit after update on public.payouts
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.payouts
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.payout_lines
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.payout_lines
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.payout_lines
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.payout_lines
  for each row execute function private.stamp_insert();

create trigger t00_forbid_org_change before update on public.deviation_reviews
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.deviation_reviews
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.deviation_reviews
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.deviation_reviews
  for each row execute function private.stamp_insert();
create trigger t90_audit after insert on public.deviation_reviews
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.fixed_costs
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.fixed_costs
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.fixed_costs
  for each row execute function private.stamp_update();
create trigger t40_period_guard after insert or update on public.fixed_costs
  for each row execute function private.fixed_costs_period_guard();
create trigger t90_audit after insert or update on public.fixed_costs
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.fixed_costs
  for each row execute function private.forbid_delete();

alter table public.payout_imports alter column organization_id set statistics 0;
alter table public.payouts alter column organization_id set statistics 0;
alter table public.payout_lines alter column organization_id set statistics 0;
alter table public.deviation_reviews alter column organization_id set statistics 0;
alter table public.fixed_costs alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS (ägare och admin skriver, läsaren läser, påfyllaren inget)
-- -----------------------------------------------------------------------------
alter table public.payout_imports enable row level security;
revoke all on table public.payout_imports from anon, authenticated;
grant select, insert on table public.payout_imports to authenticated;

create policy payout_imports_select on public.payout_imports
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy payout_imports_insert on public.payout_imports
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.payouts enable row level security;
revoke all on table public.payouts from anon, authenticated;
grant select, insert on table public.payouts to authenticated;
grant update (archived_at, note) on table public.payouts to authenticated;

create policy payouts_select on public.payouts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy payouts_insert on public.payouts
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payouts_update on public.payouts
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.payout_lines enable row level security;
revoke all on table public.payout_lines from anon, authenticated;
grant select, insert on table public.payout_lines to authenticated;

create policy payout_lines_select on public.payout_lines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy payout_lines_insert on public.payout_lines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.deviation_reviews enable row level security;
revoke all on table public.deviation_reviews from anon, authenticated;
grant select, insert on table public.deviation_reviews to authenticated;

create policy deviation_reviews_select on public.deviation_reviews
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy deviation_reviews_insert on public.deviation_reviews
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.fixed_costs enable row level security;
revoke all on table public.fixed_costs from anon, authenticated;
grant select, insert on table public.fixed_costs to authenticated;
grant update (name, category, amount_ore, interval, starts_on, ends_on, machine_id, note, archived_at)
  on table public.fixed_costs to authenticated;

create policy fixed_costs_select on public.fixed_costs
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy fixed_costs_insert on public.fixed_costs
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy fixed_costs_update on public.fixed_costs
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Storage: bucket 'contracts' (avtalsfiler). Samma mönster som imports/reports.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Schemat storage saknas: bucket contracts skapas inte.';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('contracts', 'contracts', false)
  on conflict (id) do nothing;

  create policy binderlab_contracts_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'contracts'
      and private.has_role(
        private.storage_path_org(name), 'owner', 'admin', 'viewer'
      )
    );

  create policy binderlab_contracts_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'contracts'
      and private.has_role(private.storage_path_org(name), 'owner', 'admin')
    );
end
$$;

revoke all on all functions in schema private from public;
