-- =============================================================================
-- Gissning mot utfall, steg 1: spara gissningen när en plats blir butik.
--
-- En plats i pipelinen (expansion_leads) har en uppskattning som räknas om varje gång
-- sidan Expansion öppnas, ur de befintliga butikernas försäljning. När platsen blir en
-- butik går den gissningen inte att få tillbaka senare (underlaget har ändrats). Därför
-- sparas den på platsen i samma stund:
--
--   guess_profit_month_ore  uppskattad vinst per automat och månad (öre), som Expansion
--                           visade den: efter inköp, avgifter, butikens andel och hyra
--   guess_low_month_ore     lägsta platsen i underlaget
--   guess_high_month_ore    högsta platsen i underlaget
--   guess_on                dagen gissningen sparades
--
-- Alla fyra sätts tillsammans (eller ingen), och låg ≤ förväntad ≤ hög. Vinsten kan vara
-- negativ. Ingenting visas än: jämförelsen mot utfallet kommer i en senare runda.
-- Skrivs av servern som användaren (ägare och admin, expansion_leads_update), bara när
-- ingen gissning redan är sparad.
--
-- Allt är additivt: fyra nya kolumner med null som standard och en kontroll.
-- =============================================================================

alter table public.expansion_leads
  add column guess_profit_month_ore bigint,
  add column guess_low_month_ore bigint,
  add column guess_high_month_ore bigint,
  add column guess_on date,
  add constraint expansion_leads_guess_check check (
    (guess_on is null and guess_profit_month_ore is null
       and guess_low_month_ore is null and guess_high_month_ore is null)
    or (guess_on is not null and guess_profit_month_ore is not null
       and guess_low_month_ore is not null and guess_high_month_ore is not null
       and guess_low_month_ore <= guess_profit_month_ore
       and guess_profit_month_ore <= guess_high_month_ore)
  );

comment on column public.expansion_leads.guess_profit_month_ore is
  'Gissningen när platsen blev butik: uppskattad vinst per automat och månad (öre).';
comment on column public.expansion_leads.guess_low_month_ore is
  'Gissningens lägsta värde (öre per automat och månad).';
comment on column public.expansion_leads.guess_high_month_ore is
  'Gissningens högsta värde (öre per automat och månad).';
comment on column public.expansion_leads.guess_on is
  'Dagen gissningen sparades (när platsen blev butik).';
