-- =============================================================================
-- Avtal: avtal skapade från mallen (Skapa avtal) och deras status.
--
-- * template:  mallens namn och version när avtalet skapades från mallen
--              (t.ex. 'placering-vinstdelning-v1'), null för avtal som
--              registrerats för hand.
-- * sent_at:   när avtalet skickades till butiken (null = utkast).
-- * signed_at: när avtalet signerades (signerad kopia uppladdad eller
--              markerat som signerat).
--
-- Status = signerat om signed_at, annars skickat om sent_at, annars utkast.
-- Ändringarna loggas av t90_audit och skrivs bara av ägare och admin
-- (befintliga policyer på contracts).
-- =============================================================================

alter table public.contracts
  add column template text
    check (template is null or template ~ '^[a-z0-9-]{1,60}$'),
  add column sent_at timestamptz,
  add column signed_at timestamptz;

comment on column public.contracts.template is
  'Mallen avtalet skapades från (Skapa avtal), t.ex. placering-vinstdelning-v1. null = registrerat för hand.';
comment on column public.contracts.sent_at is
  'När avtalet skickades till butiken. null = utkast (om inte signed_at är satt).';
comment on column public.contracts.signed_at is
  'När avtalet signerades (signerad kopia uppladdad eller markerat som signerat).';
