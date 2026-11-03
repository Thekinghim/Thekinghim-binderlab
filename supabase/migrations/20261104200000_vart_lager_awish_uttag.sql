-- =============================================================================
-- Vårt lager: automatiskt uttag ur centrallagret när Awish visar en påfyllning.
--
-- Awish-synken (src/server/awish/stock.ts) skriver en inventering ('count', source
-- 'awish') på automatens plats. När en automat som redan har lästs visar FLER pack av en
-- titel än saldot (och titeln har ett räknat saldo där) är ökningen en påfyllning från
-- vårt lager. Synken drar då samma antal ur centrallagret i samma transaktion, som en
-- 'adjustment' med negativt antal, source 'awish' och noteringen
-- "Awish-påfyllning <kod> <butik eller automat>" (samma form som register_refill, men
-- med en egen notering så att det syns att det var Awish).
--
-- Här vidgas bara kontrollen av stock_events.source: 'awish' får nu stå på en
-- inventering eller på ett uttag (adjustment < 0). Klientroller kan fortfarande inte
-- skriva source (triggern t06_client_source). Tabellen är fortfarande append-only.
-- =============================================================================

alter table public.stock_events
  drop constraint stock_events_source_check,
  add constraint stock_events_source_check
    check (
      source is null
      or (source = 'awish' and (kind = 'count' or (kind = 'adjustment' and quantity < 0)))
    );

comment on column public.stock_events.source is
  'Källa: null = registrerad i Binderlab, ''awish'' = Awish-synken (inventering i automaten '
  'eller uttag ur centrallagret vid en påfyllning som Awish visar).';
