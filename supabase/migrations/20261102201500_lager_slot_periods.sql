-- =============================================================================
-- Lager: sortimentets perioder per automat och titel (lager_slot_periods).
--
-- Lagersidan räknar en tom plats som Kritisk. En titel som har gått ur sortimentet
-- i en automat (sista perioden i public.machine_slots har ett slutdatum som passerat)
-- ska inte fyllas på, och en tom plats för den är därför ingen åtgärd. Sidan visar
-- sådana titlar som utgångna, utanför räkningen av kritiska platser.
--
-- machine_slots får bara läsas av ägare, admin och läsare (RLS). Påfyllaren behöver
-- samma besked på Lager, så funktionen lämnar ut exakt det sidan behöver: automat,
-- titel och periodens första och sista dag. Inga antal platser, anteckningar eller
-- belopp.
--
-- Behörighet: alla roller i organisationen (ägare, admin, påfyllare, läsare), inte i
-- en arkiverad organisation. Annars 42501. Samma regel som lager_performers.
-- =============================================================================

create function public.lager_slot_periods(p_organization_id uuid)
returns table (
  machine_id uuid,
  title_id uuid,
  valid_from date,
  valid_to date
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_organization_id is null
     or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller', 'viewer')
     or exists (
       select 1 from public.organizations o
       where o.id = p_organization_id and o.archived_at is not null
     ) then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till det här.';
  end if;
  return query
    select ms.machine_id, ms.title_id, ms.valid_from, ms.valid_to
    from public.machine_slots ms
    where ms.organization_id = p_organization_id;
end
$$;

comment on function public.lager_slot_periods(uuid) is
  'Sortimentets perioder (automat, titel, från, till) för Lager. Alla roller (42501 annars).';

revoke all on function public.lager_slot_periods(uuid) from public, anon;
grant execute on function public.lager_slot_periods(uuid) to authenticated;
