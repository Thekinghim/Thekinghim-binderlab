-- =============================================================================
-- Mina inbjudningar: den inloggade ser och tar emot sina egna inbjudningar utan
-- länken i mejlet.
--
-- Varför: ägaren kan sätta ett lösenord åt den inbjudna (delägaren) när
-- inbjudan skickas. Delägaren loggar då in med e-post och lösenord, utan att
-- öppna mejlet, och ska ändå kunna gå med på ett tryck.
--
-- Säkerhet
--   * Bara inbjudningar till den inloggades egen e-postadress (auth.jwt()
--     ->> 'email', samma kontroll som accept_invitation), som inte är använda,
--     inte har gått ut och gäller en organisation som inte är arkiverad.
--   * my_invitations lämnar bara ut id, organisationens namn, roll, butikens
--     namn och när inbjudan går ut. Aldrig token_hash eller vem som bjöd in.
--   * accept_my_invitation gör exakt det accept_invitation gör (samma
--     felkoder BL010–BL014), men med inbjudans id i stället för token.
-- =============================================================================

create function public.my_invitations()
returns table (
  id uuid,
  organization_name text,
  role public.member_role,
  store_name text,
  expires_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select i.id, o.name, i.role, st.name, i.expires_at
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
  'Den inloggades egna obesvarade inbjudningar (e-post i JWT). Ingen token.';

create function public.accept_my_invitation(p_invitation_id uuid)
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

  insert into public.memberships (organization_id, user_id, role, store_id)
  values (v_invitation.organization_id, v_uid, v_invitation.role, v_invitation.store_id);

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  insert into public.profiles (organization_id, user_id, display_name)
  values (
    v_invitation.organization_id,
    v_uid,
    coalesce(
      nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
      nullif(split_part(v_invitation.email::text, '@', 1), ''),
      'Medlem'
    )
  )
  on conflict (organization_id, user_id) do nothing;

  return v_invitation.organization_id;
end
$$;

comment on function public.accept_my_invitation(uuid) is
  'Tar emot en egen inbjudan (e-post i JWT) med id i stället för token. Som accept_invitation.';

revoke all on function public.my_invitations() from public, anon;
revoke all on function public.accept_my_invitation(uuid) from public, anon;
grant execute on function public.my_invitations() to authenticated;
grant execute on function public.accept_my_invitation(uuid) to authenticated;
