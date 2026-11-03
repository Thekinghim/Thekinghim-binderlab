-- =============================================================================
-- Avtal: vinstdelning. Nytt värde i commission_base.
--
-- 'profit_after_costs': butikens andel (commission_bp) räknas på vinsten efter
-- kostnader per butik och månad (docs/berakningar.md avsnitt 4):
--   vinst = försäljning inkl. moms − VMB-moms − inköp − kortavgifter.
--
-- Egen migrering: ett nytt enum-värde kan inte användas i samma transaktion
-- som det läggs till i (nästa migrering använder det).
-- =============================================================================

alter type public.commission_base add value if not exists 'profit_after_costs';
