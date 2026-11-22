-- =============================================================================
-- Butiksportalen: avtalets "signerat" med samma regel som ägarens Kontrakt.
--
-- Ägarens Kontrakt (src/analytics/contracts/signed.ts, isSigned) räknar ett avtal som
-- signerat när det har signed_at, eller när det registrerats för hand (template null:
-- ett befintligt papperskontrakt). portal_contracts gav bara signed_at, så portalen
-- sade "Inte signerat än" om ett avtal som ägaren ser som "Signerat" (demons Bio Fyren).
--
-- portal_contracts får kolumnen signed (samma regel, räknad i databasen) sist. Den
-- returnerade tabellen ändras, så funktionen tas bort och skapas igen med samma
-- rättigheter. Inget annat ändras: samma rader, samma ordning, samma behörighet.
--
-- Säkert medan den gamla koden kör: den läser kolumnerna med namn och bryr sig inte om
-- den nya kolumnen.
-- =============================================================================

drop function public.portal_contracts(uuid);

-- Butikens avtal (inte arkiverade), senaste först, med signaturen om den finns.
create function public.portal_contracts(p_store_id uuid)
returns table (
  contract_id uuid,
  title text,
  valid_from date,
  valid_to date,
  terminated_on date,
  signed_at timestamptz,
  signer_name text,
  has_file boolean,
  signed boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select c.id, c.title, c.valid_from, c.valid_to, c.terminated_on,
           coalesce(sig.signed_at, c.signed_at), sig.signer_name,
           (sig.signed_file_path is not null or c.storage_path is not null),
           -- Samma regel som isSigned: signerat, eller registrerat för hand.
           (c.template is null or coalesce(sig.signed_at, c.signed_at) is not null)
    from public.contracts c
    left join lateral (
      select s.signed_at, s.signer_name, s.signed_file_path
      from public.contract_signatures s
      where s.organization_id = c.organization_id and s.contract_id = c.id
      order by s.signed_at desc
      limit 1
    ) sig on true
    where c.organization_id = v_org
      and c.store_id = p_store_id
      and c.archived_at is null
    order by c.valid_from desc, c.created_at desc
    limit 10;
end
$$;

revoke all on function public.portal_contracts(uuid) from public, anon;
grant execute on function public.portal_contracts(uuid) to authenticated;
