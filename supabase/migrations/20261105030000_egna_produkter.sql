-- Egna produkter: titlar vi packar själva (t.ex. Mystery Pack).
--
-- Vårt lager och Prognos säger "Packa X st" i stället för "Beställ", inköpspriset heter
-- "Kostnad per pack (innehåll)" och inköpslistan listar dem under "Att packa".
-- Lönsamheten räknas som vanligt (inköpspriset är kostnaden för innehållet).
--
-- Förval av för alla titlar. Ägare och admin slår på det per titel under Inköpspriser
-- (samma RLS som övriga ändringar av titlar). Inga befintliga titlar ändras här.

alter table public.titles add column own_product boolean not null default false;

comment on column public.titles.own_product is
  'Egen produkt: vi packar den själva (Packa i stället för Beställ). Förval false.';

grant update (own_product) on table public.titles to authenticated;
