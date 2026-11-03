-- =============================================================================
-- Bokföring: "VMB i bokföringen" (per organisation, standard av).
--
-- * bookkeeping_settings.vmb_enabled
--     false (standard): månadspaketet (SIE 4, PDF, Excel) bokför försäljningen och resultatet
--                       utan VMB: ingen VMB-moms, ingen rad för utgående moms VMB och inget
--                       underskott som förs vidare.
--     true:             VMB som tidigare (samlad beräkning per månad, underskott förs vidare).
--   Allt räknas utan VMB som standard; ägaren slår på det med knappen i Ekonomi → Bokföring.
-- * En månad som markerats som skickad behåller valet som gällde när den skickades
--   (bookkeeping_months.snapshot.vmbEnabled; saknas = på, så räknades alla skickade månader
--   före den här ändringen). Övriga månaders sparade paket får en ny version när valet ändras
--   (underlagets fingeravtryck ändras; det schemalagda jobbet och nedladdningen tar fram det).
--
-- Ägare och admin ändrar (samma policyer som övriga bokföringsinställningar). Ändringen loggas
-- av t90_audit.
-- =============================================================================

alter table public.bookkeeping_settings
  add column vmb_enabled boolean not null default false;

comment on column public.bookkeeping_settings.vmb_enabled is
  'VMB i bokföringen: false (standard) = månadspaketet bokförs utan VMB-moms, true = VMB (samlad beräkning per månad).';

grant insert (vmb_enabled) on table public.bookkeeping_settings to authenticated;
grant update (vmb_enabled) on table public.bookkeeping_settings to authenticated;
