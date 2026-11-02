-- =============================================================================
-- Felövervakning (fas 7): systemlarm för misslyckade rapporter och jobb.
--
-- alerts.alert_group får värdet 'system'. Familjen har inga regler i larmjobbet:
-- incidenterna skrivs av src/server/monitoring (systemroll) när ett rapportutskick,
-- månadsutkasten eller ett schemalagt jobb misslyckas, och stängs när samma sak
-- lyckas. Typerna är 'report_failed' och 'job_failed' (alerts.kind har redan ett
-- formatvillkor, inte en lista).
--
-- Läsrätt som för övriga larm (ägare, admin, läsare). Påfyllarens policy
-- (alerts_select_refiller) gäller bara 'machine' och 'stock' och ändras inte.
-- Prenumerationerna (private.alert_kinds_valid) ändras inte: systemlarm aviseras
-- inte, de syns på Drift och i Att göra.
-- =============================================================================

alter table public.alerts drop constraint alerts_alert_group_check;
alter table public.alerts add constraint alerts_alert_group_check
  check (alert_group is null or alert_group in ('machine', 'stock', 'import', 'sales', 'system'));
