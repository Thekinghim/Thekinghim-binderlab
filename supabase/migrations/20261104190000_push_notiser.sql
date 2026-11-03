-- =============================================================================
-- Managerpaket 8: push i mobilen.
--
-- Ny larmtyp 'machine_discovered' ("Ny automat hittad"): Awish har en automat som inte
-- är kopplad till någon butik. Larmjobbet tar den ur samma lista som Att göra
-- (src/server/machines/new-machines.ts: source_machines utan automat, källan inte
-- arkiverad, inte "Inte vår"). Familj 'import' (alerts.alert_group har redan värdet);
-- alerts.kind har bara ett formatvillkor, så bara prenumerationerna ändras här.
--
-- Påfyllaren får den inte (private.alert_kinds_are_field ändras inte): bara ägare och
-- admin kan koppla en automat.
-- =============================================================================

create or replace function private.alert_kinds_valid(p_kinds text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_kinds is null or (
    cardinality(p_kinds) between 1 and 7
    and p_kinds <@ array['machine_suspected_fault', 'machine_fault', 'machine_offline',
                         'low_stock', 'import_failed', 'day_anomaly',
                         'machine_discovered']::text[]
  )
$$;

revoke all on function private.alert_kinds_valid(text[]) from public, anon;
grant execute on function private.alert_kinds_valid(text[]) to authenticated;
