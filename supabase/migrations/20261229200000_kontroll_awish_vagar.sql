-- =============================================================================
-- Om Awish krånglar: hur länge en väg har gått på reservvägen (docs/operations.md).
--
-- public.awish_path_health.fallback_since: när vägen började gå via webbpanelen
-- (active_route = 'webbpanelen') utan att Open API har fungerat sedan dess. Sätts av en
-- trigger, så att servern som skriver hälsan (src/server/awish/health.ts) inte behöver veta
-- om den:
--
-- - push, goods, slots: alltid null. Där är webbpanelen den vanliga vägen (Open API kan inte
--   skriva), så "via webbpanelen" är inte en reserv och ska aldrig varna.
-- - active_route = 'open_api': null (Open API fungerar igen).
-- - active_route = 'webbpanelen': behålls, eller sätts till försökets tid om den saknas.
-- - annars (senast_kanda, manuell, ingen): behålls som den var.
--
-- Kontroll varnar när den är äldre än ett dygn ("Open API har inte fungerat på ett dygn –
-- kontakta Awish"). Additivt: en ny kolumn och en trigger.
-- =============================================================================

alter table public.awish_path_health add column fallback_since timestamptz;

comment on column public.awish_path_health.fallback_since is
  'När vägen började gå via webbpanelen utan att Open API har fungerat sedan dess (null = Open API fungerar eller har aldrig ersatts). Sätts av triggern t30_fallback_since.';

create function private.awish_path_health_fallback_since()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.path in ('push', 'goods', 'slots') or new.active_route = 'open_api' then
    new.fallback_since := null;
  elsif new.active_route = 'webbpanelen' then
    new.fallback_since := coalesce(
      case when tg_op = 'UPDATE' then old.fallback_since end,
      new.fallback_since,
      new.last_attempt_at,
      now()
    );
  elsif tg_op = 'UPDATE' then
    new.fallback_since := old.fallback_since;
  end if;
  return new;
end
$$;

revoke all on function private.awish_path_health_fallback_since() from public, anon, authenticated;

create trigger t30_fallback_since before insert or update on public.awish_path_health
  for each row execute function private.awish_path_health_fallback_since();
