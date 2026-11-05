-- =============================================================================
-- Demo för kunder: kunden tar sig inte ur demon.
--
-- create_organization är öppen för alla inloggade (EXECUTE för authenticated, även via
-- PostgREST med kundens egen session). Utan spärren kunde kunden i en demo skapa en egen
-- RIKTIG organisation och där bjuda in, mejla, koppla Awish och skapa kunddemos (nya
-- konton och mejl till valfria adresser). Appen nekar redan (createOrganizationFor kräver
-- att man inte är medlem någonstans), men RPC:n gjorde det inte.
--
-- Regeln (BL093): den som är medlem i en demo kan inte bli FÖRSTA medlem i en riktig
-- organisation, alltså inte skapa en. Att bjudas in till en befintlig riktig organisation
-- (kunden blir kund på riktigt) fungerar som förut. Servern (binderlab.demo_setup, bara
-- databasägarens anslutning) skapar demoorganisationer som platshållarna, även när en
-- platshållare redan är med i den gamla demon (Återställ).
-- =============================================================================

create function private.demo_forbid_escape() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if private.system_flag('binderlab.demo_setup') then
    return new;
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.organization_id and o.is_demo)
     and not exists (
       select 1 from public.memberships m
       where m.organization_id = new.organization_id and m.user_id <> new.user_id
     )
     and exists (
       select 1 from public.memberships m
       join public.organizations o on o.id = m.organization_id
       where m.user_id = new.user_id and o.is_demo
     ) then
    raise exception using
      errcode = 'BL093',
      message = 'Det här är en demo – du kan inte skapa en egen organisation härifrån.';
  end if;
  return new;
end
$$;

revoke all on function private.demo_forbid_escape() from public, anon;

create trigger t05_demo_no_escape before insert on public.memberships
  for each row execute function private.demo_forbid_escape();

comment on function private.demo_forbid_escape() is
  'Demo för kunder: en medlem i en demo kan inte skapa en riktig organisation (BL093).';
