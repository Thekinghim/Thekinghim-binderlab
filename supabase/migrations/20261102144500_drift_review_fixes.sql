-- =============================================================================
-- Drift (fas 8): åtgärder efter granskningen.
--
-- 1. Kvittering: acknowledged_by kan inte längre sättas av användaren. Triggern sätter
--    den alltid till den inloggade, och kvitteringar loggas i audit_log.
-- 2. Push-enheter: endpoint måste vara en känd push-tjänst (FCM, Mozilla, Apple,
--    Windows). Servern gör en POST dit, så en godtycklig adress vore en väg in i det
--    interna nätet (SSRF).
-- 3. Kundärenden: ansvarig måste vara ägare eller admin (butiker och påfyllare kan inte
--    se ärenden). En återbetalning i en stängd månad kan inte flyttas till en annan
--    automat eller titel.
-- 4. Försäljningsdatats täckning per automat (public.sales_data_until): hur långt den
--    importerade försäljningen räcker. Maskinhälsan räknar tystnaden bara fram till
--    dit, så att en fil som inte laddats upp än inte larmar alla automater som trasiga.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Kvittering
-- -----------------------------------------------------------------------------
revoke update (acknowledged_by) on table public.alerts from authenticated;

create or replace function private.alerts_ack_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    -- Systemet (larmjobbet) rör inte kvitteringen.
    return new;
  end if;
  if new.acknowledged_at is distinct from old.acknowledged_at then
    if new.acknowledged_at is null then
      new.acknowledged_by := null;
    else
      new.acknowledged_at := now();
      new.acknowledged_by := v_uid;
    end if;
  else
    new.acknowledged_by := old.acknowledged_by;
  end if;
  return new;
end
$$;
revoke all on function private.alerts_ack_stamp() from public;

-- Kvitteringar loggas (inte larmjobbets uppdateringar, som sker var tionde minut).
create trigger t90_audit_ack after update of acknowledged_at, acknowledged_by on public.alerts
  for each row
  when (old.acknowledged_at is distinct from new.acknowledged_at
        or old.acknowledged_by is distinct from new.acknowledged_by)
  execute function private.audit('evidence');

-- -----------------------------------------------------------------------------
-- 2. Push-endpoint: bara kända push-tjänster
-- -----------------------------------------------------------------------------
create function private.push_endpoint_allowed(p_endpoint text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_endpoint ~ ('^https://('
    || 'fcm\.googleapis\.com'
    || '|([a-z0-9-]+\.)*push\.services\.mozilla\.com'
    || '|([a-z0-9-]+\.)*push\.apple\.com'
    || '|([a-z0-9-]+\.)*notify\.windows\.com'
    || ')(:443)?/[^\s]*$')
$$;
revoke all on function private.push_endpoint_allowed(text) from public;
grant execute on function private.push_endpoint_allowed(text) to authenticated;

-- Enheter med en annan adress (finns inga i drift ännu) tas bort innan spärren läggs på.
delete from public.push_subscriptions where not private.push_endpoint_allowed(endpoint);

alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_known check (private.push_endpoint_allowed(endpoint));

-- -----------------------------------------------------------------------------
-- 3. Kundärenden
-- -----------------------------------------------------------------------------
create or replace function private.incidents_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_machine uuid;
begin
  if new.order_id is not null
     and (tg_op = 'INSERT' or new.order_id is distinct from old.order_id
          or new.machine_id is distinct from old.machine_id) then
    select o.machine_id into v_machine from public.orders o
    where o.organization_id = new.organization_id and o.id = new.order_id;
    if v_machine is not null and v_machine <> new.machine_id then
      raise exception using errcode = '22023',
        message = 'Ordern kommer från en annan automat än ärendet.';
    end if;
  end if;
  -- Ansvarig: ägare eller admin (de enda som ser och hanterar ärenden). Kontrolleras när
  -- den sätts, så att ett ärende vars ansvariga senare bytt roll fortfarande kan uppdateras.
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (
       select 1 from public.memberships m
       where m.organization_id = new.organization_id and m.user_id = new.assignee_id
         and m.role in ('owner', 'admin')
     ) then
    raise exception using errcode = 'BL020',
      message = 'Den ansvariga måste vara ägare eller admin i organisationen.';
  end if;
  return null;
end
$$;
revoke all on function private.incidents_check() from public;

-- Återbetalningen räknas i lönsamheten per dag, automat och titel: i en stängd månad får
-- varken beloppet, dagen, automaten eller titeln ändras.
create or replace function private.incidents_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_days datemultirange := '{}'::datemultirange;
begin
  if tg_op = 'UPDATE' then
    if new.refunded_ore is not distinct from old.refunded_ore
       and new.refunded_on is not distinct from old.refunded_on
       and new.machine_id is not distinct from old.machine_id
       and new.title_id is not distinct from old.title_id then
      return null;
    end if;
    if old.refunded_ore > 0 and old.refunded_on is not null then
      v_days := v_days + datemultirange(daterange(old.refunded_on, old.refunded_on, '[]'));
    end if;
  end if;
  if new.refunded_ore > 0 and new.refunded_on is not null then
    v_days := v_days + datemultirange(daterange(new.refunded_on, new.refunded_on, '[]'));
  end if;
  if not isempty(v_days) then
    perform private.assert_period_open(new.organization_id, v_days, 'Återbetalningen');
  end if;
  return null;
end
$$;
revoke all on function private.incidents_period_guard() from public;

-- -----------------------------------------------------------------------------
-- 4. Försäljningsdatats täckning per automat
-- -----------------------------------------------------------------------------
-- En rad per automat (inte arkiverad): datakällan som automatens senaste order kom från,
-- hur långt källans försäljning räcker (data_until) och när källan senast importerades
-- (synced_at).
--   awish_grpc/awish_web (hämtas automatiskt): data_until = senaste hämtning eller order.
--   awish_csv (laddas upp för hand): data_until = senaste order i källan, i någon automat.
--     Filen innehåller all försäljning fram till exporten, så den senaste ordern är en
--     säker undre gräns. Saknas order i en automat medan andra automater i samma fil
--     säljer, är det automaten som är tyst, inte datat.
-- Automater utan order de senaste 70 dagarna får den senaste täckningen i organisationen.
-- Bara tidpunkter, inga belopp: påfyllaren får läsa den (maskinhälsan visas för henne).
create function private.sales_data_until_rows(p_organization_id uuid, p_at timestamptz)
returns table (
  machine_id uuid,
  data_source_id uuid,
  source_name text,
  manual boolean,
  data_until timestamptz,
  synced_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  with src as (
    select d.id, d.name, d.provider,
           (d.provider = 'awish_csv') as manual,
           greatest(
             d.last_synced_at,
             (select max(i.finished_at) from public.imports i
              where i.organization_id = d.organization_id and i.data_source_id = d.id
                and i.status = 'succeeded' and i.finished_at <= p_at)
           ) as synced_at,
           (select max(o.ordered_at) from public.orders o
            where o.organization_id = d.organization_id and o.data_source_id = d.id
              and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days') as last_order_at
    from public.data_sources d
    where d.organization_id = p_organization_id and d.archived_at is null
  ),
  cov as (
    select src.*,
           case when src.manual then src.last_order_at
                else least(greatest(src.synced_at, src.last_order_at), p_at) end as until_at
    from src
  ),
  latest as (
    select distinct on (o.machine_id) o.machine_id, o.data_source_id
    from public.orders o
    where o.organization_id = p_organization_id and o.machine_id is not null
      and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days'
    order by o.machine_id, o.ordered_at desc
  ),
  fallback as (
    select * from cov where cov.until_at is not null order by cov.until_at desc limit 1
  )
  select m.id,
         coalesce(c.id, f.id),
         coalesce(c.name, f.name),
         coalesce(c.manual, f.manual),
         coalesce(c.until_at, f.until_at),
         coalesce(c.synced_at, f.synced_at)
  from public.machines m
  left join latest l on l.machine_id = m.id
  left join cov c on c.id = l.data_source_id
  left join fallback f on c.id is null
  where m.organization_id = p_organization_id and m.archived_at is null
    and ((select auth.uid()) is null
         or private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller'))
$$;
create index orders_source_ordered_idx on public.orders (organization_id, data_source_id, ordered_at);
create index orders_machine_ordered_idx on public.orders (organization_id, machine_id, ordered_at)
  where machine_id is not null;

revoke all on function private.sales_data_until_rows(uuid, timestamptz) from public;
grant execute on function private.sales_data_until_rows(uuid, timestamptz) to authenticated;

-- Kör med anroparens rättigheter så att current_user är den riktiga rollen: klienter måste
-- ha en roll i organisationen (inte butiken), systemrollen (larmjobbet) får alltid.
create function public.sales_data_until(p_organization_id uuid, p_at timestamptz default null)
returns table (
  machine_id uuid,
  data_source_id uuid,
  source_name text,
  manual boolean,
  data_until timestamptz,
  synced_at timestamptz
)
language plpgsql stable
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Du har inte behörighet till organisationens driftdata.';
  end if;
  return query
    select * from private.sales_data_until_rows(p_organization_id, coalesce(p_at, now()));
end
$$;
revoke all on function public.sales_data_until(uuid, timestamptz) from public, anon;
grant execute on function public.sales_data_until(uuid, timestamptz) to authenticated;
