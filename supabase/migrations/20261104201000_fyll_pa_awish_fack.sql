-- =============================================================================
-- Fyll på (mobilen vid automaten): Awish fack per titel i automaten.
--
-- Awish-synken (src/server/awish/stock.ts) läser automatens fack (antal och
-- kapacitet per kanal). Binderlab sparade bara antalet per titel (en inventering) och
-- antalet fack (machine_slots). Fyll på behöver också kapaciteten och vilka fack som är
-- tomma, för att föreslå hur många pack som ska i ("3/12, fyll 9").
--
-- stock_locations.awish_fill: senaste läsningen, en rad per titel:
--   [{ "title_id": uuid, "units": int, "capacity": int, "channels": int, "empty": int }]
-- units = pack i automaten enligt Awish, capacity = summan av fackens kapacitet,
-- channels = antal fack, empty = fack med 0 pack. Skrivs bara av synken, samtidigt som
-- awish_synced_at (samma trigger som awish_synced_at, utvidgad). Alla roller som ser
-- lagerplatsen ser den (inga belopp), även påfyllaren.
-- =============================================================================

alter table public.stock_locations
  add column awish_fill jsonb
    check (awish_fill is null or (jsonb_typeof(awish_fill) = 'array' and jsonb_array_length(awish_fill) <= 500));

comment on column public.stock_locations.awish_fill is
  'Awish fack per titel vid senaste läsningen: [{title_id, units, capacity, channels, empty}]. '
  'null = aldrig läst. Skrivs bara av Awish-synken.';

-- Klientroller får inte ändra awish_synced_at eller awish_fill: bara synken (systemrollen).
create or replace function private.stock_locations_client_awish() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.awish_synced_at is distinct from (case when tg_op = 'UPDATE' then old.awish_synced_at end)
          or new.awish_fill is distinct from (case when tg_op = 'UPDATE' then old.awish_fill end)) then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan ändra när automaten senast lästes från Awish.';
  end if;
  return new;
end
$$;

revoke all on function private.stock_locations_client_awish() from public;
