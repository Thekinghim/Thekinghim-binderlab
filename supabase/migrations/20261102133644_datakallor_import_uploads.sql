-- =============================================================================
-- Datakällor: mellanlagring av uppladdade orderlistor (import_uploads och
-- import_upload_chunks).
--
-- En orderlista med hela historiken (upp till 50 MB) laddas upp från webbläsaren
-- i bitar om 768 KiB, förhandsvisas (gärna flera gånger, t.ex. med ändrad
-- kolumnmappning) och importeras. Bitarna sparades tidigare på serverns disk,
-- vilket inte fungerar med flera serverinstanser eller med Vercels skrivskyddade
-- disk. Nu ligger de i databasen, som alla instanser delar.
--
-- * import_uploads: en rad per uppladdning (filnamn, storlek, hur mycket som
--   tagits emot och nästa bit som väntas).
-- * import_upload_chunks: bitarna i ordning (chunk_index 0, 1, 2 …).
--
-- Raderna är tillfälliga: de tas bort när filen importerats, när användaren
-- avbryter och när de är äldre än ett dygn (vid användarens nästa uppladdning).
-- Bara den som laddade upp ser och tar bort sina rader, och bara som ägare eller
-- admin. Påfyllare och läsare har ingen åtkomst. Ingen auditlogg: innehållet är
-- en fil på väg in, och själva importen loggas i public.imports.
-- =============================================================================

create table public.import_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 500),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  received_bytes bigint not null default 0 check (received_bytes between 0 and size_bytes),
  next_index integer not null default 0 check (next_index between 0 and 100000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.import_upload_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  upload_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 100000),
  data bytea not null check (octet_length(data) between 1 and 1048576),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, upload_id, chunk_index),
  foreign key (organization_id, upload_id)
    references public.import_uploads (organization_id, id) on delete restrict
);

create trigger t00_forbid_org_change before update on public.import_uploads
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.import_uploads
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.import_uploads
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.import_upload_chunks
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.import_upload_chunks
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.import_upload_chunks
  for each row execute function private.stamp_update();

create index import_uploads_owner_idx
  on public.import_uploads (organization_id, created_by, created_at);

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS: bara den egna uppladdningen, och bara som ägare/admin.
-- -----------------------------------------------------------------------------
alter table public.import_uploads enable row level security;
alter table public.import_upload_chunks enable row level security;
revoke all on table public.import_uploads from anon, authenticated;
revoke all on table public.import_upload_chunks from anon, authenticated;
grant select, insert, update, delete on table public.import_uploads to authenticated;
grant select, insert, delete on table public.import_upload_chunks to authenticated;

create policy import_uploads_select on public.import_uploads
  for select to authenticated
  using (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_uploads_insert on public.import_uploads
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_uploads_update on public.import_uploads
  for update to authenticated
  using (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  )
  with check (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_uploads_delete on public.import_uploads
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_upload_chunks_select on public.import_upload_chunks
  for select to authenticated
  using (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_upload_chunks_insert on public.import_upload_chunks
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );

create policy import_upload_chunks_delete on public.import_upload_chunks
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );
