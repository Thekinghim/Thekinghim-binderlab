-- =============================================================================
-- Härdning: gallringen får bara köras av systemet (databasägaren).
--
-- private.purge_allowed() (20261102100000_foundation.sql) godtog varje roll utom
-- anon och authenticated, alltså även service_role (Supabase hemliga nyckel). Med
-- binderlab.allow_purge = 'on' kunde service_role då radera append-only- och
-- bokföringsdata (order, lagerhändelser, godkännanden, assistentens logg).
-- Röd granskning fas 7 (test/db/redteam-fas7-db.test.ts) visade det.
--
-- Gallringen, demoåterställningen och migreringarna kör som databasägaren
-- `postgres` (DATABASE_URL), lokalt och i Supabase (även via poolern, där
-- inloggningen postgres.<projekt> blir rollen postgres). Funktioner med
-- security definer ägs av postgres och kör därför också som postgres, men de
-- sätter aldrig flaggan, och en klient kan inte sätta den via PostgREST.
--
-- Samma signatur och samma grants; bara villkoret för rollen skärps.
-- =============================================================================

create or replace function private.purge_allowed() returns boolean
language sql stable
set search_path = ''
as $$
  select current_user = 'postgres'
     and coalesce(current_setting('binderlab.allow_purge', true), '') = 'on'
$$;

comment on function private.purge_allowed() is
  'Gallring: bara databasägaren (postgres) med binderlab.allow_purge = on i transaktionen.';
