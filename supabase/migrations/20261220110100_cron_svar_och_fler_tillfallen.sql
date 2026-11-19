-- =============================================================================
-- Schemalagda jobb: svaret sparas, och kontrollen får fler tillfällen
--
-- Den dagliga kontrollen hade aldrig körts enligt schemat i produktionen, men pg_cron
-- visade "succeeded" varje dag: det betyder bara att anropet lades i kö hos pg_net. Ingen
-- läste svaret, och pg_net rensar svaren efter sex timmar, så det gick inte att se i
-- efterhand om routen svarade 200, 500 eller inte alls.
--
-- 1. private.cron_calls: en rad per anrop från pg_cron (jobb, tid, pg_net:s id) som fylls
--    i med svaret (statuskod, timeout, fel) nästa gång något jobb körs. Awish-synken går
--    var femte minut, så svaren hinner alltid läsas innan pg_net rensar dem. Raderna
--    sparas i 30 dagar. Tabellen ligger i schemat private: inga klientroller når den,
--    servern läser den som systemroll (vakten på Hem och Drift).
-- 2. private.cron_call(jobb, sökväg, tidsgräns): det gemensamma anropet. De fem
--    tick-funktionerna gör samma anrop som förut (samma adress, hemlighet och tidsgräns)
--    genom den. Loggningen ligger i ett eget undantagsblock: ett fel där stoppar aldrig
--    anropet.
-- 3. Kontrollen anropas varje timme 03:52–09:52 UTC i stället för 03:37 och 04:37. Routen
--    kör varje organisation en gång per dag från 05:00 lokal tid, så de extra tillfällena
--    gör ingenting när den redan har kört, och är nya försök när den inte har det.
--    Minut 52 krockar inte med bokföringen (03:37) eller Awish-synken (var femte minut).
--    Bokföringen får ett andra tillfälle 05:37 UTC (samma underlag ger inget nytt paket).
--
-- Allt är additivt: en ny tabell i private, två nya funktioner, fem ersatta funktioner med
-- samma signatur och samma anrop. Den gamla koden märker ingen skillnad. Lokalt och i CI
-- (utan pg_cron och pg_net) schemaläggs ingenting och tick-funktionerna ger null som förut.
-- =============================================================================

create table private.cron_calls (
  id bigint generated always as identity primary key,
  job text not null check (char_length(job) between 1 and 40),
  -- pg_net:s id för anropet (net._http_response.id).
  request_id bigint,
  called_at timestamptz not null default now(),
  -- Sätts när svaret har lästs ur net._http_response. Null = inget svar läst (än).
  answered_at timestamptz,
  status_code integer,
  timed_out boolean,
  error text check (error is null or char_length(error) <= 500)
);

create index cron_calls_job_time_idx on private.cron_calls (job, called_at desc);
create index cron_calls_open_idx on private.cron_calls (request_id) where answered_at is null;

comment on table private.cron_calls is
  'Anropen från pg_cron till appens schemalagda jobb och vad de svarade (statuskod, timeout, fel). 30 dagar. Läses bara av servern.';

revoke all on table private.cron_calls from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Läser svaren som har kommit och sparar dem på anropen. Ger antalet ifyllda rader.
-- -----------------------------------------------------------------------------
create or replace function private.cron_collect() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  delete from private.cron_calls where called_at < now() - interval '30 days';
  if to_regclass('net._http_response') is null then
    return 0;
  end if;
  execute $q$
    update private.cron_calls c
       set answered_at = now(),
           status_code = r.status_code,
           timed_out = coalesce(r.timed_out, false),
           error = left(
             coalesce(
               nullif(r.error_msg, ''),
               case when r.status_code between 200 and 299 then null else r.content end
             ), 500)
      from net._http_response r
     where c.answered_at is null
       and c.request_id is not null
       and r.id = c.request_id
       and c.called_at > now() - interval '12 hours'$q$;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke all on function private.cron_collect() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Det gemensamma anropet: GET {binderlab_app_url}{sökväg} med
-- "Authorization: Bearer {binderlab_cron_secret}" via pg_net. Inget görs utan adress,
-- hemlighet och pg_net (samma villkor som tick-funktionerna hade var för sig).
-- -----------------------------------------------------------------------------
create or replace function private.cron_call(p_job text, p_path text, p_timeout_ms integer)
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
    using v_url || p_path,
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          p_timeout_ms;
  -- Loggningen får aldrig stoppa anropet.
  begin
    perform private.cron_collect();
    insert into private.cron_calls (job, request_id) values (p_job, v_request);
  exception when others then
    raise warning 'Anropet till % kunde inte loggas: %', p_job, sqlerrm;
  end;
  return v_request;
end
$$;

revoke all on function private.cron_call(text, text, integer)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tick-funktionerna: samma anrop som förut, nu genom private.cron_call.
-- -----------------------------------------------------------------------------
create or replace function private.awish_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('awish', '/api/cron/awish', 60000);
end
$$;

create or replace function private.ai_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('ai', '/api/cron/ai', 300000);
end
$$;

create or replace function private.bokforing_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('bokforing', '/api/cron/bokforing', 300000);
end
$$;

create or replace function private.kontroll_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('kontroll', '/api/cron/kontroll', 300000);
end
$$;

create or replace function private.vecka_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('vecka', '/api/cron/vecka', 300000);
end
$$;

revoke all on function private.awish_cron_tick() from public, anon, authenticated, service_role;
revoke all on function private.ai_cron_tick() from public, anon, authenticated, service_role;
revoke all on function private.bokforing_cron_tick() from public, anon, authenticated, service_role;
revoke all on function private.kontroll_cron_tick() from public, anon, authenticated, service_role;
revoke all on function private.vecka_cron_tick() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Fler tillfällen: kontrollen varje timme 03:52–09:52 UTC, bokföringen 03:37 och 05:37.
-- Misslyckas det blir det en varning, inte ett avbrott.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regnamespace('net') is not null then
    begin
      if exists (select 1 from cron.job where jobname = 'binderlab-kontroll') then
        perform cron.unschedule('binderlab-kontroll');
      end if;
      perform cron.schedule('binderlab-kontroll', '52 3-9 * * *', 'select private.kontroll_cron_tick()');
    exception when others then
      raise warning 'Kontrollens schema (pg_cron) kunde inte ändras: %', sqlerrm;
    end;
    begin
      if exists (select 1 from cron.job where jobname = 'binderlab-bokforing') then
        perform cron.unschedule('binderlab-bokforing');
      end if;
      perform cron.schedule('binderlab-bokforing', '37 3,5 * * *', 'select private.bokforing_cron_tick()');
    exception when others then
      raise warning 'Bokföringens schema (pg_cron) kunde inte ändras: %', sqlerrm;
    end;
  end if;
end
$$;

revoke all on all functions in schema private from public;
