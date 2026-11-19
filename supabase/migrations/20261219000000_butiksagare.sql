-- =============================================================================
-- Butiksägare: bolaget som äger en eller flera butiker.
--
-- Ägarens önskemål: flera butiker med samma ägare ska kunna ses tillsammans i
-- statistiken och få sina rapporter i ett svep, och bolagens uppgifter ska
-- finnas i appen.
--
-- 1. public.store_owners: en rad per bolag. Juridiskt namn och
--    organisationsnummer (NNNNNN-NNNN, appen kontrollerar kontrollsiffran) krävs.
--    Allt annat är valfritt: momsregistreringsnummer (SE + 10 siffror + 01),
--    F-skatt, adress, kontaktperson, e-post, telefon, fakturaadress (e-post),
--    bankgiro och en anteckning. Arkiveras i stället för att raderas.
-- 2. public.stores.owner_id: butikens ägare (null = ingen). En butik har högst
--    en ägare; samma organisation (sammansatt FK).
--
-- Rättigheter som för butiker: ägare och admin skriver, läsare läser. Påfyllare
-- och butiksportalens användare ser inga ägare (ingen policy för dem, ingen
-- portal_*-funktion läser tabellen). Ändringar loggas i audit_log.
--
-- Bara tillägg: den gamla koden läser inte de nya kolumnerna och påverkas inte.
-- =============================================================================

create table public.store_owners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  legal_name text not null check (char_length(btrim(legal_name)) between 1 and 200),
  org_number text not null check (org_number ~ '^\d{6}-\d{4}$'),
  vat_number text check (vat_number is null or vat_number ~ '^SE\d{10}01$'),
  f_tax boolean not null default false,
  street_address text
    check (street_address is null or char_length(street_address) between 1 and 200),
  postal_code text check (postal_code is null or postal_code ~ '^\d{3} \d{2}$'),
  city text check (city is null or char_length(city) between 1 and 100),
  contact_name text check (contact_name is null or char_length(contact_name) between 1 and 200),
  email extensions.citext
    check (email is null or (char_length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+$')),
  phone text check (phone is null or char_length(phone) between 1 and 50),
  invoice_email extensions.citext
    check (invoice_email is null
           or (char_length(invoice_email) between 3 and 254 and invoice_email ~ '^[^@\s]+@[^@\s]+$')),
  bankgiro text check (bankgiro is null or bankgiro ~ '^\d{3,4}-\d{4}$'),
  note text check (note is null or char_length(note) between 1 and 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

comment on table public.store_owners is
  'Butiksägare: bolaget som äger en eller flera butiker (stores.owner_id).';
comment on column public.store_owners.org_number is
  'Organisationsnummer NNNNNN-NNNN (appen kontrollerar kontrollsiffran).';
comment on column public.store_owners.vat_number is
  'Momsregistreringsnummer SE + 10 siffror + 01, eller null.';
comment on column public.store_owners.invoice_email is
  'E-postadress för leverantörsfakturor, eller null.';

-- Samma bolag två gånger bland de aktiva ägarna är ett misstag.
create unique index store_owners_org_number_key
  on public.store_owners (organization_id, org_number) where archived_at is null;

create trigger t00_forbid_org_change before update on public.store_owners
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.store_owners
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.store_owners
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update on public.store_owners
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.store_owners
  for each row execute function private.forbid_delete();

alter table public.store_owners enable row level security;
revoke all on table public.store_owners from anon, authenticated, service_role;
grant select, insert, update on table public.store_owners to authenticated;
-- Servicerollen som för övriga tabeller; appen skriver aldrig med den här.
grant select, insert, update on table public.store_owners to service_role;

-- Ingen planerarstatistik på organization_id (den avslöjar hur många organisationer som finns).
alter table public.store_owners alter column organization_id set statistics 0;

create policy store_owners_select on public.store_owners
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy store_owners_insert on public.store_owners
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy store_owners_update on public.store_owners
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Butikens ägare
-- -----------------------------------------------------------------------------

alter table public.stores add column owner_id uuid;
alter table public.stores
  add constraint stores_owner_fk foreign key (organization_id, owner_id)
    references public.store_owners (organization_id, id) on delete restrict;

comment on column public.stores.owner_id is
  'Butikens ägare (store_owners), eller null. En butik har högst en ägare.';

create index stores_owner_idx on public.stores (organization_id, owner_id)
  where owner_id is not null;
