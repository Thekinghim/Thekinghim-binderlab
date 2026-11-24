-- Butikspåfyllaren låses till butikens lager: register_refill stoppar en påfyllning
-- som är större än det butiken har fått (tidigare: varning och påfyllning ändå).
-- Funktionen i övrigt är oförändrad (kopia av 20261228000100_butikspafyllare.sql).

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
      -- Butikspåfyllaren får bara fylla på med de pack som butiken har fått (ägarens
      -- beslut 24 nov. 2026): fler än butikens lager stoppas.
      raise exception using errcode = '22023',
        message = format('Du har bara %s pack av %s att fylla på med.', greatest(v_available, 0), v_title.name);
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
