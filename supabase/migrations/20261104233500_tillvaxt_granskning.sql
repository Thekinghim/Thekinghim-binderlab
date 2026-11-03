-- =============================================================================
-- Tillväxt: rättelser efter granskningen.
--
-- 1. Gratis-pack-koderna loggades i audit_log, som läsaren kan läsa: läsaren skulle då se
--    koderna som bara ägare och admin får se. Koden tas bort ur loggen (som token_hash för
--    signeringslänkarna). Tabellen är ny i samma release, så inga loggade koder finns i drift.
-- 2. Ett digitalt signerat avtal (en rad i contract_signatures) får inte byta fil och inte
--    bli osignerat: signaturen gäller PDF:en med den sparade kontrollsumman. Arkivering och
--    uppsägning fungerar som förut.
-- =============================================================================

drop trigger t90_audit on public.free_pack_codes;
create trigger t90_audit after insert or update or delete on public.free_pack_codes
  for each row execute function private.audit('code');

create function private.contracts_signed_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.storage_path, new.file_sha256, new.file_content_type, new.signed_at)
       is not distinct from (old.storage_path, old.file_sha256, old.file_content_type, old.signed_at) then
    return new;
  end if;
  if exists (select 1 from public.contract_signatures s
             where s.organization_id = old.organization_id and s.contract_id = old.id) then
    if (new.storage_path, new.file_sha256, new.file_content_type)
         is distinct from (old.storage_path, old.file_sha256, old.file_content_type) then
      raise exception using errcode = 'BL076',
        message = 'Avtalet är signerat digitalt. Filen kan inte bytas. Gör ett nytt avtal.';
    end if;
    if new.signed_at is null then
      raise exception using errcode = 'BL076',
        message = 'Avtalet är signerat digitalt och kan inte bli osignerat.';
    end if;
  end if;
  return new;
end
$$;

revoke all on function private.contracts_signed_guard() from public, anon;

create trigger t12_signed_guard before update on public.contracts
  for each row execute function private.contracts_signed_guard();
