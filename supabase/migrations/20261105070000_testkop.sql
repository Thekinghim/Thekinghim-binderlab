-- Testköp: en order kan markeras som testköp (Order → "Markera som testköp") och ångras.
--
-- Ett testköp är ett riktigt köp i automaten (ägaren provar att den fungerar). Ordern
-- finns kvar och syns i Order med etiketten "Testköp", men räknas inte i intäkt, vinst,
-- butikens andel, avräkning, bokföring, rapporter, prognos eller "saknar inköpspris".
-- Lagret rörs inte: packet har lämnat automaten (stock_events av typen sale ligger kvar).
--
--   orders.test_purchase_at   när ordern markerades (null = vanlig order). Sätts alltid av
--                             databasen (now()), aldrig av klienten.
--   set_test_purchase(...)    ägare och admin markerar och ångrar. Ingen klient har
--                             kolumnrättighet på test_purchase_at, så RPC:n är enda vägen.
--
-- Vem och när loggas i audit_log av den befintliga triggern t90_audit på orders
-- (actor_id = auth.uid(), before/after med test_purchase_at).
-- En order i en stängd månad kan inte markeras eller ångras (BL004): öppna månaden först.
--
-- Databasens egna summeringar av order räknar inte testköp: close_period (stängningens
-- sammanfattning) och portal_sales (butiksportalen).

alter table public.orders add column test_purchase_at timestamptz;

comment on column public.orders.test_purchase_at is
  'Markerad som testköp (null = vanlig order). Räknas inte i ekonomin. Bara via set_test_purchase.';

-- Testköp listas i Order (partiellt index, få rader).
create index orders_test_purchase_idx on public.orders (organization_id, business_date)
  where test_purchase_at is not null;

-- -----------------------------------------------------------------------------
-- En importerad order ändras aldrig. Undantag: titeln, automaten (som förut) och
-- testköpsmarkeringen (bara via set_test_purchase, aldrig i en stängd månad).
-- -----------------------------------------------------------------------------
create or replace function private.orders_before_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_changed text[] := private.changed_keys(to_jsonb(old), to_jsonb(new));
begin
  if private.is_actor_anonymization(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  if not (v_changed <@ array['title_id', 'machine_id', 'test_purchase_at', 'updated_at']) then
    raise exception using
      errcode = 'BL007',
      message = 'En importerad order ändras inte.',
      detail = format('Ändrade kolumner: %s', array_to_string(v_changed, ', '));
  end if;
  if old.title_id is not null and new.title_id is null then
    raise exception using errcode = 'BL007', message = 'Orderns titel kan inte tas bort.';
  end if;
  if old.machine_id is not null and new.machine_id is distinct from old.machine_id then
    raise exception using errcode = 'BL007', message = 'Orderns automat kan inte ändras.';
  end if;
  if new.test_purchase_at is distinct from old.test_purchase_at then
    if private.is_closed_day(new.organization_id, new.business_date) then
      raise exception using errcode = 'BL004',
        message = 'Månaden är stängd. Öppna den först för att ändra testköp.';
    end if;
    -- Tidpunkten sätts av databasen; en markerad order markeras inte om.
    if new.test_purchase_at is not null then
      new.test_purchase_at := coalesce(old.test_purchase_at, now());
    end if;
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- set_test_purchase(org, order, test) → test_purchase_at (null efter ångra).
-- Ägare och admin. Samma värde två gånger ändrar inget (och loggar inget).
-- -----------------------------------------------------------------------------
create function public.set_test_purchase(
  p_organization_id uuid,
  p_order_id uuid,
  p_test boolean
)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan markera testköp.';
  end if;
  if p_order_id is null or p_test is null then
    raise exception using errcode = '22023', message = 'Ange order och om den är ett testköp.';
  end if;

  select * into v_order
  from public.orders o
  where o.organization_id = p_organization_id and o.id = p_order_id
  for update;
  if v_order.id is null then
    raise exception using errcode = '22023', message = 'Ordern finns inte.';
  end if;

  if p_test = (v_order.test_purchase_at is not null) then
    return v_order.test_purchase_at;
  end if;

  update public.orders o
  set test_purchase_at = case when p_test then now() end
  where o.organization_id = p_organization_id and o.id = p_order_id
  returning o.test_purchase_at into v_order.test_purchase_at;

  return v_order.test_purchase_at;
end
$$;

revoke all on function public.set_test_purchase(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_test_purchase(uuid, uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- close_period: sammanfattningen räknar inte testköp (annars som förut).
-- -----------------------------------------------------------------------------
create or replace function public.close_period(
  p_organization_id uuid,
  p_month date,
  p_snapshot jsonb default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_current_month date;
  v_summary jsonb;
  v_id uuid;
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan stänga en månad.';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception using errcode = '22023', message = 'Ange månadens första dag.';
  end if;
  if p_snapshot is not null and jsonb_typeof(p_snapshot) <> 'object' then
    raise exception using errcode = '22023', message = 'Ögonblicksbilden ska vara ett objekt.';
  end if;

  select o.timezone into v_tz
  from public.organizations o
  where o.id = p_organization_id
  for update;
  v_current_month := date_trunc('month', (now() at time zone v_tz))::date;
  if p_month >= v_current_month then
    raise exception using errcode = '22023', message = 'Bara passerade månader kan stängas.';
  end if;
  if private.is_closed_day(p_organization_id, p_month) then
    raise exception using errcode = 'BL015', message = 'Månaden är redan stängd.';
  end if;

  select jsonb_build_object(
    'month', p_month,
    'order_count', count(*),
    'revenue_ore', coalesce(sum(o.amount_ore), 0),
    'orders_without_title', count(*) filter (where o.title_id is null),
    'orders_without_price', count(*) filter (where c.unit_cost_ore is null),
    'revenue_without_price_ore', coalesce(sum(o.amount_ore) filter (where c.unit_cost_ore is null), 0),
    'cost_of_goods_ore', coalesce(sum(c.unit_cost_ore), 0)
  )
  into v_summary
  from public.orders o
  left join lateral (
    select pp.unit_cost_ore
    from public.purchase_prices pp
    where pp.organization_id = o.organization_id
      and pp.title_id = o.title_id
      and pp.valid_from <= o.business_date
    order by pp.valid_from desc
    limit 1
  ) c on true
  where o.organization_id = p_organization_id
    and o.business_date >= p_month
    and o.business_date < (p_month + interval '1 month')::date
    and o.test_purchase_at is null;

  insert into public.period_closes (organization_id, month, closed_at, closed_by, snapshot)
  values (
    p_organization_id,
    p_month,
    now(),
    auth.uid(),
    jsonb_build_object('database', v_summary)
      || case when p_snapshot is null then '{}'::jsonb else jsonb_build_object('app', p_snapshot) end
  )
  returning id into v_id;

  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- portal_sales: butiken ser inte testköp (annars som i 20261102135500).
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
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'Ange en period på högst tre år.';
  end if;
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
end
$$;

-- Rättigheterna följer med create or replace; sätts om för tydlighets skull.
revoke all on function public.close_period(uuid, date, jsonb) from public, anon;
grant execute on function public.close_period(uuid, date, jsonb) to authenticated;
revoke all on function public.portal_sales(uuid, date, date) from public, anon;
grant execute on function public.portal_sales(uuid, date, date) to authenticated;
