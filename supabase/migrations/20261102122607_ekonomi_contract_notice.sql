-- =============================================================================
-- Fas 9 Avtal: uppsägningstid i månader och uppsägningsdag.
--
-- Uppsägningstid anges oftast i hela månader ("3 månader före avtalets slut").
-- notice_period_months räknas från slutet först och notice_period_days därefter
-- (src/analytics/contracts, noticeDeadline). terminated_on är dagen då avtalet
-- sades upp; ett uppsagt avtal förlängs inte automatiskt.
-- =============================================================================

alter table public.contracts
  add column notice_period_months integer check (notice_period_months between 0 and 120),
  add column terminated_on date,
  add constraint contracts_terminated_check check (terminated_on is null or terminated_on >= valid_from);
