-- =============================================================================
-- Lagring av filer: två privata buckets, imports (källfiler) och reports
-- (PDF:er). Sökvägen börjar med "{organization_id}/" och policyerna kontrollerar
-- has_role mot den delen. Påfyllaren har ingen åtkomst. Filerna är underlag
-- för bokföringen och kan därför inte skrivas över eller raderas av klienter.
--
-- Skapas bara om schemat storage finns (Supabase, eller lokalt via auth-shim).
-- =============================================================================

do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Schemat storage saknas: buckets och policyer skapas inte.';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('imports', 'imports', false), ('reports', 'reports', false)
  on conflict (id) do nothing;

  create policy binderlab_imports_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'imports'
      and private.has_role(
        private.try_uuid((storage.foldername(name))[1]), 'owner', 'admin', 'viewer'
      )
    );

  create policy binderlab_imports_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'imports'
      and private.has_role(private.try_uuid((storage.foldername(name))[1]), 'owner', 'admin')
    );

  create policy binderlab_reports_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'reports'
      and private.has_role(
        private.try_uuid((storage.foldername(name))[1]), 'owner', 'admin', 'viewer'
      )
    );

  create policy binderlab_reports_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'reports'
      and private.has_role(private.try_uuid((storage.foldername(name))[1]), 'owner', 'admin')
    );
end
$$;
