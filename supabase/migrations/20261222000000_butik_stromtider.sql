-- =============================================================================
-- Butikens strömtider: när strömmen till automaten går på och av varje dag.
--
-- Vissa butiker stänger av strömmen till automaten på natten. Awish ser då automaten som
-- offline varje natt, och offlinelarmet larmade för något som inte är ett fel. Ägaren eller
-- admin anger tiderna per butik (Butiker → butiken → Kontakt och rapport → "Strömmen till
-- automaten"):
--
-- * stores.power_on_time:  'TT:MM', när strömmen går på (t.ex. '10:00')
-- * stores.power_off_time: 'TT:MM', när strömmen går av (t.ex. '21:00'; får vara efter
--   midnatt, '01:00')
--
-- Lokal tid i organisationens tidszon (Europe/Stockholm). Båda eller ingen; null (standard)
-- = strömmen är alltid på, som förut. Samma format som larmens tysta timmar
-- (alert_subscriptions.quiet_start/quiet_end).
--
-- Regeln (src/analytics/health/power.ts): en automat som är offline bara medan strömmen är av
-- (plus 30 minuter efter att den gått på) larmar inte och visas som "Strömmen av". Är den
-- inte tillbaka efter det larmar den som vanligt. Fyll på påminner om att starta om
-- automaten efter en påfyllning som skickats till Awish (skärmen läser antalen när den
-- startar).
--
-- Bara tillägg: kolumnerna är valfria, så äldre kod (som inte känner till dem) fungerar som
-- förut. RLS som butikens övriga fält: alla roller som läser butiken (ägare, admin, läsare,
-- påfyllare) läser tiderna, bara ägare och admin ändrar (stores_update, oförändrad). Andra
-- organisationer ser dem aldrig (stores RLS per organisation). Ändringen loggas i audit_log
-- av triggern på stores, som butikens övriga fält.
-- =============================================================================

alter table public.stores
  add column power_on_time text
    check (power_on_time is null or power_on_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column power_off_time text
    check (power_off_time is null or power_off_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

alter table public.stores
  add constraint stores_power_hours_check
    check (
      (power_on_time is null) = (power_off_time is null)
      and (power_on_time is null or power_on_time <> power_off_time)
    );

comment on column public.stores.power_on_time is
  'När strömmen till automaten går på varje dag (TT:MM, organisationens tidszon). null = alltid på.';
comment on column public.stores.power_off_time is
  'När strömmen till automaten går av varje dag (TT:MM, organisationens tidszon). null = alltid på.';
