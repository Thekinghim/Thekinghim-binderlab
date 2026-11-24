-- =============================================================================
-- Butikspåfyllare (rollen machine_refiller): personal i en butik som bara fyller på
-- sina automater. Loggar in med mobilnummer och PIN-kod (private.phone_logins).
--
--   * phone_logins och membership_machines ligger i schemat private: bara servern.
--   * Rollen finns inte i någon befintlig policy: den ser 0 rader överallt. Allt den
--     behöver går genom staff_my_machines() och staff_fill_data(), som kontrollerar
--     automaten (membership_machines) och att kontot inte är avstängt.
--   * Skrivningar: register_refill, register_refill_once och undo_field_refills släpper
--     in butikspåfyllaren för sina automater. Hen väljer aldrig lager: packen tas ur
--     automatens "Fylls på från" om det är ett annat lager än standardlagret, annars
--     spåras de inte. Räcker lagret inte sparas påfyllningen ändå, utan uttag och med
--     noteringen "Butikens lager räckte inte – kontrollera lagret".
--   * Inga priser, ingen försäljning, inga kontaktuppgifter, inga andra automater.
--
-- Ingen data sätts här.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. phone_logins: inloggning med mobilnummer och PIN-kod (bara serverns systemroll)
-- -----------------------------------------------------------------------------

create table private.phone_logins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone_e164 text not null unique check (phone_e164 ~ '^\+46[1-9][0-9]{6,9}$'),
  pin_hash text not null check (char_length(pin_hash) between 20 and 500),
  must_change_pin boolean not null default true,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  disabled_at timestamptz,
  last_used_at timestamptz,
  -- Senaste felaktiga försöket: fel som är äldre än ett dygn räknas inte (under 10 fel).
  last_failed_at timestamptz,
  -- sha256 (hex) av QR-kodens hemliga nyckel (/m/<nyckel>). Ny QR-kod byter nyckel.
  qr_token_hash text unique check (qr_token_hash ~ '^[0-9a-f]{64}$'),
  -- Sessioner utfärdade före den här tiden gäller inte (ny PIN-kod, avstängning).
  sessions_valid_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table private.phone_logins is
  'Inloggning med mobilnummer och PIN-kod (scrypt-hash). Läses och skrivs bara av servern '
  '(schemat private: ingen klientroll når tabellen).';

alter table private.phone_logins enable row level security;
revoke all on table private.phone_logins from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. membership_machines: vilka automater en butikspåfyllare får fylla på
-- -----------------------------------------------------------------------------

create table private.membership_machines (
  organization_id uuid not null,
  membership_id uuid not null,
  machine_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (membership_id, machine_id),
  foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id) on delete cascade,
  foreign key (organization_id, machine_id)
    references public.machines (organization_id, id) on delete cascade
);

create index membership_machines_machine_idx on private.membership_machines (organization_id, machine_id);

comment on table private.membership_machines is
  'Butikspåfyllarens automater (bara medlemskap med rollen machine_refiller).';

create function private.membership_machines_role_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.organization_id = new.organization_id and m.id = new.membership_id
      and m.role = 'machine_refiller'
  ) then
    raise exception using errcode = '22023', message = 'Bara butikspåfyllare kan kopplas till automater.';
  end if;
  return new;
end
$$;

revoke all on function private.membership_machines_role_check() from public;

create trigger "A10_role_check" before insert on private.membership_machines
  for each row execute function private.membership_machines_role_check();

-- Bara servern (systemrollen) läser och skriver, efter rollkontroll (ägare och admin).
-- Påfyllaren når sina rader bara genom funktionerna nedan.
alter table private.membership_machines enable row level security;
revoke all on table private.membership_machines from public, anon, authenticated;

-- Ett medlemskap byter aldrig roll till eller från machine_refiller från en klient: kontot
-- loggar in med mobilnummer och PIN-kod och får aldrig appen (ta bort och skapa nytt i stället).
create function private.memberships_machine_refiller_fixed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (old.role = 'machine_refiller' or new.role = 'machine_refiller')
     and old.role is distinct from new.role then
    raise exception using errcode = '42501',
      message = 'En påfyllare i butiken kan inte byta roll. Hantera på automatens sida.';
  end if;
  return new;
end
$$;

revoke all on function private.memberships_machine_refiller_fixed() from public;

create trigger t11_machine_refiller_fixed before update of role on public.memberships
  for each row execute function private.memberships_machine_refiller_fixed();

-- -----------------------------------------------------------------------------
-- 3. Kontrollerna
-- -----------------------------------------------------------------------------

-- Har den inloggade ett aktivt konto som butikspåfyllare i organisationen? (Mobilinloggning
-- som inte är avstängd och använts de senaste 90 dagarna.)
create function private.staff_active(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join private.phone_logins p on p.user_id = m.user_id
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = 'machine_refiller'
      and p.disabled_at is null
      and coalesce(p.last_used_at, p.created_at) > now() - interval '90 days'
      -- En token (direkt mot PostgREST) utfärdad före ny PIN-kod eller avstängning gäller
      -- inte. Appens egna anrop har ingen iat; där kontrollerar servern sessionen.
      and (p.sessions_valid_after is null
           or not (coalesce(auth.jwt(), '{}'::jsonb) ? 'iat')
           or (auth.jwt() ->> 'iat')::bigint
              >= extract(epoch from date_trunc('second', p.sessions_valid_after))::bigint)
  )
$$;

-- Får den inloggade fylla på automaten som butikspåfyllare?
create function private.staff_can_fill(p_org uuid, p_machine uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.staff_active(p_org) and exists (
    select 1
    from public.memberships m
    join private.membership_machines mm
      on mm.organization_id = m.organization_id and mm.membership_id = m.id
    join public.machines ma on ma.organization_id = mm.organization_id and ma.id = mm.machine_id
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = 'machine_refiller'
      and mm.machine_id = p_machine
      and ma.archived_at is null
  )
$$;

-- Lagret som butikspåfyllarens packen tas ur: automatens "Fylls på från" om det är ett
-- aktivt lager och inte standardlagret, annars null (spåras inte).
create function private.staff_refill_source(p_org uuid, p_machine uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select w.id
  from public.stock_locations m
  join public.stock_locations w on w.organization_id = m.organization_id and w.id = m.refill_source_id
  where m.organization_id = p_org
    and m.kind = 'machine'
    and m.machine_id = p_machine
    and w.kind = 'warehouse'
    and w.archived_at is null
    and not w.is_central
  order by m.archived_at nulls first
  limit 1
$$;

-- Bara funktionerna nedan (security definer) anropar dem: ingen klientroll.
revoke all on function private.staff_active(uuid) from public, anon, authenticated;
revoke all on function private.staff_can_fill(uuid, uuid) from public, anon, authenticated;
revoke all on function private.staff_refill_source(uuid, uuid) from public, anon, authenticated;

-- Butiken där automaten står i dag (bara namnet).
create function private.machine_store_name(p_org uuid, p_machine uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select s.name
  from public.machine_placements pl
  join public.stores s on s.organization_id = pl.organization_id and s.id = pl.store_id
  where pl.organization_id = p_org
    and pl.machine_id = p_machine
    and pl.valid_from <= (now() at time zone 'Europe/Stockholm')::date
    and (pl.valid_to is null or pl.valid_to >= (now() at time zone 'Europe/Stockholm')::date)
  order by pl.valid_from desc
  limit 1
$$;

revoke all on function private.machine_store_name(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Det butikspåfyllaren ser
-- -----------------------------------------------------------------------------

create function public.staff_my_machines()
returns table (organization_id uuid, machine_id uuid, code text, name text, store_name text)
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id, ma.id, ma.code, ma.name,
         private.machine_store_name(m.organization_id, ma.id)
  from public.memberships m
  join private.membership_machines mm
    on mm.organization_id = m.organization_id and mm.membership_id = m.id
  join public.machines ma on ma.organization_id = mm.organization_id and ma.id = mm.machine_id
  where m.user_id = (select auth.uid())
    and m.role = 'machine_refiller'
    and private.staff_can_fill(m.organization_id, ma.id)
  order by ma.code
$$;

revoke all on function public.staff_my_machines() from public, anon;
grant execute on function public.staff_my_machines() to authenticated;

-- Allt Fyll på-skärmen för butiken behöver om en automat: bara antal.
create function public.staff_fill_data(p_org uuid, p_machine uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_machine public.machines;
  v_loc public.stock_locations;
  v_src uuid;
  v_rows jsonb;
begin
  if auth.uid() is null or not private.staff_can_fill(p_org, p_machine) then
    raise exception using errcode = '42501', message = 'Du kan inte fylla på den här automaten.';
  end if;
  select * into v_machine from public.machines m where m.organization_id = p_org and m.id = p_machine;
  select * into v_loc from public.stock_locations l
  where l.organization_id = p_org and l.kind = 'machine' and l.machine_id = p_machine
  order by l.archived_at nulls first
  limit 1;
  v_src := private.staff_refill_source(p_org, p_machine);

  -- Pack i automaten: vårt lager på automatens plats när det finns (har påfyllningar efter
  -- Awish-läsningen med), annars Awish-läsningen (samma regel som fillUnitsOf i appen).
  with awish as (
    select (e ->> 'title_id')::uuid as title_id,
           greatest(coalesce((e ->> 'units')::integer, 0), 0) as units,
           greatest(coalesce((e ->> 'capacity')::integer, 0), 0) as capacity
    from jsonb_array_elements(coalesce(v_loc.awish_fill, '[]'::jsonb)) e
    where e ? 'title_id'
  ),
  fill as (
    select a.title_id,
           greatest(coalesce(sl.quantity::integer, a.units), 0) as units,
           a.capacity
    from awish a
    left join public.stock_levels sl
      on sl.organization_id = p_org and sl.location_id = v_loc.id and sl.title_id = a.title_id
  ),
  levels as (
    select sl.title_id, sl.quantity::integer as units
    from public.stock_levels sl
    where sl.organization_id = p_org and sl.location_id = v_loc.id and sl.quantity > 0
  ),
  list as (
    select f.title_id, f.units, f.capacity from fill f
    union all
    select l.title_id, l.units, null::integer from levels l
    where v_loc.awish_fill is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'title_id', t.id,
           'title', t.name,
           'units', li.units,
           'capacity', li.capacity,
           'suggested', case when li.capacity is null then 0 else greatest(li.capacity - li.units, 0) end,
           'store_stock', case when v_src is null then null
                               else private.location_level(p_org, v_src, t.id) end
         ) order by t.name), '[]'::jsonb)
    into v_rows
  from list li
  join public.titles t on t.organization_id = p_org and t.id = li.title_id;

  return jsonb_build_object(
    'machine_id', v_machine.id,
    'code', v_machine.code,
    'name', v_machine.name,
    'store_name', private.machine_store_name(p_org, p_machine),
    'synced_at', v_loc.awish_synced_at,
    'tracks_store_stock', v_src is not null,
    'rows', v_rows
  );
end
$$;

revoke all on function public.staff_fill_data(uuid, uuid) from public, anon;
grant execute on function public.staff_fill_data(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Påfyllning och Ångra: samma funktioner som appen, med butikspåfyllaren insläppt
--    för sina automater (kroppar från 20261104210000_flera_lager.sql och
--    20261105020000_fyll_pa_angra.sql, ändrade bara där det står).
-- -----------------------------------------------------------------------------

create or replace function public.register_refill(
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
  v_staff boolean := false;
  v_withdraw integer;
begin
  if v_uid is null
     or not (private.has_role(p_organization_id, 'owner', 'admin', 'refiller')
             or private.staff_can_fill(p_organization_id, p_machine_id)) then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan registrera påfyllningar.';
  end if;
  -- Butikspåfyllaren väljer aldrig lager: packen tas ur automatens "Fylls på från" om det
  -- är ett annat lager än standardlagret (butikens lager), annars spåras de inte.
  if not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    v_staff := true;
    p_from_location := null;
    p_from_warehouse := private.staff_refill_source(p_organization_id, p_machine_id) is not null;
    -- Tid och notering väljs aldrig av telefonen: nu, och ingen egen text.
    v_at := now();
    v_note := null;
    if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
      raise exception using errcode = '22023', message = 'Ange antal pack, minst 1 och högst 500.';
    end if;
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

  v_withdraw := case when p_from_warehouse then greatest(p_quantity - v_from_source, 0) else 0 end;
  if v_withdraw > 0 then
    v_available := private.location_level(p_organization_id, v_source, p_title_id);
    if v_staff and v_available < v_withdraw then
      -- Butikspåfyllaren stoppas aldrig: det som finns tas ur butikens lager, resten
      -- sparas utan uttag, med en varning.
      v_withdraw := greatest(v_available, 0);
      v_note := concat_ws(' – ', v_note, 'Butikens lager räckte inte – kontrollera lagret');
    elsif v_available < v_withdraw then
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

  if v_withdraw > 0 then
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_source, p_title_id, 'adjustment', -v_withdraw, v_at,
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


create or replace function public.register_refill_once(
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
  v_src uuid;
begin
  if v_uid is null
     or not (private.has_role(p_organization_id, 'owner', 'admin', 'refiller')
             or private.staff_can_fill(p_organization_id, p_machine_id)) then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan registrera påfyllningar.';
  end if;
  -- Butikspåfyllaren: samma val av lager som i register_refill (sparas i inskicket).
  if not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    p_from_location := null;
    p_occurred_at := null;
    p_note := null;
    v_at := now();
    v_src := private.staff_refill_source(p_organization_id, p_machine_id);
    p_from_warehouse := v_src is not null;
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


create or replace function public.undo_field_refills(p_organization_id uuid, p_client_ids uuid[])
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_packs integer := 0;
  f public.field_submissions;
  v_event public.stock_events;
  v_code text;
  w record;
  v_app boolean := private.has_role(p_organization_id, 'owner', 'admin', 'refiller');
begin
  if v_uid is null or not (v_app or private.staff_active(p_organization_id)) then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan ångra påfyllningar.';
  end if;
  if p_client_ids is null or coalesce(array_length(p_client_ids, 1), 0) = 0 then
    return 0;
  end if;
  if array_length(p_client_ids, 1) > 200 then
    raise exception using errcode = '22023', message = 'För många påfyllningar på en gång.';
  end if;

  for f in
    select * from public.field_submissions s
    where s.organization_id = p_organization_id
      and s.client_id = any (p_client_ids)
    order by s.created_at
    for update
  loop
    if f.submitted_by is distinct from v_uid then
      raise exception using errcode = '42501', message = 'Du kan bara ångra dina egna påfyllningar.';
    end if;
    if not v_app and not private.staff_can_fill(p_organization_id, f.machine_id) then
      raise exception using errcode = '42501', message = 'Du kan bara ångra dina egna påfyllningar.';
    end if;
    continue when f.undone_at is not null;
    if f.received_at < now() - interval '30 minutes' then
      raise exception using errcode = '22023', message = 'För sent att ångra. Rätta med Fel antal.';
    end if;

    select * into v_event from public.stock_events e
    where e.organization_id = p_organization_id and e.id = f.stock_event_id;
    select m.code into v_code from public.machines m
    where m.organization_id = p_organization_id and m.id = f.machine_id;

    perform private.lock_own_stock(p_organization_id, f.title_id);

    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_event.location_id, f.title_id, 'adjustment', -v_event.quantity, now(),
      v_uid, 'Ångrad påfyllning ' || v_event.id::text
    );

    -- Uttagen ur (och återföringarna till) våra lager som påfyllningen skrev.
    for w in
      select e.id, e.location_id, e.quantity from public.stock_events e
      join public.stock_locations l on l.organization_id = e.organization_id and l.id = e.location_id
      where e.organization_id = p_organization_id
        and l.kind = 'warehouse'
        and e.title_id = f.title_id
        and e.kind = 'adjustment'
        and e.source is null
        and e.created_at = v_event.created_at
        and e.performed_by is not distinct from v_event.performed_by
        and e.note in ('Uttag till påfyllning av ' || v_code, 'Återfört Awish-uttag ' || v_code)
        and not exists (
          select 1 from public.stock_events x
          where x.organization_id = p_organization_id
            and x.location_id = e.location_id
            and x.title_id = e.title_id
            and x.note = 'Ångrad påfyllning ' || e.id::text
        )
    loop
      insert into public.stock_events (
        organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
      )
      values (
        p_organization_id, w.location_id, f.title_id, 'adjustment', -w.quantity, now(), v_uid,
        'Ångrad påfyllning ' || w.id::text
      );
    end loop;

    update public.field_submissions set undone_at = now()
    where organization_id = p_organization_id and id = f.id;
    v_packs := v_packs + v_event.quantity;
  end loop;
  return v_packs;
end
$$;


-- -----------------------------------------------------------------------------
-- 6. En butikspåfyllare skapar aldrig en egen organisation (då skulle hen få appen).
--    Kropparna från 20261102181500_onboarding_create_first_organization.sql, med
--    kontrollen BL062 tillagd.
-- -----------------------------------------------------------------------------

create function private.is_phone_staff(p_uid uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from private.phone_logins p where p.user_id = p_uid)
      or exists (select 1 from public.memberships m
                 where m.user_id = p_uid and m.role = 'machine_refiller')
$$;

revoke all on function private.is_phone_staff(uuid) from public, anon, authenticated;

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_org uuid;
  v_display_name text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  if exists (select 1 from public.memberships m
             where m.user_id = v_uid and m.role = 'store') then
    raise exception using errcode = 'BL061',
      message = 'Kontot är ett butikskonto. Logga in med ett annat konto för att skapa en organisation.';
  end if;

  if private.is_phone_staff(v_uid) then
    raise exception using errcode = 'BL062',
      message = 'Kontot är en påfyllare i butiken och kan inte skapa en organisation.';
  end if;

  insert into public.organizations (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning id into v_org;

  insert into public.memberships (organization_id, user_id, role)
  values (v_org, v_uid, 'owner');

  insert into public.organization_settings (organization_id) values (v_org);

  insert into public.stock_locations (organization_id, kind, name, is_central)
  values (v_org, 'warehouse', 'Centrallager', true);

  v_display_name := coalesce(
    nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_claims ->> 'email', ''), '@', 1), ''),
    'Ägare'
  );
  insert into public.profiles (organization_id, user_id, display_name)
  values (v_org, v_uid, v_display_name);

  return v_org;
end
$$;

create or replace function public.create_first_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_first_organization:' || v_uid::text, 0));

  if exists (select 1 from public.memberships m
             where m.user_id = v_uid and m.role = 'store') then
    raise exception using errcode = 'BL061',
      message = 'Kontot är ett butikskonto. Logga in med ett annat konto för att skapa en organisation.';
  end if;

  if private.is_phone_staff(v_uid) then
    raise exception using errcode = 'BL062',
      message = 'Kontot är en påfyllare i butiken och kan inte skapa en organisation.';
  end if;

  if exists (select 1 from public.memberships m
             join public.organizations o on o.id = m.organization_id
             where m.user_id = v_uid and o.archived_at is null) then
    raise exception using errcode = 'BL060',
      message = 'Du är redan med i en organisation. Byt organisation i menyn.';
  end if;

  return public.create_organization(p_name, p_slug);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. En klient tar aldrig bort en butikspåfyllares medlemskap (då blir inloggningen kvar
--    utan automater). Ägaren stänger av kontot på automatens sida i stället.
-- -----------------------------------------------------------------------------

create function private.memberships_machine_refiller_no_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and old.role = 'machine_refiller' then
    raise exception using errcode = '42501',
      message = 'En påfyllare i butiken tas inte bort här. Stäng av kontot på automatens sida.';
  end if;
  return old;
end
$$;

revoke all on function private.memberships_machine_refiller_no_delete() from public;

create trigger t12_machine_refiller_no_delete before delete on public.memberships
  for each row execute function private.memberships_machine_refiller_no_delete();
