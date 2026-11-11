-- =============================================================================
-- Runda 2, granskningen: ett inköp skrivs aldrig två gånger.
--
-- Felet: "Kom fram", "Köpt, har dem här", "+ Inköp" och delägarens leverans lade in packen
-- en gång till om svaret aldrig kom fram och användaren tryckte igen (eller tryckte två
-- gånger). "Beställt" skyddades bara i 60 sekunder.
--
-- purchase_requests: en rad per inskick från ett formulär. Formuläret skapar ett id
-- (client_id) och behåller det tills svaret kommit. Servern (src/server/purchasing/quick.ts)
-- skriver raden i samma transaktion som inköpet, med svaret som användaren fick. Samma id
-- en gång till ger samma svar och ingen ny lagerhändelse eller order.
--
--   kind    'order' = "Beställt" · 'arrival' = packen kom (alla fyra knapparna)
--   result  svaret som det första inskicket fick (visas igen)
--
-- Ägare och admin läser och skriver (samma roller som övriga inköp). Raderna ändras och
-- raderas aldrig (append-only).
--
-- Additivt: en ny tabell.
-- =============================================================================

create table public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Formulärets id för inskicket: samma id två gånger ger samma svar.
  client_id uuid not null,
  kind text not null check (kind in ('order', 'arrival')),
  title_id uuid not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, client_id),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict
);

comment on table public.purchase_requests is
  'Inköp: en rad per inskick ("Beställt", "Kom fram", "+ Inköp"). Samma client_id två gånger ger samma svar. Append-only.';

-- Som övriga tabeller: ingen planerarstatistik på organization_id (test/db/hardening.test.ts).
alter table public.purchase_requests alter column organization_id set statistics 0;

create trigger t00_forbid_org_change before update on public.purchase_requests
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.purchase_requests
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.purchase_requests
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.purchase_requests
  for each row execute function private.stamp_insert();

alter table public.purchase_requests enable row level security;
revoke all on table public.purchase_requests from anon, authenticated, service_role;
grant select, insert on table public.purchase_requests to authenticated;
grant select, insert on table public.purchase_requests to service_role;

create policy purchase_requests_select on public.purchase_requests
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

create policy purchase_requests_insert on public.purchase_requests
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
