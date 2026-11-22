-- =============================================================================
-- V2: facken per kanal från förra Awish-läsningen, för produktbyten (byggplanen 3.3).
--
-- Saldosynken hittade ett produktbyte (titel A ut ur fack A3, titel B in) genom att jämföra
-- förra läsningens fack per titel (machine_slot_capacity.channels) med facken nu. Den tabellen
-- har bara titlar med kapacitet > 0: rapporterar Awish kapacitet 0 för en automats fack fanns
-- inga rader, och byten i den automaten upptäcktes aldrig.
--
-- stock_locations.awish_channels: kanal → titel vid förra läsningen, för alla fack med vara,
-- oberoende av kapaciteten: { "A3": "<title uuid>", ... }. Skrivs bara av synken
-- (src/server/awish/stock.ts), i samma transaktion som awish_fill. Väntar ett bytt fack på en
-- sändning till Awish skrivs den inte om (som machine_slot_capacity), så att bytet hittas när
-- sändningen gått fram. machine_slot_capacity behåller sin betydelse (känd kapacitet > 0).
-- Inga belopp: alla roller som ser lagerplatsen ser den.
-- =============================================================================

alter table public.stock_locations
  add column awish_channels jsonb
    check (awish_channels is null
           or (jsonb_typeof(awish_channels) = 'object'
               and pg_column_size(awish_channels) <= 65536));

comment on column public.stock_locations.awish_channels is
  'Awish kanal → titel vid senaste läsningen ({"A3": title_id}), även fack med kapacitet 0. '
  'null = aldrig läst. Skrivs bara av Awish-synken (produktbyten).';

-- Klientroller får inte ändra awish_synced_at, awish_fill eller awish_channels: bara synken.
create or replace function private.stock_locations_client_awish() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.awish_synced_at is distinct from (case when tg_op = 'UPDATE' then old.awish_synced_at end)
          or new.awish_fill is distinct from (case when tg_op = 'UPDATE' then old.awish_fill end)
          or new.awish_channels is distinct from (case when tg_op = 'UPDATE' then old.awish_channels end)) then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan ändra när automaten senast lästes från Awish.';
  end if;
  return new;
end
$$;

revoke all on function private.stock_locations_client_awish() from public;
