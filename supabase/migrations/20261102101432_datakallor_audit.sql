-- =============================================================================
-- Datakällor: ändringar loggas i audit_log.
--
-- * data_sources: skapande och ändringar (namn, källans tidszon, status,
--   sparad kolumnmappning i config, arkivering). Synkmarkören och
--   last_synced_at tas bort ur loggraden, så att varje import inte ger en
--   loggrad (importen själv finns i public.imports).
-- * source_machines: kopplingen av en källautomat (Order Machine) till en av
--   våra automater. Raderna som importen skapar för okända automater loggas
--   inte (de syns i importen); bara ändringar.
-- =============================================================================

create trigger t90_audit after insert or update on public.data_sources
  for each row execute function private.audit('cursor', 'last_synced_at');

create trigger t90_audit after update on public.source_machines
  for each row execute function private.audit();
