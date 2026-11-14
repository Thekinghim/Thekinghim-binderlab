-- =============================================================================
-- Butiksrapporten: kort som standard, detaljer per butik.
--
-- Butiken får sin andel av vinsten och ska kunna räkna efter den, men behöver inte få
-- försäljningen per titel eller våra servicebesök utan att be om det. Rapporten visar
-- därför som standard bara uträkningen (summor), försäljning per vecka och automaterna.
--
-- * stores.report_details (standard false): "Visa detaljer i rapporten". På: butikens
--   rapport visar också titlarna och service, som förut. Bara ägare och admin ändrar
--   (stores_update, oförändrad). Valet läses när rapporten skapas och sparas i rapportens
--   ögonblicksbild, så en rapport som redan är godkänd eller skickad ändras inte.
-- * portal_report_details: butiksportalen läser valet för sin egen butik.
-- * portal_sales: med valet av lämnas försäljningen ut utan titel (en rad per dag,
--   automat och belopp), så att portalen inte kan visa titlar som rapporten inte visar.
--
-- Bara tillägg: kolumnen har ett standardvärde, den nya funktionen används inte av äldre
-- kod, och portal_sales har samma kolumner som förut (äldre kod visar då en enda titel,
-- "Alla titlar").
-- =============================================================================

alter table public.stores
  add column report_details boolean not null default false;

comment on column public.stores.report_details is
  'Visa detaljer i butiksrapporten (titlar och service). false = butiken får bara uträkningen.';

-- -----------------------------------------------------------------------------
-- Portalen: butikens eget val.
-- -----------------------------------------------------------------------------
create function public.portal_report_details(p_store_id uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return coalesce(
    (select s.report_details from public.stores s
     where s.organization_id = v_org and s.id = p_store_id),
    false
  );
end
$$;

revoke all on function public.portal_report_details(uuid) from public, anon;
grant execute on function public.portal_report_details(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- portal_sales: utan titlar när butiken inte får detaljer (annars som i
-- 20261105070000_testkop.sql).
-- -----------------------------------------------------------------------------
create or replace function public.portal_sales(p_store_id uuid, p_from date, p_to date)
returns table (
  business_date date,
  machine_id uuid,
  title_id uuid,
  title_name text,
  amount_ore bigint,
  order_count bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
  v_details boolean;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'Ange en period på högst tre år.';
  end if;
  select s.report_details into v_details
  from public.stores s
  where s.organization_id = v_org and s.id = p_store_id;
  if coalesce(v_details, false) then
    return query
      select o.business_date, o.machine_id, o.title_id, t.name, o.amount_ore, count(*)
      from public.orders o
      join public.machine_placements mp
        on mp.organization_id = o.organization_id
       and mp.machine_id = o.machine_id
       and mp.store_id = p_store_id
       and o.business_date >= mp.valid_from
       and (mp.valid_to is null or o.business_date <= mp.valid_to)
      join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
      where o.organization_id = v_org
        and o.title_id is not null
        and o.test_purchase_at is null
        and o.business_date between p_from and p_to
      group by o.business_date, o.machine_id, o.title_id, t.name, o.amount_ore
      order by o.business_date, o.machine_id, t.name, o.amount_ore;
  else
    -- Samma order som ovan (bara de med titel räknas), men titeln lämnas inte ut.
    return query
      select o.business_date, o.machine_id, null::uuid, 'Alla titlar'::text, o.amount_ore,
             count(*)
      from public.orders o
      join public.machine_placements mp
        on mp.organization_id = o.organization_id
       and mp.machine_id = o.machine_id
       and mp.store_id = p_store_id
       and o.business_date >= mp.valid_from
       and (mp.valid_to is null or o.business_date <= mp.valid_to)
      where o.organization_id = v_org
        and o.title_id is not null
        and o.test_purchase_at is null
        and o.business_date between p_from and p_to
      group by o.business_date, o.machine_id, o.amount_ore
      order by o.business_date, o.machine_id, o.amount_ore;
  end if;
end
$$;

revoke all on function public.portal_sales(uuid, date, date) from public, anon;
grant execute on function public.portal_sales(uuid, date, date) to authenticated;
