-- =============================================================================
-- Avtalsvillkor ändrade efter att kontraktet signerades
--
-- Villkoren (provision, hyra, vinstdelning) för ett avtal som hör till ett signerat
-- kontrakt kunde ändras under Butiker utan att något sa till: rapporter och avräkningar
-- följde de nya villkoren medan den signerade PDF:en sa de gamla. Appen frågar nu först,
-- och när ägaren ändå ändrar sätts tiden här. Ändringen loggas som alla andra i audit_log
-- (t90_audit på store_agreements), nu med den här kolumnen i raden.
--
-- En ny kolumn som får vara tom: den gamla koden rör den inte.
-- =============================================================================

alter table public.store_agreements
  add column changed_after_signing_at timestamptz;

comment on column public.store_agreements.changed_after_signing_at is
  'Senaste gången villkoren ändrades fast avtalet hör till ett signerat kontrakt (bekräftat av ägare eller admin). Null = aldrig.';
