-- =============================================================================
-- Företagsuppgifter (Inställningar → Företaget): vi i kontraktet.
--
-- Kontraktets operatörsblock (src/reports/contract-pdf.ts) hade tomma rader för
-- adress, kontakt, e-post och telefon, eftersom bara organisationens namn och
-- organisationsnumret (Bokföring) fanns. Nu har organisationen egna uppgifter:
--
-- * company_name:    juridiskt namn i kontraktet (null = organisationens namn)
-- * org_number:      organisationsnummer NNNNNN-NNNN. Fylls i från Bokföring
--                    (bookkeeping_settings.org_number) här nedan; Inställningar
--                    sparar samma nummer i Bokföring när den raden finns.
-- * company_address: gatuadress, postnummer och ort (en rad)
-- * contact_name, contact_email, contact_phone: vår kontaktperson
--
-- Allt är valfritt (null = tom rad i kontraktet). Läses av ägare, admin och
-- läsare och skrivs av ägare och admin (befintliga policyer på
-- organization_settings). Ändringarna loggas av private.audit() som förut.
-- =============================================================================

alter table public.organization_settings
  add column company_name text
    check (company_name is null or char_length(company_name) between 1 and 200),
  add column org_number text
    check (org_number is null or org_number ~ '^\d{6}-\d{4}$'),
  add column company_address text
    check (company_address is null or char_length(company_address) between 1 and 300),
  add column contact_name text
    check (contact_name is null or char_length(contact_name) between 1 and 200),
  add column contact_email text
    check (contact_email is null or (char_length(contact_email) between 3 and 254
                                     and contact_email ~ '^[^@\s]+@[^@\s]+$')),
  add column contact_phone text
    check (contact_phone is null or char_length(contact_phone) between 1 and 50);

comment on column public.organization_settings.company_name is
  'Juridiskt namn i kontrakt (null = organizations.name).';
comment on column public.organization_settings.org_number is
  'Organisationsnummer NNNNNN-NNNN (samma som Bokföringens när den finns).';
comment on column public.organization_settings.company_address is
  'Vår adress i kontrakt (en rad).';
comment on column public.organization_settings.contact_name is
  'Vår kontaktperson i kontrakt.';
comment on column public.organization_settings.contact_email is
  'Vår e-post i kontrakt.';
comment on column public.organization_settings.contact_phone is
  'Vårt telefonnummer i kontrakt.';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (company_name, org_number, company_address, contact_name, contact_email,
              contact_phone)
  on table public.organization_settings to authenticated;

-- Organisationsnumret som redan finns i Bokföring (mängdbaserat, bara giltiga nummer).
update public.organization_settings os
   set org_number = bs.org_number
  from public.bookkeeping_settings bs
 where bs.organization_id = os.organization_id
   and os.org_number is null
   and bs.org_number ~ '^\d{6}-\d{4}$';
