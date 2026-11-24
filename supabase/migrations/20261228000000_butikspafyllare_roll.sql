-- =============================================================================
-- Butikspåfyllare: ny roll machine_refiller (egen migration: ett nytt enum-värde kan inte
-- användas i samma transaktion som lägger till det). Se 20261228000100_butikspafyllare.sql.
-- =============================================================================

alter type public.member_role add value if not exists 'machine_refiller';
