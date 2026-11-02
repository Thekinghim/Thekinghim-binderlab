-- =============================================================================
-- Att göra: registrera en påfyllning (register_refill).
--
-- En påfyllning är en 'refill'-händelse i automatens lagerplats. Tas packen från
-- centrallagret dras samma antal därifrån i samma transaktion, som en
-- 'adjustment' med noteringen "Uttag till påfyllning av <kod>" (samma form som
-- seed-datan). Påfyllaren får inte skriva 'adjustment' direkt (RLS), därför görs
-- båda stegen här, efter en rollkontroll, så att centrallagret alltid stämmer.
--
-- Behörighet: ägare, admin och påfyllare. performed_by är alltid den inloggade
-- användaren. Händelserna loggas i audit_log av triggarna på stock_events, och
-- stängda perioder skyddas av stock_events_period_guard.
--
-- Fel (SQLSTATE 22023) har svenska meddelanden som kan visas för användaren.
-- =============================================================================

create function public.register_refill(
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
  limit 1;
  if v_location is null then
    insert into public.stock_locations (organization_id, kind, machine_id, name)
    values (p_organization_id, 'machine', p_machine_id,
            v_machine.code || ' ' || v_machine.name)
    returning id into v_location;
  end if;

  if p_from_warehouse then
    select l.id into v_central from public.stock_locations l
    where l.organization_id = p_organization_id and l.is_central and l.archived_at is null;
    if v_central is null then
      raise exception using errcode = '22023', message = 'Organisationen har inget centrallager.';
    end if;
    -- Lås titelns rader i centrallagret så att två samtidiga uttag inte båda ser samma saldo.
    perform pg_advisory_xact_lock(hashtextextended(v_central::text || '/' || p_title_id::text, 0));
    select coalesce(sum(sl.quantity), 0)::integer into v_available
    from public.stock_levels sl
    where sl.organization_id = p_organization_id
      and sl.location_id = v_central and sl.title_id = p_title_id;
    if v_available < p_quantity then
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

  if p_from_warehouse then
    insert into public.stock_events (
      organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, note
    )
    values (
      p_organization_id, v_central, p_title_id, 'adjustment', -p_quantity, v_at, v_uid,
      'Uttag till påfyllning av ' || v_machine.code
    );
  end if;

  return v_event;
end
$$;

revoke all on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text)
  from public, anon;
grant execute on function public.register_refill(uuid, uuid, uuid, integer, boolean, timestamptz, text)
  to authenticated;
