# Översikt

## Vad Binderlab gör

En kontrollpanel för den som driver varuautomater med samlarkortspack (Pokémon) utställda i
butiker. Panelen läser in all försäljning från automatplattformen och svarar på driftens frågor:

- **Vad tjänar vi?** Vinst per titel, automat och butik efter inköpspris, butikens ersättning
  (provision och hyra), kortavgift och moms (Hem, Lönsamhet, Enhetsekonomi).
- **Vad ska göras i dag?** Påfyllning innan något tar slut, automater som slutat sälja,
  rapporter som ska skickas (Att göra, Drift, Fyll på i mobilen).
- **Vad ska köpas in?** Prognos per vecka och inköpsförslag (Prognos & inköp, Vårt lager).
- **Pappersarbetet:** månadsrapporter till butiker (PDF), avräkningar, SIE 4 och Excel till
  bokföringen, avtal med signering, butiksportal (Rapporter, Ekonomi, Avtal, Butiker).

Allt gränssnitt är på svenska, belopp sparas i öre och datum räknas i organisationens tidszon
(standard `Europe/Stockholm`). Mer i [docs/product.md](../product.md).

## Kunder och organisationer (multi-tenant)

- **Organisation = kund.** All data har `organization_id` och hör till exakt en organisation
  (82 av 83 tabeller i `public`; katalogtestet `test/db/catalog.test.ts` kräver det för varje
  tabell utom `organizations` själv). En operatör (t.ex. en dansk operatör) får en egen organisation och ser
  aldrig någon annans data.
- **Roller per organisation** (`public.member_role`): ägare (`owner`), admin, läsare
  (`viewer`, t.ex. delägare) och påfyllare (`refiller`, bara lager, inga belopp). Butiker
  loggar in i en egen portal och ser bara sin butik. Detaljer i [sakerhet.md](sakerhet.md).
- **En användare kan vara medlem i flera organisationer** och byter aktiv organisation i
  menyn (kakan `bl_org`; rollen läses alltid om ur databasen).
- **Ny kund:** inbjudan i Supabase och "Kom igång" i appen (`create_first_organization`).
  Plan, automatgräns (`organizations.machine_limit`) och fakturering finns i datamodellen men
  ingen fakturering är byggd (README, "Innan andra operatörer kan börja").

## Automatplattformar

Binderlab är byggt mot Awish (DingShang), men beror inte på det: ett gränssnitt
(`src/server/platforms`) beskriver vad Binderlab behöver från en plattform, och en operatör med
ett annat märke laddar upp sin försäljning som CSV ("Annan automat"). Se
[integrationer.md](integrationer.md).

## Läge

I drift på `https://thekinghim-binderlab.vercel.app` för Binderlab (en organisation). Kända
brister och vad som återstår innan fler operatörer släpps in står i README ("Kända brister" och
"Innan andra operatörer kan börja använda panelen").
