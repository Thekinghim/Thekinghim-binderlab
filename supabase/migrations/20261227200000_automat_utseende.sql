-- =============================================================================
-- Automatens utseende (machines.appearance): vilken av våra kiosker som står i butiken,
-- så att appen kan rita rätt automat (MachineGlyph, src/components/v2/machine-glyph.tsx).
--
--   'stjarnor'  svart kiosk med gula stjärnor och blå strålar (de flesta butiker, standard)
--   'gul'       gul kiosk med vit blixt
--
-- Bara utseende: inga belopp, inga beräkningar. RLS och rättigheter oförändrade (tabellens
-- befintliga policyer gäller: alla roller läser, ägare och admin ändrar). null räknas som
-- 'stjarnor' i appen.
--
-- Ingen data sätts här. Vid driftsättning: sätt BL-001 (Sega gubben) till 'gul' för hand.
--
-- Säkert medan den gamla koden kör: den läser kolumnerna med namn och bryr sig inte om
-- den nya kolumnen.
-- =============================================================================

alter table public.machines
  add column appearance text default 'stjarnor'
    constraint machines_appearance_check check (appearance in ('stjarnor', 'gul'));

comment on column public.machines.appearance is
  'Automatens utseende: stjarnor (svart med stjärnor, standard) eller gul. null = stjarnor.';
