-- =============================================================================
-- Awish-synken var femte minut i stället för var tionde (order och fack).
--
-- pg_cron-jobbet binderlab-awish-sync (20261103090000_awish_api.sql) anropar
-- private.awish_cron_tick() → GET /api/cron/awish. Här schemaläggs det om till
-- '*/5 * * * *'. Saldot (Products) läses nu i varje körning
-- (src/server/awish/stock.ts, STOCK_SYNC_INTERVAL_MS = 5 min).
--
-- * Bara där pg_cron finns (Supabase). Lokalt och i CI finns det inte; då hoppas
--   det över. Jobbet skrivs bara om när pg_net också finns (som originalet), annars
--   gör tick-funktionen ändå ingenting.
-- * Idempotent: ett befintligt jobb med samma namn tas bort och läggs in igen med
--   det nya schemat. Körs migreringen om blir resultatet detsamma.
-- * Misslyckas det blir det en varning, inte ett avbrott; scripts/deploy kontrollerar
--   schemat och schemalägger om jobbet om det inte är '*/5 * * * *'.
-- =============================================================================

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regnamespace('net') is not null then
    begin
      if exists (select 1 from cron.job where jobname = 'binderlab-awish-sync') then
        perform cron.unschedule('binderlab-awish-sync');
      end if;
      perform cron.schedule('binderlab-awish-sync', '*/5 * * * *', 'select private.awish_cron_tick()');
    exception when others then
      raise warning 'Awish-synkens schema (pg_cron) kunde inte ändras till var femte minut: %', sqlerrm;
    end;
  end if;
end
$$;
