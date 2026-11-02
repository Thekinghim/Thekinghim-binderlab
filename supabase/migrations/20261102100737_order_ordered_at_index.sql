-- Orderlistan (/order): nyaste först över hela historiken.
--
-- Listan sorterar på ordered_at (fallande, id som avgörare) och hämtar en sida i taget.
-- Utan index sorteras alla order i perioden för varje sida (top-N över 100 000 rader,
-- ~100 ms); med index läses bara sidan. Samma index ger "senaste ordern" (max) direkt.

create index if not exists orders_ordered_at_idx
  on public.orders (organization_id, ordered_at desc, id desc);
