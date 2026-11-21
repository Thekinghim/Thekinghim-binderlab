-- =============================================================================
-- V2: dagens rutt och partnerns lager (docs/design/v2/byggplan.md, avsnitt 3.2 och 3.4).
--
-- Bara tillägg. Äldre kod som inte känner till kolumnerna fungerar som förut.
--
-- 1. organization_settings: dagens gräns för rutten (ägarbeslut b, byggs som inställning).
--    * route_max_stops  standard 6   (1–30)   besök per dag
--    * route_max_packs  standard 350 (1–5000) pack per dag
--    * route_weekdays   standard {1,2,3,4,5}  besöksdagar (1 = måndag), som i dag mån–fre
--    Läses av alla roller via public.route_settings() (påfyllaren läser inte
--    organization_settings), ändras av ägare och admin (befintliga policyer, kolumnrätt).
--
-- 2. stock_locations: adress och koordinat för egna lager, så att Hemma blir ruttens start
--    och slut (depån). Bara för kind = 'warehouse', och båda koordinaterna eller ingen.
--
-- 3. stock_locations: partnerns lager (ägarbeslut a, byggs som val). held_by = 'own'
--    (standard, oförändrat) eller 'partner' med partner_store_id (butiken som håller
--    lagret). Standard är oförändrat: refill_source_id null = standardlagret (Hemma).
--
-- 4. route_day_changes: ändringar i dagens rutt (hoppa över, lägg till, till i morgon).
--    Läses av alla medlemmar, skrivs av ägare, admin och påfyllare (samma som Fyll på).
--    En ändring ångras genom att undone_at sätts (raden finns kvar). Högst en gällande
--    ändring per automat och dag.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Dagens gräns
-- -----------------------------------------------------------------------------

alter table public.organization_settings
  add column route_max_stops integer not null default 6
    check (route_max_stops between 1 and 30),
  add column route_max_packs integer not null default 350
    check (route_max_packs between 1 and 5000),
  add column route_weekdays smallint[] not null default '{1,2,3,4,5}'
    check (
      cardinality(route_weekdays) between 1 and 7
      and route_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]
      and array_position(route_weekdays, null) is null
    );

comment on column public.organization_settings.route_max_stops is
  'Dagens rutt: högst så många besök per dag (standard 6).';
comment on column public.organization_settings.route_max_packs is
  'Dagens rutt: högst så många pack per dag (standard 350).';
comment on column public.organization_settings.route_weekdays is
  'Dagens rutt: besöksdagar, 1 = måndag … 7 = söndag (standard mån–fre).';

grant update (route_max_stops, route_max_packs, route_weekdays)
  on table public.organization_settings to authenticated;

-- Ruttens inställningar för alla roller i organisationen (påfyllaren läser inte
-- organization_settings). Utan rad: standardvärdena.
create function public.route_settings(p_organization_id uuid)
returns table (max_stops integer, max_packs integer, weekdays smallint[])
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller', 'viewer') then
    raise exception using errcode = '42501', message = 'Du är inte med i organisationen.';
  end if;
  return query
    select coalesce(s.route_max_stops, 6),
           coalesce(s.route_max_packs, 350),
           coalesce(s.route_weekdays, '{1,2,3,4,5}'::smallint[])
    from (select 1) one
    left join public.organization_settings s on s.organization_id = p_organization_id;
end
$$;

revoke all on function public.route_settings(uuid) from public, anon;
grant execute on function public.route_settings(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2–3. Lagrets plats och partnerns lager
-- -----------------------------------------------------------------------------

alter table public.stock_locations
  add column address text check (address is null or char_length(btrim(address)) between 1 and 300),
  add column latitude double precision check (latitude is null or latitude between -90 and 90),
  add column longitude double precision check (longitude is null or longitude between -180 and 180),
  add column held_by text not null default 'own' check (held_by in ('own', 'partner')),
  add column partner_store_id uuid;

alter table public.stock_locations
  add constraint stock_locations_place_warehouse
    check (kind = 'warehouse' or (address is null and latitude is null and longitude is null)),
  add constraint stock_locations_coordinates_pair
    check ((latitude is null) = (longitude is null)),
  add constraint stock_locations_partner_store
    check (
      (held_by = 'own' and partner_store_id is null)
      or (held_by = 'partner' and partner_store_id is not null and kind = 'warehouse')
    ),
  add constraint stock_locations_partner_store_fk
    foreign key (organization_id, partner_store_id)
    references public.stores (organization_id, id) on delete restrict;

create index stock_locations_partner_store_idx
  on public.stock_locations (organization_id, partner_store_id)
  where partner_store_id is not null;

comment on column public.stock_locations.address is
  'Eget lagers adress (bara lager). Visas i rutten.';
comment on column public.stock_locations.latitude is
  'Eget lagers latitud (bara lager). Standardlagrets plats är ruttens start och slut.';
comment on column public.stock_locations.longitude is
  'Eget lagers longitud (bara lager).';
comment on column public.stock_locations.held_by is
  'own = vårt eget lager (standard), partner = lager som en partnerbutik håller åt oss.';
comment on column public.stock_locations.partner_store_id is
  'Butiken som håller partnerns lager (bara när held_by = partner).';

-- Kolumnerna ändras av ägare och admin (stock_locations_update, oförändrad).

-- -----------------------------------------------------------------------------
-- 4. route_day_changes
-- -----------------------------------------------------------------------------

create table public.route_day_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  day date not null,
  machine_id uuid not null,
  change text not null check (change in ('skip', 'add', 'later')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict
);

comment on table public.route_day_changes is
  'Ändringar i dagens rutt: hoppa över (skip), lägg till (add), till i morgon (later). Ångras med undone_at.';

create unique index route_day_changes_active_unique
  on public.route_day_changes (organization_id, day, machine_id)
  where undone_at is null;
create index route_day_changes_day_idx
  on public.route_day_changes (organization_id, day);

-- Bara undone_at (och vem) får ändras, och bara en gång: allt annat står kvar.
create function private.route_day_changes_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.day is distinct from old.day
     or new.machine_id is distinct from old.machine_id
     or new.change is distinct from old.change
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception using errcode = '22023', message = 'En ändring i rutten kan bara ångras.';
  end if;
  if old.undone_at is not null then
    raise exception using errcode = '22023', message = 'Ändringen är redan ångrad.';
  end if;
  if new.undone_at is not null then
    new.undone_by := coalesce(auth.uid(), new.undone_by);
  end if;
  return new;
end
$$;

revoke all on function private.route_day_changes_guard() from public;

create trigger t00_forbid_org_change before update on public.route_day_changes
  for each row execute function private.forbid_org_change();
create trigger t01_no_delete before delete on public.route_day_changes
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.route_day_changes
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.route_day_changes
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.route_day_changes
  for each row execute function private.stamp_update();
create trigger t30_guard before update on public.route_day_changes
  for each row execute function private.route_day_changes_guard();
create trigger t90_audit after insert or update on public.route_day_changes
  for each row execute function private.audit();

alter table public.route_day_changes alter column organization_id set statistics 0;

alter table public.route_day_changes enable row level security;
revoke all on table public.route_day_changes from anon, authenticated, service_role;
grant select, insert on table public.route_day_changes to authenticated;
grant update (undone_at) on table public.route_day_changes to authenticated;
grant select, insert, update on table public.route_day_changes to service_role;

create policy route_day_changes_select on public.route_day_changes
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer')))
  );

create policy route_day_changes_insert on public.route_day_changes
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and undone_at is null
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller')))
  );

create policy route_day_changes_update on public.route_day_changes
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller'))));
