-- =============================================================================
-- Tillägg (Awish Chrome-tillägg): synk-tokens.
--
-- Tillägget skickar ordrar till POST /api/ingest/awish med
-- "Authorization: Bearer <token>". En token är bunden till en organisation och
-- en datakälla av typen awish_extension, kan återkallas och visas bara en gång
-- när den skapas: här sparas bara dess sha256 (token_hash) och de första
-- tecknen (token_prefix) så att den går att känna igen i listan.
--
-- * Ägare och admin skapar, döper om och återkallar tokens (RLS). Läsare,
--   påfyllare och butiker ser dem inte alls.
-- * En återkallad token kan inte återställas, och hash, datakälla och
--   organisation kan inte ändras (trigger). Rader raderas inte (arkivering via
--   revoked_at), så att importerna går att spåra till en token.
-- * Felkod BL070: otillåten ändring av en synk-token (se triggern nedan).
-- * Kontaktfälten (last_seen_at, last_batch_at, last_status, last_error,
--   client_version) skrivs bara av ingest-API:t (systemrollen) och tas bort ur
--   ändringsloggen, så att varje synk inte ger en loggrad. Skapande, namnbyte
--   och återkallelse loggas i audit_log.
-- =============================================================================

create table public.sync_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  -- De första tecknen i token (t.ex. "blsync_Ab12"), för att känna igen den i listan.
  token_prefix text not null check (token_prefix ~ '^[A-Za-z0-9_-]{4,16}$'),
  -- Senaste kontakt (batch, statusfråga eller rapport) och senaste batch med rader.
  last_seen_at timestamptz,
  last_batch_at timestamptz,
  -- Tilläggets senaste rapport: ok, utloggad från Awish eller fel.
  last_status text check (last_status is null or last_status in ('ok', 'logged_out', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  client_version text check (client_version is null or char_length(client_version) <= 100),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (token_hash),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete restrict
);

create index sync_tokens_source_idx on public.sync_tokens (organization_id, data_source_id);

-- Datakällan är ett aktivt Awish-tillägg. Security definer: kontrollen ska ge samma svar
-- oavsett vad anroparen ser (RLS på data_sources avgör sedan med policyn nedan om raden
-- får skrivas, så en rad i en annan organisation nekas med 42501 som alla andra tabeller).
create function private.is_extension_source(p_organization_id uuid, p_data_source_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.data_sources ds
    where ds.organization_id = p_organization_id and ds.id = p_data_source_id
      and ds.provider = 'awish_extension' and ds.archived_at is null
  )
$$;

revoke all on function private.is_extension_source(uuid, uuid) from public, anon;
grant execute on function private.is_extension_source(uuid, uuid) to authenticated;

-- Regler som RLS inte kan uttrycka:
--   * datakällan måste vara ett Awish-tillägg (awish_extension) och inte arkiverad;
--   * hash, prefix och datakälla ändras aldrig; en återkallad token förblir återkallad;
--   * klientroller (authenticated) får bara ändra namn och återkalla. revoked_by sätts
--     av databasen. Kontaktfälten skrivs bara av systemrollen (ingest-API:t).
create function private.sync_tokens_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if not private.is_extension_source(new.organization_id, new.data_source_id) then
      raise exception using
        errcode = 'BL070',
        message = 'Synk-token kan bara skapas för en aktiv datakälla av typen Awish-tillägg.';
    end if;
    if v_client then
      new.last_seen_at := null;
      new.last_batch_at := null;
      new.last_status := null;
      new.last_error := null;
      new.client_version := null;
      new.revoked_at := null;
      new.revoked_by := null;
    end if;
    return new;
  end if;

  if new.token_hash is distinct from old.token_hash
     or new.token_prefix is distinct from old.token_prefix
     or new.data_source_id is distinct from old.data_source_id then
    raise exception using errcode = 'BL070', message = 'En synk-token kan inte ändras, bara återkallas.';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception using errcode = 'BL070', message = 'En återkallad synk-token kan inte återställas.';
  end if;
  if v_client then
    new.last_seen_at := old.last_seen_at;
    new.last_batch_at := old.last_batch_at;
    new.last_status := old.last_status;
    new.last_error := old.last_error;
    new.client_version := old.client_version;
    if old.revoked_at is null and new.revoked_at is not null then
      new.revoked_at := now();
      new.revoked_by := auth.uid();
    else
      new.revoked_by := old.revoked_by;
    end if;
  end if;
  return new;
end
$$;

revoke all on function private.sync_tokens_guard() from public;

create trigger t00_forbid_org_change before update on public.sync_tokens
  for each row execute function private.forbid_org_change();
create trigger t10_guard before insert or update on public.sync_tokens
  for each row execute function private.sync_tokens_guard();
create trigger t20_stamp_insert before insert on public.sync_tokens
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.sync_tokens
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update on public.sync_tokens
  for each row execute function private.audit(
    'token_hash', 'last_seen_at', 'last_batch_at', 'last_status', 'last_error', 'client_version'
  );
create trigger t99_forbid_delete before delete on public.sync_tokens
  for each row execute function private.forbid_delete();

alter table public.sync_tokens alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS: bara ägare och admin, aldrig radering.
-- -----------------------------------------------------------------------------
alter table public.sync_tokens enable row level security;
revoke all on table public.sync_tokens from anon, authenticated;
grant select, insert, update on table public.sync_tokens to authenticated;

create policy sync_tokens_select on public.sync_tokens
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy sync_tokens_insert on public.sync_tokens
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy sync_tokens_update on public.sync_tokens
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
