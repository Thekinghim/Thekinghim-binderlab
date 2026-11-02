-- =============================================================================
-- Användare (Inställningar → Användare): medlemslistan med e-post.
--
-- auth.users är stängd för klientroller, så ägare och admin kan inte se
-- medlemmarnas e-postadresser via RLS. list_members() lämnar ut exakt det
-- sidan behöver, och bara till ägare och admin i en organisation som inte är
-- arkiverad. Rolländringar och borttagning går fortfarande direkt mot
-- public.memberships under RLS (med triggarna för sista ägaren, BL005, och
-- admin mot ägare, BL006) och loggas i audit_log som vanligt.
-- =============================================================================

create function public.list_members(p_organization_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  display_name text,
  role public.member_role,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_organization_id is null
     or not private.has_role(p_organization_id, 'owner', 'admin')
     or exists (
       select 1 from public.organizations o
       where o.id = p_organization_id and o.archived_at is not null
     ) then
    raise exception using errcode = '42501', message = 'Bara ägare och admin ser medlemmarna.';
  end if;
  return query
    select m.id, m.user_id, u.email::text, p.display_name, m.role, m.created_at
    from public.memberships m
    join auth.users u on u.id = m.user_id
    left join public.profiles p
      on p.organization_id = m.organization_id and p.user_id = m.user_id
    where m.organization_id = p_organization_id
    order by m.created_at, u.email::text;
end
$$;

comment on function public.list_members(uuid) is
  'Medlemmar med e-post och visningsnamn. Bara ägare och admin (42501 annars).';

revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.list_members(uuid) to authenticated;
