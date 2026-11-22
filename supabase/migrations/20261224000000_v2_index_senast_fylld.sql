-- V2 prestanda: "senast fylld" per automat utan att läsa alla lagerhändelser.
--
-- Flottans läge (src/server/data/v2/fleet.ts) läser senaste påfyllningen (refill eller
-- transfer_in) per automat på varje sida som visar Hem, Automater eller Rutt. Frågan tog
-- max(occurred_at) över ALLA händelser i automaternas lagerplatser (ett sekventiellt svep
-- som växer med varje försäljning). Nu slås den upp per lagerplats i det här delindexet
-- (en indexrad per påfyllning, senaste först), så att varje plats kostar en indexläsning.
--
-- Bara ett nytt index (additivt): inga tabeller, vyer eller policyer ändras.

create index if not exists stock_events_last_refill_idx
  on public.stock_events (organization_id, location_id, occurred_at desc)
  where kind in ('refill', 'transfer_in');
