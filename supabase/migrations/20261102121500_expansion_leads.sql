-- =============================================================================
-- Expansion och effekt (fas 6b och 10).
--
-- * stores: attribut för likhet mellan platser (butikstyp, ort, öppettimmar
--   per vecka, yta). Används av uppskattningen för nya platser
--   (src/analytics/expansion/similarity.ts). null = okänt.
-- * expansion_leads: tänkbara nya platser i pipelinen lead → kontaktad →
--   möte → avtal → installerad (eller förlorad), med kontaktperson,
--   anteckningar, nästa steg, samma attribut som stores, erbjudna villkor och
--   planerad investering.
-- * effect_measurements: mätvärden per månad för effekten mot utgångsläget
--   (baselines): slutsålda dagar (dagar) och tid för påfyllning och
--   administration (minuter). Vinst per automat räknas ur orderna och lagras
--   inte.
-- * effect_settings: timkostnad och värde per slutsåld dag, så att effekten
--   kan räknas i kronor. En rad per organisation.
--
-- Behörighet: ägare och admin skriver, läsaren läser. Påfyllaren ser ingenting
-- (tillåtlistan i datamodellen nämner inte tabellerna). Ändringar loggas i
-- audit_log.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Platsattribut på stores
-- -----------------------------------------------------------------------------
alter table public.stores
  add column store_type text
    check (store_type is null or char_length(btrim(store_type)) between 1 and 60),
  add column city text
    check (city is null or char_length(btrim(city)) between 1 and 100),
  add column open_hours_per_week integer
    check (open_hours_per_week is null or open_hours_per_week between 0 and 168),
  add column area_sqm integer
    check (area_sqm is null or area_sqm between 0 and 1000000);

-- -----------------------------------------------------------------------------
-- expansion_leads
-- -----------------------------------------------------------------------------
create type public.expansion_lead_stage as enum (
  'lead', 'contacted', 'meeting', 'agreement', 'installed', 'lost'
);

create table public.expansion_leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  stage public.expansion_lead_stage not null default 'lead',
  stage_changed_at timestamptz not null default now(),
  store_type text
    check (store_type is null or char_length(btrim(store_type)) between 1 and 60),
  city text check (city is null or char_length(btrim(city)) between 1 and 100),
  open_hours_per_week integer
    check (open_hours_per_week is null or open_hours_per_week between 0 and 168),
  area_sqm integer check (area_sqm is null or area_sqm between 0 and 1000000),
  address text check (address is null or char_length(address) <= 300),
  contact_name text check (contact_name is null or char_length(contact_name) <= 200),
  contact_email extensions.citext
    check (contact_email is null or char_length(contact_email::text) <= 320),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 50),
  notes text check (notes is null or char_length(notes) <= 5000),
  next_step text check (next_step is null or char_length(next_step) <= 300),
  next_step_on date,
  -- Erbjudna villkor. null = liknande platsers egna avtal används i uppskattningen.
  commission_bp integer check (commission_bp is null or commission_bp between 0 and 10000),
  monthly_rent_ore bigint check (monthly_rent_ore is null or monthly_rent_ore >= 0),
  -- Planerad investering. null = snittet av befintliga automaters investering.
  purchase_ore bigint check (purchase_ore is null or purchase_ore >= 0),
  installation_ore bigint check (installation_ore is null or installation_ore >= 0),
  -- Befintlig butik som leaden gäller (andra automat, eller platsen när den installerats).
  store_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict
);

create index expansion_leads_org_stage_idx on public.expansion_leads (organization_id, stage);

-- stage_changed_at följer steget och sätts alltid av databasen.
create function private.expansion_leads_stage_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  else
    new.stage_changed_at := old.stage_changed_at;
  end if;
  return new;
end
$$;

revoke all on function private.expansion_leads_stage_stamp() from public;

create trigger t00_forbid_org_change before update on public.expansion_leads
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.expansion_leads
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.expansion_leads
  for each row execute function private.stamp_update();
create trigger t30_stage_stamp before insert or update on public.expansion_leads
  for each row execute function private.expansion_leads_stage_stamp();
create trigger t90_audit after insert or update or delete on public.expansion_leads
  for each row execute function private.audit();

alter table public.expansion_leads alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- effect_measurements
-- -----------------------------------------------------------------------------
create table public.effect_measurements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  metric public.baseline_metric not null check (metric <> 'profit_per_machine_month'),
  scope public.target_scope not null default 'organization',
  store_id uuid,
  machine_id uuid,
  month date not null check (extract(day from month) = 1),
  -- Dagar (slutsålda dagar) eller minuter (tid). Heltal, aldrig flyttal.
  value bigint not null check (value between 0 and 1000000),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint effect_measurements_key unique nulls not distinct
    (organization_id, metric, scope, store_id, machine_id, month),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  constraint effect_measurements_scope_check check (
    (scope = 'organization' and store_id is null and machine_id is null)
    or (scope = 'store' and store_id is not null and machine_id is null)
    or (scope = 'machine' and machine_id is not null and store_id is null)
  )
);

create trigger t00_forbid_org_change before update on public.effect_measurements
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.effect_measurements
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.effect_measurements
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.effect_measurements
  for each row execute function private.audit();

alter table public.effect_measurements alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- effect_settings
-- -----------------------------------------------------------------------------
create table public.effect_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Timkostnad för påfyllning och administration, öre per timme. null = tid visas bara i tid.
  hourly_cost_ore bigint check (hourly_cost_ore is null or hourly_cost_ore between 0 and 10000000),
  -- Värde per undviken slutsåld dag, öre. null = månadens vinst per automat och dag.
  stockout_day_value_ore bigint
    check (stockout_day_value_ore is null or stockout_day_value_ore between 0 and 100000000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

create trigger t00_forbid_org_change before update on public.effect_settings
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.effect_settings
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.effect_settings
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.effect_settings
  for each row execute function private.audit();

alter table public.effect_settings alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.expansion_leads enable row level security;
revoke all on table public.expansion_leads from anon, authenticated;
grant select, insert, update, delete on table public.expansion_leads to authenticated;

create policy expansion_leads_select on public.expansion_leads
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy expansion_leads_insert on public.expansion_leads
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy expansion_leads_update on public.expansion_leads
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy expansion_leads_delete on public.expansion_leads
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.effect_measurements enable row level security;
revoke all on table public.effect_measurements from anon, authenticated;
grant select, insert, update, delete on table public.effect_measurements to authenticated;

create policy effect_measurements_select on public.effect_measurements
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy effect_measurements_insert on public.effect_measurements
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy effect_measurements_update on public.effect_measurements
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy effect_measurements_delete on public.effect_measurements
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.effect_settings enable row level security;
revoke all on table public.effect_settings from anon, authenticated;
grant select, insert, update on table public.effect_settings to authenticated;

create policy effect_settings_select on public.effect_settings
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy effect_settings_insert on public.effect_settings
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy effect_settings_update on public.effect_settings
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- Mål och utgångsläge loggas också (de styr vad sidorna Expansion och Effekt visar).
create trigger t90_audit after insert or update or delete on public.goals
  for each row execute function private.audit();
create trigger t90_audit after insert or update or delete on public.baselines
  for each row execute function private.audit();
create trigger t90_audit after insert or update or delete on public.machine_investments
  for each row execute function private.audit();
