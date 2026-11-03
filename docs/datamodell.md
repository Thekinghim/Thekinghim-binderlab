# Binderlab: datamodell v2

Status: godkänd. Migreringarna finns i `supabase/migrations`; förfiningar som gjordes när de skrevs står sist i dokumentet.
v2 bygger på beställarens svar (2 nov. 2026), uppgifter om Awish och en adversariell granskning. 33 av 50 föreslagna ändringar behölls.

Läget efter fas 2–11: 63 tabeller och 3 vyer i schemat `public`, 23 RPC:er i `public` och 76 hjälpfunktioner i
`private` (räknat 2 nov. 2026 i en nyskapad databas efter `npm run db:reset` med alla 50 migreringar till och med
`20261102201500`, och i `binderlab_dev` efter `npm run db:migrate`). Sex av RPC:erna kommer från grundmigreringen
(tabellen nedan), sjutton från fas 2–11. Grundmodellen beskrivs i avsnitten nedan;
allt som tillkommit efter grundmigreringarna står i [Tabeller och funktioner som tillkommit i fas 2–11](#tabeller-och-funktioner-som-tillkommit-i-fas-211),
en tabell per område. Arkitekturen och säkerhetsmodellen i sin helhet står i `docs/architecture.md`.

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

### 11. Senare faser (skapades tomma i grundmigreringen, används sedan fas 8 och 9)

- **alerts** (fas 8): typ, allvar, mål, utlöst, kvitterad av och när. Utökad med incidentens tillstånd, se "Fas 8" nedan.
- **incidents** (fas 8): automat, typ, start, slut, beskrivning, åtgärd. Utökad till kundärenden med återbetalning, se "Fas 8".
- **contracts** (fas 9): butik, giltighet, uppsägning, `storage_path`. Utökad med villkor, uppsägningstid och avtalsfil, se översikten.

### 12. Ändringslogg

- **audit_log**: `table_name`, `row_id`, `action`, `actor_id`, `occurred_at`, `before`, `after`
  - Den skrivs bara av triggern `private.audit()` (security definer). Ingen roll har grants för att skriva, uppdatera eller radera.
  - Läsrätt har ägare, admin och läsare.
  - Den loggar: `purchase_prices`, `stock_events`, `store_agreements`, `machine_placements`, `organization_settings`, `owner_shares`, `ledger_accounts`, `memberships`, `invitations`, `title_aliases`, `titles` (vid sammanslagning), `report_deliveries` och `period_closes`.

### Lagring av filer

- Två privata buckets: `imports` för källfiler och `reports` för PDF:er.
- Sökvägarna börjar med `{organization_id}/`. Storage-policyerna kontrollerar `has_role` mot den delen av sökvägen.
- Påfyllaren har ingen åtkomst till någon av dem.

## Tabeller och funktioner som tillkommit i fas 2–11

Allt nedan ligger i egna migreringar efter grundmigreringarna (`20261102100000`–`20261102101200`). Samma regler gäller
som för grundmodellen: `organization_id` i varje rad med sammansatta FK:er, RLS `to authenticated` via
`private.orgs_with_role`, `set statistics 0` på `organization_id`, ändringslogg via `private.audit()` där det står
"audit", och påfyllaren ser bara det som uttryckligen står i kolumnen Roller. Ord i kolumnen Roller: **Ä** ägare,
**A** admin, **L** läsare, **P** påfyllare, **B** butiksrollen. "Läs Ä/A/L, skriv Ä/A" är standard och skrivs bara
ut när det avviker.

### RPC:er från grundmigreringen

Alla i `20261102101000_rpc.sql`: security definer med `search_path = ''`, behörigheten (`private.has_role`) kontrolleras
först, och bara `authenticated` får köra dem.

| Funktion                                              | Innehåll och regler                                                                                                                                                                                              | Roller   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `create_organization(name, slug)`                     | Skapar organisationen, ägarmedlemskapet, inställningarna, centrallagret och ägarens profil i en transaktion. Nekar butikskonton (`…181500`). Kom igång använder `create_first_organization`.                     | inloggad |
| `create_invitation(org, email, role, valid_days = 7)` | Returnerar token i klartext en gång; bara sha256-hashen sparas. 1–30 dagar. Tidigare obesvarade inbjudningar till samma adress löper ut. Bara en ägare kan bjuda in en ägare. BL014 om personen redan är medlem. | Ä/A      |
| `accept_invitation(token)`                            | Låser inbjudan och kontrollerar e-post mot JWT, giltighet och att den inte använts (BL010–BL014). Skapar medlemskap och profil. Ny version för butiksrollen i `…130100`.                                         | inloggad |
| `close_period(org, month, snapshot)`                  | Månadsstängning: bara passerade månader (BL015 om redan stängd). Databasen sparar en egen sammanfattning (antal, intäkt, inköp, prisets täckning); appens beräkning sparas under `app`.                          | Ä/A      |
| `reopen_period(org, month)`                           | Öppnar en stängd månad igen (BL016 om den inte är stängd). Loggas i `audit_log`.                                                                                                                                 | Ä        |
| `merge_titles(org, from, into)`                       | Flyttar `orders.title_id` (varje ändring loggas), lagret med kompenserande `adjustment`; den gamla titeln får `merged_into_id` och arkiveras. Alias och `raw_title` skrivs inte om.                              | Ä/A      |

### Organisation, användare och onboarding

| Tabell eller funktion                          | Migrering                                                                      | Innehåll och regler                                                                                                                                                                                                       | Roller                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `list_members(org)` (RPC)                      | `20261102112957_anvandare_list_members.sql`                                    | Medlemslistan med e-post för Inställningar → Användare (`auth.users` är stängd för klienter). Inte i arkiverad organisation. Rolländring och borttagning går mot `memberships`.                                           | Ä/A                        |
| `memberships.store_id`, `invitations.store_id` | `20261102130100_portal_store_access.sql`                                       | Butiken för rollen `store` (check: krävs för `store`, förbjuden annars).                                                                                                                                                  | –                          |
| Rollen `store` i `member_role`                 | `20261102130000_portal_store_role.sql`                                         | Egen fil: ett nytt enumvärde kan inte användas i samma transaktion. Ingen policy i appens tabeller nämner rollen.                                                                                                         | B                          |
| `create_first_organization(name, slug)` (RPC)  | `20261102181500_onboarding_create_first_organization.sql`                      | Kom igång: skapar första organisationen. Lås per användare (`pg_advisory_xact_lock`); BL060 om kontot redan är med i en organisation, BL061 om det är ett butikskonto. `create_organization` nekar nu också butikskonton. | inloggad utan organisation |
| `private.purge_allowed()`                      | `20261102193000_hardening_purge_owner_only.sql`                                | Gallring (radering av ekonomiska rader) bara som databasägaren `postgres` med `binderlab.allow_purge = 'on'`. `service_role` kan inte gallra.                                                                             | –                          |
| Statistikskydd                                 | `20261102160000_hardening_org_statistics.sql`                                  | `set statistics 0` på `organization_id` i alla tabeller som saknade det (planerarens estimat kunde annars avslöja andra organisationers radantal).                                                                        | –                          |
| Ändringslogg för stamdata                      | `…101432_datakallor_audit`, `…101439_butiker_audit`, `…131337_automater_audit` | `data_sources` (utan synkmarkören), `source_machines` (bara ändringar), `stores`, `report_recipients` (även radering) och `machines` loggas i `audit_log`.                                                                | –                          |

### Datakällor och import

| Tabell eller funktion       | Migrering                                            | Innehåll och regler                                                                                                                                                                                             | Roller                              |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `import_uploads`            | `20261102133644_datakallor_import_uploads.sql`       | En rad per uppladdning: filnamn, `size_bytes`, `received_bytes`, `next_index`. Tillfällig: tas bort efter import, vid Avbryt och när den är äldre än ett dygn (vid användarens nästa uppladdning). Ingen audit. | Ä/A, bara egna rader (`created_by`) |
| `import_upload_chunks`      | samma                                                | Bitarna (768 KiB, `bytea`) i ordning per uppladdning. Ligger i databasen så att alla serverinstanser (och Vercels skrivskyddade disk) fungerar.                                                                 | Ä/A, bara egna rader                |
| Trigramindex på `orders`    | `20261102165000_sok_search_indexes.sql`              | GIN-index `(organization_id, external_id)` och `(organization_id, raw_title)` med `pg_trgm` och `btree_gin`, `gin_pending_list_limit = 256`.                                                                    | –                                   |
| `private.search_orders`     | `20261102165100_sok_search_orders.sql`               | Kommandopalettens ordersökning (`GET /sok`). Security definer, kontrollerar `has_role` (Ä/A/L) först; sökorden blir literaler via `format(%L)`. Anropas från serverkoden (`src/server/search`).                 | Ä/A/L                               |
| `imports.status = 'failed'` | (används från `20261102180000_drift_systemlarm.sql`) | En misslyckad import sparas som en rad med status `failed`; larmregeln `import_failed` läser den.                                                                                                               | –                                   |

### Lager, påfyllning och Att göra

| Tabell eller funktion             | Migrering                                                                             | Innehåll och regler                                                                                                                                                                                                  | Roller                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `todo_dismissals`                 | `20261102113602_att_gora_todo_dismissals.sql`, `…141800_att_gora_dismissal_title.sql` | Avbockad punkt: `todo_key`, genererad kopia `key`, `fingerprint` (orsakens tillstånd), `title` (rubriken när den bockades av, från servern), `dismissed_by/at`. En rad per punkt; ny avbockning skriver över. Audit. | läs Ä/A/L; skriv Ä/A; P läser och skriver bara lagerpunkter (`private.todo_key_is_stock`: `refill:%`, `stale-machine:%`) |
| `register_refill(...)` (RPC)      | `20261102113951_att_gora_register_refill.sql`                                         | Påfyllning: `refill` i automatens lagerplats och, om packen tas från centrallagret, en `adjustment` där i samma transaktion. `performed_by` = den inloggade. Fel 22023 med svensk text.                              | Ä/A/P                                                                                                                    |
| `field_submissions`               | `20261102122143_drift_larm_arenden.sql`                                               | Påfyllning från fältläget med ett id som webbläsaren skapat (`client_id`), kopplad till lagerhändelsen.                                                                                                              | läs Ä/A/L, P bara egna                                                                                                   |
| `register_refill_once(...)` (RPC) | samma                                                                                 | Som `register_refill`, men samma `client_id` igen ger samma lagerhändelse (köade omförsök från PWA:n blir aldrig dubbla).                                                                                            | Ä/A/P                                                                                                                    |
| `lager_performers(org)` (RPC)     | `20261102120412_lager_performers.sql`, `…141131_lager_performers_fallback.sql`        | Visningsnamn för dem som utfört lagerhändelser (profil → metadata i `auth.users` → rollnamn). Inga e-postadresser eller belopp.                                                                                      | Ä/A/L/P                                                                                                                  |
| `lager_slot_periods(org)` (RPC)   | `20261102201500_lager_slot_periods.sql`                                               | Sortimentets perioder (automat, titel, från, till) ur `machine_slots`. Lager räknar en titel vars sista period passerat som utgången: ingen status, ingen påfyllning. Inga antal platser, anteckningar eller belopp. | Ä/A/L/P                                                                                                                  |

### Rapporter

| Tabell eller funktion                        | Migrering                                       | Innehåll och regler                                                                                                                                                                                  | Roller                           |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `report_approvals`                           | `20261102104410_rapporter_report_approvals.sql` | Godkännandet av en rapportversion: `approved_by` (= den inloggade), `approved_at`, `note`. Append-only, en per rapport. Utan godkännande skickas inget.                                              | läs Ä/A/L; skriv Ä/A i eget namn |
| `report_files`                               | `20261102145500_rapporter_review_fixes.sql`     | En rad när PDF:en faktiskt sparats: `kind` (i dag bara `pdf`), `storage_path`, `byte_size`. Append-only, en per rapport och typ. Arkivet visar "PDF finns" utifrån den, inte `reports.storage_path`. | läs Ä/A/L; skriv Ä/A             |
| `private.reports_storage_path_check`         | samma                                           | `reports.storage_path` låst till `{org}/{ÅÅÅÅ-MM}/{id}.pdf`, och en ny rapport får inte återanvända en annans sökväg.                                                                                | –                                |
| `private.report_deliveries_require_approval` | samma                                           | Ett utskick kan bara loggas för en godkänd rapport, även direkt mot databasen.                                                                                                                       | –                                |
| Unik aktiv mottagare                         | `20261102114850_butiker_recipient_unique.sql`   | En adress kan bara vara aktiv mottagare en gång per butik (pausade omfattas inte).                                                                                                                   | –                                |

### Drift, larm och kundärenden

Detaljerna står i avsnittet "Fas 8" nedan.

| Tabell eller funktion             | Migrering                                                              | Innehåll                                                                                                                             | Roller                                                              |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `alerts` (utökad)                 | `20261102122143_drift_larm_arenden.sql`, `…144500`, `…180000`          | Incidentens tillstånd, `alert_group` (`machine`, `stock`, `import`, `sales`, `system`), kvittering.                                  | läs Ä/A/L, P bara `machine` och `stock`; klienter får bara kvittera |
| `incidents` (utökad)              | samma, `…144500_drift_review_fixes.sql`                                | Kundärenden med status, ansvarig (Ä/A), order, titel, återbetalning (`refunded_ore`, `refunded_on`).                                 | Ä/A                                                                 |
| `alert_subscriptions`             | `20261102122143`                                                       | En per användare och organisation: typer, automater, allvar, kanaler, tysta timmar.                                                  | egna rader; P bara för `machine`/`stock`                            |
| `push_subscriptions`              | samma, `…144500` (`private.push_endpoint_allowed`)                     | Web Push per enhet. Endpoint måste vara FCM, Mozilla, Apple eller Windows (SSRF-skydd).                                              | egna rader, Ä/A/L/P                                                 |
| `alert_deliveries`                | `20261102122143`                                                       | Utskickskö och logg per användare och sändtid. Skrivs av larmjobbet.                                                                 | Ä/A alla; L/P bara egna                                             |
| `alert_runs`                      | samma                                                                  | En rad per körning av larmjobbet och organisation (antal, status, `error`).                                                          | läs Ä/A/L                                                           |
| `sales_data_until(org, at)` (RPC) | `…144500_drift_review_fixes.sql`, `…150500_drift_sales_last_order.sql` | Hur långt importerad försäljning räcker per automat (`data_until`, `synced_at`, `last_order_at`). Bara tidpunkter. Security invoker. | Ä/A/L/P och systemet                                                |

### Ekonomi och avtal

| Tabell eller funktion             | Migrering                                                                                             | Innehåll och regler                                                                                                                                                                                                           | Roller                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `payout_imports`                  | `20261102121731_ekonomi_payouts_costs_contracts.sql`                                                  | Varje uppladdad utbetalningsfil (format, sha256, antal nya, dubbletter, konflikter, fel). Append-only.                                                                                                                        | läs Ä/A/L; skriv Ä/A              |
| `payouts`                         | samma, `…142000_ekonomi_review_fixes.sql`                                                             | Utbetalning från leverantören: `reference`, period, `paid_on`, `amount_ore`, `fees_ore`, `refunds_ore`, `source_hash`. Ändras aldrig (bara arkivering med anteckning). Referensen unik bland icke arkiverade. Raderas aldrig. | läs Ä/A/L; skriv Ä/A              |
| `payout_lines`                    | samma                                                                                                 | Leverantörens specifikation per order (`external_id`, `amount_ore`). Append-only.                                                                                                                                             | läs Ä/A/L; skriv Ä/A              |
| `deviation_reviews`               | samma, `…142000`                                                                                      | Utredda (och återöppnade) avvikelser i avstämningen: nyckel, serverns `fingerprint` (krävs), anteckning. Append-only, audit; senaste raden per nyckel gäller.                                                                 | läs Ä/A/L; skriv Ä/A              |
| `fixed_costs`                     | samma                                                                                                 | Fasta kostnader: kategori (`insurance`, `software`, `transport`, `storage`, `other`), belopp, `interval` (`month`, `quarter`, `year`), `starts_on`/`ends_on`, valfri automat. Arkiveras; stängd månad skyddas (BL004). Audit. | läs Ä/A/L; skriv Ä/A              |
| `voucher_deliveries`              | `20261102142000_ekonomi_review_fixes.sql`                                                             | Leveranslogg till bokföringsprogrammet: månad, program, serie, första och sista nummer, filens sha256. Append-only, audit; en månad en gång per program.                                                                      | läs Ä/A/L; skriv Ä/A              |
| `contracts` (utökad)              | `…121731`, `…122607_ekonomi_contract_notice.sql`, `…125306_ekonomi_contract_file_rule.sql`, `…142000` | Rubrik, villkor, `renewal_months`, `notice_period_months`, `terminated_on`, filens namn, typ (PDF, PNG, JPEG, Word), storlek och sha256. Filkolumnerna sätts bara via `attach_contract_file`. Audit.                          | läs Ä/A/L; skriv Ä/A              |
| `attach_contract_file(...)` (RPC) | `20261102142000_ekonomi_review_fixes.sql`                                                             | Bifogar avtalsfilen efter att servern kontrollerat innehållet; sökvägen måste vara `{org}/{avtal}/{sha256}.{ändelse}`.                                                                                                        | Ä/A                               |
| `store_agreements.contract_id`    | `…121731`                                                                                             | Villkoren kopplas till ett avtal för samma butik (BL041); avtalets butik kan inte bytas när villkor är kopplade.                                                                                                              | –                                 |
| Kontot `bank` (BAS 1930)          | `…142000`                                                                                             | Läggs in i organisationer som har en kontoplan men saknar det (verifikation per utbetalning).                                                                                                                                 | –                                 |
| Bucket `contracts`                | `…121731`                                                                                             | Privat, samma policymönster som `imports` och `reports`. Klienter laddar upp och läser, men skriver inte över och raderar inte.                                                                                               | läs Ä/A/L; ladda upp Ä/A; P inget |

### Butiksportal

| Funktion                                                                                                                                           | Migrering                                                                   | Innehåll                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal_stores`, `portal_sales`, `portal_agreements`, `portal_machines`, `portal_reports`, `portal_report`, `portal_faults`, `portal_report_fault` | `20261102130100_portal_store_access.sql`, `…135500_portal_review_fixes.sql` | Allt butiken ser: egen försäljning, avtalsvillkor, automaternas perioder i butiken, godkända butiksrapporter och egna felanmälningar. Security definer; första steget är `private.portal_require_store`. |
| `create_store_invitation(...)`, `accept_invitation` (ny version)                                                                                   | `20261102130100`                                                            | Inbjudan till rollen `store` med `store_id`.                                                                                                                                                             |
| `private.portal_report_approved`                                                                                                                   | `…135500`, ersatt i `…145500`                                               | Butiken ser bara den senaste godkända versionen av en rapport; ett utkast ger samma svar som en rapport som inte finns.                                                                                  |
| Storage-policyn `binderlab_reports_select_store`                                                                                                   | `20261102130100`                                                            | Butiken kan läsa PDF:en för sina egna, godkända butiksrapporter.                                                                                                                                         |

### Expansion och effekt

Detaljerna står i avsnittet "Expansion och effekt" nedan.

| Tabell                   | Migrering                            | Innehåll                                                                                                                |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `stores` (platsattribut) | `20261102121500_expansion_leads.sql` | `store_type`, `city`, `open_hours_per_week`, `area_sqm` för likhet mellan platser.                                      |
| `expansion_leads`        | samma                                | Tänkbara platser i pipelinen (`lead` → `contacted` → `meeting` → `agreement` → `installed`, eller `lost`). Kan raderas. |
| `effect_measurements`    | samma                                | Mätvärden per månad mot utgångsläget (slutsålda dagar, minuter för påfyllning och administration).                      |
| `effect_settings`        | samma                                | Timkostnad och värde per undviken slutsåld dag.                                                                         |

### Marknad

| Tabell                      | Migrering                                        | Innehåll                                                                                                                      |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `releases`                  | `20261102122500_marknad_market_intelligence.sql` | Kortsläpp; när förslaget fastställs sparas inköpsmängd, släppkurva och förslag som ögonblicksbild (`plan_*`).                 |
| `release_allocations`       | samma                                            | Fastställd fördelning per automat (`units`) och vad förslaget sa (`suggested_units`).                                         |
| `supplier_price_quotes`     | samma                                            | Leverantörspriser över tid (`quote` eller `purchase`), pris per pack i öre.                                                   |
| `machine_slots`             | samma                                            | Fackfördelningen per automat och titel med giltighetsperiod (får inte överlappa).                                             |
| `assortment_changes`        | samma, `…143000_marknad_review_fixes.sql`        | Genomförd sortimentsrekommendation med väntad effekt; (automat, fingerprint) unik.                                            |
| `price_experiments`         | samma, `…143000`                                 | Pristester: titel, pris före och efter, startdag, längd; förslagets nyckel unik.                                              |
| `price_experiment_machines` | `20261102132000_marknad_experiment_arms.sql`     | Test- och kontrollautomater som rader (sammansatt FK mot `machines`) i stället för uuid-listor; en automat i en arm per test. |

Alla marknadstabeller: läs Ä/A/L, skriv Ä/A, påfyllaren ser inget. Inget är bokföringsunderlag, så rader får raderas; allt loggas i `audit_log`.

### Assistent

| Tabell eller funktion          | Migrering                                               | Innehåll och regler                                                                                                                                                                                                        | Roller                                                                                |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `assistant_logs`               | `20261102124000_assistent_assistant_logs.sql`           | En rad per fråga: samtal, användare, roll vid frågan, fråga, svar, `status` (`answered`, `unverified`, `refused`, `limit`, `error`), modell, verktygsanrop, kontroll av talen, tokenåtgång, tid. Append-only, ingen audit. | Ä/A läser alla; var och en sina egna så länge rollen fortfarande ser den sortens data |
| `private.insert_assistant_log` | `20261102134800_assistent_assistant_logs_hardening.sql` | Enda vägen att skriva en rad (inte nåbar via API:t). Ingen medlem har INSERT på tabellen; butiksrollen kan aldrig logga.                                                                                                   | servern                                                                               |

## Hämtning från Awish

Adaptergränssnittet: `SourceAdapter.fetch(cursor) → { orders: RawOrder[], machines: RawMachine[], nextCursor }`. Allt efter adaptern är gemensamt: koppling av automater och titlar, deduplicering, logg och lagerhändelser. Så blir de olika källorna:

1. **`awish_grpc` (i bruk).** Awish officiella gRPC-API med AppId, AppSecret och AppKey (i Vault, `secret_ref`).
   - Körs på servern var 10:e minut (pg_cron → `/api/cron/awish`), utan webbläsare och utan tillägg. Läget (sidor, senaste körning) ligger i `cursor` som JSON. Se `docs/awish-api.md`.
2. **`awish_csv` (reserv).** Uppladdning på sidan Datakällor, med förhandsvisning, kolumnmappning, kontroll av dubbletter och logg.
   - Kolumnerna mappas från Awish orderlista: Order No. → `external_id`, Name → titel, Order Machine → automat, Order Amount → belopp, Payment Time → tid, Is Paid → filter.
3. **`awish_web` (reserv, inte beslutad).** Serverhämtning av samma orderlista som panelen visar. Tas bara fram om gRPC dröjer, eftersom det är skörare.

## Beräkningslager (`src/domain/`, `src/analytics/`, `src/reports/`, rena funktioner med tester)

All indata är vanliga objekt. Belopp anges i öre. Avrundning sker på ett enda ställe: halva öre avrundas uppåt per rad, sedan summeras öre.

Funktionerna i `src/domain/` (grunden; reglerna står i `docs/berakningar.md`):

- `revenue`, `orderCount`, `averageOrderValue`
- `costOfGoods`, med det pris som gällde `business_date`. Den rapporterar också **täckning**: hur många order som saknar pris.
- `storeCompensation`: provision på belopp exkl. moms, hyra per dag vid delmånad, med de villkor och den placering som gällde varje dag.
- `vat` (0 i dag), `cardFees` (0 i dag)
- `profit`, `margin`
- `salesVelocity` (pack per dag, glidande), `daysOfStockLeft`
- `unitEconomics` (per automat: täckningsbidrag, avskrivning, återbetalningstid)
- `allocateToOwners`

Ovanpå domänen ligger `src/analytics/` (Att göra, maskinhälsa, larm, prognos, förlorad försäljning, inköp, avstämning,
kassaflöde, fasta kostnader, avtal, expansion, effekt, marknad, besöksplan) och `src/reports/` (butiks-, bokförings- och
delägarrapport, SIE 4, Excel). De importerar bara `@/domain`, varandra och formateringen i `@/lib` (`format`,
`fuzzy`), aldrig databasen eller serverkoden. Det kontrolleras av `purity.test.ts` i `src/domain`, `src/reports` och
fyra av analysmapparna (`forecast`, `reconciliation`, `expansion`, `pricing`).

## Öppna punkter som inte stoppar migreringarna

1. **Awish:** gRPC-API:t är byggt men inte provat mot Awish riktiga server (token med gemener, tidszon, beloppsformat; `docs/awish-api.md`).
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
  - Gallring körs som databasägaren `postgres` med `binderlab.allow_purge = 'on'` i transaktionen. Andra roller, även `service_role`, kan inte gallra (`20261102193000_hardening_purge_owner_only.sql`).
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

## Expansion och effekt (fas 6b och 10, migrering `20261102121500_expansion_leads.sql`)

- **stores** får platsattribut för likhet mellan platser: `store_type`, `city`, `open_hours_per_week` (0–168), `area_sqm`. null = okänt (räknas som olika). Redigeras under Expansion → Platsprofiler.
- **expansion_leads**: tänkbara platser i pipelinen `lead → contacted → meeting → agreement → installed` (eller `lost`). Namn, kontaktperson, e-post, telefon, adress, anteckningar, nästa steg och datum, samma attribut som `stores`, erbjudna villkor (`commission_bp`, `monthly_rent_ore`), planerad investering (`purchase_ore`, `installation_ore`) och valfri `store_id` (andra automat i en befintlig butik). `stage_changed_at` sätts av databasen när steget ändras. `archived_at` sätts när en avslutad plats arkiveras (Expansion → Avslutade platser → Arkivera; "Ta tillbaka" nollar den). Kan raderas.
- **effect_measurements**: mätvärden per månad mot utgångsläget: `stockout_days_month` (dagar), `refill_hours_month` och `admin_hours_month` (minuter), för organisationen, en butik eller en automat. Vinst per automat lagras inte (räknas ur orderna). Unik per (mått, omfattning, månad).
- **effect_settings**: en rad per organisation med `hourly_cost_ore` (tid i kronor) och `stockout_day_value_ore` (värde per undviken slutsåld dag; null = månadens vinst per automat och dag).
- Siffrorna på Enhetsekonomi, Expansion, Säljunderlag och Effekt räknas från första ordern: börjar skalets period före den klipps perioden dit (och på Effekt räknas automatdagarna i första ordermånaden från första ordern), så att dagar utan data inte räknas som dagar utan försäljning. Sidan skriver det i en mono-rad.
- Indatakontroll: datum måste finnas i kalendern (år 2000–2100), investeringsdatum högst två år från i dag (investeringar kan inte raderas), slutsålda dagar högst månadens dagar × automater i omfattningen och tid högst 744 h × automater per månad.
- Läsrätt ägare, admin och läsare; skrivrätt ägare och admin. Påfyllaren ser inget. Ändringslogg (`audit_log`) för de nya tabellerna och nu också för `goals`, `baselines` och `machine_investments`.

## Fas 8: drift, larm och kundärenden (2 nov. 2026)

Migreringen `20261102122143_drift_larm_arenden.sql`. Drizzle: `alerts` och `incidents` i
`src/db/schema.ts`, övriga i `src/db/schema/drift.ts`.

- **alerts** har fått incidentens tillstånd (`incident_key`, `alert_group`, `status`, `title`,
  `evidence`, `link`, `last_seen_at`, `closed_at`, `last_notified_at`, `notified_severity`,
  `notify_count`, `occurrences`, `reopen_count`, `one_shot`, `resolved_notified_at`,
  `suppressed_by`). Unikt index: högst en öppen rad per (organisation, `incident_key`). Raderna
  skrivs av larmjobbet; klienter får bara kvittera (`acknowledged_at`; vem och när sätts av
  databasen). Påfyllaren ser larm i familjerna `machine` och `stock`.
- **incidents** är kundärenden: `status` (`open`, `in_progress`, `resolved`, där `resolved` ⇔
  `ended_at`), `assignee_id` (ägare eller admin), `order_id` (sammansatt FK; ordern måste komma från
  ärendets automat), `title_id`, `refunded_ore` (≥ 0), `refunded_on` (krävs när beloppet > 0),
  `customer_contact`. Ändringar loggas i `audit_log`, och en återbetalning i en stängd månad
  kan inte läggas till, ändras eller flyttas till en annan automat eller titel (BL004).
  Påfyllaren och butiken ser inga ärenden.
- **alert_subscriptions**: en per användare och organisation (`kinds` och `machine_ids`, null =
  alla; `min_severity`, `channels`, `phone`, tysta timmar `quiet_start`/`quiet_end` som
  'TT:MM', `delivery_windows`, `critical_during_quiet`, `notify_resolved`, `reminders`,
  `active`). Var och en ser och ändrar bara sin egen; påfyllaren bara för automater och lager.
- **push_subscriptions**: Web Push per enhet (`endpoint`, `p256dh`, `auth_secret`), egna rader.
  `endpoint` måste vara en känd push-tjänst (`private.push_endpoint_allowed`: FCM, Mozilla,
  Apple, Windows), eftersom servern gör en POST dit.
- **alerts** (kvittering): användare får bara sätta `acknowledged_at`; `acknowledged_by` sätts
  alltid av databasen till den inloggade, och kvitteringar loggas i `audit_log`.
- RPC **sales_data_until(org, at)**: hur långt den importerade försäljningen räcker per automat
  (datakällan som automatens senaste order kom från, `data_until`, `synced_at`, automatens
  senaste order `last_order_at`). Bara
  tidpunkter; ägare, admin, läsare, påfyllare och systemet. Maskinhälsan räknar tystnaden fram
  till `data_until` (docs/berakningar.md, avsnitt 15).
- **alert_deliveries**: utskick per användare och sändtid (kö och logg), skrivs av larmjobbet.
- **alert_runs**: en rad per körning av larmjobbet.
- **field_submissions** och RPC:n **register_refill_once**: påfyllning från fältet med ett id
  som webbläsaren skapat; samma id igen ger samma lagerhändelse.

## Fas 7: felövervakning (2 nov. 2026)

Migreringen `20261102180000_drift_systemlarm.sql`: `alerts.alert_group` får värdet `system`
(typerna `report_failed` och `job_failed`). Systemlarmen skrivs av `src/server/monitoring`
(systemroll) när ett rapportutskick, månadsutkasten eller larmjobbet misslyckas, och stängs när
samma sak lyckas; larmjobbet utvärderar inte familjen. En misslyckad import sparas som en rad i
`imports` med status `failed` (och `storage_path` där filen skulle ha legat), och larmet kommer
från regeln `import_failed`. Läsrätt som för övriga larm; påfyllaren ser dem inte. Ett nytt
systemlarm läggs i `alert_deliveries` till prenumeranterna (samma regler som övriga larm) och
räknar upp `alerts.notify_count`. Rapportlarmet stängs också när en nyare version av rapporten
(samma typ, period och butik) skickas, och utkastlarmet när de saknade utkasten skapats för
hand. Länken på importlarm går till importens sida (`/datakallor/importer/<id>`). Se
`docs/operations.md`.
