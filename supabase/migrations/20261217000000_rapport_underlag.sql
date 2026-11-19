-- =============================================================================
-- Butiksrapporten som underlag för butikens bokföring.
--
-- En butiks revisor godkände inte rapporten som underlag: den visade inte vilket bolag
-- som betalar ersättningen, och inte om svensk moms gäller. Rapporten visar nu vem som
-- betalar (företagsnamn, organisationsnummer, adress, momsregistreringsnummer), avtalet
-- och momsen. Två nya uppgifter under Inställningar → Företaget:
--
-- * vat_number:      vårt momsregistreringsnummer, SE + tio siffror + 01. null = visas
--                    inte. Appen föreslår numret från organisationsnumret, men sparar det
--                    aldrig utan att ägaren eller admin har valt det.
-- * report_vat_mode: momsen i butiksrapporten. 'added' (standard) = "Moms tillkommer
--                    (25 %)": rapporten visar ersättningen, momsen och beloppet att
--                    fakturera. 'none' = "Visa ingen momsrad".
--
-- Uppgifterna läses när rapporten skapas och sparas i rapportens ögonblicksbild
-- (reports.data_snapshot → report.basis), så en godkänd eller skickad rapport ändras inte.
--
-- Bara tillägg: vat_number är valfri och report_vat_mode har ett standardvärde, så äldre
-- kod (som inte känner till kolumnerna) fungerar som förut. Läses av ägare, admin och
-- läsare och skrivs av ägare och admin (befintliga policyer på organization_settings).
-- Ändringarna loggas av private.audit() som förut.
-- =============================================================================

alter table public.organization_settings
  add column vat_number text
    check (vat_number is null or vat_number ~ '^SE\d{10}01$'),
  add column report_vat_mode text not null default 'added'
    check (report_vat_mode in ('added', 'none'));

comment on column public.organization_settings.vat_number is
  'Vårt momsregistreringsnummer (SE + tio siffror + 01). null = visas inte i butiksrapporten.';
comment on column public.organization_settings.report_vat_mode is
  'Momsen i butiksrapporten: added = moms tillkommer (25 %), none = ingen momsrad.';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (vat_number, report_vat_mode)
  on table public.organization_settings to authenticated;
