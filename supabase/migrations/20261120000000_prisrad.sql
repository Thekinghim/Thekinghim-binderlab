-- =============================================================================
-- Prisråd: organisationens mål för marginalen.
--
-- Lönsamhet och Att göra flaggar produkter vars marginal (före butikernas andel) är under
-- målet, och föreslår ett pris som når det. Målet är en inställning per organisation:
--
-- * organization_settings.target_margin_bp: målet i baspunkter. Standard 2 500 (25 %),
--   1–90 %. Läses av ägare, admin och läsare och ändras av ägare och admin (befintliga
--   policyer på organization_settings). Ändringen loggas av private.audit() som förut.
--
-- Bara ett råd: appen ändrar aldrig priset i automaten. Inget befintligt ändras i data
-- (alla organisationer får standardvärdet).
-- =============================================================================

alter table public.organization_settings
  add column target_margin_bp integer not null default 2500
    check (target_margin_bp between 100 and 9000);

comment on column public.organization_settings.target_margin_bp is
  'Prisråd: mål för marginalen före butikernas andel, i baspunkter (2500 = 25 %).';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (target_margin_bp) on table public.organization_settings to authenticated;
