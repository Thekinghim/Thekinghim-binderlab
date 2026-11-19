-- =============================================================================
-- Butiksrapporten: avtalets form per butik.
--
-- Rapporten ska säga vilket avtal ersättningen vilar på. Appen kan inte veta om ett avtal
-- är skriftligt eller muntligt: en kontraktsrad kan stå som undertecknad utan att ett
-- skriftligt avtal finns. Ägaren eller admin väljer därför per butik (Butiker → Kontakt och
-- rapport):
--
-- * stores.agreement_form: 'written' = "Skriftligt avtal" (rapporten visar det
--   undertecknade kontraktet, som förut), 'oral' = "Muntligt avtal" (rapporten visar
--   "Muntligt avtal mellan {bolag} och {butik}: {villkoren}.", också om en kontraktsrad
--   står som undertecknad). null (standard) = inte valt: rapporten visar det undertecknade
--   kontraktet om det finns, annars ingen rad, och granskningen varnar.
--
-- Valet läses när rapporten skapas och sparas i rapportens ögonblicksbild
-- (reports.data_snapshot → report.basis.agreementForm): en godkänd eller skickad rapport
-- ändras inte.
--
-- Bara tillägg: kolumnen är valfri, så äldre kod (som inte känner till den) fungerar som
-- förut. Bara ägare och admin ändrar (stores_update, oförändrad). Butiksportalen läser inte
-- kolumnen: den får raden med den sparade rapporten.
-- =============================================================================

alter table public.stores
  add column agreement_form text
    check (agreement_form is null or agreement_form in ('written', 'oral'));

comment on column public.stores.agreement_form is
  'Avtalets form i butiksrapporten: written = skriftligt, oral = muntligt, null = inte valt.';
