# Binderlab: datamodell v2

Status: förslag för godkännande. Inga migreringar är skrivna.
v2 bygger på beställarens svar (2 nov. 2026), uppgifter om Awish och en adversariell granskning. 33 av 50 föreslagna ändringar behölls.

## Beslut från beställaren

| Fråga | Beslut |
|---|---|
| Moms | Ingen moms. `vat_rate_bp = 0` som inställning. Beräkningarna hanterar moms men värdet är 0. |
| Butiksprovision | Räknas alltid på belopp exkl. moms (= betalt belopp, eftersom momsen är 0). |
| Kortavgift | Ingår inte i beräkningarna nu. Inställningen finns med värdet 0. |
| Tidszon i källan | Troligen Asia/Shanghai (Awish-konfigurationen). Inställning per datakälla (`source_timezone`), verifieras mot order 42780 som betalades 1 nov. 17:17 svensk tid: Shanghai visar 2 nov. 00:17, UTC visar 1 nov. 16:17. Importens förhandsvisning visar alltid tolkad svensk tid för första raden. |
| Ändrade eller återbetalda order | Förekommer inte. En importerad order ändras aldrig. Om en ny källrad avviker loggas en konflikt. |
| Pack per order | Alltid 1. Varje order är ett pack. |
| Låsning av perioder | Månadsstängning (se Perioder). |
| Användare | Två från start: ägaren och delägaren (inbjuden, rollen läsare). |

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

| Roll | Läsa | Skriva |
|---|---|---|
| `owner` | allt | allt, inklusive roller, ägarandelar, öppning av stängd månad och arkivering av organisationen |
| `admin` | allt | allt utom ägarroll, ägarandelar och öppning av stängd månad |
| `refiller` | **endast tillåtna tabeller** (nedan) | lagerhändelser av typerna påfyllning, inventering, svinn och flytt, alltid med `performed_by = auth.uid()` |
| `viewer` | allt utom inbjudningar och medlemshantering | inget |

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
- **machine_placements** *(ny)*: `machine_id`, `store_id`, `from`, `to`. Placeringen versioneras, så att en automat kan flytta mellan butiker utan att historiken ändras. Perioderna får inte överlappa.
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
- **source_machines** *(ny)*: `data_source_id`, `external_id` (Awish ID), `external_device_no`, `external_name` ("Order Machine"), `machine_id`. Kopplingen mellan Awish-automat och vår automat. Okända automater stoppar inte importen: de hamnar i en kö där någon kopplar dem.
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
- **supplier_items** *(ny)*: `supplier_id`, `title_id`, `pack_size` (pack per box), `min_order_qty`, `lead_time_days`, `unit_cost_ore`. Behövs för inköpsplaneringen.
- **purchase_orders**: `supplier_id`, `status` (`draft`, `ordered`, `partially_received`, `received`, `cancelled`), beställd, förväntad, mottagen
- **purchase_order_lines**: `title_id`, antal, `unit_cost_ore`, mottaget antal. Mottagningen skapar en lagerhändelse av typen `receipt` i centrallagret.

### 7. Mål och utgångsläge
- **goals**: `scope` (`organization`, `store`, `machine`), `scope_id`, `month`, `metric` (`revenue`, `profit`, `active_machines`), `target`; unik (org, scope, scope_id, month, metric)
- **baselines**: `scope`, `scope_id`, `metric` (`profit_per_machine_month`, `stockout_days_month`, `refill_hours_month`, `admin_hours_month`), `value`, `unit`, mätperiod, källa; unik (org, scope, scope_id, metric)

### 8. Perioder
- **period_closes** *(ny)*: `month`, `closed_at`, `closed_by`, `reopened_at`, `reopened_by`, `snapshot jsonb`
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
