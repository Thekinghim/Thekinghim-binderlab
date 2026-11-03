-- =============================================================================
-- Kontrakt: "Särskilda villkor" (fritext) som skrivs in i kontraktets PDF.
--
-- * special_terms: ägarens egna villkor utöver mallen (t.ex. "Butiken får
--   ställa automaten vid kassan"). null = inga. Skrivs ut som ett eget
--   avsnitt i PDF:en (src/reports/contract-pdf.ts). Högst 2 000 tecken.
--
-- Villkoren för ersättningen (andel, av vad, hyra, vid förlust, VMB) ligger
-- som förut i store_agreements; den här kolumnen gäller själva dokumentet.
-- Ändringarna loggas av t90_audit och skrivs bara av ägare och admin
-- (befintliga policyer på contracts).
-- =============================================================================

alter table public.contracts
  add column special_terms text
    check (special_terms is null or char_length(special_terms) between 1 and 2000);

comment on column public.contracts.special_terms is
  'Särskilda villkor (fritext) som skrivs in i kontraktets PDF. null = inga.';
