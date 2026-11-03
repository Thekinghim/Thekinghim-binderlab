-- =============================================================================
-- Flera egna lager: "Hemma" och "Kontoret".
--
-- Ett eget lager är en stock_locations-rad med kind 'warehouse'. Förut fanns exakt ett
-- (is_central). Nu kan ägare och admin skapa, byta namn på och ta bort (arkivera) egna
-- lager. is_central finns kvar och betyder standardlagret: det som används när inget
-- annat är valt (inköp från en beställning, påfyllning utan vald plats, automater utan
-- eget val). "Vårt lager" i alla siffror är summan av alla egna lager.
--
-- 1. Data: har en organisation exakt ett lager med ett allmänt namn (Centrallager …)
--    heter det nu "Hemma". Ingen historik ändras (bara namnet). Nya organisationers
--    första lager heter också "Hemma" (triggern t15_warehouse_name).
-- 2. Standardlagret kan inte vara arkiverat; aktiva lager har unika namn.
-- 3. Ett lager kan bara arkiveras när det är tomt (alla titlar 0 pack), och inga nya
--    lagerhändelser kan skrivas på ett arkiverat lager.
-- 4. stock_locations.refill_source_id: automatens "Fylls på från" (ett eget lager).
--    null = standardlagret. Awish-synken drar en påfyllning härifrån.
-- 5. register_refill / register_refill_once: ny sista parameter p_from_location (vilket
--    lager packen togs från). null = automatens "Fylls på från", annars standardlagret.
--    Awish-uttag räknas av oavsett vilket lager de drogs ur (ingen dubbel dragning); togs
--    packen från ett annat lager än Awish drog ur läggs Awish-uttaget tillbaka där.
-- 6. RPC:er: create_warehouse, rename_warehouse, archive_warehouse (med ångra),
--    set_refill_source, transfer_stock (flytt mellan lager) och undo_transfer.
--    En flytt är transfer_out + transfer_in med samma transfer_group_id: summan är
--    oförändrad.
-- 7. warehouse_stock: saldot i alla aktiva egna lager (förut bara centrallagret).
--
-- Alla uttag ur egna lager för en titel tar samma lås (private.lock_own_stock), så att
-- påfyllning, flytt och Awish-synken inte ser samma saldo samtidigt.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1–2. Namn och standardlager
-- -----------------------------------------------------------------------------

-- Ett arkiverat standardlager (ska inte finnas) tas tillbaka, så att varje organisation
-- som hade ett lager fortfarande har ett standardlager.
update public.stock_locations
set archived_at = null
where is_central and archived_at is not null;

update public.stock_locations l
set name = 'Hemma'
where l.kind = 'warehouse'
  and lower(btrim(l.name)) in (
    'centrallager', 'centrallagret', 'lager', 'lagret', 'huvudlager', 'huvudlagret',
    'vårt lager', 'eget lager', 'warehouse', 'hem'
  )
  and (
    select count(*) from public.stock_locations w
    where w.organization_id = l.organization_id and w.kind = 'warehouse'
  ) = 1;

-- Namnregler för befintliga lager (förut tilläts 200 tecken och samma namn två gånger):
-- för långa namn kortas till 60 tecken, och ett aktivt lager med samma namn som ett äldre
-- får en siffra efter ("Lager 2"). Bara namnen ändras, aldrig saldo eller historik.
update public.stock_locations
set name = left(btrim(name), 60)
where kind = 'warehouse' and char_length(btrim(name)) > 60;

update public.stock_locations l
set name = left(btrim(l.name), 55) || ' ' || d.rn
from (
  select w.id, row_number() over (
    partition by w.organization_id, lower(btrim(w.name))
    order by w.is_central desc, w.created_at, w.id
  ) as rn
  from public.stock_locations w
  where w.kind = 'warehouse' and w.archived_at is null
) d
where l.id = d.id and d.rn > 1;

alter table public.stock_locations
  add constraint stock_locations_central_active check (not (is_central and archived_at is not null)),
  add constraint stock_locations_warehouse_name
    check (kind <> 'warehouse' or char_length(btrim(name)) between 1 and 60);

create unique index stock_locations_warehouse_name_unique
  on public.stock_locations (organization_id, lower(btrim(name)))
  where kind = 'warehouse' and archived_at is null;

-- Nya organisationers första lager heter "Hemma" (create_organization skapar det som
-- "Centrallager").
create function private.stock_locations_warehouse_name() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.kind = 'warehouse' and new.is_central and lower(btrim(new.name)) = 'centrallager'
     and not exists (
       select 1 from public.stock_locations w
       where w.organization_id = new.organization_id and w.kind = 'warehouse'
     ) then
    new.name := 'Hemma';
  end if;
  return new;
end
$$;

create trigger t15_warehouse_name before insert on public.stock_locations
  for each row when (new.kind = 'warehouse')
  execute function private.stock_locations_warehouse_name();

-- -----------------------------------------------------------------------------
-- 3. Arkivering och händelser på arkiverade lager
-- -----------------------------------------------------------------------------

-- Ett eget lager kan bara arkiveras när det är tomt (inget saldo, varken plus eller minus).
create function private.stock_locations_archive_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.stock_levels sl
    where sl.organization_id = new.organization_id
      and sl.location_id = new.id
      and sl.quantity <> 0
  ) then
    raise exception using
      errcode = '22023',
      message = format('%s är inte tomt. Flytta packen till ett annat lager först.', new.name);
  end if;
  return new;
end
$$;

create trigger t30_archive_guard before update of archived_at on public.stock_locations
  for each row when (new.kind = 'warehouse' and old.archived_at is null and new.archived_at is not null)
  execute function private.stock_locations_archive_guard();

-- Inga nya lagerhändelser på ett arkiverat eget lager. Raden låses (for share) så att en
-- samtidig arkivering antingen väntar in händelsen (och ser saldot) eller hinner först
-- (och händelsen nekas).
create function private.stock_events_location_open() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind public.stock_location_kind;
  v_archived timestamptz;
begin
  select l.kind into v_kind from public.stock_locations l
  where l.organization_id = new.organization_id and l.id = new.location_id;
  if v_kind is distinct from 'warehouse' then
    return null;
  end if;
  select l.archived_at into v_archived from public.stock_locations l
  where l.organization_id = new.organization_id and l.id = new.location_id
  for share;
  if v_archived is not null then
    raise exception using errcode = '22023', message = 'Lagret är borttaget.';
  end if;
  return null;
end
$$;

create trigger t41_location_open after insert on public.stock_events
  for each row execute function private.stock_events_location_open();

-- -----------------------------------------------------------------------------
-- 4. Automatens "Fylls på från"
-- -----------------------------------------------------------------------------

alter table public.stock_locations
  add column refill_source_id uuid,
  add constraint stock_locations_refill_source_fk
    foreign key (organization_id, refill_source_id)
    references public.stock_locations (organization_id, id) on delete restrict,
  add constraint stock_locations_refill_source_machine
    check (refill_source_id is null or kind = 'machine');

comment on column public.stock_locations.refill_source_id is
  'Automatens "Fylls på från": det egna lager som påfyllningar (och Awish-uttag) dras ur. '
  'null = standardlagret (is_central).';

create function private.stock_locations_refill_source_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.stock_locations w
    where w.organization_id = new.organization_id
      and w.id = new.refill_source_id
      and w.kind = 'warehouse'
      and w.archived_at is null
  ) then
    raise exception using errcode = '22023', message = 'Välj ett av era lager.';
  end if;
  return null;
end
$$;

create trigger "A10_refill_source_check" after insert or update of refill_source_id
  on public.stock_locations
  for each row when (new.refill_source_id is not null)
  execute function private.stock_locations_refill_source_check();

-- Lagret som automatens påfyllningar dras ur: "Fylls på från" om det är ett aktivt lager,
-- annars standardlagret. null om organisationen inte har något eget lager.
create function private.refill_source_for(p_organization_id uuid, p_machine_id uuid)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (
      select w.id
      from public.stock_locations m
      join public.stock_locations w
        on w.organization_id = m.organization_id and w.id = m.refill_source_id
      where m.organization_id = p_organization_id
        and m.machine_id = p_machine_id
        and w.kind = 'warehouse'
        and w.archived_at is null
      limit 1
    ),
    (
      select c.id from public.stock_locations c
      where c.organization_id = p_organization_id and c.is_central and c.archived_at is null
      limit 1
    )
  )
$$;

-- Ett lås per organisation och titel för alla uttag ur egna lager (påfyllning, flytt,
-- Awish-synken). Synken (src/server/awish/stock.ts) använder samma nyckel.
create function private.lock_own_stock(p_organization_id uuid, p_title_id uuid) returns void
language sql security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('own-stock/' || p_organization_id::text || '/' || p_title_id::text, 0)
  )
$$;

-- Aktivt eget lager i organisationen, annars fel.
create function private.active_warehouse(p_organization_id uuid, p_location_id uuid)
returns public.stock_locations
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.stock_locations;
begin
  select * into v from public.stock_locations l
  where l.organization_id = p_organization_id and l.id = p_location_id
    and l.kind = 'warehouse' and l.archived_at is null;
  if v.id is null then
    raise exception using errcode = '22023', message = 'Lagret finns inte.';
  end if;
  return v;
end
$$;

-- Saldot för en titel i ett lager.
create function private.location_level(p_organization_id uuid, p_location_id uuid, p_title_id uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select sl.quantity from public.stock_levels sl
    where sl.organization_id = p_organization_id
      and sl.location_id = p_location_id
      and sl.title_id = p_title_id
  ), 0)::integer
$$;

-- -----------------------------------------------------------------------------
-- 5. Påfyllning från ett valt lager
-- -----------------------------------------------------------------------------

alter table public.field_submissions
  add column from_location_id uuid,
  add constraint field_submissions_from_location_fk
    foreign key (organization_id, from_location_id)
    references public.stock_locations (organization_id, id) on delete restrict;

comment on column public.field_submissions.from_location_id is
  'Lagret som packen togs från (null = automatens "Fylls på från" eller standardlagret).';

drop function public.register_refill_once(uuid, uuid, uuid, uuid, integer, boolean, timestamptz, text);
drop function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text);

create function public.register_refill(
  p_organization_id uuid,
  p_machine_id uuid,
  p_title_id uuid,
  p_quantity integer,
  p_from_warehouse boolean default true,
  p_occurred_at timestamptz default null,
  p_note text default null,
  p_from_location uuid default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_machine public.machines;
  v_title public.titles;
  v_location uuid;
  v_source uuid;
  v_source_name text;
  v_available integer;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_event uuid;
  v_prefix text;
  v_d_at timestamptz[] := '{}';
  v_d_left integer[] := '{}';
  v_d_loc uuid[] := '{}';
  v_need integer;
  v_take integer;
  v_from_source integer := 0;
  v_return_loc uuid[] := '{}';
  v_return_qty integer[] := '{}';
  v_i integer;
  v_j integer;
  v_found boolean;
  r record;
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan registrera påfyllningar.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 10000 then
    raise exception using errcode = '22023', message = 'Ange antal pack, minst 1 och högst 10 000.';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'Tiden för påfyllningen ligger i framtiden.';
  end if;
  if v_at < now() - interval '14 days' then
    raise exception using errcode = '22023',
      message = 'En påfyllning kan registreras högst 14 dagar i efterhand.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'Noteringen får vara högst 500 tecken.';
  end if;

  select * into v_machine from public.machines m
  where m.organization_id = p_organization_id and m.id = p_machine_id;
  if v_machine.id is null or v_machine.archived_at is not null then
    raise exception using errcode = '22023', message = 'Automaten finns inte i organisationen.';
  end if;

  select * into v_title from public.titles t
  where t.organization_id = p_organization_id and t.id = p_title_id;
  if v_title.id is null or v_title.merged_into_id is not null then
    raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
  end if;

  select l.id into v_location from public.stock_locations l
  where l.organization_id = p_organization_id and l.kind = 'machine' and l.machine_id = p_machine_id
  order by l.archived_at nulls first
  limit 1
  for update;
  if v_location is null then
    insert into public.stock_locations (organization_id, kind, machine_id, name)
    values (p_organization_id, 'machine', p_machine_id,
            v_machine.code || ' ' || v_machine.name)
    returning id into v_location;
  end if;

  -- Lagret packen tas från: valt lager, annars automatens "Fylls på från", annars standard.
  if p_from_location is not null and coalesce(p_from_warehouse, true) then
    v_source := (private.active_warehouse(p_organization_id, p_from_location)).id;
  else
    v_source := private.refill_source_for(p_organization_id, p_machine_id);
  end if;
  if p_from_warehouse and v_source is null then
    raise exception using errcode = '22023', message = 'Organisationen har inget eget lager.';
  end if;
  select l.name into v_source_name from public.stock_locations l
  where l.organization_id = p_organization_id and l.id = v_source;

  -- Ett lås för titelns alla egna lager (samma som flytt och Awish-synken).
  perform private.lock_own_stock(p_organization_id, p_title_id);

  -- Awish-uttag för automaten och titeln (ur vilket eget lager som helst) som
  -- påfyllningar i appen ännu inte använt.
  v_prefix := 'Awish-påfyllning ' || v_machine.code;
  for r in
    select e.seq, e.occurred_at, -e.quantity as qty, true as awish, e.location_id as loc
    from public.stock_events e
    join public.stock_locations w on w.organization_id = e.organization_id and w.id = e.location_id
    where e.organization_id = p_organization_id
      and w.kind = 'warehouse'
      -- Ett borttaget lager kan inte få tillbaka ett uttag (och var tomt när det togs bort).
      and w.archived_at is null
      and e.title_id = p_title_id
      and e.kind = 'adjustment'
      and e.source = 'awish'
      and e.quantity < 0
      and (e.note = v_prefix or left(e.note, char_length(v_prefix) + 1) = v_prefix || ' ')
      and e.created_at >= now() - interval '1 day'
    union all
    select e.seq, e.occurred_at, e.quantity as qty, false as awish, null::uuid as loc
    from public.stock_events e
    where e.organization_id = p_organization_id
      and e.location_id = v_location
      and e.title_id = p_title_id
      and e.kind = 'refill'
      and e.source is null
      and e.created_at >= now() - interval '1 day'
    order by 1
  loop
    if r.awish then
      v_d_at := v_d_at || r.occurred_at;
      v_d_left := v_d_left || r.qty;
      v_d_loc := v_d_loc || r.loc;
    else
      v_need := r.qty;
      for v_i in 1 .. coalesce(array_length(v_d_at, 1), 0) loop
        exit when v_need = 0;
        if v_d_left[v_i] > 0
           and v_d_at[v_i] between r.occurred_at - interval '30 minutes'
                               and r.occurred_at + interval '2 hours' then
          v_take := least(v_need, v_d_left[v_i]);
          v_d_left[v_i] := v_d_left[v_i] - v_take;
          v_need := v_need - v_take;
        end if;
      end loop;
    end if;
  end loop;

  -- Awish-uttag som täcker den här påfyllningen: ur källagret räknas de av, ur andra lager
  -- (eller om packen inte kom från vårt lager) läggs de tillbaka.
  v_need := p_quantity;
  for v_i in 1 .. coalesce(array_length(v_d_at, 1), 0) loop
    exit when v_need = 0;
    if v_d_left[v_i] > 0
       and v_d_at[v_i] between v_at - interval '30 minutes' and v_at + interval '2 hours' then
      v_take := least(v_need, v_d_left[v_i]);
      v_need := v_need - v_take;
      if p_from_warehouse and v_d_loc[v_i] = v_source then
        v_from_source := v_from_source + v_take;
      else
        v_found := false;
        for v_j in 1 .. coalesce(array_length(v_return_loc, 1), 0) loop
          if v_return_loc[v_j] = v_d_loc[v_i] then
            v_return_qty[v_j] := v_return_qty[v_j] + v_take;
            v_found := true;
          end if;
        end loop;
        if not v_found then
          v_return_loc := v_return_loc || v_d_loc[v_i];
          v_return_qty := v_return_qty || v_take;
        end if;
      end if;
    end if;
  end loop;

  if p_from_warehouse and p_quantity > v_from_source then
    v_available := private.location_level(p_organization_id, v_source, p_title_id);
    if v_available < p_quantity - v_from_source then
      raise exception using errcode = '22023',
        message = format('%s har bara %s pack av %s.', v_source_name, v_available, v_title.name);
    end if;
  end if;

  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
  )
  values (
    p_organization_id, v_location, p_title_id, 'refill', p_quantity, v_at, v_uid,
    coalesce(v_note, 'Påfyllning')
  )
  returning id into v_event;

  if p_from_warehouse and p_quantity > v_from_source then
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_source, p_title_id, 'adjustment', -(p_quantity - v_from_source), v_at,
      v_uid, 'Uttag till påfyllning av ' || v_machine.code
    );
  end if;
  for v_j in 1 .. coalesce(array_length(v_return_loc, 1), 0) loop
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_return_loc[v_j], p_title_id, 'adjustment', v_return_qty[v_j], v_at,
      v_uid, 'Återfört Awish-uttag ' || v_machine.code
    );
  end loop;

  return v_event;
end
$$;

revoke all on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text, uuid)
  to authenticated;

create function public.register_refill_once(
  p_organization_id uuid,
  p_client_id uuid,
  p_machine_id uuid,
  p_title_id uuid,
  p_quantity integer,
  p_from_warehouse boolean default true,
  p_occurred_at timestamptz default null,
  p_note text default null,
  p_from_location uuid default null
)
returns table (stock_event_id uuid, duplicate boolean)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.field_submissions;
  v_event uuid;
  v_at timestamptz := coalesce(p_occurred_at, now());
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan registrera påfyllningar.';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'Inskicket saknar id.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || '/field/' || p_client_id::text, 0)
  );
  select * into v_prev from public.field_submissions f
  where f.organization_id = p_organization_id and f.client_id = p_client_id;
  if v_prev.id is not null then
    if v_prev.submitted_by is distinct from v_uid
       or v_prev.machine_id <> p_machine_id
       or v_prev.title_id <> p_title_id
       or v_prev.quantity <> p_quantity then
      raise exception using errcode = '22023',
        message = 'Id:t används redan för en annan påfyllning.';
    end if;
    return query select v_prev.stock_event_id, true;
    return;
  end if;

  v_event := public.register_refill(
    p_organization_id, p_machine_id, p_title_id, p_quantity, p_from_warehouse, v_at, p_note,
    p_from_location
  );
  insert into public.field_submissions (
    organization_id, client_id, kind, machine_id, title_id, quantity, from_warehouse,
    occurred_at, stock_event_id, submitted_by, from_location_id
  )
  values (
    p_organization_id, p_client_id, 'refill', p_machine_id, p_title_id, p_quantity,
    coalesce(p_from_warehouse, true), v_at, v_event, v_uid,
    case when coalesce(p_from_warehouse, true) then p_from_location end
  );
  return query select v_event, false;
end
$$;

revoke all on function public.register_refill_once(uuid, uuid, uuid, uuid, integer, boolean, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.register_refill_once(uuid, uuid, uuid, uuid, integer, boolean, timestamptz, text, uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Lagren: skapa, byta namn, ta bort (och ångra), "Fylls på från", flytt
-- -----------------------------------------------------------------------------

create function private.assert_warehouse_editor(p_organization_id uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan ändra lagren.';
  end if;
end
$$;

-- Ett namn för ett eget lager: 1–60 tecken, unikt bland organisationens aktiva lager.
create function private.warehouse_name(
  p_organization_id uuid,
  p_name text,
  p_except uuid default null
) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(v_name) < 1 then
    raise exception using errcode = '22023', message = 'Skriv ett namn.';
  end if;
  if char_length(v_name) > 60 then
    raise exception using errcode = '22023', message = 'Namnet får vara högst 60 tecken.';
  end if;
  if exists (
    select 1 from public.stock_locations l
    where l.organization_id = p_organization_id
      and l.kind = 'warehouse'
      and l.archived_at is null
      and lower(btrim(l.name)) = lower(v_name)
      and l.id is distinct from p_except
  ) then
    raise exception using errcode = '22023',
      message = format('Det finns redan ett lager som heter %s.', v_name);
  end if;
  return v_name;
end
$$;

create function public.create_warehouse(p_organization_id uuid, p_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text;
  v_id uuid;
  v_has_central boolean;
begin
  perform private.assert_warehouse_editor(p_organization_id);
  perform pg_advisory_xact_lock(hashtextextended('warehouses/' || p_organization_id::text, 0));
  v_name := private.warehouse_name(p_organization_id, p_name);
  if (
    select count(*) from public.stock_locations l
    where l.organization_id = p_organization_id and l.kind = 'warehouse' and l.archived_at is null
  ) >= 20 then
    raise exception using errcode = '22023', message = 'Högst 20 lager.';
  end if;
  v_has_central := exists (
    select 1 from public.stock_locations l
    where l.organization_id = p_organization_id and l.is_central
  );
  insert into public.stock_locations (organization_id, kind, name, is_central)
  values (p_organization_id, 'warehouse', v_name, not v_has_central)
  returning id into v_id;
  return v_id;
end
$$;

create function public.rename_warehouse(p_organization_id uuid, p_location_id uuid, p_name text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  perform private.assert_warehouse_editor(p_organization_id);
  perform pg_advisory_xact_lock(hashtextextended('warehouses/' || p_organization_id::text, 0));
  perform private.active_warehouse(p_organization_id, p_location_id);
  v_name := private.warehouse_name(p_organization_id, p_name, p_location_id);
  update public.stock_locations
  set name = v_name
  where organization_id = p_organization_id and id = p_location_id;
end
$$;

-- Tar bort (arkiverar) ett tomt lager, eller tar tillbaka det (p_archived false, för
-- Ångra). Är det standardlagret blir det äldsta andra lagret standard. Det sista lagret
-- kan inte tas bort. Automaternas "Fylls på från" ligger kvar (ett arkiverat lager
-- räknas som standardlagret) så att Ångra tar tillbaka valet.
create function public.archive_warehouse(
  p_organization_id uuid,
  p_location_id uuid,
  p_archived boolean default true
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.stock_locations;
  v_next uuid;
begin
  perform private.assert_warehouse_editor(p_organization_id);
  perform pg_advisory_xact_lock(hashtextextended('warehouses/' || p_organization_id::text, 0));
  select * into v from public.stock_locations l
  where l.organization_id = p_organization_id and l.id = p_location_id and l.kind = 'warehouse'
  for update;
  if v.id is null then
    raise exception using errcode = '22023', message = 'Lagret finns inte.';
  end if;

  if not coalesce(p_archived, true) then
    if v.archived_at is null then
      return;
    end if;
    perform private.warehouse_name(p_organization_id, v.name, v.id);
    update public.stock_locations set archived_at = null
    where organization_id = p_organization_id and id = v.id;
    if not exists (
      select 1 from public.stock_locations l
      where l.organization_id = p_organization_id and l.is_central
    ) then
      update public.stock_locations set is_central = true
      where organization_id = p_organization_id and id = v.id;
    end if;
    return;
  end if;

  if v.archived_at is not null then
    return;
  end if;
  select l.id into v_next from public.stock_locations l
  where l.organization_id = p_organization_id and l.kind = 'warehouse'
    and l.archived_at is null and l.id <> v.id
  order by l.created_at, l.id
  limit 1;
  if v_next is null then
    raise exception using errcode = '22023', message = 'Det sista lagret kan inte tas bort.';
  end if;
  if v.is_central then
    update public.stock_locations set is_central = false
    where organization_id = p_organization_id and id = v.id;
    update public.stock_locations set is_central = true
    where organization_id = p_organization_id and id = v_next;
  end if;
  -- Spärren t30_archive_guard nekar om lagret inte är tomt (hela transaktionen rullas tillbaka).
  update public.stock_locations set archived_at = now()
  where organization_id = p_organization_id and id = v.id;
end
$$;

-- Automatens "Fylls på från". null = standardlagret.
create function public.set_refill_source(
  p_organization_id uuid,
  p_machine_id uuid,
  p_location_id uuid
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_machine public.machines;
  v_location uuid;
begin
  perform private.assert_warehouse_editor(p_organization_id);
  select * into v_machine from public.machines m
  where m.organization_id = p_organization_id and m.id = p_machine_id;
  if v_machine.id is null then
    raise exception using errcode = '22023', message = 'Automaten finns inte i organisationen.';
  end if;
  if p_location_id is not null then
    perform private.active_warehouse(p_organization_id, p_location_id);
  end if;
  select l.id into v_location from public.stock_locations l
  where l.organization_id = p_organization_id and l.machine_id = p_machine_id
  for update;
  if v_location is null then
    insert into public.stock_locations (organization_id, kind, machine_id, name, refill_source_id)
    values (p_organization_id, 'machine', p_machine_id, v_machine.code || ' ' || v_machine.name,
            p_location_id);
    return;
  end if;
  update public.stock_locations set refill_source_id = p_location_id
  where organization_id = p_organization_id and id = v_location;
end
$$;

-- Flytt mellan två egna lager: transfer_out ur det ena och transfer_in i det andra med
-- samma transfer_group_id. Aldrig fler pack än det finns i lagret man flyttar från.
create function public.transfer_stock(
  p_organization_id uuid,
  p_from uuid,
  p_to uuid,
  p_title_id uuid,
  p_quantity integer,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_from public.stock_locations;
  v_to public.stock_locations;
  v_title public.titles;
  v_available integer;
  v_group uuid := gen_random_uuid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.assert_warehouse_editor(p_organization_id);
  if p_quantity is null or p_quantity < 1 or p_quantity > 10000 then
    raise exception using errcode = '22023', message = 'Ange antal pack, minst 1 och högst 10 000.';
  end if;
  if p_from is null or p_to is null or p_from = p_to then
    raise exception using errcode = '22023', message = 'Välj två olika lager.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'Noteringen får vara högst 500 tecken.';
  end if;
  v_from := private.active_warehouse(p_organization_id, p_from);
  v_to := private.active_warehouse(p_organization_id, p_to);
  select * into v_title from public.titles t
  where t.organization_id = p_organization_id and t.id = p_title_id;
  if v_title.id is null or v_title.merged_into_id is not null then
    raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
  end if;

  perform private.lock_own_stock(p_organization_id, p_title_id);
  v_available := private.location_level(p_organization_id, v_from.id, p_title_id);
  if v_available < p_quantity then
    raise exception using errcode = '22023',
      message = format('%s har bara %s pack av %s.', v_from.name, greatest(v_available, 0), v_title.name);
  end if;

  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, performed_by, transfer_group_id, note
  ) values
    (p_organization_id, v_from.id, p_title_id, 'transfer_out', -p_quantity, v_uid, v_group,
     coalesce(v_note, 'Flytt till ' || v_to.name)),
    (p_organization_id, v_to.id, p_title_id, 'transfer_in', p_quantity, v_uid, v_group,
     coalesce(v_note, 'Flytt från ' || v_from.name));
  return v_group;
end
$$;

-- Ångra en flytt: samma antal tillbaka (en ny flytt åt andra hållet). Bara en gång.
create function public.undo_transfer(p_organization_id uuid, p_transfer_group_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_out public.stock_events;
  v_in public.stock_events;
  v_marker text := 'Ångrad flytt ' || p_transfer_group_id::text;
begin
  perform private.assert_warehouse_editor(p_organization_id);
  select * into v_out from public.stock_events e
  where e.organization_id = p_organization_id and e.transfer_group_id = p_transfer_group_id
    and e.kind = 'transfer_out'
  limit 1;
  select * into v_in from public.stock_events e
  where e.organization_id = p_organization_id and e.transfer_group_id = p_transfer_group_id
    and e.kind = 'transfer_in'
  limit 1;
  if v_out.id is null or v_in.id is null then
    raise exception using errcode = '22023', message = 'Flytten finns inte.';
  end if;
  perform private.lock_own_stock(p_organization_id, v_out.title_id);
  if exists (
    select 1 from public.stock_events e
    where e.organization_id = p_organization_id
      and e.kind = 'transfer_out'
      and e.title_id = v_out.title_id
      and e.note = v_marker
  ) then
    raise exception using errcode = '22023', message = 'Flytten är redan ångrad.';
  end if;
  return public.transfer_stock(
    p_organization_id, v_in.location_id, v_out.location_id, v_out.title_id, -v_out.quantity,
    v_marker
  );
end
$$;

revoke all on function public.create_warehouse(uuid, text) from public, anon;
revoke all on function public.rename_warehouse(uuid, uuid, text) from public, anon;
revoke all on function public.archive_warehouse(uuid, uuid, boolean) from public, anon;
revoke all on function public.set_refill_source(uuid, uuid, uuid) from public, anon;
revoke all on function public.transfer_stock(uuid, uuid, uuid, uuid, integer, text) from public, anon;
revoke all on function public.undo_transfer(uuid, uuid) from public, anon;
grant execute on function public.create_warehouse(uuid, text) to authenticated;
grant execute on function public.rename_warehouse(uuid, uuid, text) to authenticated;
grant execute on function public.archive_warehouse(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_refill_source(uuid, uuid, uuid) to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, uuid, uuid, integer, text) to authenticated;
grant execute on function public.undo_transfer(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. warehouse_stock: alla aktiva egna lager
-- -----------------------------------------------------------------------------
create or replace view public.warehouse_stock
with (security_invoker = true)
as
select sl.organization_id, sl.location_id, sl.title_id, sl.quantity, sl.last_counted_at, sl.last_event_at
from public.stock_levels sl
join public.stock_locations l
  on l.organization_id = sl.organization_id
 and l.id = sl.location_id
where l.kind = 'warehouse' and l.archived_at is null;

revoke all on table public.warehouse_stock from anon, authenticated;
grant select on table public.warehouse_stock to authenticated;

revoke all on all functions in schema private from public;
