-- =============================================================================
-- Portalen: butikens ort i portal_stores, så att namnet visas som i resten av appen
-- (storeNameLabel i src/lib/format.ts: "Söt och salt alingsås" i Alingsås → "Söt och salt
-- Alingsås"). Samma rader och samma behörighet som förut, bara en kolumn till (store_city).
-- Returtypen ändras, så funktionen tas bort och skapas igen med samma rättigheter.
-- =============================================================================

drop function public.portal_stores();

create function public.portal_stores()
returns table (
  store_id uuid,
  store_name text,
  organization_id uuid,
  organization_name text,
  timezone text,
  vat_rate_bp integer,
  store_city text
)
language sql stable security definer
set search_path = ''
as $$
  select s.id, s.name, o.id, o.name, o.timezone, coalesce(os.vat_rate_bp, 0), s.city
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  join public.stores s on s.organization_id = m.organization_id and s.id = m.store_id
  left join public.organization_settings os on os.organization_id = o.id
  where m.user_id = (select auth.uid())
    and m.role = 'store'
    and o.archived_at is null
    and s.archived_at is null
  order by m.created_at, s.name
$$;

revoke all on function public.portal_stores() from public, anon;
grant execute on function public.portal_stores() to authenticated;
