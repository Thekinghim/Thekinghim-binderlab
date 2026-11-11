-- =============================================================================
-- Rapporter utan e-post: "Skickade du den?" sparar att rapporten delats för hand.
--
-- När e-post inte är inställd delar ägaren rapporten själv (iPhones dela-meny). Efteråt
-- markeras rapporten som levererad med en rad i report_deliveries, så att månaden räknas
-- som klar och punkten i Att göra försvinner (status 'delivered', inget nytt värde).
--
-- * channel: 'email' (utskick från appen, som förut) eller 'manual' (delad för hand).
-- * email får vara tomt för en manuell rad utan mottagare (butiken har ingen adress i
--   appen). Utskick med e-post kräver adressen som förut.
--
-- Tabellen är fortfarande append-only, och raden kräver en godkänd rapport
-- (t30_require_approval). Samma policyer: ägare och admin lägger in. Inga rader ändras.
-- =============================================================================

alter table public.report_deliveries
  add column channel text not null default 'email'
    check (channel in ('email', 'manual')),
  alter column email drop not null,
  add constraint report_deliveries_email_required
    check (channel = 'manual' or email is not null);

comment on column public.report_deliveries.channel is
  'email = skickad från appen, manual = delad för hand och markerad som skickad.';
