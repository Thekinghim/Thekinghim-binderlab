-- =============================================================================
-- Tillväxt E: månadsavräkning per butik och butiksportalens avräkningar och avtal.
--
-- store_settlements  En avräkning per butik och kalendermånad: beloppet att betala ut
--                    (butikens ersättning enligt avtalet, samma uträkning som
--                    månadsrapporten och bokföringen), uträkningen i klartext
--                    (statement) och när den markerades som betald.
--
-- Flödet:
--   1. Den 1:a varje månad (Vercel cron /api/cron/rapporter) skapas förra månadens
--      avräkningar som systemet. Ägare och admin skapar saknade avräkningar och räknar om
--      obetalda som sig själva (RLS nedan) när de öppnar Butiker → Butiksportal.
--   2. Ägare eller admin markerar avräkningen som betald med ett datum, och kan ångra.
--      Vem och när sätts av triggern, aldrig av klienten.
--   3. Butiksanvändaren läser sina avräkningar och sitt avtal med portal_*-funktionerna
--      (security definer, bara den egna butiken, samma kontroll som övriga portalen).
--
-- Bokföringen läser inte tabellen: butikens andel bokförs som tidigare ur försäljningen
-- (ingen dubbelräkning). Avräkningen är bara utbetalningens status.
--
-- En betald avräkning ändras inte (belopp och uträkning låses). Inget raderas.
-- =============================================================================

create table public.store_settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  store_id uuid not null,
  -- Månadens första dag.
  month date not null check (extract(day from month) = 1),
  -- Att betala ut till butiken, öre. Negativt = förlust som butiken delar (ingen utbetalning).
  amount_ore bigint not null check (amount_ore between -10000000000 and 10000000000),
  -- Uträkningen som visas och skrivs ut (avtalet, stegen, försäljningen). Inga inköpspriser
  -- per titel; vinstdelningens månadssummor står i stegen som i avtalet.
  statement jsonb not null
    check (jsonb_typeof(statement) = 'object' and octet_length(statement::text) <= 100000),
  calc_version text not null check (char_length(calc_version) between 1 and 40),
  computed_at timestamptz not null default now(),
  paid_on date,
  paid_by uuid references auth.users (id) on delete set null,
  paid_marked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, store_id, month),
  check (paid_on is null or paid_on >= month),
  check ((paid_on is null) = (paid_marked_at is null)),
  foreign key (organization_id, store_id)
    references public.stores (organization_id, id) on delete restrict
);

create index store_settlements_unpaid_idx
  on public.store_settlements (organization_id, month desc)
  where paid_on is null;

alter table public.store_settlements alter column organization_id set statistics 0;

-- Betald: belopp och uträkning låses. Vem och när sätts här. Datum högst i morgon.
create function private.store_settlements_guard() returns trigger
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
    return new;
  end if;
  if (new.store_id, new.month) is distinct from (old.store_id, old.month) then
    raise exception using errcode = 'BL080', message = 'Avräkningens butik och månad ändras inte.';
  end if;
  if old.paid_on is not null and new.paid_on is not null
     and (new.amount_ore, new.statement, new.calc_version, new.computed_at)
         is distinct from (old.amount_ore, old.statement, old.calc_version, old.computed_at) then
    raise exception using errcode = 'BL081', message = 'Avräkningen är betald och räknas inte om.';
  end if;
  if new.paid_on is distinct from old.paid_on then
    if new.paid_on is not null and old.paid_on is null
       and (new.amount_ore, new.statement) is distinct from (old.amount_ore, old.statement) then
      raise exception using errcode = 'BL081', message = 'Markera som betald utan att ändra beloppet.';
    end if;
    if new.paid_on is not null
       and new.paid_on > ((now() at time zone 'Europe/Stockholm')::date + 1) then
      raise exception using errcode = '22023', message = 'Betaldatumet kan inte vara i framtiden.';
    end if;
    if new.paid_on is null then
      new.paid_by := null;
      new.paid_marked_at := null;
    else
      new.paid_by := auth.uid();
      new.paid_marked_at := now();
    end if;
  else
    new.paid_by := old.paid_by;
    new.paid_marked_at := old.paid_marked_at;
  end if;
  return new;
end
$$;

create trigger t10_guard before insert or update on public.store_settlements
  for each row execute function private.store_settlements_guard();
create trigger t00_forbid_org_change before update on public.store_settlements
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.store_settlements
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.store_settlements
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.store_settlements
  for each row execute function private.audit('statement');
create trigger t99_forbid_delete before delete on public.store_settlements
  for each row execute function private.forbid_delete();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS: ägare och admin skriver, läsaren läser. Påfyllaren och
-- butiksrollen läser inte tabellen (butiken via portal_settlements).
-- -----------------------------------------------------------------------------
alter table public.store_settlements enable row level security;
revoke all on table public.store_settlements from anon, authenticated, service_role;
grant select, insert on table public.store_settlements to authenticated;
grant update (amount_ore, statement, calc_version, computed_at, paid_on)
  on table public.store_settlements to authenticated;
grant select, insert, update on table public.store_settlements to service_role;

create policy store_settlements_select on public.store_settlements
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy store_settlements_insert on public.store_settlements
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy store_settlements_update on public.store_settlements
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Butiksportalen: avräkningarna och avtalet för den egna butiken
-- -----------------------------------------------------------------------------

-- Butikens avräkningar, senaste först.
create function public.portal_settlements(p_store_id uuid)
returns table (
  settlement_id uuid,
  month date,
  amount_ore bigint,
  paid_on date,
  computed_at timestamptz,
  statement jsonb
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select x.id, x.month, x.amount_ore, x.paid_on, x.computed_at, x.statement
    from public.store_settlements x
    where x.organization_id = v_org
      and x.store_id = p_store_id
    order by x.month desc
    limit 60;
end
$$;

-- Butikens avtal (inte arkiverade), senaste först, med signaturen om den finns.
create function public.portal_contracts(p_store_id uuid)
returns table (
  contract_id uuid,
  title text,
  valid_from date,
  valid_to date,
  terminated_on date,
  signed_at timestamptz,
  signer_name text,
  has_file boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select c.id, c.title, c.valid_from, c.valid_to, c.terminated_on,
           coalesce(sig.signed_at, c.signed_at), sig.signer_name,
           (sig.signed_file_path is not null or c.storage_path is not null)
    from public.contracts c
    left join lateral (
      select s.signed_at, s.signer_name, s.signed_file_path
      from public.contract_signatures s
      where s.organization_id = c.organization_id and s.contract_id = c.id
      order by s.signed_at desc
      limit 1
    ) sig on true
    where c.organization_id = v_org
      and c.store_id = p_store_id
      and c.archived_at is null
    order by c.valid_from desc, c.created_at desc
    limit 10;
end
$$;

-- Filen till ett av butikens avtal: den signerade PDF:en om den finns, annars avtalsfilen.
-- Samma fel (P0002) för ett avtal hos någon annan som för ett som inte finns.
create function public.portal_contract_file(p_store_id uuid, p_contract_id uuid)
returns table (storage_path text, content_type text, signed boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select coalesce(sig.signed_file_path, c.storage_path),
           case when sig.signed_file_path is not null then 'application/pdf'
                else coalesce(c.file_content_type, 'application/pdf') end,
           sig.signed_file_path is not null
    from public.contracts c
    left join lateral (
      select s.signed_file_path
      from public.contract_signatures s
      where s.organization_id = c.organization_id and s.contract_id = c.id
        and s.signed_file_path is not null
      order by s.signed_at desc
      limit 1
    ) sig on true
    where c.organization_id = v_org
      and c.store_id = p_store_id
      and c.id = p_contract_id
      and c.archived_at is null
      and coalesce(sig.signed_file_path, c.storage_path) is not null;
  if not found then
    raise exception using errcode = 'P0002', message = 'Avtalet finns inte.';
  end if;
end
$$;

revoke all on function public.portal_settlements(uuid) from public, anon;
revoke all on function public.portal_contracts(uuid) from public, anon;
revoke all on function public.portal_contract_file(uuid, uuid) from public, anon;
grant execute on function public.portal_settlements(uuid) to authenticated;
grant execute on function public.portal_contracts(uuid) to authenticated;
grant execute on function public.portal_contract_file(uuid, uuid) to authenticated;
