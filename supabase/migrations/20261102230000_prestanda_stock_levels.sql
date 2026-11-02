-- Prestanda (fas 7): lagersaldot (stock_levels) utan att sortera alla lagerhändelser.
--
-- Den tidigare vyn tog fram senaste inventeringen med DISTINCT ON över alla händelser och
-- slog ihop alla händelser med den, vilket med 120 000 händelser (100 000 order) gav en
-- sortering på disk och 160–650 ms per fråga. Saldot läses på varje sida (Att göra i
-- menyn, Lager, Drift, Prognos).
--
-- Samma regel och samma kolumner som förut (20261102100500_stock.sql):
--   saldo = senaste inventeringens antal (ordning occurred_at, seq) + summan av alla
--           händelser som inte är inventeringar och ligger efter den; utan inventering
--           summan av alla sådana händelser.
--   last_counted_at = senaste inventeringens tidpunkt, last_event_at = senaste händelsen.
-- Nu per lagerplats och titel: senaste inventeringen slås upp i ett delindex, och bara
-- händelserna efter den summeras (indexet stock_events_level_idx).
--
-- test/db/prestanda.test.ts jämför vyn med den tidigare definitionen.

-- Senaste inventeringen per lagerplats och titel.
create index stock_events_last_count_idx
  on public.stock_events (organization_id, location_id, title_id, occurred_at desc, seq desc)
  where kind = 'count';

create or replace view public.stock_levels
with (security_invoker = true)
as
select
  s.organization_id,
  s.location_id,
  s.title_id,
  (
    coalesce(lc.quantity, 0)
    + coalesce(
        case
          when lc.seq is null then (
            select sum(a.quantity)
            from public.stock_events a
            where a.organization_id = s.organization_id
              and a.location_id = s.location_id
              and a.title_id = s.title_id
              and a.kind <> 'count'
          )
          else (
            -- Radjämförelsen (occurred_at, seq) blir ett intervall i stock_events_level_idx.
            select sum(a.quantity)
            from public.stock_events a
            where a.organization_id = s.organization_id
              and a.location_id = s.location_id
              and a.title_id = s.title_id
              and (a.occurred_at, a.seq) > (lc.occurred_at, lc.seq)
              and a.kind <> 'count'
          )
        end,
        0
      )
  )::integer as quantity,
  lc.occurred_at as last_counted_at,
  s.last_event_at
from (
  select e.organization_id, e.location_id, e.title_id, max(e.occurred_at) as last_event_at
  from public.stock_events e
  group by e.organization_id, e.location_id, e.title_id
) s
left join lateral (
  select c.quantity, c.occurred_at, c.seq
  from public.stock_events c
  where c.organization_id = s.organization_id
    and c.location_id = s.location_id
    and c.title_id = s.title_id
    and c.kind = 'count'
  order by c.occurred_at desc, c.seq desc
  limit 1
) lc on true;

comment on view public.stock_levels is
  'Saldo per lagerplats och titel: senaste inventering plus händelserna efter den (occurred_at, seq).';

-- Rättigheterna följer med create or replace, men sätts igen för tydlighetens skull.
revoke all on table public.stock_levels from anon, authenticated;
grant select on table public.stock_levels to authenticated;
