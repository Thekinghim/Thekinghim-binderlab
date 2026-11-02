-- =============================================================================
-- Marknad: granskningens rättelser (samtidiga anrop).
--
-- 1. Samma pristest kunde startas flera gånger av parallella anrop (dubbelklick):
--    tjänsten läste, kontrollerade och skrev utan lås. Förslagets nyckel
--    ('price-test:<titel>:<riktning>:<startdag>') är nu unik per organisation, så
--    ett och samma förslag kan bara bli ett pristest. Tjänsten tar dessutom ett
--    transaktionslås per titel och kontrollerar inne i transaktionen att titeln inte
--    redan testas.
-- 2. Samma sortimentsrekommendation kunde markeras som genomförd två gånger, vilket
--    dubbelräknade effekten i uppföljningen. (automat, fingerprint) är nu unik per
--    organisation; sidan räknar redan en rekommendation med samma fingerprint som
--    genomförd.
-- =============================================================================

create unique index price_experiments_proposal_unique
  on public.price_experiments (organization_id, proposal_key);

create unique index assortment_changes_fingerprint_unique
  on public.assortment_changes (organization_id, machine_id, fingerprint);
