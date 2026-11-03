-- =============================================================================
-- Awish API efter granskningen (docs/awish-api.md). Ändrar inget i
-- 20261103090000_awish_api.sql (migreringar ändras aldrig i efterhand).
--
-- * public.awish_save_credentials: de sista fyra tecknen av AppSecret och AppKey
--   sparas i data_sources.config bara när värdet är minst 12 tecken (annars tom
--   text). config kan läsas av alla roller i organisationen (även Läsare) och
--   kopieras till granskningsloggen, så ett kort värde får inte synas där.
--   Redan sparade ledtrådar räknas om på samma sätt.
-- * Chrome-tillägget är borttaget: alla synk-token som inte redan är återkallade
--   återkallas (sync_tokens används inte längre men raderna ligger kvar), och
--   datakällor av typen awish_extension som inte är arkiverade pausas, så att
--   de inte väntar på data som aldrig kommer.
-- * pg_cron sparar varje körning i cron.job_run_details och rensar aldrig. Ett
--   dagligt jobb tar bort körningar äldre än sju dagar. Bara där pg_cron finns
--   (Supabase); scripts/deploy schemalägger samma jobb om det saknas.
-- =============================================================================

create or replace function private.awish_secret_hint(p_value text) returns text
language sql
immutable
set search_path = ''
as $$
  select case when char_length(coalesce(p_value, '')) >= 12 then right(p_value, 4) else '' end
$$;

revoke all on function private.awish_secret_hint(text) from public, anon, authenticated;

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

  -- AppId är ingen hemlighet (skickas som appid i varje anrop).
  v_hints := jsonb_build_object(
    'appIdLast4', right(v_app_id, 4),
    'appSecretLast4', private.awish_secret_hint(v_app_secret),
    'appKeyLast4', private.awish_secret_hint(v_app_key),
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

-- Redan sparade ledtrådar: samma regel.
update public.data_sources ds
set config = jsonb_set(
  ds.config,
  '{awishGrpc,credentials}',
  (ds.config #> '{awishGrpc,credentials}') || jsonb_build_object(
    'appSecretLast4', private.awish_secret_hint(s.decrypted_secret::jsonb ->> 'appSecret'),
    'appKeyLast4', private.awish_secret_hint(s.decrypted_secret::jsonb ->> 'appKey')
  )
)
from vault.decrypted_secrets s
where ds.provider = 'awish_grpc'
  and s.name = ds.secret_ref
  and jsonb_typeof(ds.config #> '{awishGrpc,credentials}') = 'object';

-- Chrome-tillägget finns inte längre.
update public.sync_tokens set revoked_at = now() where revoked_at is null;

update public.data_sources
set status = 'paused'
where provider = 'awish_extension' and archived_at is null and status <> 'paused';

-- Rensning av pg_cron:s körlogg (bara där pg_cron finns).
do $$
begin
  if to_regnamespace('cron') is not null then
    begin
      execute $cmd$select cron.schedule('binderlab-cron-cleanup', '23 3 * * *', $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$)$cmd$;
    exception when others then
      raise warning 'Rensningen av cron.job_run_details kunde inte schemaläggas: %', sqlerrm;
    end;
  end if;
end
$$;
