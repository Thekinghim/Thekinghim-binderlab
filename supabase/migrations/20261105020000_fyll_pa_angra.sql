-- Fyll på: "Ångra" efter Klar.
--
-- En påfyllning från fältet (field_submissions, sparad av register_refill_once) kan ångras
-- av den som gjorde den, inom 30 minuter. Ångra skriver motbokningar, aldrig radering:
--
--   automaten   adjustment −antal                  ("Ångrad påfyllning")
--   eget lager  adjustment ± varje uttag/återföring som påfyllningen skrev i samma
--               transaktion ("Uttag till påfyllning av …", "Återfört Awish-uttag …")
--
-- Svinnkontrollen räknar påfyllt + justering, så påfyllning och ångring tar ut varandra.
-- Samma inskick två gånger ger ingen dubbel motbokning (undone_at, och varje syskonhändelse
-- motbokas bara en gång). Påfyllaren kan ångra sina egna; ägare och admin likaså.

alter table public.field_submissions add column undone_at timestamptz;

comment on column public.field_submissions.undone_at is
  'När påfyllningen ångrades i Fyll på (null = gäller).';

create function public.undo_field_refills(p_organization_id uuid, p_client_ids uuid[])
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
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
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

revoke all on function public.undo_field_refills(uuid, uuid[]) from public, anon;
grant execute on function public.undo_field_refills(uuid, uuid[]) to authenticated;
