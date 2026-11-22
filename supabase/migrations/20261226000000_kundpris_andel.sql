-- =============================================================================
-- Pris mot kund räknas i butikens andel vid vinstdelning.
--
-- Ägarens beslut: för försäljning från och med 2026-11-01 räknas butikens andel
-- vid vinstdelning (commission_base 'profit_after_costs') på pris mot kund
-- (purchase_prices.customer_price_ore) för den prisperiod som gällde orderns dag,
-- och på unit_cost_ore när perioden saknar pris mot kund. Vår vinst räknas som
-- förut på unit_cost_ore. Uträkningen görs i appen (src/domain/profit-split.ts,
-- CUSTOMER_PRICE_SHARE_FROM); ingen databasfunktion räknar andelen.
--
-- Pris mot kund ändrar alltså siffror från datumet, och får därför inte längre
-- ändras för dagar i en stängd månad från och med datumet:
-- purchase_prices_period_guard bevakar nu också customer_price_ore, men bara
-- på prisperiodens dagar från och med private.customer_price_share_from().
-- Före datumet ändrar pris mot kund ingen siffra och får ändras som förut.
--
-- private.customer_price_share_from() har samma datum som CUSTOMER_PRICE_SHARE_FROM
-- i koden (test/db/kundpris-andel.test.ts jämför dem).
--
-- Säkert medan den gamla koden kör: bara triggerfunktionen byts ut.
-- =============================================================================

create function private.customer_price_share_from() returns date
language sql immutable
set search_path = ''
as $$ select date '2026-11-01' $$;

create or replace function private.purchase_prices_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_affected datemultirange := '{}'::datemultirange;
begin
  if tg_op = 'DELETE' and private.purge_allowed() then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.title_id = old.title_id
     and new.valid_from = old.valid_from
     and new.unit_cost_ore = old.unit_cost_ore then
    if new.customer_price_ore is not distinct from old.customer_price_ore then
      return null;
    end if;
    -- Bara pris mot kund ändrades: det räknas i butikens andel från och med datumet.
    perform private.assert_period_open(
      new.organization_id,
      private.price_effective_range(new.organization_id, new.title_id, new.valid_from, new.id)
        * datemultirange(daterange(private.customer_price_share_from(), null, '[)')),
      'Priset mot kund'
    );
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_affected := v_affected
      + private.price_effective_range(old.organization_id, old.title_id, old.valid_from, old.id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_affected := v_affected
      + private.price_effective_range(new.organization_id, new.title_id, new.valid_from, new.id);
  end if;
  perform private.assert_period_open(
    coalesce(new.organization_id, old.organization_id), v_affected, 'Inköpspriset'
  );
  return null;
end
$$;

comment on column public.purchase_prices.customer_price_ore is
  'Pris mot kund per pack i öre (leverantörens prislista). Från 2026-11-01 räknas butikens andel vid vinstdelning på det (vår vinst på unit_cost_ore). Tomt = inget pris mot kund angivet (andelen räknas på unit_cost_ore).';
