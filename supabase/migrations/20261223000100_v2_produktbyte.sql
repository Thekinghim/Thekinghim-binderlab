-- =============================================================================
-- V2: produktbyte i ett Awish-fack (docs/design/v2/byggplan.md, avsnitt 3.3).
--
-- När en titel byts i ett fack direkt i Awish (titel A ut, titel B in) räknade saldosynken
-- A till 0 i automaten (svinn) och B in utan att dra något från lagret. Synken registrerar
-- nu bytet: A flyttas tillbaka till automatens "Fylls på från" och B dras därifrån
-- (src/server/awish/product-swap.ts, byggs av G2). Den här tabellen är loggen över byten,
-- som Automater → Historik och Vårt lager → Senaste händelser visar.
--
-- * Append-only (som stock_events): rader ändras eller tas aldrig bort.
-- * Inga belopp. Läses av alla medlemmar (ägare, admin, påfyllare, läsare).
-- * Inga skrivpolicyer för användare: bara synken skriver, i sin transaktion.
-- * Ett byte per automat, fack och tidpunkt (en andra synk skriver inget nytt).
-- =============================================================================

create table public.product_swaps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  channel text not null check (char_length(btrim(channel)) between 1 and 20),
  from_title_id uuid not null,
  to_title_id uuid not null,
  returned_units integer not null check (returned_units between 0 and 10000),
  taken_units integer not null check (taken_units between 0 and 10000),
  -- Lagret A lämnades till och B togs ur ("Fylls på från", standard Hemma). null = inget flyttat.
  source_location_id uuid,
  -- Flytten tillbaka (transfer_out + transfer_in) har samma grupp-id i stock_events.
  transfer_group_id uuid,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, machine_id, channel, occurred_at),
  check (from_title_id <> to_title_id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, from_title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, to_title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, source_location_id)
    references public.stock_locations (organization_id, id) on delete restrict
);

comment on table public.product_swaps is
  'Produktbyten i Awish-fack som saldosynken registrerat: titel ut, titel in, pack tillbaka till lagret och pack tagna ur lagret.';

create index product_swaps_machine_idx
  on public.product_swaps (organization_id, machine_id, occurred_at desc);

create trigger t00_forbid_org_change before update on public.product_swaps
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.product_swaps
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.product_swaps
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.product_swaps
  for each row execute function private.stamp_insert();
create trigger t90_audit_insert after insert on public.product_swaps
  for each row execute function private.audit();

alter table public.product_swaps alter column organization_id set statistics 0;

alter table public.product_swaps enable row level security;
revoke all on table public.product_swaps from anon, authenticated, service_role;
grant select on table public.product_swaps to authenticated;
-- update för service_role som på stock_counts: triggerna (append-only) stoppar ändå varje ändring.
grant select, insert, update on table public.product_swaps to service_role;

create policy product_swaps_select on public.product_swaps
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer')))
  );
