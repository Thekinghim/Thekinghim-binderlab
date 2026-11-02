-- =============================================================================
-- Butiksportalen (fas 10), del 1: rollen 'store'.
--
-- Ett nytt värde i en uppräkningstyp kan inte användas i samma transaktion som
-- det läggs till i, och migreringarna körs en transaktion per fil. Därför står
-- rollen ensam här; kolumner, kontroller, funktioner och policyer ligger i
-- 20261102130100_portal_store_access.sql.
--
-- Rollen 'store' ges INGA rättigheter i appens tabeller: varje policy och RPC
-- räknar uttryckligen upp sina roller (has_role/orgs_with_role), och ingen
-- nämner 'store'. Butiken når bara sina egna siffror via portal_*-funktionerna.
-- =============================================================================

alter type public.member_role add value if not exists 'store';
