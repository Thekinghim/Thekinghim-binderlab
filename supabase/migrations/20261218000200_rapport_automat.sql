-- =============================================================================
-- Butiksrapporten: "Vi äger och driver automaterna i butikerna".
--
-- En butiks revisor frågade vem som äger automaten. Appen kan inte veta det (en automat kan
-- vara hyrd eller ägas av någon annan), så ägaren eller admin anger det under
-- Inställningar → Företaget:
--
-- * report_owns_machines (standard false): på = butiksrapporten säger under bolaget som
--   betalar att det "äger och driver automaten". Av = rapporten säger inget om det.
--
-- Valet läses när rapporten skapas och sparas i rapportens ögonblicksbild
-- (reports.data_snapshot → report.basis.payer.ownsMachines): en godkänd eller skickad
-- rapport ändras inte. Det ändrar ingen uträkning.
--
-- Bara tillägg: kolumnen har ett standardvärde, så äldre kod (som inte känner till den)
-- fungerar som förut. Läses och skrivs med de befintliga policyerna på
-- organization_settings (läses av ägare, admin och läsare; skrivs av ägare och admin).
-- Ändringarna loggas av private.audit() som förut.
-- =============================================================================

alter table public.organization_settings
  add column report_owns_machines boolean not null default false;

comment on column public.organization_settings.report_owns_machines is
  'Vi äger och driver automaterna i butikerna: butiksrapporten säger det. false = sägs inte.';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (report_owns_machines)
  on table public.organization_settings to authenticated;
