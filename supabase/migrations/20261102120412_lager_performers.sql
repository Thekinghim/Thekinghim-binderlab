-- =============================================================================
-- Lager: namn på dem som registrerat lagerhändelser (lager_performers).
--
-- Historiken på /lager visar vem som fyllde på eller inventerade. Påfyllaren får
-- bara läsa sin egen profil (profiles_select), så namnen på kollegorna syns inte
-- via RLS. Funktionen lämnar ut exakt det historiken behöver: användar-id och
-- visningsnamn för de medlemmar som står som utförare av en lagerhändelse i
-- organisationen. Inga e-postadresser, roller eller belopp.
--
-- Behörighet: alla roller i organisationen (ägare, admin, påfyllare, läsare),
-- inte i en arkiverad organisation. Annars 42501.
-- =============================================================================

create function public.lager_performers(p_organization_id uuid)
returns table (
  user_id uuid,
  display_name text
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
    select m.user_id, p.display_name
    from public.memberships m
    left join public.profiles p
      on p.organization_id = m.organization_id and p.user_id = m.user_id
    where m.organization_id = p_organization_id
      and exists (
        select 1 from public.stock_events e
        where e.organization_id = p_organization_id
          and e.performed_by = m.user_id
          and e.kind <> 'sale'
      );
end
$$;

comment on function public.lager_performers(uuid) is
  'Visningsnamn för medlemmar som registrerat lagerhändelser. Alla roller (42501 annars).';

revoke all on function public.lager_performers(uuid) from public, anon;
grant execute on function public.lager_performers(uuid) to authenticated;
