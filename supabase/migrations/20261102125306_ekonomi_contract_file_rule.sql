-- =============================================================================
-- Fas 9 Avtal: avtal som redan har en sökväg (storage_path) utan filnamn får
-- finnas kvar. Kontrollen contracts_file_complete (20261102121731) ersätts av
-- en svagare: ett filnamn eller en sha256 kräver en sökväg. Servern sätter alltid
-- alla tre när en fil bifogas (src/server/accounting).
-- =============================================================================

alter table public.contracts
  drop constraint contracts_file_complete,
  add constraint contracts_file_has_path check (
    storage_path is not null or (file_name is null and file_sha256 is null)
  );
