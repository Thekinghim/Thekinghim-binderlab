-- =============================================================================
-- Demo för kunder och de nya funktionerna (Värde, Abonnemang, Annan automat, Exportera).
--
-- 1. En demoorganisation räknas aldrig som plattformsorganisation. Även om någon
--    av misstag lägger en demo i private.platform_operators blir ingen i demon
--    plattformsoperatör: /plattform (am_platform_operator, platform_overview_data,
--    platform_save_plan) nekas.
-- 2. "Annan automat" (manual_csv) är en uppladdad fil, precis som Awish orderlista
--    (awish_csv): inget hämtas utifrån. Den får därför finnas i en demo. Alla andra
--    typer (Awish gRPC, webb och tillägget) nekas som förut (BL092).
--
-- Exportera all data och Värde behöver inget nytt: båda läses under användarens RLS
-- för den aktiva organisationen (en demo exporterar och ser bara sig själv).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Plattformsoperatör: aldrig via en demo
-- -----------------------------------------------------------------------------
create or replace function private.is_platform_operator() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join private.platform_operators p on p.organization_id = m.organization_id
    join public.organizations o on o.id = m.organization_id
    where m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
      and o.archived_at is null
      and not o.is_demo
  )
$$;

revoke all on function private.is_platform_operator() from public, anon;

-- -----------------------------------------------------------------------------
-- 2. Demo: uppladdade filer (awish_csv, manual_csv) men inga kopplingar
-- -----------------------------------------------------------------------------
create or replace function private.demo_forbid_integration() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.provider::text not in ('awish_csv', 'manual_csv')
     and exists (select 1 from public.organizations o where o.id = new.organization_id and o.is_demo) then
    raise exception using
      errcode = 'BL092',
      message = 'Det här är en demo – kopplingar till Awish och andra tjänster är avstängda.';
  end if;
  return new;
end
$$;

revoke all on function private.demo_forbid_integration() from public, anon;
