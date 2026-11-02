-- =============================================================================
-- Butiker: ändringar i butiksregistret och bland rapportmottagarna loggas i
-- audit_log.
--
-- store_agreements loggas redan (ersättningsmodell och avtalshistorik). Här
-- läggs loggning till för stores (ny butik, namn, adress, kontaktuppgifter,
-- exempelmarkering och arkivering) och report_recipients (ny mottagare,
-- ändrad adress, pausad och borttagen). Mottagare får raderas (datamodellen),
-- så radering loggas också.
-- =============================================================================

drop trigger if exists t90_audit on public.stores;
create trigger t90_audit after insert or update on public.stores
  for each row execute function private.audit();

drop trigger if exists t90_audit on public.report_recipients;
create trigger t90_audit after insert or update or delete on public.report_recipients
  for each row execute function private.audit();
