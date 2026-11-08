-- =============================================================================
-- Enkel vy: teamlås.
--
-- Ägaren (William) står överst. Han bjuder in och sätter allas vy och språk från sitt
-- konto. Den som har Enkel vy i en organisation (memberships.view_mode = 'simple') får
-- därför inte hantera teamet där, även om rollen är ägare:
--
--   * inga inbjudningar: skapa (create_invitation, create_store_invitation), skicka om
--     (samma RPC:er), återkalla (delete), ändra (set_invitation_options, BL131 sedan förut);
--   * inga ändringar av medlemskap: roll, vy (BL130/BL131 sedan förut) eller borttagning,
--     inte heller av det egna medlemskapet;
--   * inga ändringar av någon annans profil (språk, namn). Det egna språket och namnet
--     får personen ändra som förut (setMyLocale).
--
-- Två lager:
--   1. Triggrar (BL132) på invitations, memberships och profiles. De gäller också inne i
--      RPC:er med security definer (create_invitation m.fl.), som annars går förbi RLS.
--   2. Restriktiva RLS-policyer för direkta skrivningar från klienten: radering av
--      inbjudningar och medlemskap, och profiler som inte är ens egen.
--
-- Systemjobb, migreringar och skript (ingen inloggad användare, auth.uid() är null)
-- påverkas inte. Att ta emot en inbjudan påverkas inte: mottagaren är inte medlem i
-- organisationen än (BL014), alltså inte i Enkel vy där.
-- =============================================================================

-- Organisationerna där den inloggade har Enkel vy. Security definer: läser memberships
-- utan RLS (policyerna på memberships använder den, så ingen rekursion).
create function private.orgs_in_simple_view()
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.view_mode = 'simple'
$$;

-- Har den inloggade Enkel vy i organisationen?
create function private.in_simple_view(p_organization_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.view_mode = 'simple'
  )
$$;

revoke all on function private.orgs_in_simple_view() from public, anon;
revoke all on function private.in_simple_view(uuid) from public, anon;
grant execute on function private.orgs_in_simple_view() to authenticated;
grant execute on function private.in_simple_view(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 1. Triggrar
-- -----------------------------------------------------------------------------

-- Inbjudningar och medlemskap: ingen ändring alls av den som har Enkel vy i organisationen.
create function private.simple_view_team_lock() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Att ta emot sin egen inbjudan (accept_invitation / accept_my_invitation): medlemskapet
  -- med inbjudans vy skapas först, sedan markeras inbjudan som använd. Bara de två fälten.
  -- (jsonb, eftersom memberships inte har fälten och plpgsql inte kortsluter.)
  if tg_table_name = 'invitations' and tg_op = 'UPDATE' then
    if to_jsonb(old) ->> 'accepted_at' is null
       and to_jsonb(new) ->> 'accepted_at' is not null
       and to_jsonb(new) ->> 'accepted_by' = auth.uid()::text
       and (to_jsonb(new) - array['accepted_at', 'accepted_by', 'updated_at', 'updated_by'])
         = (to_jsonb(old) - array['accepted_at', 'accepted_by', 'updated_at', 'updated_by']) then
      return new;
    end if;
  end if;
  if private.in_simple_view(v_org) then
    raise exception using
      errcode = 'BL132',
      message = 'Med Enkel vy kan du inte ändra teamet. Be ägaren.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

-- Profiler: den som har Enkel vy ändrar bara sin egen (språket och namnet).
create function private.simple_view_profile_lock() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if private.in_simple_view(new.organization_id)
     and (new.user_id is distinct from v_uid
          or (tg_op = 'UPDATE' and old.user_id is distinct from v_uid)) then
    raise exception using
      errcode = 'BL132',
      message = 'Med Enkel vy kan du inte ändra teamet. Be ägaren.';
  end if;
  return new;
end
$$;

revoke all on function private.simple_view_team_lock() from public, anon, authenticated;
revoke all on function private.simple_view_profile_lock() from public, anon, authenticated;

-- t06: efter demospärren (t05), före stämplarna (t20).
create trigger t06_simple_view_team_lock before insert or update or delete on public.invitations
  for each row execute function private.simple_view_team_lock();

-- t12: efter t10_guard_role och t11_guard_view_mode, så att BL006/BL130/BL131 gäller som förut.
create trigger t12_simple_view_team_lock before insert or update or delete on public.memberships
  for each row execute function private.simple_view_team_lock();

create trigger t12_simple_view_profile_lock before insert or update on public.profiles
  for each row execute function private.simple_view_profile_lock();

-- -----------------------------------------------------------------------------
-- 2. Restriktiva policyer (gäller utöver de vanliga, för direkta skrivningar)
-- -----------------------------------------------------------------------------

create policy invitations_delete_not_simple on public.invitations
  as restrictive
  for delete to authenticated
  using (not (organization_id = any (array(select private.orgs_in_simple_view()))));

create policy memberships_delete_not_simple on public.memberships
  as restrictive
  for delete to authenticated
  using (not (organization_id = any (array(select private.orgs_in_simple_view()))));

create policy profiles_insert_not_simple on public.profiles
  as restrictive
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    or not (organization_id = any (array(select private.orgs_in_simple_view())))
  );

create policy profiles_update_not_simple on public.profiles
  as restrictive
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or not (organization_id = any (array(select private.orgs_in_simple_view())))
  )
  with check (
    user_id = (select auth.uid())
    or not (organization_id = any (array(select private.orgs_in_simple_view())))
  );
