-- =============================================================================
-- Awish webbpanel: skicka påfyllningar till Awish (docs/awish-web.md)
--
-- Den officiella gRPC-kopplingen kan bara läsa lager. För att slippa skriva antal
-- för hand på dash.awish.vip loggar servern in på Awishs webbpanel med butikens egen
-- e-post och lösenord och sätter facken via panelens GraphQL-API. Uppgifterna sparas
-- krypterat i Supabase Vault, aldrig i klartext i tabellerna och aldrig i webbläsaren.
--
-- * public.awish_save_web_credentials(org, ds, email, password): ägare och admin sparar
--   inloggningen för en awish_grpc-datakälla. Hemligheten läggs i Vault under
--   "{organization_id}/awish_web:{data_source_id}". data_sources.config.awishWeb får
--   { email (maskad), emailLast4, hasPassword, enabled }. Tomma fält behåller det sparade.
--   Returnerar bara ledtrådarna (aldrig lösenordet).
-- * public.awish_set_web_push(org, ds, enabled): slår på/av automatisk push (config-flagga).
-- * private.awish_read_web_credentials(ds): servern läser e-post och lösenord inför ett
--   anrop till Awish. Kan inte köras av klientroller.
--
-- Allt är additivt. Ingen tabell ändras; bara nya funktioner och en config-nyckel.
-- =============================================================================

create or replace function public.awish_save_web_credentials(
  p_organization_id uuid,
  p_data_source_id uuid,
  p_email text,
  p_password text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source public.data_sources%rowtype;
  v_secret_name text;
  v_secret_id uuid;
  v_old jsonb := '{}'::jsonb;
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_password text := nullif(p_password, '');
  v_masked text;
  v_hints jsonb;
begin
  if not private.has_role(p_organization_id, 'owner'::public.member_role, 'admin'::public.member_role) then
    raise exception 'Bara ägare och administratörer får spara Awish-inloggningen.'
      using errcode = '42501';
  end if;

  select * into v_source
  from public.data_sources ds
  where ds.organization_id = p_organization_id and ds.id = p_data_source_id
    and ds.provider = 'awish_grpc' and ds.archived_at is null
  for update;
  if not found then
    raise exception 'Datakällan finns inte.' using errcode = 'P0002';
  end if;

  if v_email is not null and (char_length(v_email) > 200 or v_email ~ '[[:cntrl:]]' or v_email !~ '@') then
    raise exception 'Ange en giltig e-postadress.' using errcode = '22023';
  end if;
  if v_password is not null and (char_length(v_password) > 200 or v_password ~ '[[:cntrl:]]') then
    raise exception 'Lösenordet får vara högst 200 tecken utan radbrytningar.' using errcode = '22023';
  end if;

  v_secret_name := p_organization_id::text || '/awish_web:' || p_data_source_id::text;
  select s.id, coalesce(s.decrypted_secret, '{}')::jsonb into v_secret_id, v_old
  from vault.decrypted_secrets s
  where s.name = v_secret_name;

  v_email := coalesce(v_email, v_old ->> 'email');
  v_password := coalesce(v_password, v_old ->> 'password');
  if v_email is null or v_password is null then
    raise exception 'Ange både e-post och lösenord.' using errcode = '22023';
  end if;

  if v_secret_id is null then
    perform vault.create_secret(
      jsonb_build_object('email', v_email, 'password', v_password)::text,
      v_secret_name,
      'Binderlab: Awish webbpanel (e-post och lösenord) för en datakälla'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      jsonb_build_object('email', v_email, 'password', v_password)::text
    );
  end if;

  -- Maskad e-post för visning: första tecknet + *** + domänen.
  v_masked := case
    when position('@' in v_email) > 1
    then left(v_email, 1) || '***' || substring(v_email from position('@' in v_email))
    else '***'
  end;
  v_hints := jsonb_build_object(
    'email', v_masked,
    'emailLast4', right(split_part(v_email, '@', 1), 4),
    'hasPassword', true,
    'enabled', coalesce((v_source.config -> 'awishWeb' ->> 'enabled')::boolean, false)
  );

  update public.data_sources ds
  set config = jsonb_set(
        ds.config,
        '{awishWeb}',
        coalesce(ds.config -> 'awishWeb', '{}'::jsonb) || v_hints
      )
  where ds.organization_id = p_organization_id and ds.id = p_data_source_id;

  return v_hints;
end
$$;

revoke all on function public.awish_save_web_credentials(uuid, uuid, text, text) from public, anon;
grant execute on function public.awish_save_web_credentials(uuid, uuid, text, text) to authenticated;

-- Slå på eller av automatisk push till Awish.
create or replace function public.awish_set_web_push(
  p_organization_id uuid,
  p_data_source_id uuid,
  p_enabled boolean
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_has_password boolean;
begin
  if not private.has_role(p_organization_id, 'owner'::public.member_role, 'admin'::public.member_role) then
    raise exception 'Bara ägare och administratörer får ändra Awish-push.' using errcode = '42501';
  end if;
  select coalesce((config -> 'awishWeb' ->> 'hasPassword')::boolean, false) into v_has_password
  from public.data_sources
  where organization_id = p_organization_id and id = p_data_source_id and provider = 'awish_grpc'
    and archived_at is null;
  if not found then
    raise exception 'Datakällan finns inte.' using errcode = 'P0002';
  end if;
  if p_enabled and not v_has_password then
    raise exception 'Spara Awish-inloggningen innan du slår på push.' using errcode = '22023';
  end if;
  update public.data_sources ds
  set config = jsonb_set(
        ds.config,
        '{awishWeb,enabled}',
        to_jsonb(p_enabled)
      )
  where ds.organization_id = p_organization_id and ds.id = p_data_source_id;
  return p_enabled;
end
$$;

revoke all on function public.awish_set_web_push(uuid, uuid, boolean) from public, anon;
grant execute on function public.awish_set_web_push(uuid, uuid, boolean) to authenticated;

-- Servern (systemrollen) läser inloggningen inför ett anrop till Awish.
create or replace function private.awish_read_web_credentials(p_data_source_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret::jsonb
  from public.data_sources ds
  join vault.decrypted_secrets s on s.name = ds.organization_id::text || '/awish_web:' || ds.id::text
  where ds.id = p_data_source_id and ds.provider = 'awish_grpc'
$$;

revoke all on function private.awish_read_web_credentials(uuid) from public, anon, authenticated, service_role;
