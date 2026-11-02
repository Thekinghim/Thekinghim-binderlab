-- =============================================================================
-- Kom igång: en ny operatör skapar sin första organisation.
--
-- 1. public.create_first_organization(name, slug) → organization_id
--    Den väg appen använder (src/server/onboarding/create-organization.ts). Regeln
--    "bara den som inte är med i någon organisation och inte har ett butikskonto"
--    gäller i databasen, inte bara i appen:
--    - Ett transaktionslås per användare (pg_advisory_xact_lock) gör att samtidiga
--      anrop från samma konto (två flikar, ett skript) körs efter varandra. Det andra
--      anropet ser då det första medlemskapet och nekas.
--    - BL060: kontot är med i en organisation som inte är arkiverad (alla roller).
--    - BL061: kontot är ett butikskonto (rollen store), även när butiken eller
--      organisationen är arkiverad.
--    Sedan skapas organisationen med create_organization i samma transaktion.
--
-- 2. public.create_organization(name, slug) nekar butikskonton (BL061).
--    Funktionen är fortfarande körbar av authenticated: seed, demo-seed och testerna
--    skapar organisationer som ägaren, och en ägare med flera bolag (organisations-
--    väljaren) får skapa fler. Ett butikskonto ska däremot aldrig nå appen den vägen.
--    Kroppen är i övrigt oförändrad (20261102101000_rpc.sql).
-- =============================================================================

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_org uuid;
  v_display_name text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  if exists (select 1 from public.memberships m
             where m.user_id = v_uid and m.role = 'store') then
    raise exception using errcode = 'BL061',
      message = 'Kontot är ett butikskonto. Logga in med ett annat konto för att skapa en organisation.';
  end if;

  insert into public.organizations (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning id into v_org;

  insert into public.memberships (organization_id, user_id, role)
  values (v_org, v_uid, 'owner');

  insert into public.organization_settings (organization_id) values (v_org);

  insert into public.stock_locations (organization_id, kind, name, is_central)
  values (v_org, 'warehouse', 'Centrallager', true);

  v_display_name := coalesce(
    nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_claims ->> 'email', ''), '@', 1), ''),
    'Ägare'
  );
  insert into public.profiles (organization_id, user_id, display_name)
  values (v_org, v_uid, v_display_name);

  return v_org;
end
$$;

create function public.create_first_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  -- Samtidiga anrop från samma konto väntar här på varandra. Låset släpps när
  -- transaktionen slutar; kontrollerna nedan läser med en ny ögonblicksbild.
  perform pg_advisory_xact_lock(hashtextextended('create_first_organization:' || v_uid::text, 0));

  if exists (select 1 from public.memberships m
             where m.user_id = v_uid and m.role = 'store') then
    raise exception using errcode = 'BL061',
      message = 'Kontot är ett butikskonto. Logga in med ett annat konto för att skapa en organisation.';
  end if;

  if exists (select 1 from public.memberships m
             join public.organizations o on o.id = m.organization_id
             where m.user_id = v_uid and o.archived_at is null) then
    raise exception using errcode = 'BL060',
      message = 'Du är redan med i en organisation. Byt organisation i menyn.';
  end if;

  return public.create_organization(p_name, p_slug);
end
$$;

comment on function public.create_first_organization(text, text) is
  'Kom igång: första organisationen för ett konto utan medlemskap och utan butikskonto. Lås per användare.';

revoke all on function public.create_organization(text, text) from public, anon;
revoke all on function public.create_first_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated;
grant execute on function public.create_first_organization(text, text) to authenticated;
