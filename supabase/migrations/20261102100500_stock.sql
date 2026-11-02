-- =============================================================================
-- 5. Lager: stock_locations, stock_events (append-only), vyerna stock_levels
-- och warehouse_stock, samt försäljning → lagerhändelse.
-- =============================================================================

create table public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind public.stock_location_kind not null,
  machine_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  -- Centrallagret (standardlagerplatsen). Exakt ett per organisation.
  is_central boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, machine_id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  check ((kind = 'machine') = (machine_id is not null)),
  check (not is_central or kind = 'warehouse')
);

create unique index stock_locations_one_central
  on public.stock_locations (organization_id)
  where is_central;

-- quantity är förändringen (negativ för uttag), utom vid 'count' där den är
-- det räknade antalet. seq ger en entydig ordning för händelser med samma tid.
create table public.stock_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  seq bigint generated always as identity,
  location_id uuid not null,
  title_id uuid not null,
  kind public.stock_event_kind not null,
  quantity integer not null,
  occurred_at timestamptz not null default now(),
  -- Räknas alltid fram från occurred_at i organisationens tidszon.
  business_date date not null,
  performed_by uuid default auth.uid() references auth.users (id) on delete set null,
  order_id uuid,
  transfer_group_id uuid,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, order_id),
  foreign key (organization_id, location_id) references public.stock_locations (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, order_id) references public.orders (organization_id, id)
    on delete restrict,
  constraint stock_events_sale_has_order check ((kind = 'sale') = (order_id is not null)),
  constraint stock_events_sale_quantity check (kind <> 'sale' or quantity = -1),
  constraint stock_events_count_quantity check (kind <> 'count' or quantity >= 0),
  constraint stock_events_in_quantity
    check (kind not in ('refill', 'receipt', 'transfer_in') or quantity > 0),
  constraint stock_events_out_quantity check (kind not in ('waste', 'transfer_out') or quantity < 0),
  constraint stock_events_adjustment_quantity check (kind <> 'adjustment' or quantity <> 0),
  constraint stock_events_transfer_group
    check ((kind in ('transfer_in', 'transfer_out')) = (transfer_group_id is not null))
);

create index stock_events_level_idx
  on public.stock_events (organization_id, location_id, title_id, occurred_at, seq);
create index stock_events_business_date_idx on public.stock_events (organization_id, business_date);
create index stock_events_transfer_idx
  on public.stock_events (organization_id, transfer_group_id)
  where transfer_group_id is not null;

-- -----------------------------------------------------------------------------
-- Vyer
-- -----------------------------------------------------------------------------

-- Saldo per lagerplats och titel: senaste inventering plus alla händelser
-- efter den (i ordningen occurred_at, seq). Inget saldo lagras separat.
create view public.stock_levels
with (security_invoker = true)
as
with last_count as (
  select distinct on (e.organization_id, e.location_id, e.title_id)
    e.organization_id, e.location_id, e.title_id, e.quantity, e.occurred_at, e.seq
  from public.stock_events e
  where e.kind = 'count'
  order by e.organization_id, e.location_id, e.title_id, e.occurred_at desc, e.seq desc
)
select
  e.organization_id,
  e.location_id,
  e.title_id,
  (
    coalesce(max(lc.quantity), 0)
    + coalesce(
        sum(e.quantity) filter (
          where e.kind <> 'count'
            and (lc.seq is null or (e.occurred_at, e.seq) > (lc.occurred_at, lc.seq))
        ),
        0
      )
  )::integer as quantity,
  max(lc.occurred_at) as last_counted_at,
  max(e.occurred_at) as last_event_at
from public.stock_events e
left join last_count lc
  on lc.organization_id = e.organization_id
 and lc.location_id = e.location_id
 and lc.title_id = e.title_id
group by e.organization_id, e.location_id, e.title_id;

-- Centrallagrets saldo.
create view public.warehouse_stock
with (security_invoker = true)
as
select sl.organization_id, sl.location_id, sl.title_id, sl.quantity, sl.last_counted_at, sl.last_event_at
from public.stock_levels sl
join public.stock_locations l
  on l.organization_id = sl.organization_id
 and l.id = sl.location_id
where l.is_central;

-- -----------------------------------------------------------------------------
-- Triggerfunktioner
-- -----------------------------------------------------------------------------

-- Affärsdatum från occurred_at och spärr mot stängd månad (gäller inte
-- försäljning: order som importeras sent till en stängd månad sparas).
create function private.stock_events_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  select o.timezone into v_tz from public.organizations o where o.id = new.organization_id;
  if v_tz is null then
    return new;
  end if;
  new.business_date := (new.occurred_at at time zone v_tz)::date;
  if new.kind <> 'sale' then
    perform private.assert_period_open(
      new.organization_id,
      datemultirange(daterange(new.business_date, new.business_date, '[]')),
      'Lagerhändelsen'
    );
  end if;
  return new;
end
$$;

-- En flytt (transfer_out + transfer_in med samma transfer_group_id) måste gå
-- jämnt ut. Kontrolleras vid commit.
create function private.stock_events_check_transfer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_sum bigint;
  v_kinds text[];
begin
  select coalesce(sum(e.quantity), 0), array_agg(distinct e.kind::text order by e.kind::text)
    into v_sum, v_kinds
  from public.stock_events e
  where e.organization_id = new.organization_id
    and e.transfer_group_id = new.transfer_group_id;
  if v_sum <> 0 or v_kinds is distinct from array['transfer_in', 'transfer_out'] then
    raise exception using
      errcode = 'BL017',
      message = 'En lagerflytt måste ha lika många ut som in.';
  end if;
  return null;
end
$$;

-- Varje automat får en egen lagerplats.
create function private.machines_create_location() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.stock_locations (organization_id, kind, machine_id, name)
  values (new.organization_id, 'machine', new.id, new.code || ' ' || new.name)
  on conflict (organization_id, machine_id) do nothing;
  return null;
end
$$;

-- Försäljning → lagerhändelse. När ordern har både automat och titel skrivs
-- en 'sale'-händelse (−1 pack) på automatens lagerplats, utan belopp. Ändras
-- orderns titel (sammanslagning eller koppling i kön) följer händelsen med via
-- det kontrollerade undantaget i private.forbid_mutation().
create function private.orders_sync_sale_event() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_event_title uuid;
  v_location uuid;
begin
  if new.machine_id is null or new.title_id is null then
    return null;
  end if;

  select e.id, e.title_id into v_event_id, v_event_title
  from public.stock_events e
  where e.organization_id = new.organization_id
    and e.order_id = new.id;

  if v_event_id is not null then
    if v_event_title <> new.title_id then
      update public.stock_events
      set title_id = new.title_id
      where organization_id = new.organization_id and id = v_event_id;
    end if;
    return null;
  end if;

  select l.id into v_location
  from public.stock_locations l
  where l.organization_id = new.organization_id and l.machine_id = new.machine_id;

  if v_location is null then
    insert into public.stock_locations (organization_id, kind, machine_id, name)
    select m.organization_id, 'machine', m.id, m.code || ' ' || m.name
    from public.machines m
    where m.organization_id = new.organization_id and m.id = new.machine_id
    returning id into v_location;
  end if;

  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, order_id
  ) values (
    new.organization_id, v_location, new.title_id, 'sale', -1, new.ordered_at, null, new.id
  );
  return null;
end
$$;

-- När en okänd källautomat kopplas till en automat får dess order automaten
-- (och därmed sina lagerhändelser).
create function private.source_machines_backfill_orders() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.machine_id is null and new.machine_id is not null then
    update public.orders o
    set machine_id = new.machine_id
    where o.organization_id = new.organization_id
      and o.source_machine_id = new.id
      and o.machine_id is null;
  end if;
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.stock_locations
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.stock_locations
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.stock_locations
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.stock_locations
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.stock_events
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.stock_events
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.stock_events
  for each statement execute function private.forbid_truncate();
create trigger t10_prepare before insert on public.stock_events
  for each row execute function private.stock_events_before_insert();
create trigger t20_stamp_insert before insert on public.stock_events
  for each row execute function private.stamp_insert();
create constraint trigger t80_check_transfer after insert on public.stock_events
  deferrable initially deferred
  for each row when (new.transfer_group_id is not null)
  execute function private.stock_events_check_transfer();
-- Försäljning loggas inte en gång till (den kommer från ordern); allt annat gör det.
create trigger t90_audit_insert after insert on public.stock_events
  for each row when (new.kind <> 'sale')
  execute function private.audit();
create trigger t90_audit_update after update on public.stock_events
  for each row execute function private.audit();

create trigger t50_create_location after insert on public.machines
  for each row execute function private.machines_create_location();

create trigger t50_sale_event after insert or update of title_id, machine_id on public.orders
  for each row execute function private.orders_sync_sale_event();

create trigger t50_backfill_orders after update of machine_id on public.source_machines
  for each row execute function private.source_machines_backfill_orders();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------

-- stock_locations: tillåtlistad för påfyllare.
alter table public.stock_locations enable row level security;
revoke all on table public.stock_locations from anon, authenticated;
grant select, insert, update on table public.stock_locations to authenticated;

create policy stock_locations_select on public.stock_locations
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy stock_locations_insert on public.stock_locations
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy stock_locations_update on public.stock_locations
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- stock_events: tillåtlistad för påfyllare, som bara får skapa egna händelser
-- av typerna påfyllning, inventering, svinn och flytt. 'sale' skrivs bara av
-- triggern på orders.
alter table public.stock_events enable row level security;
revoke all on table public.stock_events from anon, authenticated;
grant select, insert on table public.stock_events to authenticated;

create policy stock_events_select on public.stock_events
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy stock_events_insert on public.stock_events
  for insert to authenticated
  with check (
    kind <> 'sale'
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and kind in ('refill', 'count', 'waste', 'transfer_in', 'transfer_out')
        and performed_by = (select auth.uid())
      )
    )
  );

revoke all on table public.stock_levels, public.warehouse_stock from anon, authenticated;
grant select on table public.stock_levels, public.warehouse_stock to authenticated;

revoke all on all functions in schema private from public;
