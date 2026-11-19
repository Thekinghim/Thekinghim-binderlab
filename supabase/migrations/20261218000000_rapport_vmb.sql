-- =============================================================================
-- Butiksrapporten: "Vi säljer med vinstmarginalbeskattning (VMB)".
--
-- En butiks revisor frågade om svensk moms gäller. Bolaget säljer varorna i automaten
-- under vinstmarginalbeskattning och vill att rapporten säger det. Appen kan inte veta hur
-- bolaget redovisar sin moms, så ägaren eller admin anger det under Inställningar →
-- Företaget:
--
-- * report_vmb (standard false): på = butiksrapporten säger att bolaget är säljare av
--   varorna och redovisar momsen på försäljningen enligt reglerna om
--   vinstmarginalbeskattning, och att butikens ersättning inte omfattas av VMB. Av = bara
--   att bolaget är säljare av varorna, som förut.
--
-- Valet läses när rapporten skapas och sparas i rapportens ögonblicksbild
-- (reports.data_snapshot → report.basis.vmb): en godkänd eller skickad rapport ändras inte.
-- Det ändrar ingen uträkning (VMB i vyerna, i avtalen och i Bokföringen har egna val).
--
-- Bara tillägg: kolumnen har ett standardvärde, så äldre kod (som inte känner till den)
-- fungerar som förut. Läses och skrivs med de befintliga policyerna på
-- organization_settings (läses av ägare, admin och läsare; skrivs av ägare och admin).
-- Ändringarna loggas av private.audit() som förut.
-- =============================================================================

alter table public.organization_settings
  add column report_vmb boolean not null default false;

comment on column public.organization_settings.report_vmb is
  'Vi säljer med vinstmarginalbeskattning (VMB): butiksrapporten säger det. false = sägs inte.';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (report_vmb)
  on table public.organization_settings to authenticated;
