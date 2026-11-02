# Binderlab: datamodell v2

Status: godkänd. Migreringarna finns i `supabase/migrations`; förfiningar som gjordes när de skrevs står sist i dokumentet.
v2 bygger på beställarens svar (2 nov. 2026), uppgifter om Awish och en adversariell granskning. 33 av 50 föreslagna ändringar behölls.

## Beslut från beställaren

| Fråga                           | Beslut                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Moms                            | Ingen moms. `vat_rate_bp = 0` som inställning. Beräkningarna hanterar moms men värdet är 0.                                                                                                                                                                                                      |
| Butiksprovision                 | Räknas alltid på belopp exkl. moms (= betalt belopp, eftersom momsen är 0).                                                                                                                                                                                                                      |
| Kortavgift                      | Ingår inte i beräkningarna nu. Inställningen finns med värdet 0.                                                                                                                                                                                                                                 |
| Tidszon i källan                | Troligen Asia/Shanghai (Awish-konfigurationen). Inställning per datakälla (`source_timezone`), verifieras mot order 42780 som betalades 1 nov. 17:17 svensk tid: Shanghai visar 2 nov. 00:17, UTC visar 1 nov. 16:17. Importens förhandsvisning visar alltid tolkad svensk tid för första raden. |
| Ändrade eller återbetalda order | Förekommer inte. En importerad order ändras aldrig. Om en ny källrad avviker loggas en konflikt.                                                                                                                                                                                                 |
| Pack per order                  | Alltid 1. Varje order är ett pack.                                                                                                                                                                                                                                                               |
| Låsning av perioder             | Månadsstängning (se Perioder).                                                                                                                                                                                                                                                                   |
| Användare                       | Två från start: ägaren och delägaren (inbjuden, rollen läsare).                                                                                                                                                                                                                                  |

## Grundval

- **Postgres via Supabase och Drizzle.** Migreringarna är SQL, med RLS-policyer i samma fil som tabellen.
- **Flera organisationer från dag ett.** Alla datatabeller har `organization_id uuid not null`.
  - FK:er mellan datatabeller är **sammansatta**: `(organization_id, x_id)` refererar `(organization_id, id)`. Varje tabell har därför `unique (organization_id, id)`.
  - Valfria referenser använder `on delete set null (x_id)` med kolumnlista, så att `organization_id` aldrig nollas.
- **`organization_id` kan inte ändras.** Triggern `private.forbid_org_change()` sitter på varje tabell och gäller även service role.
- **RLS på alla tabeller.** Policyerna skrivs `to authenticated` och anropar `(select auth.uid())`.
  - Grants för `anon` återkallas i hela schemat, även som standard för framtida tabeller.
- **Schemat `private`** (exponeras inte via API) innehåller hjälpfunktionerna. Varje `security definer`-funktion har:
  - `set search_path = ''` och fullt kvalificerade namn
  - `revoke` från public/anon och `grant` endast till `authenticated`
- **`private.has_role(org, variadic roles)`** läser `memberships`. Policyer på `memberships` anropar bara `has_role` och aldrig en underfråga mot samma tabell, så att ingen rekursion uppstår.
- **Belopp** lagras i öre som `bigint` (`*_ore`). **Procentsatser** lagras i baspunkter som `integer` (`*_bp`). Flyttal förekommer aldrig.
- **Tider** lagras som `timestamptz` (UTC). **Affärsdatum** lagras som `date` i organisationens tidszon (`organizations.timezone`, standard `Europe/Stockholm`).
  - Varje order sparar dessutom `business_date` vid import, så att dygnsgränser, priser och perioder alltid räknas på svenskt datum.
- **Ingen hård radering av ekonomiska data** (bokföringslagen, 7 år). Raderna arkiveras med `archived_at`, `delete` är spärrat med RLS och trigger, och de gallras först efter 7 år.
- **Append-only** gäller `stock_events`, `audit_log`, `import_rows` och `report_deliveries`. Fel rättas med nya rader.
- **Personuppgifter (GDPR).** Kolumner som pekar på en aktör (`created_by`, `performed_by`, `actor_id`) har `on delete set null` mot `auth.users`.
  - En raderad användare ersätts av "Borttagen användare", men händelsen finns kvar.
  - `profiles` anonymiseras.

## Roller och åtkomst

| Roll       | Läsa                                        | Skriva                                                                                                     |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `owner`    | allt                                        | allt, inklusive roller, ägarandelar, öppning av stängd månad och arkivering av organisationen              |
| `admin`    | allt                                        | allt utom ägarroll, ägarandelar och öppning av stängd månad                                                |
| `refiller` | **endast tillåtna tabeller** (nedan)        | lagerhändelser av typerna påfyllning, inventering, svinn och flytt, alltid med `performed_by = auth.uid()` |
| `viewer`   | allt utom inbjudningar och medlemshantering | inget                                                                                                      |

**Påfyllaren styrs av en lista över vad som är tillåtet, inte vad som är förbjudet.** Läsrätten gäller `organizations`, egen profil och eget medlemskap, `stores` (namn, adress, kontakt), `machines`, `machine_placements`, `titles`, `title_aliases`, `stock_locations`, `stock_events` och vyn `stock_levels`. Policyn för alla andra tabeller är `has_role(org, 'owner', 'admin', 'viewer')`. En ny tabell blir alltså aldrig synlig för påfyllaren av misstag.

**Försäljning i lagret utan att belopp läcker:** en trigger på `orders` skriver en `stock_events`-rad (`kind = 'sale'`, antal 1) med bara titel, automat, antal och dag. Påfyllaren ser alltså hur mycket som sålts, men aldrig belopp. Alla vyer har `security_invoker = true`.

**Medlemskap:**

- Rollen kan inte höjas förbi den egna. En admin kan inte skapa en ägare.
- En trigger ser till att det alltid finns minst en ägare.

**Inbjudningar:**

- Inbjudan är bunden till e-postadressen och gäller en gång.
- Bara `token_hash` sparas.
- Den accepteras via en atomisk RPC som kontrollerar att e-posten stämmer, att inbjudan inte har gått ut och att den inte redan använts.

Behörigheten kontrolleras **både** i serverkoden (`requireRole()` i varje server action) och i databasen (RLS).

## Tabeller per område

### 1. Organisation och åtkomst

- **organizations**: namn, `slug`, `timezone`, `currency = 'SEK'`, `plan`, `machine_limit` (inför fler operatörer), `archived_at`
- **profiles**: `user_id`, visningsnamn, `anonymized_at`
- **memberships**: `user_id`, `role`; unik (org, user)
- **invitations**: `email`, `role`, `token_hash`, `expires_at`, `accepted_at`, `accepted_by`, `invited_by`

### 2. Platser och avtal

- **stores**: namn, adress, kontaktperson, e-post, telefon, `is_example`, `archived_at`
- **store_agreements**: `store_id`, `valid_from`, `valid_to`, `commission_bp` (null), `monthly_rent_ore` (null), `commission_base = 'net_excl_vat'`, `rent_proration = 'daily'`. Minst en av provision och hyra måste vara satt, och perioderna får inte överlappa (exclusion constraint). Kopplas till `contracts` i fas 9.
- **machines**: kod (BL-001), namn, `serial`, `active_from`, `active_to`, `is_example`
- **machine_placements** _(ny)_: `machine_id`, `store_id`, `from`, `to`. Placeringen versioneras, så att en automat kan flytta mellan butiker utan att historiken ändras. Perioderna får inte överlappa.
- **machine_investments**: `machine_id`, `kind` (`purchase`, `installation`, `other`), `amount_ore`, `date`, `depreciation_months` (för enhetsekonomi och återbetalningstid)

### 3. Titlar och priser

- **titles**: kanoniskt namn, serie, `merged_into_id` (null), `archived_at`
- **title_aliases**: `title_id`, `alias` (originalstavningen), `alias_normalized`; unik (org, alias_normalized)
- **purchase_prices**: `title_id`, `unit_cost_ore` (inköp per order), `valid_from`; unik (org, title, valid_from). Det pris som gäller är det senaste med `valid_from <= order.business_date`.

**Sammanslagning av titlar:**

- Varken alias eller `orders.raw_title` skrivs om.
- `orders.title_id` uppdateras i en transaktion som loggas i `audit_log`. Lagerhändelserna av typen `sale` följer med via en trigger.
- Den gamla titeln får `merged_into_id` och arkiveras. Rapporter som redan skickats använder sin sparade ögonblicksbild.

### 4. Datakällor och import (adapter)

- **data_sources**: `provider` (`awish_grpc`, `awish_web`, `awish_csv`, …), namn, `source_timezone`, `config jsonb` (kolumnmappning, merchant-id), `secret_ref` (namn på hemlighet i Supabase Vault, aldrig själva värdet), `cursor` (senast hämtade), `last_synced_at`, `status`
- **source_machines** _(ny)_: `data_source_id`, `external_id` (Awish ID), `external_device_no`, `external_name` ("Order Machine"), `machine_id`. Kopplingen mellan Awish-automat och vår automat. Okända automater stoppar inte importen: de hamnar i en kö där någon kopplar dem.
- **imports**: `data_source_id`, `trigger` (`upload`, `schedule`, `webhook`), filnamn, `file_sha256`, `storage_path`, `parser_version`, `mapping jsonb`, antal rader totalt, nya, dubbletter, konflikter och fel, `status`, start och slut, `created_by`
- **import_rows**: radnummer, `raw jsonb`, `status` (`new`, `conflict`, `error`), meddelande, `order_id`. **Dubbletter sparas inte rad för rad**, de räknas bara. Annars skulle tabellen växa för varje överlappande export. Rådata gallras efter 24 månader (orderna själva sparas i 7 år).
- **orders**: `data_source_id`, `external_id` (Order No.), `raw_title` (ändras aldrig), `title_id`, `ordered_at` (UTC), `business_date`, `amount_ore`, `payment_method`, `source_machine_id`, `machine_id`, `import_id`, `source_hash`
  - **Unik (organization_id, data_source_id, external_id).** Importen kör `insert … on conflict do nothing`.
  - Om källraden avviker från den sparade (`source_hash` skiljer sig) blir raden `conflict` i loggen. Ordern ändras inte.
  - Bara betalda order importeras (`Is Paid = Paid Success`).
- **Samtidighet:** en advisory lock per datakälla gör att två importer mot samma källa aldrig körs parallellt. Laddas samma fil upp igen (samma `file_sha256`) varnar systemet innan något körs.

### 5. Lager

- **stock_locations**: `kind` (`warehouse` eller `machine`), `machine_id` (null), namn
- **stock_events** (append-only): `location_id`, `title_id`, `kind` (`refill`, `count`, `sale`, `waste`, `adjustment`, `transfer_in`, `transfer_out`, `receipt`), `quantity` (förändring, eller räknat antal vid `count`), `occurred_at`, `business_date`, `performed_by`, `order_id` (vid `sale`), `transfer_group_id`, notering
- **stock_levels** (vy, `security_invoker`): senaste inventering plus alla händelser efter den. Ett saldo som lagras separat kan glida isär från händelserna, så det finns inget sådant. `warehouse_stock` blir samma vy filtrerad på centrallagret.

### 6. Inköp

- **suppliers**: namn, kontakt, e-post, `default_lead_time_days`
- **supplier_items** _(ny)_: `supplier_id`, `title_id`, `pack_size` (pack per box), `min_order_qty`, `lead_time_days`, `unit_cost_ore`. Behövs för inköpsplaneringen.
- **purchase_orders**: `supplier_id`, `status` (`draft`, `ordered`, `partially_received`, `received`, `cancelled`), beställd, förväntad, mottagen
- **purchase_order_lines**: `title_id`, antal, `unit_cost_ore`, mottaget antal. Mottagningen skapar en lagerhändelse av typen `receipt` i centrallagret.

### 7. Mål och utgångsläge

- **goals**: `scope` (`organization`, `store`, `machine`), `scope_id`, `month`, `metric` (`revenue`, `profit`, `active_machines`), `target`; unik (org, scope, scope_id, month, metric)
- **baselines**: `scope`, `scope_id`, `metric` (`profit_per_machine_month`, `stockout_days_month`, `refill_hours_month`, `admin_hours_month`), `value`, `unit`, mätperiod, källa; unik (org, scope, scope_id, metric)

### 8. Perioder

- **period_closes** _(ny)_: `month`, `closed_at`, `closed_by`, `reopened_at`, `reopened_by`, `snapshot jsonb`
  - När en månad har stängts stoppas ändringar som påverkar den: inköpspriser med `valid_from` i månaden, lagerjusteringar och nya avtal.
  - Order som importeras sent till en stängd månad sparas, men flaggas och syns i nästa rapport.
  - Bara ägaren kan öppna en stängd månad, och det loggas.

### 9. Rapporter

- **report_recipients**: namn, e-post, `kind` (`store`, `accountant`, `partner`), `store_id` (null), aktiv
- **reports**: `kind`, period, `storage_path` (PDF), `generated_by`, `generated_at`, `data_snapshot jsonb`, `calc_version`. Rapporten kan återskapas exakt.
- **report_deliveries** (append-only): `report_id`, `recipient_id`, `sent_at`, `status`, `provider_message_id`, fel

### 10. Inställningar och ägande

- **organization_settings**: `vat_rate_bp = 0`, `card_fee_bp = 0`, `fiscal_year_start_month = 1`
- **owner_shares**: `member_user_id` eller namn, `share_bp`, `valid_from`. Andelarna ska summera till 10 000. Vid fördelning går öresavrundningen till den största andelen, så att summan stämmer exakt.
- **ledger_accounts**: nyckel (`sales`, `store_commission`, `rent`, `cogs`, …), BAS-konto och namn

### 11. Senare faser (tabellerna skapas nu men står tomma)

- **alerts** (fas 8): typ, allvar, mål, utlöst, kvitterad av och när
- **incidents** (fas 8): automat, typ, start, slut, beskrivning, åtgärd
- **contracts** (fas 9): butik, giltighet, uppsägning, `storage_path`

### 12. Ändringslogg

- **audit_log**: `table_name`, `row_id`, `action`, `actor_id`, `occurred_at`, `before`, `after`
  - Den skrivs bara av triggern `private.audit()` (security definer). Ingen roll har grants för att skriva, uppdatera eller radera.
  - Läsrätt har ägare, admin och läsare.
  - Den loggar: `purchase_prices`, `stock_events`, `store_agreements`, `machine_placements`, `organization_settings`, `owner_shares`, `ledger_accounts`, `memberships`, `invitations`, `title_aliases`, `titles` (vid sammanslagning), `report_deliveries` och `period_closes`.

### Lagring av filer

- Två privata buckets: `imports` för källfiler och `reports` för PDF:er.
- Sökvägarna börjar med `{organization_id}/`. Storage-policyerna kontrollerar `has_role` mot den delen av sökvägen.
- Påfyllaren har ingen åtkomst till någon av dem.

## Hämtning från Awish

Adaptergränssnittet: `SourceAdapter.fetch(cursor) → { orders: RawOrder[], machines: RawMachine[], nextCursor }`. Allt efter adaptern är gemensamt: koppling av automater och titlar, deduplicering, logg och lagerhändelser. Så blir de olika källorna:

1. **`awish_grpc` (målet).** Awish erbjuder ett gRPC-API med läsbehörighet via app-ID.
   - Det körs som ett schemalagt jobb på servern var 10:e minut, utan webbläsare och utan tillägg.
   - Det kräver följande från Awish: .proto-filerna, hur token beräknas, TLS-inställningar, det tredje metadatafältet och webhook-dokumentation.
   - När webhooks finns läggs `trigger = 'webhook'` till för hämtning i realtid.
2. **`awish_csv` (nu).** Uppladdning på sidan Datakällor, med förhandsvisning, kolumnmappning, kontroll av dubbletter och logg.
   - Kolumnerna mappas från Awish orderlista: Order No. → `external_id`, Name → titel, Order Machine → automat, Order Amount → belopp, Payment Time → tid, Is Paid → filter.
3. **`awish_web` (reserv, inte beslutad).** Serverhämtning av samma orderlista som panelen visar. Tas bara fram om gRPC dröjer, eftersom det är skörare.

## Beräkningslager (`src/domain/`, rena funktioner med tester)

All indata är vanliga objekt. Belopp anges i öre. Avrundning sker på ett enda ställe: halva öre avrundas uppåt per rad, sedan summeras öre.

Funktionerna:

- `revenue`, `orderCount`, `averageOrderValue`
- `costOfGoods`, med det pris som gällde `business_date`. Den rapporterar också **täckning**: hur många order som saknar pris.
- `storeCompensation`: provision på belopp exkl. moms, hyra per dag vid delmånad, med de villkor och den placering som gällde varje dag.
- `vat` (0 i dag), `cardFees` (0 i dag)
- `profit`, `margin`
- `salesVelocity` (pack per dag, glidande), `daysOfStockLeft`
- `unitEconomics` (per automat: täckningsbidrag, avskrivning, återbetalningstid)
- `allocateToOwners`

## Öppna punkter som inte stoppar migreringarna

1. **Awish:** gRPC-specifikation och token-beräkning. Tills dess körs CSV.
2. **Källans tidszon:** Asia/Shanghai verifieras mot order 42780 vid första riktiga importen.

## Förfiningar i migreringarna (2 nov. 2026)

Migreringarna följer v2. Följande preciserades eller ändrades när SQL:en skrevs. Katalogtesterna i `test/db/` håller reglerna.

**Åtkomst**

- Policyerna använder `private.orgs_with_role(roller…)` i formen `organization_id = any (array(select …))`. Postgres räknar ut den en gång per fråga och kan använda index. `has_role` per rad var ungefär 60 gånger långsammare (1,1 s mot 17 ms på 200 000 order). `has_role` finns kvar för RPC:er och storage. Båda är `security definer` och läser `memberships` utan RLS, så ingen rekursion uppstår.
- Läsaren och påfyllaren kan inte lämna organisationen själva. Bara ägare och admin tar bort medlemskap.
- Kolumnrättigheter: klienter får bara uppdatera vissa kolumner. Exempel: `orders` bara `title_id` och `machine_id`, `titles` inte `merged_into_id` (bara via `merge_titles`), `reports` bara `storage_path`. `invitations` och `period_closes` skrivs bara via RPC.
- Inga klientroller har `truncate`, `references` eller `trigger` på någon tabell. `audit_log` saknar skrivrättigheter även för `service_role`.
- Storage: klienter kan ladda upp och läsa, men inte skriva över eller radera filer (de är underlag).
- Medlemskap skapas bara via `create_organization` och `accept_invitation`. En klient kan inte lägga in någon direkt i `memberships`, inte heller ägaren, eftersom det saknar samtycke.
- När någon nedgraderas eller tas bort löper hens obesvarade inbjudningar som hen inte längre får skapa ut. En admin som bjuder in en adress igen rör inte en ägares ägarinbjudan.
- `profiles.user_id` och `stock_events.performed_by` måste vara medlemmar i organisationen (BL020).

**Datum och tid**

- Datumintervall (`valid_from`, `valid_to`) är **inklusiva**: `valid_to` är sista giltiga dagen, null betyder tills vidare.
- `business_date` räknas fram av databasen från `ordered_at`/`occurred_at` i organisationens tidszon. Om värdet anges kontrolleras det.
- Vyn `purchase_price_periods` (ny) ger varje inköpspris med `valid_to` (dagen före nästa pris).

**Order och lager**

- En order ändras aldrig, med två undantag. `title_id` kan sättas eller flyttas men aldrig tas bort. `machine_id` kan bara sättas när den saknas. När en källautomat kopplas (`source_machines.machine_id`) får dess order automaten automatiskt.
- `orders.late_in_closed_period` (ny) flaggar order som importerats till en redan stängd månad.
- `stock_events.seq` ger en entydig ordning för händelser med samma tid. Den räknas **per organisation** med en egen sekvens i schemat `private` och sätts alltid av databasen. En global räknare skulle låta en organisation räkna andras lagerhändelser via glappet mellan två egna.
- Kontroller per typ av lagerhändelse:
  - `sale` har alltid `quantity = −1` och `order_id`.
  - `count` har ett antal ≥ 0.
  - In-typer är positiva och ut-typer negativa.
  - En flytt (`transfer_out` + `transfer_in` med samma `transfer_group_id`) måste gå jämnt ut, vilket kontrolleras vid commit.
- `stock_locations.is_central` (ny) markerar centrallagret, exakt ett per organisation. Varje automat får en lagerplats automatiskt.
- **Sammanslagning av titlar:**
  - Försäljningshändelsens `title_id` följer orderns titel genom ett kontrollerat undantag i append-only-regeln. Det gäller bara inne i en trigger (aldrig direkt, inte ens för databasägaren), bara kolumnen `title_id` och bara till det värde ordern har. Ändringen loggas.
  - Lager av den gamla titeln som inte kommer från försäljning flyttas med kompenserande `adjustment`-händelser, så att totalsaldot per lagerplats blir exakt oförändrat.
  - Varför: invarianten "en försäljningshändelse per order, med orderns titel" gäller fortfarande, och saldon och försäljningsstatistik kräver ingen nettning.
- `machine_investments.date` heter `invested_on`.
- `goals` och `baselines` har `store_id` och `machine_id` med sammansatta FK:er i stället för ett polymorft `scope_id`, så att korsreferenser mellan organisationer stoppas av databasen. `baselines.value` är ett heltal i `unit` (`ore`, `days`, `minutes` eller `count`).

**Perioder**

- Påverkade dagar räknas exakt:
  - Ett inköpspris gäller fram till nästa pris för titeln. Därför spärras också ett nytt pris i en öppen månad om det skulle gälla in i en stängd.
  - För avtal och placeringar räknas bara de dagar som faktiskt ändras. Ett tillsvidareavtal kan alltså avslutas efter en stängd månad.
- `machine_placements` spärras också, eftersom placeringen avgör butiksersättningen.
- En rad per stängning. Öppning sätter `reopened_at`, och en ny stängning blir en ny rad, så historiken finns kvar.
- Ägare och admin kan stänga, bara ägaren kan öppna. Innevarande månad kan inte stängas.
- `snapshot.database` sparar antal order, intäkt, inköp och prisets täckning. Appens beräkning sparas under `snapshot.app`.

**Övrigt**

- Tabeller som är append-only saknar `updated_at`. `audit_log` har `occurred_at` och `actor_id` i stället för `created_*`.
- Ändringsloggen hoppar över uppdateringar utan effekt och det som bara är anonymisering (GDPR).
- `invitations.token_hash` loggas aldrig. En ny inbjudan till samma adress gör den äldre ogiltig. En inbjudan gäller 7 dagar (1–30).
- `owner_shares.holder_name` är obligatoriskt, eftersom `member_user_id` nollas om användaren raderas. Summan 10 000 per `valid_from` kontrolleras vid commit.
- `report_deliveries.email` sparar adressen vid utskicket.
- `organizations.machine_limit` gäller vid nya automater.
- Radering:
  - Ekonomiska tabeller har dessutom en trigger som stoppar `delete` för alla roller.
  - Följande kan raderas: medlemskap, obesvarade inbjudningar, alias, leverantörsartiklar, mål, utgångslägen, rapportmottagare och konton.
  - Gallring körs som systemroll med `binderlab.allow_purge = 'on'` i transaktionen.
- Felkoder från databasen (`BL001`–`BL020`) står i den första migreringen.

**Härdning efter röd granskning (2 nov. 2026)**

- Kontroller som läser organisationens data (stängda månader, automatgräns) är AFTER-triggers och körs alltså först när RLS har godkänt raden. BEFORE-triggers som måste räkna fram värden (`orders.business_date`, `stock_events.business_date` och `seq`) har en spärr före sig (`t05_rls_gate`) som nekar med samma kod och text som RLS. Utan det avslöjade felkoderna en annan organisations stängda månader, automatgräns och tidszon.
- Kontroller som jämför användar-id (`A05_…`) körs före FK-kontrollerna, så att felkoden inte avslöjar om ett id finns.
- `organization_id` saknar planerarstatistik (`set statistics 0`) i alla tabeller. Annars kunde estimatet (PostgREST `Prefer: count=planned`) visa ungefär hur många rader en annan organisation har.
- Inga klientroller har rättigheter på sekvenser.
- Sökvägar till filer (`storage_path` och storage-policyerna) måste vara `{organization_id}/segment/…/fil`, där varje segment börjar med en bokstav, en siffra, `_` eller `-`. `.`, `..`, tomma segment, `\`, `%` och mellanslag nekas. Servern ger filerna egna namn.
- `data_sources.secret_ref` måste ligga i organisationens namnrymd: `{organization_id}/namn`. Importjobbet ska kontrollera samma sak innan det läser Vault.
- Tidszonen kan inte ändras av en klient när organisationen har stängda månader (BL004).
- Sista ägaren skyddas även under REPEATABLE READ: den andra transaktionen får 40001.

**Känd begränsning:** `organization_settings` (moms och kortavgift) är inte tidsversionerad. En ändring slår igenom bakåt i tiden utom för stängda månader, som har sin ögonblicksbild.
