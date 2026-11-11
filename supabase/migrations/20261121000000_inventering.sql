-- =============================================================================
-- Inventering: räkna ett helt eget lager (Hemma, Kontoret …) i ett svep.
--
-- 1. public.stock_counts: en rad per sparad inventering (lagret, vem, när, och raderna:
--    titel, vad appen trodde, vad som räknades och lagerhändelsens id). Raderna ändras
--    aldrig (append-only). Härifrån kommer "Senast inventerad" per lager och punkten i
--    Att göra när ett lager inte räknats på 30 dagar. Ägare, admin och läsare läser
--    (samma som Vårt lager).
-- 2. public.save_stock_count: EN transaktion. En 'count'-händelse per räknad titel (samma
--    händelse och regler som "Rätta antalet": 0–10 000 pack, aktiv titel, aktivt eget
--    lager) med noteringen "Inventering, Hemma", så att historiken visar att det var en
--    inventering. Titlar som inte skickas med ändras inte. Idempotent på p_client_id:
--    samma inskick två gånger sparar en gång och ger samma svar. Ägare och admin.
--
-- Inget befintligt ändras i data.
-- =============================================================================

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Klientens id för inskicket: samma id två gånger ger samma inventering.
  client_id uuid not null,
  location_id uuid not null,
  -- Antal räknade titlar och hur många av dem som ändrade saldot.
  line_count integer not null check (line_count between 1 and 500),
  changed_count integer not null check (changed_count >= 0),
  -- [{ "titleId": uuid, "name": text, "previous": int, "counted": int, "eventId": uuid }]
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  counted_at timestamptz not null default now(),
  counted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, client_id),
  foreign key (organization_id, location_id) references public.stock_locations (organization_id, id)
    on delete restrict,
  check (changed_count <= line_count)
);

comment on table public.stock_counts is
  'Inventeringar av ett eget lager (save_stock_count): en rad per sparad inventering.';

create index stock_counts_location_idx
  on public.stock_counts (organization_id, location_id, counted_at desc);

create trigger t00_forbid_org_change before update on public.stock_counts
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.stock_counts
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.stock_counts
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.stock_counts
  for each row execute function private.stamp_insert();
create trigger t90_audit_insert after insert on public.stock_counts
  for each row execute function private.audit();

alter table public.stock_counts enable row level security;
revoke all on table public.stock_counts from anon, authenticated, service_role;
grant select on table public.stock_counts to authenticated;
-- Servicerollen som för övriga tabeller (update ger den bara triggernas fel); appen skriver
-- aldrig med den här.
grant select, insert, update on table public.stock_counts to service_role;

-- Ingen planerarstatistik på organization_id (den avslöjar hur många organisationer som finns).
alter table public.stock_counts alter column organization_id set statistics 0;

-- Samma läsare som Vårt lager (ägare, admin, läsare). Skrivs bara via save_stock_count.
create policy stock_counts_select on public.stock_counts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

-- -----------------------------------------------------------------------------
-- Spara en inventering
-- -----------------------------------------------------------------------------

-- p_lines: [{ "titleId": uuid, "counted": heltal 0–10000 }], 1–500 rader, en per titel.
create function public.save_stock_count(
  p_organization_id uuid,
  p_client_id uuid,
  p_location_id uuid,
  p_lines jsonb
)
returns table (count_id uuid, duplicate boolean, counted_at timestamptz, lines jsonb)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.stock_counts;
  v_loc public.stock_locations;
  v_note text;
  v_n integer;
  v_changed integer := 0;
  v_out jsonb := '[]'::jsonb;
  v_previous integer;
  v_event uuid;
  v_id uuid;
  v_at timestamptz;
  r record;
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501',
      message = 'Bara ägare och admin kan inventera lagret.';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'Inskicket saknar id.';
  end if;

  -- Två inskick med samma id köas: det andra ser det första och sparar inget.
  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || '/inventering/' || p_client_id::text, 0)
  );
  select * into v_prev from public.stock_counts c
  where c.organization_id = p_organization_id and c.client_id = p_client_id;
  if v_prev.id is not null then
    if v_prev.counted_by is distinct from v_uid or v_prev.location_id <> p_location_id then
      raise exception using errcode = '22023',
        message = 'Den här inventeringen är redan sparad. Ladda om sidan.';
    end if;
    return query select v_prev.id, true, v_prev.counted_at, v_prev.lines;
    return;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Räkna minst en produkt.';
  end if;
  v_n := jsonb_array_length(p_lines);
  if v_n < 1 then
    raise exception using errcode = '22023', message = 'Räkna minst en produkt.';
  end if;
  if v_n > 500 then
    raise exception using errcode = '22023', message = 'Högst 500 produkter per inventering.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'titleId') is distinct from 'string'
       or (e ->> 'titleId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(e -> 'counted') is distinct from 'number'
       or (e ->> 'counted') !~ '^[0-9]{1,5}$'
       or (e ->> 'counted')::integer > 10000
  ) then
    raise exception using errcode = '22023', message = 'Ange antal, 0 till 10 000 pack.';
  end if;
  if (select count(distinct e ->> 'titleId') from jsonb_array_elements(p_lines) e) <> v_n then
    raise exception using errcode = '22023', message = 'Samma produkt står två gånger.';
  end if;

  v_loc := private.active_warehouse(p_organization_id, p_location_id);
  v_note := left('Inventering, ' || v_loc.name, 300);

  -- Samma lås som påfyllning, flytt, packning och Awish-synken, i titel-ordning (inga dödlägen).
  for r in
    select (e ->> 'titleId')::uuid as title_id
    from jsonb_array_elements(p_lines) e order by 1
  loop
    perform private.lock_own_stock(p_organization_id, r.title_id);
  end loop;

  v_id := gen_random_uuid();
  v_at := now();
  for r in
    select (e ->> 'titleId')::uuid as title_id, (e ->> 'counted')::integer as counted,
           t.id as found, t.name, t.merged_into_id, t.archived_at
    from jsonb_array_elements(p_lines) with ordinality as x(e, pos)
    left join public.titles t
      on t.organization_id = p_organization_id and t.id = (e ->> 'titleId')::uuid
    order by x.pos
  loop
    if r.found is null or r.merged_into_id is not null or r.archived_at is not null then
      raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
    end if;
    v_previous := private.location_level(p_organization_id, v_loc.id, r.title_id);
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    ) values (
      p_organization_id, v_loc.id, r.title_id, 'count', r.counted, v_at, v_uid, v_note
    )
    returning id into v_event;
    if v_previous <> r.counted then
      v_changed := v_changed + 1;
    end if;
    v_out := v_out || jsonb_build_object(
      'titleId', r.title_id, 'name', r.name, 'previous', v_previous, 'counted', r.counted,
      'eventId', v_event
    );
  end loop;

  insert into public.stock_counts (
    id, organization_id, client_id, location_id, line_count, changed_count, lines,
    counted_at, counted_by
  ) values (
    v_id, p_organization_id, p_client_id, v_loc.id, v_n, v_changed, v_out, v_at, v_uid
  );

  return query select v_id, false, v_at, v_out;
end
$$;

revoke all on function public.save_stock_count(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_stock_count(uuid, uuid, uuid, jsonb) to authenticated;
