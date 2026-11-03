-- =============================================================================
-- Vårt lager: en påfyllning i appen efter att Awish redan dragit packen.
--
-- Awish-synken drar en påfyllning ur centrallagret när en automat visar fler pack än
-- saldot (20261104200000_vart_lager_awish_uttag.sql, source 'awish', noteringen
-- "Awish-påfyllning <kod> ..."). Registreras samma påfyllning i appen EFTER synken
-- (påfyllaren fyller, synken går, sedan trycker hen Klar; eller kön skickas när nätet
-- kommer tillbaka) drog register_refill samma pack en gång till.
--
-- Nu räknar register_refill av: Awish-uttag för samma automat och titel som ännu inte
-- har "använts" av en påfyllning i appen täcker påfyllningen först. Ordningen är
-- insättningsordningen (seq): ett Awish-uttag används bara av påfyllningar som sparades
-- efter det, och bara om Awish såg påfyllningen från 30 minuter före till 2 timmar efter
-- påfyllningens tid (Klar trycks strax efter att automaten fyllts; kön kan skickas
-- senare men med tiden då Klar trycktes). Fönstret är ett dygn (created_at).
-- Begränsning: fyller någon samma titel i samma automat två gånger inom 30 minuter, och
-- bara den andra registreras i appen, räknas de som samma påfyllning.
--   * Från vårt lager: bara resten dras (det redan dragna dras inte igen).
--   * Inte från vårt lager: packen kom inte härifrån, så det Awish drog läggs tillbaka
--     (en 'adjustment' med positivt antal, noteringen "Återfört Awish-uttag <kod>").
-- Påfyllningen i automaten registreras som förut ('refill'); nästa Awish-läsning
-- rättar automatens saldo.
--
-- Automatens lagerplats låses (for update, samma som synken) så att en påfyllning i
-- appen och en Awish-läsning av samma automat inte går samtidigt.
-- Samma signatur, behörighet och felmeddelanden som förut.
-- =============================================================================

create or replace function public.register_refill(
  p_organization_id uuid,
  p_machine_id uuid,
  p_title_id uuid,
  p_quantity integer,
  p_from_warehouse boolean default true,
  p_occurred_at timestamptz default null,
  p_note text default null
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
  v_central uuid;
  v_available integer;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_event uuid;
  v_prefix text;
  v_d_at timestamptz[] := '{}';
  v_d_left integer[] := '{}';
  v_need integer;
  v_take integer;
  v_covered integer := 0;
  v_i integer;
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

  select l.id into v_central from public.stock_locations l
  where l.organization_id = p_organization_id and l.is_central and l.archived_at is null;
  if p_from_warehouse and v_central is null then
    raise exception using errcode = '22023', message = 'Organisationen har inget centrallager.';
  end if;

  if v_central is not null then
    -- Lås titelns rader i centrallagret så att två samtidiga uttag inte båda ser samma saldo.
    perform pg_advisory_xact_lock(hashtextextended(v_central::text || '/' || p_title_id::text, 0));

    -- Awish-uttag för automaten och titeln som påfyllningar i appen ännu inte använt.
    v_prefix := 'Awish-påfyllning ' || v_machine.code;
    for r in
      select e.seq, e.occurred_at, -e.quantity as qty, true as awish
      from public.stock_events e
      where e.organization_id = p_organization_id
        and e.location_id = v_central
        and e.title_id = p_title_id
        and e.kind = 'adjustment'
        and e.source = 'awish'
        and e.quantity < 0
        and (e.note = v_prefix or left(e.note, char_length(v_prefix) + 1) = v_prefix || ' ')
        and e.created_at >= now() - interval '1 day'
      union all
      select e.seq, e.occurred_at, e.quantity as qty, false as awish
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
    v_need := p_quantity;
    for v_i in 1 .. coalesce(array_length(v_d_at, 1), 0) loop
      exit when v_need = 0;
      if v_d_left[v_i] > 0
         and v_d_at[v_i] between v_at - interval '30 minutes' and v_at + interval '2 hours' then
        v_take := least(v_need, v_d_left[v_i]);
        v_need := v_need - v_take;
        v_covered := v_covered + v_take;
      end if;
    end loop;
  end if;

  if p_from_warehouse and p_quantity > v_covered then
    select coalesce(sum(sl.quantity), 0)::integer into v_available
    from public.stock_levels sl
    where sl.organization_id = p_organization_id
      and sl.location_id = v_central and sl.title_id = p_title_id;
    if v_available < p_quantity - v_covered then
      raise exception using errcode = '22023',
        message = format('Centrallagret har bara %s pack av %s.', v_available, v_title.name);
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

  if p_from_warehouse and p_quantity > v_covered then
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_central, p_title_id, 'adjustment', -(p_quantity - v_covered), v_at,
      v_uid, 'Uttag till påfyllning av ' || v_machine.code
    );
  elsif not p_from_warehouse and v_covered > 0 then
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_central, p_title_id, 'adjustment', v_covered, v_at, v_uid,
      'Återfört Awish-uttag ' || v_machine.code
    );
  end if;

  return v_event;
end
$$;

revoke all on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text)
  from public, anon;
grant execute on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text)
  to authenticated;
