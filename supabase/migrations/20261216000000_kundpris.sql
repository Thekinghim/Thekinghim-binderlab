-- =============================================================================
-- Pris mot kund på inköpspriserna.
--
-- Leverantörens prislista har två priser per produkt: vad vi betalar (Real Cost,
-- unit_cost_ore) och ett högre pris mot kund. Det andra priset sparas här, på
-- samma prisperiod som kostnaden, så att det följer historiken (valid_from).
--
-- Kolumnen visas bara på sidan Inköpspriser. Ingen beräkning läser den: vinst,
-- rapporter, butikens andel, bokföring och lagervärde räknas som förut på
-- unit_cost_ore. Vyn purchase_price_periods lämnas orörd.
--
-- Tillägget är säkert medan den gamla koden kör: kolumnen får vara tom och
-- ingen gammal fråga nämner den.
--
-- Stängda månader: purchase_prices_period_guard bevakar bara titel, datum och
-- unit_cost_ore. Pris mot kund ändrar ingen siffra och får därför ändras också
-- i en stängd månad. Ändringen loggas av t90_audit som alla andra.
--
-- RLS är oförändrad: ägare, admin och läsare läser raden, ägare och admin
-- skriver. Påfyllare och butikernas portal når aldrig tabellen.
-- =============================================================================

alter table public.purchase_prices
  add column customer_price_ore bigint
  constraint purchase_prices_customer_price_ore_check
    check (customer_price_ore is null or customer_price_ore >= 0);

comment on column public.purchase_prices.customer_price_ore is
  'Pris mot kund per pack i öre (leverantörens prislista). Bara för visning: vinsten räknas på unit_cost_ore. Tomt = inget pris mot kund angivet.';

-- Uppdatering är tillåtlistad per kolumn (unit_cost_ore, valid_from, note).
grant update (customer_price_ore) on table public.purchase_prices to authenticated;
