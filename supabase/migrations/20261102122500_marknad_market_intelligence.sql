-- =============================================================================
-- Marknad (fas 11): releasekalender, leverantörspriser, fackfördelning,
-- genomförda sortimentsändringar och pristester.
--
--   releases               Kommande och tidigare kortsläpp. Manuellt nu
--                          (source = 'manual'), import senare ('import').
--                          När förslaget fastställs sparas inköpsmängden,
--                          släppkurvan och förslaget som ögonblicksbild
--                          (plan_*), så att utfallet alltid mäts mot det
--                          förslag som faktiskt gällde.
--   release_allocations    Fastställd fördelning per automat (units) och vad
--                          förslaget sa (suggested_units).
--   supplier_price_quotes  Inköpspriser från leverantörer över tid: offerter
--                          och prislistor ('quote') eller inköp som inte gått
--                          via en inköpsorder ('purchase'). Pris per pack i öre.
--   machine_slots          Fackfördelningen (planogrammet): titel X har N fack
--                          i automat A från och med valid_from till och med
--                          valid_to (null = tills vidare). Perioder för samma
--                          automat och titel får inte överlappa.
--   assortment_changes     En sortimentsrekommendation som markerats som
--                          genomförd: dag, väntad effekt och rekommendationen
--                          som ögonblicksbild. Uppföljningen räknas fram.
--   price_experiments      Startade pristester: titel, pris före och efter,
--                          test- och kontrollautomater, startdag och längd.
--
-- Behörighet: ägare och admin skriver, läsaren läser. Påfyllaren ser ingenting
-- (tabellerna innehåller priser och belopp och står inte på påfyllarens
-- tillåtlista). Inget här är bokföringsunderlag, så rader får raderas (rättelse
-- av felregistreringar); alla ändringar loggas i audit_log.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- releases
-- -----------------------------------------------------------------------------
create table public.releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  series text check (series is null or char_length(btrim(series)) between 1 and 200),
  release_date date not null,
  title_id uuid,
  supplier_id uuid,
  scale_bp integer not null default 10000 check (scale_bp between 0 and 100000),
  horizon_days integer not null default 28 check (horizon_days between 7 and 91),
  box_size integer not null default 1 check (box_size between 1 and 10000),
  min_order_qty integer not null default 0 check (min_order_qty between 0 and 1000000),
  source text not null default 'manual' check (source in ('manual', 'import')),
  external_ref text check (external_ref is null or char_length(external_ref) between 1 and 200),
  note text check (note is null or char_length(note) <= 2000),
  plan_locked_at timestamptz,
  plan_locked_by uuid references auth.users (id) on delete set null,
  plan_purchase_units integer check (plan_purchase_units between 0 and 10000000),
  plan_curve_bp integer[],
  plan_snapshot jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
    on delete restrict,
  constraint releases_plan_consistent check (
    (plan_locked_at is null and plan_purchase_units is null and plan_snapshot is null)
    or (plan_locked_at is not null and plan_purchase_units is not null)
  ),
  constraint releases_plan_curve check (
    plan_curve_bp is null or (cardinality(plan_curve_bp) between 1 and 91)
  )
);

-- En titel har ett släpp (analysen räknar släppkurvan per titel).
create unique index releases_title_unique on public.releases (organization_id, title_id)
  where title_id is not null and archived_at is null;
create index releases_date_idx on public.releases (organization_id, release_date);

-- Vem som fastställde förslaget och när sätts av databasen. Som created_by får
-- plan_locked_by bara nollas när användaren raderats (FK on delete set null).
create function private.releases_stamp_plan() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if new.plan_locked_at is null then
    new.plan_locked_by := null;
  elsif tg_op = 'INSERT' or old.plan_locked_at is null
        or old.plan_locked_at is distinct from new.plan_locked_at then
    new.plan_locked_at := now();
    new.plan_locked_by := coalesce(v_uid, new.plan_locked_by);
  elsif new.plan_locked_by is distinct from old.plan_locked_by
        and not (new.plan_locked_by is null and not private.user_exists(old.plan_locked_by)) then
    new.plan_locked_by := old.plan_locked_by;
  end if;
  return new;
end
$$;

revoke all on function private.releases_stamp_plan() from public, anon;

create trigger t00_forbid_org_change before update on public.releases
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.releases
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.releases
  for each row execute function private.stamp_update();
create trigger t30_plan_stamp before insert or update on public.releases
  for each row execute function private.releases_stamp_plan();
create trigger t90_audit after insert or update or delete on public.releases
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- release_allocations
-- -----------------------------------------------------------------------------
create table public.release_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  release_id uuid not null,
  machine_id uuid not null,
  units integer not null check (units between 0 and 100000),
  suggested_units integer check (suggested_units between 0 and 100000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, release_id, machine_id),
  foreign key (organization_id, release_id) references public.releases (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict
);

create trigger t00_forbid_org_change before update on public.release_allocations
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.release_allocations
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.release_allocations
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.release_allocations
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- supplier_price_quotes
-- -----------------------------------------------------------------------------
create table public.supplier_price_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_id uuid not null,
  title_id uuid not null,
  quoted_on date not null,
  valid_until date,
  unit_cost_ore bigint not null check (unit_cost_ore between 0 and 100000000),
  quantity integer not null default 1 check (quantity between 1 and 1000000),
  kind text not null default 'quote' check (kind in ('quote', 'purchase')),
  source text not null default 'manual' check (source in ('manual', 'import', 'market')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  constraint supplier_price_quotes_range_check check (valid_until is null or valid_until >= quoted_on)
);

create index supplier_price_quotes_title_idx
  on public.supplier_price_quotes (organization_id, title_id, quoted_on);

create trigger t00_forbid_org_change before update on public.supplier_price_quotes
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.supplier_price_quotes
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.supplier_price_quotes
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.supplier_price_quotes
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- machine_slots
-- -----------------------------------------------------------------------------
create table public.machine_slots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  title_id uuid not null,
  slots integer not null check (slots between 1 and 100),
  valid_from date not null,
  valid_to date,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  constraint machine_slots_range_check check (valid_to is null or valid_to >= valid_from),
  constraint machine_slots_no_overlap exclude using gist (
    organization_id with =,
    machine_id with =,
    title_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create trigger t00_forbid_org_change before update on public.machine_slots
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.machine_slots
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machine_slots
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.machine_slots
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- assortment_changes
-- -----------------------------------------------------------------------------
create table public.assortment_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  implemented_on date not null,
  recommendation_key text not null check (char_length(recommendation_key) between 1 and 200),
  fingerprint text not null check (char_length(fingerprint) between 1 and 4000),
  expected_effect_per_week_ore bigint not null
    check (expected_effect_per_week_ore between -100000000 and 100000000),
  changed_title_ids uuid[] not null default '{}',
  snapshot jsonb not null default '{}'::jsonb,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict
);

create index assortment_changes_machine_idx
  on public.assortment_changes (organization_id, machine_id, implemented_on desc);

create trigger t00_forbid_org_change before update on public.assortment_changes
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.assortment_changes
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.assortment_changes
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.assortment_changes
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- price_experiments
-- -----------------------------------------------------------------------------
create table public.price_experiments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title_id uuid not null,
  proposal_key text not null check (char_length(proposal_key) between 1 and 200),
  direction text not null check (direction in ('up', 'down')),
  from_ore bigint not null check (from_ore between 0 and 100000000),
  to_ore bigint not null check (to_ore between 0 and 100000000),
  started_on date not null,
  test_days integer not null check (test_days between 7 and 91),
  stopped_on date,
  test_machine_ids uuid[] not null check (cardinality(test_machine_ids) between 1 and 500),
  control_machine_ids uuid[] not null check (cardinality(control_machine_ids) between 1 and 500),
  snapshot jsonb not null default '{}'::jsonb,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  constraint price_experiments_stop_check check (stopped_on is null or stopped_on >= started_on),
  constraint price_experiments_arms_disjoint check (not (test_machine_ids && control_machine_ids)),
  constraint price_experiments_price_direction check (
    (direction = 'up' and to_ore > from_ore) or (direction = 'down' and to_ore < from_ore)
  )
);

create index price_experiments_title_idx
  on public.price_experiments (organization_id, title_id, started_on desc);

-- Test- och kontrollautomaterna måste vara organisationens egna. Körs efter
-- RLS (AFTER-trigger, security invoker): en automat i en annan organisation
-- syns inte och ger samma fel som ett id som inte finns.
create function private.price_experiments_check_machines() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct unnest(new.test_machine_ids || new.control_machine_ids));
  v_found integer;
begin
  select count(*) into v_found
  from public.machines m
  where m.organization_id = new.organization_id and m.id = any (v_ids);
  if v_found <> cardinality(v_ids) then
    raise exception using
      errcode = '23503',
      message = 'En automat i pristestet finns inte i organisationen.';
  end if;
  return null;
end
$$;

revoke all on function private.price_experiments_check_machines() from public, anon;

create trigger t00_forbid_org_change before update on public.price_experiments
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.price_experiments
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.price_experiments
  for each row execute function private.stamp_update();
create trigger t50_check_machines after insert or update of test_machine_ids, control_machine_ids
  on public.price_experiments
  for each row execute function private.price_experiments_check_machines();
create trigger t90_audit after insert or update or delete on public.price_experiments
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS: ägare och admin skriver, läsaren läser, påfyllaren
-- ingenting.
-- -----------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'releases', 'release_allocations', 'supplier_price_quotes', 'machine_slots',
    'assortment_changes', 'price_experiments'
  ]
  loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated', v_table);
    execute format('alter table public.%I alter column organization_id set statistics 0', v_table);
    execute format(
      $p$create policy %1$s_select on public.%1$I for select to authenticated
         using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))))$p$,
      v_table);
    execute format(
      $p$create policy %1$s_insert on public.%1$I for insert to authenticated
         with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))$p$,
      v_table);
    execute format(
      $p$create policy %1$s_update on public.%1$I for update to authenticated
         using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
         with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))$p$,
      v_table);
    execute format(
      $p$create policy %1$s_delete on public.%1$I for delete to authenticated
         using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))$p$,
      v_table);
  end loop;
end
$$;

revoke truncate, references, trigger on table
  public.releases, public.release_allocations, public.supplier_price_quotes,
  public.machine_slots, public.assortment_changes, public.price_experiments
  from authenticated, service_role;
