-- =============================================================================
-- Enkel vy och språk per person.
--
-- profiles.locale ('sv' | 'en', standard 'sv'): språket i appen för personen i
-- organisationen. Personen ändrar sitt eget språk (profiles_update tillåter redan den
-- egna profilen); ägare och admin kan sätta det åt en medlem (samma policy).
--
-- memberships.view_mode ('full' | 'simple', standard 'full'): "Enkel vy". Medlemmen ser
-- bara Fyll på, Försäljning och Mystery packs, oberoende av rollen (en delägare behåller
-- ägarrollen i datan). Bara ägare och admin ändrar den (memberships_update, och admin
-- aldrig för en ägare), och aldrig sin egen: den som har enkel vy kan inte slå av den
-- själv (BL130), och den som själv har enkel vy ändrar inte någon annans (BL131).
--
-- invitations.view_mode / invitations.locale: en inbjudan kan bära båda, så att den
-- inbjudna landar direkt i rätt vy och språk när inbjudan tas emot. Sätts med
-- set_invitation_options (ägare och admin; ägarinbjudningar bara av en ägare), och
-- accept_invitation / accept_my_invitation kopierar dem till medlemskapet och profilen.
--
-- Butiksriktade dokument (rapporter, PDF:er, avtal, mejl till butiker) påverkas inte:
-- de är alltid på svenska.
-- =============================================================================

alter table public.profiles
  add column locale text not null default 'sv' check (locale in ('sv', 'en'));

alter table public.memberships
  add column view_mode text not null default 'full' check (view_mode in ('full', 'simple'));

alter table public.invitations
  add column view_mode text not null default 'full' check (view_mode in ('full', 'simple')),
  add column locale text not null default 'sv' check (locale in ('sv', 'en'));

comment on column public.profiles.locale is
  'Appens språk för personen: sv eller en. Personen själv, eller ägare/admin.';
comment on column public.memberships.view_mode is
  'full eller simple (Enkel vy: bara Fyll på, Försäljning och Mystery). Bara ägare/admin, aldrig den egna.';
comment on column public.invitations.view_mode is
  'Vyn medlemskapet får när inbjudan tas emot (full eller simple).';
comment on column public.invitations.locale is
  'Språket profilen får när inbjudan tas emot (sv eller en).';

-- Kolumnrättigheter: samma tabeller, en kolumn till var.
grant update (role, view_mode) on table public.memberships to authenticated;
grant update (display_name, locale) on table public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- Enkel vy: bara ägare/admin i full vy, aldrig det egna medlemskapet.
-- RLS (memberships_update) avgör redan vem som får skriva raden: ägare alla, admin
-- alla utom ägare. Triggern lägger till reglerna för just view_mode.
-- -----------------------------------------------------------------------------
-- Security invoker: current_user är klientens roll (authenticated), och den egna raden i
-- memberships syns under RLS (user_id = auth.uid()).
create function private.memberships_guard_view_mode() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if new.view_mode is not distinct from old.view_mode then
    return new;
  end if;
  -- Systemjobb, migreringar och skript (ingen inloggad användare).
  if current_user not in ('anon', 'authenticated') or v_uid is null then
    return new;
  end if;
  if new.user_id = v_uid then
    raise exception using
      errcode = 'BL130',
      message = 'Du kan inte ändra din egen vy. Be en ägare eller admin.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.organization_id = new.organization_id
      and m.user_id = v_uid
      and m.view_mode = 'simple'
  ) or not private.has_role(new.organization_id, 'owner', 'admin') then
    raise exception using
      errcode = 'BL131',
      message = 'Bara en ägare eller admin kan ändra vyn.';
  end if;
  return new;
end
$$;

create trigger t11_guard_view_mode before update of view_mode on public.memberships
  for each row execute function private.memberships_guard_view_mode();

-- -----------------------------------------------------------------------------
-- set_invitation_options: vy och språk på en obesvarad inbjudan.
-- -----------------------------------------------------------------------------
create function public.set_invitation_options(
  p_organization_id uuid,
  p_invitation_id uuid,
  p_view_mode text,
  p_locale text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.member_role;
begin
  if not private.has_role(p_organization_id, 'owner', 'admin')
     or exists (
       select 1 from public.memberships m
       where m.organization_id = p_organization_id
         and m.user_id = auth.uid()
         and m.view_mode = 'simple'
     ) then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan ändra inbjudningar.';
  end if;
  if p_view_mode is null or p_view_mode not in ('full', 'simple')
     or p_locale is null or p_locale not in ('sv', 'en') then
    raise exception using errcode = '22023', message = 'Okänd vy eller okänt språk.';
  end if;

  select i.role into v_role
  from public.invitations i
  where i.id = p_invitation_id
    and i.organization_id = p_organization_id
    and i.accepted_at is null
  for update;
  if not found then
    raise exception using errcode = 'BL010', message = 'Inbjudan finns inte.';
  end if;
  if v_role = 'owner' and not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara en ägare kan ändra en ägarinbjudan.';
  end if;

  update public.invitations
  set view_mode = p_view_mode, locale = p_locale
  where id = p_invitation_id and organization_id = p_organization_id;
end
$$;

comment on function public.set_invitation_options(uuid, uuid, text, text) is
  'Vy (full/simple) och språk (sv/en) på en obesvarad inbjudan. Ägare och admin (ägarinbjudan: ägare).';

-- -----------------------------------------------------------------------------
-- accept_invitation / accept_my_invitation: som förut (20261102130100 och
-- 20261105060000), men medlemskapet får inbjudans view_mode och profilen dess locale.
-- -----------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_invitation public.invitations;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  select * into v_invitation
  from public.invitations i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception using errcode = 'BL010', message = 'Inbjudan finns inte.';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception using errcode = 'BL011', message = 'Inbjudan har redan använts.';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'BL012', message = 'Inbjudan har gått ut.';
  end if;
  if not (coalesce(v_claims ->> 'email', '')::extensions.citext operator(extensions.=) v_invitation.email) then
    raise exception using
      errcode = 'BL013',
      message = 'Inbjudan gäller en annan e-postadress.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.organization_id = v_invitation.organization_id and m.user_id = v_uid
  ) then
    raise exception using errcode = 'BL014', message = 'Du är redan medlem.';
  end if;

  insert into public.memberships (organization_id, user_id, role, store_id, view_mode)
  values (
    v_invitation.organization_id, v_uid, v_invitation.role, v_invitation.store_id,
    v_invitation.view_mode
  );

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  insert into public.profiles (organization_id, user_id, display_name, locale)
  values (
    v_invitation.organization_id,
    v_uid,
    coalesce(
      nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
      nullif(split_part(v_invitation.email::text, '@', 1), ''),
      'Medlem'
    ),
    v_invitation.locale
  )
  on conflict (organization_id, user_id) do update set locale = excluded.locale;

  return v_invitation.organization_id;
end
$$;

create or replace function public.accept_my_invitation(p_invitation_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_invitation public.invitations;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  select i.* into v_invitation
  from public.invitations i
  join public.organizations o on o.id = i.organization_id
  where i.id = p_invitation_id and o.archived_at is null
  for update of i;

  -- Samma svar för en okänd inbjudan och någon annans: inget avslöjas.
  if not found
    or not (coalesce(v_claims ->> 'email', '')::extensions.citext operator(extensions.=) v_invitation.email)
  then
    raise exception using errcode = 'BL010', message = 'Inbjudan finns inte.';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception using errcode = 'BL011', message = 'Inbjudan har redan använts.';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'BL012', message = 'Inbjudan har gått ut.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.organization_id = v_invitation.organization_id and m.user_id = v_uid
  ) then
    raise exception using errcode = 'BL014', message = 'Du är redan medlem.';
  end if;

  insert into public.memberships (organization_id, user_id, role, store_id, view_mode)
  values (
    v_invitation.organization_id, v_uid, v_invitation.role, v_invitation.store_id,
    v_invitation.view_mode
  );

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  insert into public.profiles (organization_id, user_id, display_name, locale)
  values (
    v_invitation.organization_id,
    v_uid,
    coalesce(
      nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
      nullif(split_part(v_invitation.email::text, '@', 1), ''),
      'Medlem'
    ),
    v_invitation.locale
  )
  on conflict (organization_id, user_id) do update set locale = excluded.locale;

  return v_invitation.organization_id;
end
$$;

-- -----------------------------------------------------------------------------
-- my_invitations: som i 20261105060000_mina_inbjudningar.sql, med inbjudans språk (så att
-- sidan "Du är inbjuden." visas på det språk ägaren valde). Returtypen ändras: skapas om.
-- -----------------------------------------------------------------------------
drop function public.my_invitations();

create function public.my_invitations()
returns table (
  id uuid,
  organization_name text,
  role public.member_role,
  store_name text,
  expires_at timestamptz,
  locale text
)
language sql stable security definer
set search_path = ''
as $$
  select i.id, o.name, i.role, st.name, i.expires_at, i.locale
  from public.invitations i
  join public.organizations o on o.id = i.organization_id
  left join public.stores st
    on st.organization_id = i.organization_id and st.id = i.store_id
  where auth.uid() is not null
    and i.accepted_at is null
    and i.expires_at > now()
    and o.archived_at is null
    and i.email operator(extensions.=)
      (coalesce(auth.jwt() ->> 'email', ''))::extensions.citext
    and not exists (
      select 1 from public.memberships m
      where m.organization_id = i.organization_id and m.user_id = auth.uid()
    )
  order by i.created_at desc
$$;

comment on function public.my_invitations() is
  'Den inloggades egna obesvarade inbjudningar (e-post i JWT), med språket. Ingen token.';

revoke all on function public.my_invitations() from public, anon;
grant execute on function public.my_invitations() to authenticated;

revoke all on function public.set_invitation_options(uuid, uuid, text, text) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.accept_my_invitation(uuid) from public, anon;
grant execute on function public.set_invitation_options(uuid, uuid, text, text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.accept_my_invitation(uuid) to authenticated;
