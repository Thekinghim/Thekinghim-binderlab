-- =============================================================================
-- Inställningar säger till: momsgränsen och "Revisorn har koll".
--
-- Den dagliga kontrollen får en sjunde kontroll, "Inställningar" (ryms i
-- self_check_runs.checks, ingen ändring där). Den varnar när momsen står på 0 % och årets
-- försäljning närmar sig gränsen för momsbefrielse. Två nya inställningar per organisation:
--
-- * organization_settings.vat_limit_ore: gränsen vi varnar vid, i öre. Standard
--   12 000 000 (120 000 kr, Skatteverkets gräns). Går att ändra.
-- * organization_settings.vat_ok_at: när någon tryckte "Revisorn har koll". null = varna.
--
-- Läses och ändras av samma roller som resten av raden (befintliga policyer: ägare och
-- admin ändrar). Ändringen loggas av private.audit() som förut. Bara en varning: appen
-- ändrar aldrig momssatsen själv. Inget befintligt ändras i data.
-- =============================================================================

alter table public.organization_settings
  add column vat_limit_ore bigint not null default 12000000
    check (vat_limit_ore between 100 and 100000000000),
  add column vat_ok_at timestamptz;

comment on column public.organization_settings.vat_limit_ore is
  'Momsgränsen vi varnar vid, i öre (12000000 = 120 000 kr).';
comment on column public.organization_settings.vat_ok_at is
  'När "Revisorn har koll" trycktes: momsvarningen visas inte. null = varna.';

-- Insert är redan beviljat på hela tabellen; update är per kolumn.
grant update (vat_limit_ore, vat_ok_at) on table public.organization_settings to authenticated;
