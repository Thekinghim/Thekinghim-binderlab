-- =============================================================================
-- Partneravtal: hur vinsten från Nayax-utbetalningarna delas med partnern.
--
-- Ägarens regel: partnern köper alla pack och automater. Av pengarna från Nayax får
-- partnern tillbaka inköpet för de sålda packen (vårt inköpspris) och en andel av vinsten.
-- Vinsten = försäljning − inköp − butikernas andel − kort-/Nayax-avgifter − momsen att
-- spara. Företagets egna kostnader dras inte före delningen.
--
-- 1. public.partner_agreements: en rad per avtal med partnerns namn, om inköpet betalas
--    tillbaka, andelen av vinsten (bp, 5 000 = 50 %) och dagen det gäller från. Det avtal
--    gäller en dag som har senaste valid_from ≤ dagen. Ändras ett avtal mitt i en
--    utbetalning delas dagarna (src/domain/payout-split.ts). Arkiveras, raderas aldrig.
-- 2. organization_settings.vat_reserve_mode: momsen att spara (auto, vmb, standard,
--    none; regeln står i src/domain/vat-reserve.ts). payout_reminder_days: påminn om
--    obetalda belopp efter så många dagar (0 = av).
--
-- Rättigheter: bara ägare och admin läser och skriver (partnerns andel är känslig).
-- Läsaren, påfyllaren och butiksportalen ser inget; ingen portal_*-funktion läser
-- tabellen. Ändringar loggas i audit_log.
--
-- Bara tillägg: ingen befintlig kod läser tabellen eller de nya kolumnerna.
-- =============================================================================

create table public.partner_agreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  partner_name text not null check (char_length(btrim(partner_name)) between 1 and 200),
  reimburse_cost boolean not null default true,
  profit_share_bp integer not null default 5000 check (profit_share_bp between 0 and 10000),
  valid_from date not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

comment on table public.partner_agreements is
  'Partneravtal: inköpet tillbaka och andel av vinsten från Nayax-utbetalningarna.';

create unique index partner_agreements_active_from_key
  on public.partner_agreements (organization_id, valid_from)
  where archived_at is null;

create trigger t00_forbid_org_change before update on public.partner_agreements
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.partner_agreements
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.partner_agreements
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.partner_agreements
  for each row execute function private.audit();

alter table public.partner_agreements enable row level security;
alter table public.partner_agreements alter column organization_id set statistics 0;
revoke all on table public.partner_agreements from anon, authenticated, service_role;
grant select, insert, update on table public.partner_agreements to authenticated;
grant select, insert, update on table public.partner_agreements to service_role;

create policy partner_agreements_select on public.partner_agreements
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy partner_agreements_insert on public.partner_agreements
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy partner_agreements_update on public.partner_agreements
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Inställningarna för utbetalningarna
-- -----------------------------------------------------------------------------
alter table public.organization_settings
  add column vat_reserve_mode text not null default 'auto'
    check (vat_reserve_mode in ('auto', 'vmb', 'standard', 'none')),
  add column payout_reminder_days integer not null default 7
    check (payout_reminder_days between 0 and 90);

comment on column public.organization_settings.vat_reserve_mode is
  'Momsen att spara från Nayax-utbetalningarna (src/domain/vat-reserve.ts).';
comment on column public.organization_settings.payout_reminder_days is
  'Påminn om obetalda belopp från utbetalningarna efter så många dagar (0 = av).';

grant update (vat_reserve_mode, payout_reminder_days)
  on table public.organization_settings to authenticated;
