-- =============================================================================
-- Lager: namn även för utförare utan profil (lager_performers, version 2).
--
-- Version 1 (20261102120412_lager_performers.sql) läste bara visningsnamnet i
-- public.profiles. En medlem utan profil (t.ex. en påfyllare som lagts till direkt
-- som medlem) och en tidigare medlem visades därför som "Okänd" i historiken.
--
-- Nu utgår funktionen från dem som faktiskt står som utförare av en lagerhändelse
-- i organisationen och väljer namnet i den här ordningen:
--   1. visningsnamnet i organisationens profil,
--   2. display_name, full_name eller name i användarens metadata (auth.users),
--   3. rollen i organisationen ("Påfyllare", "Ägare" …) för en medlem utan namn.
-- Utan något av dem blir namnet null (sidan visar "Okänd"). Inga e-postadresser,
-- inga roller utöver reservnamnet, inga belopp.
--
-- Behörighet oförändrad: alla roller i organisationen (ägare, admin, påfyllare,
-- läsare), inte i en arkiverad organisation. Annars 42501.
-- =============================================================================

create or replace function public.lager_performers(p_organization_id uuid)
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
    with performers as (
      select distinct e.performed_by as uid
      from public.stock_events e
      where e.organization_id = p_organization_id
        and e.performed_by is not null
        and e.kind <> 'sale'
    )
    select
      x.uid,
      coalesce(
        nullif(btrim(p.display_name), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
        case m.role
          when 'owner' then 'Ägare'
          when 'admin' then 'Admin'
          when 'refiller' then 'Påfyllare'
          when 'viewer' then 'Läsare'
          when 'store' then 'Butik'
        end
      )::text
    from performers x
    left join public.profiles p
      on p.organization_id = p_organization_id and p.user_id = x.uid
      and p.anonymized_at is null
    left join public.memberships m
      on m.organization_id = p_organization_id and m.user_id = x.uid
    left join auth.users u
      on u.id = x.uid and m.id is not null;
end
$$;

comment on function public.lager_performers(uuid) is
  'Visningsnamn för dem som registrerat lagerhändelser: profil, användarens namn eller rollen. Alla roller (42501 annars).';

revoke all on function public.lager_performers(uuid) from public, anon;
grant execute on function public.lager_performers(uuid) to authenticated;
