-- =============================================================================
-- Butiksportalen visar butiksrapporter med vinstdelning.
--
-- private.portal_snapshot_safe stoppade varje nyckel som liknar inköp eller vinst, var den
-- än stod. En rapport med vinstdelning har alltid butikens summor för inköp och vinst i
-- ersättningsdelen (report.compensation.splits: purchasesOre, profitOre): det är så butiken
-- räknar efter sin andel, och samma siffror står i PDF:en som butiken redan får. Portalen
-- visade därför "Rapportens innehåll kan inte visas i portalen" för varje sådan rapport,
-- medan kontrollen i appen (assertStoreReportSafe i src/reports/store-report.ts) godkände
-- den.
--
-- Nu samma regel som i appen:
-- * Allt utom ersättningsdelen: samma nyckelregel som förut.
-- * Ersättningsdelen (report.compensation): när den har vinstdelning (splits med minst en
--   rad) får nycklar för inköp och vinst stå där. Inget annat släpps: listor över andra
--   butiker, priser, avtal, placeringar, inställningar och investeringar stoppas fortfarande
--   överallt, "orders" måste vara ett tal och varje storeId måste vara butikens egen.
--   Utan vinstdelning gäller samma regel som förut även i ersättningsdelen.
--
-- Bara funktionen ändras (samma namn, argument och svar). Äldre kod fungerar som förut: den
-- kontrollerar rapporten med assertStoreReportSafe, som redan godkänner samma rapporter.
-- =============================================================================

-- Har objektet (eller något nästlat objekt) en otillåten nyckel? p_open: nycklar för inköp
-- och vinst är tillåtna (ersättningsdelen vid vinstdelning).
create function private.portal_bad_keys(p_value jsonb, p_store_id uuid, p_open boolean)
returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_path_query(p_value, 'strict $.** ? (@.type() == "object")') as v(value)
    cross join lateral jsonb_each(v.value) as kv(key, value)
    where jsonb_typeof(v.value) = 'object'
      and (
        (not coalesce(p_open, false)
          and kv.key ~* '(cost|margin|profit|unpriced|inkop|inköp|vinst|marginal|purchase|owner)')
        or kv.key in ('stores', 'prices', 'agreements', 'placements', 'settings', 'investments')
        or (kv.key = 'orders' and jsonb_typeof(kv.value) <> 'number')
        or (kv.key = 'storeId' and kv.value <> to_jsonb(p_store_id::text))
      )
  )
$$;

create or replace function private.portal_snapshot_safe(p_report jsonb, p_store_id uuid) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_report is not null
    and jsonb_typeof(p_report) = 'object'
    and p_report ->> 'kind' = 'store'
    and p_report -> 'store' ->> 'id' = p_store_id::text
    and not private.portal_bad_keys(p_report - 'compensation', p_store_id, false)
    and (
      p_report -> 'compensation' is null
      or not private.portal_bad_keys(
        p_report -> 'compensation',
        p_store_id,
        -- coalesce: utan "splits" (null) gäller regeln, aldrig "okänt".
        coalesce(
          jsonb_typeof(p_report -> 'compensation' -> 'splits') = 'array'
            and jsonb_array_length(p_report -> 'compensation' -> 'splits') > 0,
          false
        )
      )
    )
$$;

revoke all on function private.portal_bad_keys(jsonb, uuid, boolean) from public, anon;
