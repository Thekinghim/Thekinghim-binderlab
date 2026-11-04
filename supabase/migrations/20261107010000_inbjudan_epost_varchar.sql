-- =============================================================================
-- Inbjudningar: e-postjämförelsen mot auth.users fungerar i Supabase.
--
-- I Supabase är auth.users.email av typen character varying, inte citext som i den
-- lokala auth-shimmen. Jämförelsen `u.email operator(extensions.=) x::citext` fanns
-- därför inte i produktion (42883: operator does not exist: character varying =
-- citext), och både create_invitation och create_store_invitation kraschade alltid.
-- Funktionerna skapas om med samma innehåll, men e-posten castas uttryckligen till
-- citext på båda sidor (fungerar för varchar i Supabase och citext lokalt).
-- =============================================================================

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role public.member_role,
  p_valid_days integer default 7
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text := lower(btrim(p_email));
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan bjuda in.';
  end if;
  if p_role = 'owner' and not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara en ägare kan bjuda in en ägare.';
  end if;
  if p_role is null then
    raise exception using errcode = '22023', message = 'Roll saknas.';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception using errcode = '22023', message = 'En inbjudan gäller 1–30 dagar.';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
      and u.email::extensions.citext operator(extensions.=) v_email::extensions.citext
  ) then
    raise exception using errcode = 'BL014', message = 'Personen är redan medlem.';
  end if;

  -- Bara inbjudningar som anroparen själv hade fått skapa löper ut: en admin
  -- kan inte slå ut en ägares ägarinbjudan genom att bjuda in adressen igen.
  update public.invitations i
  set expires_at = now()
  where i.organization_id = p_organization_id
    and i.email operator(extensions.=) v_email::extensions.citext
    and i.accepted_at is null
    and i.expires_at > now()
    and (i.role <> 'owner' or private.has_role(p_organization_id, 'owner'));

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (organization_id, email, role, token_hash, expires_at, invited_by)
  values (
    p_organization_id,
    v_email,
    p_role,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    now() + make_interval(days => p_valid_days),
    auth.uid()
  );

  return v_token;
end
$$;

create or replace function public.create_store_invitation(
  p_organization_id uuid,
  p_store_id uuid,
  p_email text,
  p_valid_days integer default 14
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan bjuda in.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'Ange en e-postadress.';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception using errcode = '22023', message = 'En inbjudan gäller 1–30 dagar.';
  end if;
  if p_store_id is null or not exists (
    select 1 from public.stores s
    where s.organization_id = p_organization_id and s.id = p_store_id and s.archived_at is null
  ) then
    raise exception using errcode = '22023', message = 'Butiken finns inte.';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
      and u.email::extensions.citext operator(extensions.=) v_email::extensions.citext
  ) then
    raise exception using errcode = 'BL014', message = 'Personen är redan medlem.';
  end if;

  -- Tidigare obesvarade butiksinbjudningar till samma adress löper ut (inte
  -- inbjudningar med andra roller: de ägs av Användare).
  update public.invitations i
  set expires_at = now()
  where i.organization_id = p_organization_id
    and i.email operator(extensions.=) v_email::extensions.citext
    and i.role = 'store'
    and i.accepted_at is null
    and i.expires_at > now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (
    organization_id, email, role, store_id, token_hash, expires_at, invited_by
  )
  values (
    p_organization_id,
    v_email,
    'store',
    p_store_id,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    now() + make_interval(days => p_valid_days),
    auth.uid()
  );

  return v_token;
end
$$;
