-- =============================================================================
-- Klientfel: fel som telefonen eller webbläsaren själv kastade (felrutan "Sidan kunde inte
-- laddas" utan fel-id, och ohanterade fel i skalet) sparas automatiskt, så att det riktiga
-- felet kan läsas i databasen utan skärmdumpar.
--
-- - private.client_errors: en rad per rapporterat fel. Ligger i schemat private: ingen
--   klientroll kan läsa, skriva eller radera direkt. Operatören läser med SQL.
-- - public.report_client_error(...): enda vägen in (security definer, authenticated).
--   Kortar varje fält i databasen, tar bort frågesträngar och e-postadresser, sparar
--   organisationen bara om personen är medlem där, högst 30 rader per person och timme
--   (fler släpps tyst) och gallrar rader äldre än 30 dagar. Returnerar ingenting, så att
--   anroparen inte kan se om organisationen godtogs eller gränsen nåddes.
-- =============================================================================

create table private.client_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null,
  organization_id uuid,
  path text not null default '' check (char_length(path) <= 300),
  message text not null default '' check (char_length(message) <= 500),
  stack text not null default '' check (char_length(stack) <= 4000),
  digest text check (digest is null or char_length(digest) <= 100),
  build_id text check (build_id is null or char_length(build_id) <= 80),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  extra jsonb not null default '{}'::jsonb check (pg_column_size(extra) <= 2000)
);

create index client_errors_user_time_idx on private.client_errors (user_id, created_at desc);
create index client_errors_time_idx on private.client_errors (created_at desc);

comment on table private.client_errors is
  'Fel som telefonen eller webbläsaren kastade (felrutan utan fel-id, ohanterade fel). 30 dagar, högst 30 per person och timme. Skrivs bara av public.report_client_error, läses av operatören.';

revoke all on table private.client_errors from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Text som får sparas: utan frågesträngar och fragment i adresser, utan e-postadresser och
-- utan styrtecken, kortad till max tecken.
-- -----------------------------------------------------------------------------
create function private.client_error_text(value text, max integer) returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(value, ''), '(https?://[^\s?#)]*)[?#][^\s)]*', '\1', 'g'),
        '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[e-post]', 'g'
      ),
      '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g'
    ),
    max
  )
$$;

revoke all on function private.client_error_text(text, integer) from public, anon, authenticated;

create function public.report_client_error(
  p_path text,
  p_message text,
  p_stack text,
  p_digest text,
  p_build_id text,
  p_user_agent text,
  p_extra jsonb,
  p_organization_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  org uuid;
  recent integer;
  extra jsonb := '{}'::jsonb;
begin
  if uid is null then
    return;
  end if;

  -- En rapport i taget per person, så att gränsen håller även när flera kommer samtidigt.
  perform pg_advisory_xact_lock(hashtextextended('client_errors:' || uid::text, 0));

  select count(*) into recent
  from private.client_errors
  where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 30 then
    return;
  end if;

  if p_organization_id is not null and exists (
    select 1 from public.memberships m
    where m.user_id = uid and m.organization_id = p_organization_id
  ) then
    org := p_organization_id;
  end if;

  if jsonb_typeof(p_extra) = 'object' and pg_column_size(p_extra) <= 1000 then
    extra := p_extra;
  end if;

  insert into private.client_errors
    (user_id, organization_id, path, message, stack, digest, build_id, user_agent, extra)
  values (
    uid,
    org,
    -- Bara sökvägen: frågesträngen och fragmentet tas bort.
    private.client_error_text(split_part(split_part(coalesce(p_path, ''), '?', 1), '#', 1), 300),
    private.client_error_text(p_message, 500),
    private.client_error_text(p_stack, 4000),
    nullif(private.client_error_text(p_digest, 100), ''),
    nullif(private.client_error_text(p_build_id, 80), ''),
    nullif(private.client_error_text(p_user_agent, 300), ''),
    extra
  );

  -- Gallring: rader äldre än 30 dagar (indexet på created_at gör det billigt).
  delete from private.client_errors where created_at < now() - interval '30 days';
end;
$$;

revoke all on function public.report_client_error(text, text, text, text, text, text, jsonb, uuid)
  from public, anon;
grant execute on function public.report_client_error(text, text, text, text, text, text, jsonb, uuid)
  to authenticated;
