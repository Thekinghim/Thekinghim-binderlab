-- =============================================================================
-- Betalning till en butik för en egen period (t.ex. 14 okt.–14 nov.)
--
-- Ägaren betalar ofta butiken från mitten av en månad till mitten av nästa. Avräkningen
-- (store_settlements) finns bara per kalendermånad och skapas först när månaden är slut.
-- En betalning för en period sparas här, uppdelad per kalendermånad (parts). Det som
-- betalats för en månad dras av på månadens avräkning när den finns eller skapas.
--
--   store_payments   En betalning: dag, belopp (öre), perioden den gäller, en anteckning
--                    och delarna per månad:
--                    [{"month": "2026-10", "start": "2026-10-14", "end": "2026-10-31",
--                      "amountOre": 838808}, {"month": "2026-11", ...}]
--                    Delarna räknas av servern när betalningen registreras (regeln står i
--                    src/server/settlements/advance.ts och docs/berakningar.md) och ändras
--                    aldrig. Summan är alltid beloppet. En felaktig betalning tas bort och
--                    registreras igen (ändras inte).
--
--   store_settlements.paid_from_payments
--                    Avräkningen räknas som betald för att betalningarna täcker den (inte
--                    för att någon tryckte "Markera som betald"). Tas betalningen bort blir
--                    avräkningen obetald igen. Nollas när avräkningen blir obetald.
--
-- Rättigheter som store_settlements: ägare och admin registrerar och tar bort, läsaren
-- läser. Påfyllaren och butiksrollen läser inte tabellen; butiken ser bara delarna för sin
-- egen butik (portal_store_payments, utan anteckningen), som avräkningens betaldatum.
--
-- Bara tillägg. Den gamla koden läser inte tabellen och rör inte den nya kolumnen (den har
-- ett standardvärde); vakten på store_settlements byts mot en som också låser kolumnen.
-- =============================================================================

create table public.store_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  store_id uuid not null,
  paid_on date not null,
  amount_ore bigint not null check (amount_ore between 1 and 10000000000),
  period_start date not null,
  period_end date not null,
  note text check (note is null or char_length(btrim(note)) between 1 and 500),
  parts jsonb not null
    check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) between 1 and 14),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (period_end >= period_start and period_end - period_start <= 400),
  foreign key (organization_id, store_id)
    references public.stores (organization_id, id) on delete restrict
);

create index store_payments_store_idx
  on public.store_payments (organization_id, store_id, period_start);

alter table public.store_payments alter column organization_id set statistics 0;

-- Delarna: en per kalendermånad i ordning, utan glapp, inom perioden, summan = beloppet.
-- Betaldagen högst i morgon. En betalning ändras inte (bara aktörskolumnen nollas när
-- användaren raderas).
create function private.store_payments_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_part jsonb;
  v_prev_end date;
  v_start date;
  v_end date;
  v_month text;
  v_amount bigint;
  v_sum bigint := 0;
  v_n integer := 0;
begin
  if tg_op = 'UPDATE' then
    if private.is_actor_anonymization(to_jsonb(old), to_jsonb(new)) then
      return new;
    end if;
    raise exception using
      errcode = 'BL082',
      message = 'En betalning ändras inte. Ta bort den och registrera den igen.';
  end if;
  if new.paid_on > ((now() at time zone 'Europe/Stockholm')::date + 1) then
    raise exception using errcode = '22023', message = 'Betaldagen kan inte vara i framtiden.';
  end if;
  for v_part in select e from jsonb_array_elements(new.parts) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_part) <> 'object'
       or jsonb_typeof(v_part -> 'amountOre') <> 'number'
       or jsonb_typeof(v_part -> 'start') <> 'string'
       or jsonb_typeof(v_part -> 'end') <> 'string'
       or jsonb_typeof(v_part -> 'month') <> 'string'
       or (v_part ->> 'month') !~ '^\d{4}-(0[1-9]|1[0-2])$'
       or (v_part ->> 'start') !~ '^\d{4}-\d{2}-\d{2}$'
       or (v_part ->> 'end') !~ '^\d{4}-\d{2}-\d{2}$'
       or (v_part ->> 'amountOre') !~ '^\d+$' then
      raise exception using errcode = 'BL082', message = 'Betalningens delar har fel form.';
    end if;
    v_start := (v_part ->> 'start')::date;
    v_end := (v_part ->> 'end')::date;
    v_month := v_part ->> 'month';
    v_amount := (v_part ->> 'amountOre')::bigint;
    if to_char(v_start, 'YYYY-MM') <> v_month or to_char(v_end, 'YYYY-MM') <> v_month
       or v_end < v_start
       or (v_prev_end is null and v_start <> new.period_start)
       or (v_prev_end is not null and v_start <> v_prev_end + 1) then
      raise exception using
        errcode = 'BL082',
        message = 'Betalningens delar ska följa perioden, en kalendermånad i taget.';
    end if;
    v_prev_end := v_end;
    v_sum := v_sum + v_amount;
  end loop;
  if v_n = 0 or v_prev_end <> new.period_end then
    raise exception using
      errcode = 'BL082',
      message = 'Betalningens delar ska följa perioden, en kalendermånad i taget.';
  end if;
  if v_sum <> new.amount_ore then
    raise exception using errcode = 'BL082', message = 'Delarna ska tillsammans bli beloppet.';
  end if;
  return new;
end
$$;

create trigger t10_guard before insert or update on public.store_payments
  for each row execute function private.store_payments_guard();
create trigger t00_forbid_org_change before update on public.store_payments
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.store_payments
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.store_payments
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.store_payments
  for each row execute function private.audit();

alter table public.store_payments enable row level security;
revoke all on table public.store_payments from anon, authenticated, service_role;
grant select, insert, delete on table public.store_payments to authenticated;
-- service_role får uppdatera som på andra tabeller; vakten stoppar ändå allt utom att
-- aktörskolumnen nollas (BL082), och forbid_org_change stoppar flytt (BL001).
grant select, insert, update, delete on table public.store_payments to service_role;

create policy store_payments_select on public.store_payments
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy store_payments_insert on public.store_payments
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy store_payments_delete on public.store_payments
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Avräkningen: betald för att betalningarna täcker den
-- -----------------------------------------------------------------------------
alter table public.store_settlements
  add column paid_from_payments boolean not null default false,
  add constraint store_settlements_paid_from_payments_when_paid
    check (not paid_from_payments or paid_on is not null);

grant update (paid_from_payments) on table public.store_settlements to authenticated;

-- Samma vakt som 20261220100200, och paid_from_payments: sätts bara när butikens betalningar
-- för månaden täcker beloppet, låst på en betald avräkning och nollas när den blir obetald.
create or replace function private.store_settlements_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.paid_on is not null then
      raise exception using errcode = 'BL080', message = 'En ny avräkning kan inte vara betald.';
    end if;
    new.paid_by := null;
    new.paid_marked_at := null;
    new.paid_from_payments := false;
    return new;
  end if;
  if (new.store_id, new.month) is distinct from (old.store_id, old.month) then
    raise exception using errcode = 'BL080', message = 'Avräkningens butik och månad ändras inte.';
  end if;
  if old.paid_on is not null and new.paid_on is not null
     and (new.amount_ore, new.statement, new.calc_version, new.computed_at,
          new.corrections, new.paid_amount_ore, new.paid_from_payments)
         is distinct from (old.amount_ore, old.statement, old.calc_version, old.computed_at,
                           old.corrections, old.paid_amount_ore, old.paid_from_payments) then
    raise exception using errcode = 'BL081', message = 'Avräkningen är betald och räknas inte om.';
  end if;
  if new.paid_on is distinct from old.paid_on then
    if new.paid_on is not null and old.paid_on is null
       and (new.amount_ore, new.statement, new.corrections)
           is distinct from (old.amount_ore, old.statement, old.corrections) then
      raise exception using errcode = 'BL081', message = 'Markera som betald utan att ändra beloppet.';
    end if;
    if new.paid_on is not null
       and new.paid_on > ((now() at time zone 'Europe/Stockholm')::date + 1) then
      raise exception using errcode = '22023', message = 'Betaldatumet kan inte vara i framtiden.';
    end if;
    -- Betald med betalningarna bara när butikens betalningar för månaden täcker beloppet.
    if new.paid_on is not null and new.paid_from_payments
       and coalesce((
         select sum((part ->> 'amountOre')::bigint)
         from public.store_payments p
         cross join lateral jsonb_array_elements(p.parts) part
         where p.organization_id = new.organization_id
           and p.store_id = new.store_id
           and part ->> 'month' = to_char(new.month, 'YYYY-MM')
       ), 0) < greatest(new.amount_ore, 1) then
      raise exception using
        errcode = 'BL081',
        message = 'Avräkningen kan bara vara betald med betalningar som täcker den.';
    end if;
    if new.paid_on is null then
      -- En skillnad som redan ligger som rättelse på en senare avräkning skulle betalas två
      -- gånger om den här blev obetald och räknades om.
      if old.corrected_ore <> 0 then
        raise exception using
          errcode = 'BL081',
          message = 'Skillnaden ligger som rättelse på en senare avräkning. Ta bort rättelsen först.';
      end if;
      new.paid_by := null;
      new.paid_marked_at := null;
      new.paid_amount_ore := null;
      new.live_amount_ore := null;
      new.live_checked_at := null;
      new.paid_from_payments := false;
    else
      new.paid_by := auth.uid();
      new.paid_marked_at := now();
    end if;
  else
    new.paid_by := old.paid_by;
    new.paid_marked_at := old.paid_marked_at;
    if new.paid_on is null and new.paid_amount_ore is not null then
      raise exception using errcode = 'BL081', message = 'Betalt belopp sätts när avräkningen markeras som betald.';
    end if;
    if new.paid_on is null and new.paid_from_payments then
      raise exception using errcode = 'BL081', message = 'En obetald avräkning är inte betald med betalningar.';
    end if;
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- Butiksportalen: delarna av betalningarna till den egna butiken (utan anteckningen)
-- -----------------------------------------------------------------------------
create function public.portal_store_payments(p_store_id uuid)
returns table (
  payment_id uuid,
  paid_on date,
  month date,
  part_start date,
  part_end date,
  amount_ore bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select p.id, p.paid_on, (part ->> 'start')::date - (extract(day from (part ->> 'start')::date)::int - 1),
           (part ->> 'start')::date, (part ->> 'end')::date, (part ->> 'amountOre')::bigint
    from public.store_payments p
    cross join lateral jsonb_array_elements(p.parts) part
    where p.organization_id = v_org
      and p.store_id = p_store_id
      and (part ->> 'amountOre')::bigint > 0
    order by (part ->> 'start')::date desc
    limit 200;
end
$$;

revoke all on function public.portal_store_payments(uuid) from public, anon;
grant execute on function public.portal_store_payments(uuid) to authenticated;
