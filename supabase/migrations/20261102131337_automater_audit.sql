-- =============================================================================
-- Automater: ändringar i automatregistret loggas i audit_log.
--
-- machine_placements loggas redan (flytt mellan butiker). Här läggs loggning
-- till för machines: ny automat, namn, serienummer, driftstart och
-- avveckling (active_to). Raderingar stoppas redan av t99_forbid_delete.
-- =============================================================================

-- (Idempotent: en tidigare version av filen med fel tidsstämpel kan redan ha körts lokalt.)
drop trigger if exists t90_audit on public.machines;
create trigger t90_audit after insert or update on public.machines
  for each row execute function private.audit();
