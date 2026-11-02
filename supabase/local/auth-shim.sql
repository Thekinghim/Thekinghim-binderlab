-- =============================================================================
-- Auth-shim: ENDAST för lokal utveckling och CI. Körs ALDRIG mot Supabase.
--
-- Efterliknar det Supabase redan har i varje projekt, så att migreringarna i
-- supabase/migrations kan köras oförändrade mot en vanlig Postgres 16:
--   * rollerna anon, authenticated och service_role (nologin, service_role
--     kringgår RLS),
--   * schemat auth med auth.users och auth.uid()/auth.jwt()/auth.role(), som
--     läser current_setting('request.jwt.claims', true) precis som Supabase,
--   * schemat extensions (citext installeras här, som i Supabase),
--   * ett minimalt storage-schema (buckets, objects, foldername) så att
--     storage-policyer kan skapas och testas,
--   * samma standardrättigheter (grants) som Supabase sätter på schemat public.
--
-- Skriptet är idempotent och kan köras flera gånger mot samma databas.
-- Rollerna är globala i klustret och delas därför mellan binderlab_dev och
-- binderlab_test.
-- =============================================================================

-- Roller -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Supabase låter anslutningsrollen byta till dessa roller (set role).
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not pg_catalog.pg_has_role('postgres', r, 'member') then
      execute format('grant %I to postgres', r);
    end if;
  end loop;
end
$$;

-- Schema extensions ---------------------------------------------------------
create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Schema auth ----------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Supabase: klienter läser aldrig auth.users direkt, men service_role får.
revoke all on auth.users from anon, authenticated;
grant all on auth.users to service_role;

-- Samma definitioner som Supabase (läser både det nya och det äldre formatet).
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role;

-- Schema storage (minimalt) ---------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Samma som Supabase: alla mappsegment utom filnamnet.
create or replace function storage.foldername(name text) returns text[]
language plpgsql
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text) returns text
language plpgsql
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

grant execute on function storage.foldername(text), storage.filename(text)
  to anon, authenticated, service_role;

-- Standardrättigheter i public, som Supabase -----------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
