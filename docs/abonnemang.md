# Abonnemang

Binderlab (plattformsoperatören) tar betalt av varje kundorganisation **per aktiv automat och månad**. Den här
sidan beskriver modellen, räknereglerna, säkerheten och hur produktionen sätts upp.

| Del                | Var                                                                  |
| ------------------ | -------------------------------------------------------------------- |
| Migrering          | `supabase/migrations/20261111010000_abonnemang.sql`                  |
| Räkneregler (rena) | `src/analytics/subscriptions/billing.ts` (+ `billing.test.ts`)       |
| Data, ändringar    | `src/server/subscriptions/service.ts`                                |
| Format och CSV     | `src/server/subscriptions/model.ts` (+ `model.test.ts`)              |
| Plattformen        | `/plattform` (kunder, MRR, ARR, churn, historik, ändra plan)         |
| Fakturaunderlag    | `/plattform/underlag?manad=ÅÅÅÅ-MM[&kund=<id>]`, CSV under `.../csv` |
| Kundens vy         | Inställningar → Abonnemang (bara läsning, ägare och admin)           |
| Tester             | `test/db/abonnemang.test.ts`, `e2e/09-abonnemang.e2e.test.ts`        |

## Vem är plattformsoperatör

Tabellen `private.platform_operators` säger vilka **organisationer** som driver plattformen. Ägare och admin i en
sådan organisation är plattformsoperatörer (`private.is_platform_operator()`); läsare och påfyllare är det inte.

- Tabellen ligger i schemat `private`, som inte exponeras. Ingen klientroll har rättigheter på den, inte ens
  `service_role`. Bara databasägaren (en migrering eller SQL i Supabase SQL Editor) kan lägga till en rad.
- En kund kan alltså aldrig göra sig själv till operatör, och att bjuda in någon till Binderlabs organisation som
  ägare eller admin är det enda sättet att ge åtkomst (och att ta bort medlemskapet tar bort den).
- Alla andra får 404 på `/plattform` och CSV:n, och RPC:erna nekar med 42501.

### Produktion: gör Binderlabs organisation till operatör (en rad SQL)

Ingen migrering gör det automatiskt, eftersom vi inte kan veta säkert vilken organisation i produktionen som är
Binderlabs (en kund kan i teorin heta "Binderlab"). Kör i Supabase SQL Editor (som `postgres`):

```sql
insert into private.platform_operators (organization_id, note)
select id, 'Binderlab' from public.organizations where slug = 'binderlab' on conflict do nothing;
```

Kontrollera först att sluggen är rätt: `select id, name, slug, created_at from public.organizations order by
created_at;` (Binderlabs organisation är den äldsta, skapad av William). Ta bort: `delete from
private.platform_operators where organization_id = '<id>';`.

## Modellen

- `private.subscription_plans`: planens **perioder** per kund: `valid_from`, `valid_to` (inklusive, null = tills
  vidare), `status` (`active`, `paused`, `ended`), `price_per_machine_ore` (öre per automat och månad), `currency`
  (SEK, EUR, DKK, NOK) och en intern anteckning. Perioderna kan inte överlappa (exclusion constraint).
- `private.subscription_customers`: kundens land (ISO-kod, null = Sverige), momsnummer (VAT) och provperiodens
  sista dag.
- En ändring görs alltid "från ett datum" (`platform_save_plan`): den öppna perioden slutar dagen före och en ny
  börjar. Samma dag som senaste periodens start skriver över den. Ett datum före senaste periodens start nekas
  (BL120), så äldre perioder ändras aldrig. Oförändrat pris, status och valuta skapar ingen ny period.
- Obs: ett datum bakåt i tiden (men inom den senaste perioden) ändrar underlaget för månader som redan kan vara
  fakturerade, och land, momsnummer och provperiod gäller alla månader. Formuläret varnar när datumet ligger
  före innevarande månad. Spara CSV:n när en månad är fakturerad; den är det som gäller.
- Automater: `private.billing_machines` räknar varje automats aktiva period: från `active_from` (annars dagen den
  lades upp, i organisationens tidszon) till `active_to` eller dagen före arkiveringen (automatens eller hela
  organisationens, det som kommer först). Exempelautomater räknas aldrig.
- Plattformens egna organisationer visas i listan men räknas inte som kunder (totaler, historik, churn).
- Demoorganisationer (`organizations.is_demo`, när demofunktionen är ihopslagen) räknas aldrig som kunder.

## Räkneregler

- **Automatdag**: en dag en automat är aktiv. En automat som är aktiv hela månaden kostar exakt priset.
- **Belopp** per fakturarad (samma valuta och pris) = round(pris × debiterade automatdagar / dagar i månaden),
  halva öret uppåt. Prisändring mitt i månaden ger två rader.
- **Provperiod**: inget debiteras till och med `trialEndsOn`. **Pausad** och **avslutad** debiteras inte.
- **MRR** en dag = pris × aktiva automater den dagen, för kunder med aktiv plan utanför provperioden.
  **ARR** = 12 × MRR. Totaler summeras per valuta; valutor blandas aldrig. ARR är en takt (dagens MRR × 12),
  inte ett avtalat eller garanterat belopp.
- **Betalande kund**: MRR över 0 i dag (aktiv plan utanför provperioden, minst en automat, pris över 0).
- **Historik**: MRR mäts sista dagen i varje månad (i dag för innevarande månad), plus fakturerat belopp.
- **Churn** i en månad = kunder med aktiv plan (betalande eller provperiod) dagen före månaden som vid månadens
  slut varken är aktiva eller pausade. Andel = churnade / aktiva vid månadens start.

### Moms (enkel modell, kontrollera med revisor)

| Kund                         | Moms                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Sverige (eller inget land)   | 25 % svensk moms                                                             |
| Annat EU-land med momsnummer | 0 %, omvänd skattskyldighet (art. 44 och 196, direktiv 2006/112/EG) på raden |
| Annat EU-land utan momsnr    | 25 % svensk moms och en varning om att momsnumret saknas                     |
| Utanför EU                   | 0 %, tjänsten omsätts utanför EU (art. 44, direktiv 2006/112/EG)             |

Momsnumret valideras bara till formen (4–20 bokstäver och siffror). Kontrollera det i EU:s VIES innan första
fakturan till en EU-kund. Reglerna gäller företagskunder (B2B); privatpersoner stöds inte.

## Fakturering

Inget dras eller faktureras automatiskt. Plattformen visar ett **underlag** per månad och kund (utskrivbart som PDF
via webbläsarens utskrift) och en CSV (svenskt Excel-format, en rad per kund och valuta) att fakturera från i
bokföringsprogrammet. Innevarande månad är preliminär.

### Stripe senare (inte byggt)

1. Skapa en Stripe-kund per organisation (spara `stripe_customer_id` i `private.subscription_customers`).
2. Ett månadsjobb (`/api/cron/...`, som de andra) räknar underlaget för förra månaden med `invoiceBasis` och
   skapar en Stripe-faktura med raderna (eller rapporterar automatdagar som "metered usage" på ett pris per
   automat och dag), med Stripe Tax eller momsen ovan.
3. En webhook (`invoice.paid`, `invoice.payment_failed`) uppdaterar en ny tabell med fakturastatus; plattformen
   visar betalt/obetalt. Nycklarna läggs i Vercel, aldrig i koden.
