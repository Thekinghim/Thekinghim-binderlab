-- =============================================================================
-- Om Awish krånglar (WP2): automatiska nya försök för skrivningar till Awish.
--
-- 1. automation_log får sorten 'awish_push_retry': ett automatiskt nytt försök (cron var
--    femte minut) med de väntande sändningarna i en organisation. En rad per försök och
--    organisation (machine_id null, units = antal väntande automater). Raderna ger
--    väntetiden per organisation: 5, 10, 20, 40 och sedan 60 minuter mellan försöken.
--    Sidan Värde, dagliga kontrollen och "väntar"-logiken läser bara sina egna sorter och
--    ändras inte.
-- 2. campaign_machines får retry_count och next_retry_at: en automat där kampanjen inte
--    kom fram försöks igen automatiskt efter 5, 15 och 60 minuter (högst 3 gånger), med
--    samma skydd mot dubbla kampanjer som "Försök igen".
--
-- Additivt: en bredare kontroll och två kolumner med standardvärde.
-- =============================================================================

alter table public.automation_log drop constraint automation_log_kind_check;
alter table public.automation_log add constraint automation_log_kind_check
  check (kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared', 'awish_push_retry'));

comment on table public.automation_log is
  'Arbete som Binderlab gjort automatiskt (awish_push), sändningar till Awish som inte gick fram (awish_push_failed, awish_push_cleared) och automatiska nya försök (awish_push_retry). Skrivs av servern, append-only.';

create index automation_log_retry_idx
  on public.automation_log (organization_id, occurred_at desc)
  where kind = 'awish_push_retry';

alter table public.campaign_machines
  add column retry_count integer not null default 0 check (retry_count between 0 and 10),
  add column next_retry_at timestamptz;

comment on column public.campaign_machines.retry_count is
  'Antal automatiska nya försök efter failed (högst 3).';
comment on column public.campaign_machines.next_retry_at is
  'När nästa automatiska försök får göras (null = inget fler automatiskt).';

create index campaign_machines_retry_idx on public.campaign_machines (next_retry_at)
  where status = 'failed' and next_retry_at is not null;
