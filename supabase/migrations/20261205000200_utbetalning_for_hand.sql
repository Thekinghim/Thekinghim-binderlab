-- =============================================================================
-- Ekonomi utan fil: "Vad betalade Awish?"
--
-- Ägaren skriver in vad som kom in på kontot (belopp och dag) i stället för att ladda upp
-- en fil. Raden sparas i payouts som vilken utbetalning som helst, märkt manual = true.
--
-- * manual: sant för en utbetalning som skrivits in för hand. Avgifterna är då okända
--   (fees_ore = 0 i raden); avstämningen räknar dem ur inställningen och visar hela
--   skillnaden mot försäljningen.
--
-- Raden går som förut inte att ändra (payouts_guard jämför alla kolumner utom arkivering
-- och anteckning, alltså också manual), bara arkivera. Samma policyer: ägare och admin
-- lägger in.
-- =============================================================================

alter table public.payouts
  add column manual boolean not null default false;

comment on column public.payouts.manual is
  'Sant = inskriven för hand på Ekonomi (ingen fil). Avgifterna är okända.';
