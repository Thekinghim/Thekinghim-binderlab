-- =============================================================================
-- Nayax månadsrapport (Reimbursement Statement) som utbetalning
--
-- Kortbetalningarna betalas ut av Nayax, som skickar en rapport i PDF varje månad. Ekonomi
-- läser rapporten och sparar den som en utbetalning i payouts. Utöver beloppet och
-- avgifterna behöver raden det som bara rapporten vet: vad som är kortavgift, vad Nayax
-- drog därutöver (bankavgift, engångsavgift med orsak), sista dag för utbetalningen och
-- försäljningen per automat.
--
-- * statement: rapportens siffror som ett JSON-objekt (null för utbetalningar från en
--   CSV-fil och för dem som är inskrivna för hand).
--
-- Bara en ny kolumn som får vara tom: den gamla koden läser och skriver payouts som förut.
-- Raden går som förut inte att ändra (payouts_guard jämför alla kolumner utom arkivering
-- och anteckning, alltså också statement), bara arkivera. Samma policyer och rättigheter.
-- =============================================================================

alter table public.payouts
  add column statement jsonb
    check (statement is null or jsonb_typeof(statement) = 'object');

comment on column public.payouts.statement is
  'Siffrorna ur Nayax månadsrapport (kortavgift, övriga avdrag med orsak, automater). Null = ingen rapport.';
