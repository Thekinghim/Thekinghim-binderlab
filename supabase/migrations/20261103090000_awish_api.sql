-- =============================================================================
-- Awish officiella gRPC-API (docs/awish-api.md): inloggningsuppgifter i Vault
-- och schemalagd synk var tionde minut.
--
-- * public.awish_save_credentials: ägare och admin sparar AppId, AppSecret och
--   AppKey för en datakälla av typen awish_grpc. Uppgifterna läggs i Supabase
--   Vault under organisationens namnrymd ("{organization_id}/awish_grpc:{id}")
--   och data_sources.secret_ref pekar dit. Funktionen returnerar aldrig
--   hemligheten, bara de fyra sista tecknen (config.awishGrpc.credentials, visas
--   i Datakällor). Tomma fält behåller det som redan är sparat. Synkens läge
--   (sidor, senaste körning) ligger i data_sources.cursor som JSON-text, som
--   granskningsloggen redan hoppar över.
-- * private.awish_read_credentials: läser uppgifterna åt servern (systemrollen,
--   synken). Kan inte köras av klientroller.
-- * private.awish_cron_tick: anropas av pg_cron var tionde minut och gör
--   GET {binderlab_app_url}/api/cron/awish med "Authorization: Bearer
--   {binderlab_cron_secret}" via pg_net. Båda värdena läses ur Vault (skrivs av
--   scripts/deploy). Saknas något av dem, eller pg_net, gör funktionen ingenting.
-- * pg_cron och pg_net installeras och jobbet schemaläggs bara där
--   tilläggen finns (Supabase). Lokalt och i CI finns de inte; då hoppas det
--   över. Misslyckas installationen i Supabase blir det en varning, inte ett
--   avbrott, och scripts/deploy rapporterar att jobbet saknas.
--
-- Chrome-tillägget är borttaget ur appen. Enum-värdena awish_extension och
-- import_trigger 'extension' och tabellen sync_tokens ligger kvar (migreringar
-- ändras aldrig i efterhand); tabellen används inte längre.
-- =============================================================================

create or replace function public.awish_save_credentials(
  p_organization_id uuid,
  p_data_source_id uuid,
  p_app_id text,
  p_app_secret text,
  p_app_key text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source public.data_sources%rowtype;
  v_name text;
  v_secret_id uuid;
  v_old jsonb := '{}'::jsonb;
  v_app_id text := nullif(btrim(coalesce(p_app_id, '')), '');
  v_app_secret text := nullif(btrim(coalesce(p_app_secret, '')), '');
  v_app_key text := nullif(btrim(coalesce(p_app_key, '')), '');
  v_hints jsonb;
  v_changed_account boolean;
begin
  if not private.has_role(p_organization_id, 'owner'::public.member_role, 'admin'::public.member_role) then
    raise exception 'Bara ägare och administratörer får spara uppgifterna för Awish.'
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

  foreach v_name in array array[v_app_id, v_app_secret, v_app_key] loop
    if v_name is not null and (char_length(v_name) > 200 or v_name ~ '[[:cntrl:]]') then
      raise exception 'AppId, AppSecret och AppKey får vara högst 200 tecken utan radbrytningar.'
        using errcode = '22023';
    end if;
  end loop;

  v_name := p_organization_id::text || '/awish_grpc:' || p_data_source_id::text;
  select s.id, coalesce(s.decrypted_secret, '{}')::jsonb into v_secret_id, v_old
  from vault.decrypted_secrets s
  where s.name = v_name;

  v_app_id := coalesce(v_app_id, v_old ->> 'appId');
  v_app_secret := coalesce(v_app_secret, v_old ->> 'appSecret');
  v_app_key := coalesce(v_app_key, v_old ->> 'appKey');
  if v_app_id is null or v_app_secret is null or v_app_key is null then
    raise exception 'Ange AppId, AppSecret och AppKey.' using errcode = '22023';
  end if;
  v_changed_account := (v_old ->> 'appId') is distinct from v_app_id;

  if v_secret_id is null then
    perform vault.create_secret(
      jsonb_build_object('appId', v_app_id, 'appSecret', v_app_secret, 'appKey', v_app_key)::text,
      v_name,
      'Binderlab: Awish gRPC (AppId, AppSecret, AppKey) för en datakälla'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      jsonb_build_object('appId', v_app_id, 'appSecret', v_app_secret, 'appKey', v_app_key)::text
    );
  end if;

  v_hints := jsonb_build_object(
    'appIdLast4', right(v_app_id, 4),
    'appSecretLast4', right(v_app_secret, 4),
    'appKeyLast4', right(v_app_key, 4),
    'savedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  update public.data_sources ds
  set secret_ref = v_name,
      config = jsonb_set(
        ds.config,
        '{awishGrpc}',
        coalesce(ds.config -> 'awishGrpc', '{}'::jsonb) || jsonb_build_object('credentials', v_hints)
      ),
      -- Nytt AppId = ett annat Awish-konto: synkens läge (cursor) börjar om.
      cursor = case when v_changed_account then null else ds.cursor end
  where ds.organization_id = p_organization_id and ds.id = p_data_source_id;

  return v_hints;
end
$$;

revoke all on function public.awish_save_credentials(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.awish_save_credentials(uuid, uuid, text, text, text) to authenticated;

-- Servern (systemrollen) läser uppgifterna inför ett anrop till Awish.
create or replace function private.awish_read_credentials(p_data_source_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret::jsonb
  from public.data_sources ds
  join vault.decrypted_secrets s on s.name = ds.secret_ref
  where ds.id = p_data_source_id and ds.provider = 'awish_grpc'
    and ds.secret_ref like ds.organization_id::text || '/awish_grpc:%'
$$;

revoke all on function private.awish_read_credentials(uuid) from public, anon, authenticated, service_role;

-- pg_cron → GET /api/cron/awish. Inget görs utan adress, hemlighet och pg_net.
create or replace function private.awish_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if to_regnamespace('net') is null then
    return null;
  end if;
  select btrim(s.decrypted_secret) into v_url
  from vault.decrypted_secrets s where s.name = 'binderlab_app_url';
  select btrim(s.decrypted_secret) into v_secret
  from vault.decrypted_secrets s where s.name = 'binderlab_cron_secret';
  if v_url is null or v_secret is null or char_length(v_secret) < 16
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    return null;
  end if;
  execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := $3)'
    into v_request
    using v_url || '/api/cron/awish',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          60000;
  return v_request;
end
$$;

revoke all on function private.awish_cron_tick() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $cmd$select cron.schedule('binderlab-awish-sync', '*/10 * * * *', 'select private.awish_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Awish-synkens schema (pg_cron/pg_net) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;
