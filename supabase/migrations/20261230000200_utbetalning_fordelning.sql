-- =============================================================================
-- Utbetalningar från Nayax: vem som ska ha vad av varje utbetalning, och vad som betalats.
--
-- 1. payout_allocations: uträkningen för en utbetalning (src/domain/payout-split.ts), en
--    gällande rad per utbetalning. 'draft' räknas om av sig själv när underlaget ändras
--    (t.ex. ett inköpspris läggs in): en ny version sparas och den gamla får superseded_at.
--    Första betalningen låser den ('locked'). En låst uträkning ändras aldrig: senare
--    skillnader blir en "Justering" på nästa utbetalning. inputs_hash = fingeravtryck av
--    underlaget, så att samma underlag inte ger en ny version.
-- 2. payout_allocation_lines: raderna i en uträkning: butik eller butikens bolag
--    (store_owner), partnern, momsen att spara och ägaren. components = "Varför?"
--    (per butik och månad: försäljning, återbetalningar, andel och varifrån andelen kom).
--    Raderna summerar exakt till utbetalningen. Ändras aldrig.
-- 3. recipient_payments: "Markera som betald" för partnern, momsen och ägaren (uttag).
--    Ångra arkiverar raden. Betalningar till butiker sparas som förut i store_payments.
-- 4. store_payments.payout_allocation_line_id: raden betalningen gjordes från. Allt annat
--    om betalningen är som förut: butikens månadsavräkning dras av och blir betald med
--    betalningarna (src/server/settlements/advances-db.ts), och butiken ser betalningen i
--    portalen (portal_store_payments). Inget räknas två gånger: avräkningen är vad butiken
--    ska ha, utbetalningen betalar den.
--
-- Rättigheter: bara ägare och admin. Läsaren, påfyllaren och butiksportalen ser inget
-- (ingen policy för dem, ingen portal_*-funktion läser tabellerna).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payout_allocations
-- -----------------------------------------------------------------------------
create table public.payout_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  payout_id uuid not null,
  version integer not null check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'locked')),
  rule_version integer not null check (rule_version >= 1),
  inputs_hash text not null check (inputs_hash ~ '^[0-9a-f]{64}$'),
  amount_ore bigint not null,
  totals jsonb not null check (jsonb_typeof(totals) = 'object'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  computed_at timestamptz not null default now(),
  locked_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, payout_id, version),
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict,
  check ((status = 'locked') = (locked_at is not null)),
  check (superseded_at is null or status = 'draft')
);

create unique index payout_allocations_current_key
  on public.payout_allocations (organization_id, payout_id) where superseded_at is null;
create index payout_allocations_org_idx
  on public.payout_allocations (organization_id) where superseded_at is null;

-- En låst uträkning ändras inte. En ny är alltid ett utkast. Ett utkast får bara bli
-- låst eller ersatt (superseded_at), aldrig byta belopp.
create function private.payout_allocations_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Den som inte får skriva i organisationen nekas av RLS (42501) efter triggern.
  if current_user = 'authenticated'
     and not (new.organization_id = any (array(select private.orgs_with_role('owner', 'admin')))) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.superseded_at is not null then
      raise exception using errcode = 'BL090', message = 'En ny uträkning är ett utkast.';
    end if;
    return new;
  end if;
  -- created_by får nollas (användaren raderas); allt annat utom status är låst.
  if (to_jsonb(old) - array['status', 'locked_at', 'superseded_at', 'updated_at', 'created_by'])
     is distinct from (to_jsonb(new) - array['status', 'locked_at', 'superseded_at', 'updated_at',
                                             'created_by']) then
    raise exception using
      errcode = 'BL090',
      message = 'Uträkningen för en utbetalning ändras inte. Skillnader läggs på nästa utbetalning.';
  end if;
  if old.status = 'locked' and (new.status <> 'locked' or new.superseded_at is not null
                                or new.locked_at is distinct from old.locked_at) then
    raise exception using
      errcode = 'BL090',
      message = 'Uträkningen är låst: något är redan betalt från den.';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception using errcode = 'BL090', message = 'Uträkningen är redan ersatt.';
  end if;
  return new;
end
$$;

create trigger t10_guard before insert or update on public.payout_allocations
  for each row execute function private.payout_allocations_guard();
create trigger t00_forbid_org_change before update on public.payout_allocations
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.payout_allocations
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.payout_allocations
  for each row execute function private.stamp_update();

alter table public.payout_allocations enable row level security;
alter table public.payout_allocations alter column organization_id set statistics 0;
revoke all on table public.payout_allocations from anon, authenticated, service_role;
grant select, insert on table public.payout_allocations to authenticated;
grant update (status, locked_at, superseded_at) on table public.payout_allocations to authenticated;
grant select, insert, update on table public.payout_allocations to service_role;

create policy payout_allocations_select on public.payout_allocations
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_allocations_insert on public.payout_allocations
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_allocations_update on public.payout_allocations
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 2. payout_allocation_lines (append-only)
-- -----------------------------------------------------------------------------
create table public.payout_allocation_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  allocation_id uuid not null,
  payout_id uuid not null,
  recipient_kind text not null
    check (recipient_kind in ('store_owner', 'store', 'partner', 'vat_reserve', 'owner')),
  store_owner_id uuid,
  store_id uuid,
  partner_agreement_id uuid,
  amount_ore bigint not null,
  components jsonb not null default '{}'::jsonb check (jsonb_typeof(components) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  foreign key (organization_id, allocation_id)
    references public.payout_allocations (organization_id, id) on delete restrict,
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict,
  foreign key (organization_id, store_owner_id)
    references public.store_owners (organization_id, id) on delete restrict,
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  foreign key (organization_id, partner_agreement_id)
    references public.partner_agreements (organization_id, id) on delete restrict,
  check ((recipient_kind = 'store_owner') = (store_owner_id is not null)),
  check ((recipient_kind = 'store') = (store_id is not null)),
  check (recipient_kind in ('store_owner', 'store', 'owner') or amount_ore >= 0)
);

create index payout_allocation_lines_allocation_idx
  on public.payout_allocation_lines (organization_id, allocation_id);

create trigger t00_forbid_org_change before update on public.payout_allocation_lines
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.payout_allocation_lines
  for each row execute function private.stamp_insert();
create trigger t10_forbid_mutation before update or delete on public.payout_allocation_lines
  for each row execute function private.forbid_mutation();
create trigger t10_forbid_truncate before truncate on public.payout_allocation_lines
  for each statement execute function private.forbid_truncate();

alter table public.payout_allocation_lines enable row level security;
alter table public.payout_allocation_lines alter column organization_id set statistics 0;
revoke all on table public.payout_allocation_lines from anon, authenticated, service_role;
grant select, insert on table public.payout_allocation_lines to authenticated;
grant select, insert, update, delete on table public.payout_allocation_lines to service_role;

create policy payout_allocation_lines_select on public.payout_allocation_lines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_allocation_lines_insert on public.payout_allocation_lines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 3. recipient_payments
-- -----------------------------------------------------------------------------
create table public.recipient_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  payout_id uuid not null,
  line_id uuid not null,
  recipient_kind text not null check (recipient_kind in ('partner', 'vat_reserve', 'owner')),
  paid_on date not null,
  amount_ore bigint not null check (amount_ore between 1 and 10000000000),
  note text check (note is null or char_length(btrim(note)) between 1 and 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict,
  foreign key (organization_id, line_id)
    references public.payout_allocation_lines (organization_id, id) on delete restrict
);

create index recipient_payments_line_idx
  on public.recipient_payments (organization_id, line_id) where archived_at is null;

-- Bara arkivering (Ångra). Betaldagen högst i morgon. Raden ska höra till utbetalningen
-- och ha rätt mottagare.
create function private.recipient_payments_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_line record;
begin
  -- Den som inte får skriva i organisationen nekas av RLS (42501) efter triggern.
  if current_user = 'authenticated'
     and not (new.organization_id = any (array(select private.orgs_with_role('owner', 'admin')))) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - array['archived_at', 'updated_at', 'created_by'])
          is distinct from (to_jsonb(new) - array['archived_at', 'updated_at', 'created_by'])
       or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
      raise exception using
        errcode = 'BL091',
        message = 'En betalning ändras inte. Ångra den och markera som betald igen.';
    end if;
    return new;
  end if;
  if new.paid_on > ((now() at time zone 'Europe/Stockholm')::date + 1) then
    raise exception using errcode = '22023', message = 'Betaldagen kan inte vara i framtiden.';
  end if;
  select l.payout_id, l.recipient_kind into v_line
  from public.payout_allocation_lines l
  where l.organization_id = new.organization_id and l.id = new.line_id;
  if v_line.payout_id is distinct from new.payout_id
     or v_line.recipient_kind is distinct from new.recipient_kind then
    raise exception using errcode = 'BL091', message = 'Betalningen hör inte till raden.';
  end if;
  return new;
end
$$;

create trigger t10_guard before insert or update on public.recipient_payments
  for each row execute function private.recipient_payments_guard();
create trigger t00_forbid_org_change before update on public.recipient_payments
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.recipient_payments
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.recipient_payments
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update on public.recipient_payments
  for each row execute function private.audit();

alter table public.recipient_payments enable row level security;
alter table public.recipient_payments alter column organization_id set statistics 0;
revoke all on table public.recipient_payments from anon, authenticated, service_role;
grant select, insert on table public.recipient_payments to authenticated;
grant update (archived_at) on table public.recipient_payments to authenticated;
grant select, insert, update on table public.recipient_payments to service_role;

create policy recipient_payments_select on public.recipient_payments
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy recipient_payments_insert on public.recipient_payments
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy recipient_payments_update on public.recipient_payments
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 4. store_payments: raden i utbetalningen betalningen gjordes från
-- -----------------------------------------------------------------------------
alter table public.store_payments
  add column payout_allocation_line_id uuid,
  add constraint store_payments_payout_line_fkey
    foreign key (organization_id, payout_allocation_line_id)
    references public.payout_allocation_lines (organization_id, id) on delete restrict;

create index store_payments_payout_line_idx
  on public.store_payments (organization_id, payout_allocation_line_id)
  where payout_allocation_line_id is not null;

-- -----------------------------------------------------------------------------
-- Låset: första betalningen från en rad låser uträkningen. En rad i en ersatt
-- uträkning går inte att betala (sidan visade en gammal uträkning).
-- -----------------------------------------------------------------------------
create function private.payout_lock_on_payment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_line_id uuid;
  v_alloc uuid;
  v_superseded timestamptz;
  v_kind text;
  v_store uuid;
  v_store_owner uuid;
begin
  if tg_table_name = 'store_payments' then
    v_line_id := new.payout_allocation_line_id;
  else
    v_line_id := new.line_id;
  end if;
  if v_line_id is null then
    return new;
  end if;
  select l.allocation_id, a.superseded_at, l.recipient_kind, l.store_id, l.store_owner_id
    into v_alloc, v_superseded, v_kind, v_store, v_store_owner
  from public.payout_allocation_lines l
  join public.payout_allocations a
    on a.organization_id = l.organization_id and a.id = l.allocation_id
  where l.organization_id = new.organization_id and l.id = v_line_id
  for update of a;
  if v_alloc is null then
    raise exception using errcode = 'BL091', message = 'Raden i utbetalningen finns inte.';
  end if;
  if v_superseded is not null then
    raise exception using
      errcode = 'BL091',
      message = 'Uträkningen har ändrats sedan sidan laddades. Ladda om och försök igen.';
  end if;
  if tg_table_name = 'store_payments' then
    if v_kind = 'store' and v_store is distinct from new.store_id then
      raise exception using errcode = 'BL091', message = 'Betalningen hör inte till raden.';
    end if;
    if v_kind = 'store_owner' and not exists (
         select 1 from public.stores s
         where s.organization_id = new.organization_id and s.id = new.store_id
           and s.owner_id = v_store_owner) then
      raise exception using errcode = 'BL091', message = 'Butiken hör inte till bolaget på raden.';
    end if;
    if v_kind not in ('store', 'store_owner') then
      raise exception using errcode = 'BL091', message = 'Betalningen hör inte till raden.';
    end if;
  end if;
  update public.payout_allocations
    set status = 'locked', locked_at = now()
  where organization_id = new.organization_id and id = v_alloc and status = 'draft';
  return new;
end
$$;

revoke all on function private.payout_lock_on_payment() from public, anon, authenticated;

create trigger t30_payout_lock after insert on public.recipient_payments
  for each row execute function private.payout_lock_on_payment();
create trigger t30_payout_lock after insert on public.store_payments
  for each row execute function private.payout_lock_on_payment();
