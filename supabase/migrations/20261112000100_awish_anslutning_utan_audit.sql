-- =============================================================================
-- source_machines: anslutningen (awish_*) loggas inte i audit_log.
--
-- Awish-synken skriver automatens läge (awish_online, awish_status, awish_seen_at
-- m.fl., 20261110000000_awish_online_konto.sql) i varje körning, nu var femte minut
-- (20261112000000_awish_synk_var_femte_minut.sql). awish_seen_at ändras varje gång,
-- så audit-triggern (20261102101432_datakallor_audit.sql) skrev en rad per automat
-- och körning i den append-only audit_log: med tio automater nästan 3 000 rader om
-- dygnet. Kolumnerna tas bort ur loggraden, som cursor och last_synced_at på
-- data_sources: en ändring som bara rör dem ger ingen rad (private.audit jämför
-- raden utan de strippade kolumnerna). Kopplingen till en automat (machine_id) och
-- övriga ändringar loggas som förut. Anslutningens historik finns i larmen
-- (machine_offline) och i public.machine_connectivity.
-- =============================================================================

drop trigger if exists t90_audit on public.source_machines;
create trigger t90_audit after update on public.source_machines
  for each row execute function private.audit(
    'awish_online',
    'awish_status',
    'awish_seen_at',
    'awish_online_at',
    'awish_offline_since',
    'awish_back_online_at',
    'awish_last_offline_from'
  );
