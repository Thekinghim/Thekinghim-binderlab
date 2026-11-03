-- =============================================================================
-- Lager: saldot i automaterna från Awish (Products).
--
-- Synken (src/server/awish/stock.ts) läser varje kopplad automats fack ur Awish och
-- skriver en inventering (stock_events kind 'count') per titel när Awish antal skiljer
-- sig från Binderlabs saldo, eller när titeln aldrig har inventerats på platsen. Awish
-- är facit för vad som finns i automaten.
--
-- 1. stock_events.source: varifrån en inventering kom. null = registrerad i Binderlab
--    (Lager, Att göra, seed), 'awish' = synken. Bara inventeringar kan ha en källa.
--    Tabellen är fortfarande append-only; kolumnen sätts vid insert.
-- 2. stock_locations.awish_synced_at: senaste gången synken läste automatens fack.
--    Lager visar "Awish hh:mm" och vet att ett saldo är känt även när inget har
--    ändrats sedan förra inventeringen. Skrivs bara av synken (systemrollen).
-- =============================================================================

alter table public.stock_events
  add column source text,
  add constraint stock_events_source_check
    check (source is null or (source = 'awish' and kind = 'count'));

comment on column public.stock_events.source is
  'Inventeringens källa: null = registrerad i Binderlab, ''awish'' = Awish-synken (Products).';

alter table public.stock_locations
  add column awish_synced_at timestamptz;

comment on column public.stock_locations.awish_synced_at is
  'Senaste gången Awish-synken läste automatens fack (Products). null = aldrig.';

-- Klientroller får inte sätta källan 'awish' (den betyder att synken skrev raden) och
-- inte ändra awish_synced_at. Synken skriver som systemrollen.
create function private.stock_events_client_source() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and new.source is not null then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan skriva en inventering från Awish.';
  end if;
  return new;
end
$$;

create trigger t06_client_source before insert on public.stock_events
  for each row when (new.source is not null)
  execute function private.stock_events_client_source();

create function private.stock_locations_client_awish() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and new.awish_synced_at is distinct from (case when tg_op = 'UPDATE' then old.awish_synced_at end) then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan ändra när automaten senast lästes från Awish.';
  end if;
  return new;
end
$$;

create trigger t06_client_awish before insert or update on public.stock_locations
  for each row execute function private.stock_locations_client_awish();

revoke all on function private.stock_events_client_source() from public;
revoke all on function private.stock_locations_client_awish() from public;
