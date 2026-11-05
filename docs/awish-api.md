# Awish API: automatisk hämtning

Binderlab hämtar orderna direkt från Awish officiella gRPC-API, var tionde minut, på servern. Ingen behöver ladda
ner något eller ha en webbläsare öppen. Uppladdning av orderlistan (CSV, `docs/awish.md`) finns kvar som reserv
under Datakällor → Ladda upp fil.

> **Status:** byggd och provad mot en låtsas-Awish (riktig gRPC-server lokalt med samma proto). Inte provad mot
> Awish riktiga server, eftersom byggmiljön inte når `49.51.72.74:50051`. Gör kontrollen under
> [Första gången i drift](#första-gången-i-drift).

## Koppla in (ägaren)

Datakällor → **Awish**: fyll i AppId, AppSecret och AppKey (Awish: Merchant → Merchant Detail → Developer Center),
klicka **Spara**, sedan **Testa anslutningen** och **Synka nu**. Klart. Första synken läser hela historiken
(1 000 order per körning); resten hämtas av det schemalagda jobbet.

## Så fungerar det

```
Supabase pg_cron (*/10 * * * *) → private.awish_cron_tick() → pg_net GET {APP_URL}/api/cron/awish
  Authorization: Bearer CRON_SECRET    (adress och hemlighet ur Vault: binderlab_app_url, binderlab_cron_secret)
/api/cron/awish → syncAllAwishSources → per datakälla awish_grpc:
  Vault (AppId/AppSecret/AppKey) → gRPC provider.Provider: Machines, Orders (sida 1, 2 …, 20 per sida)
  → adaptern (src/import/adapters/awish-grpc.ts) → samma pipeline som CSV → import (trigger 'schedule')
  → Products(machine_id) per kopplad automat (högst var 30:e minut, alltid vid "Synka nu")
  → src/server/awish/stock.ts → inventeringar (source 'awish'), uttag ur vårt lager vid påfyllning,
    machine_slots, stock_locations.awish_synced_at
```

- **Saldot (Products):** efter orderna, med den tid som är kvar av körningens budget. Automaten som lästes längst
  sedan går först; det som inte hinns med tas nästa körning. Fel för en automat stoppar inte de andra eller
  orderna. Resultatet står i `lastRun.stock` och `stockSyncedAt` i `data_sources.cursor`. Reglerna:
  `docs/berakningar.md`, avsnitt 8 (Saldot i automaterna).
- **Påfyllning dras ur vårt lager:** visar en automat som redan har lästs fler pack av en titel än saldot (och
  titeln är räknad där) skriver synken i samma transaktion ett uttag ur centrallagret: `adjustment` med negativt
  antal, `source = 'awish'`, noteringen "Awish-påfyllning <kod> <butik>" (regeln i
  `src/server/awish/refill-deduction.ts`). Aldrig vid första läsningen, aldrig vid minskning; en påfyllning som
  redan registrerats i appen ger 0, och en påfyllning som registreras strax efter synken räknas av mot uttaget
  (`register_refill`, `20261104202000_vart_lager_avrakning_awish.sql`). Pack som drogs står i `lastRun.stock.warehouseOut`. Vårt lager får bli
  negativt (fliken Vårt lager visar då "Räkna om"). Migreringen `20261104200000_vart_lager_awish_uttag.sql`
  tillåter `source = 'awish'` på ett sådant uttag. Detaljer: `docs/berakningar.md`, Vårt lager.

- **Server:** `AWISH_GRPC_ADDRESS` (standard `49.51.72.74:50051`), `AWISH_GRPC_TLS` (`false`, som i dokumentationen).
- **Inloggning** (metadata på varje anrop): `appid`, `token` = MD5 av `AppSecret.AppKey` som hex (gemener) och
  `lang` = `en-US`. Bara läsande anrop: `Merchant`, `Machines`, `Orders`, `Order`, `Products`. Aldrig `CreateBanner`,
  `UpdateBanner` eller `CreatePickupCode`.
- **Tidsgräns och omförsök:** 15 s per anrop; `UNAVAILABLE` och `DEADLINE_EXCEEDED` provas högst tre gånger. Hela
  cron-körningen (alla källor) har 40 s för anropen, och varje anrops tidsgräns kortas till det som återstår, så att
  importen hinner sparas inom funktionens 60 s. Det som inte hanns med fortsätter nästa körning. "Testa
  anslutningen" har 8 s per anrop och inga omförsök. Awish fel (`appid is missing`, `merchant not found`,
  `token is missing`, `permission denied`) visas på svenska; transportfel avgörs av gRPC-koden, inte texten.
- **Vilka sidor som läses** (`src/server/awish/paging.ts`): ordningen i svaret är inte dokumenterad och avgörs vid
  varje körning (id först och sist på sidan). En körning läser från den nya änden tills den har sett en redan
  importerad order och en order äldre än ett dygn (obetalda från senaste dygnet läses alltså om, så att en sen
  betalning kommer med). Första gången läses hela historiken bakåt, högst 50 sidor per körning, och läget sparas i
  `data_sources.cursor`. Efter ett långt avbrott fortsätter nästa körning där läsningen slutade (flera avbrott i rad
  sparas som flera glapp). Antalet sidor tas från `last_page`, annars `total`, annars `has_more`, annars tills en
  sida inte är full (fälten är valfria i proto-filen). Vilka fält Awish skickar sparas i `lastRun.pagingFields`.
- **Tolkningen:**
  - `id` → ordernummer (unikt per datakälla, samma order igen är en dubblett).
  - `title` → titel (saknas: "Okänd produkt").
  - `machine_id` → källautomat; namn och maskinnummer från `Machines`, annars "Automat &lt;id&gt;".
  - `amount` → öre. Det är text i kronor ("170.00"), fast tabellen säger "Int, unit cent". Tills källan har gett
    minst ett belopp med decimalpunkt stoppas synken på ett betalt belopp utan decimaler ("400"), eftersom det kan
    vara öre: inget importeras och felet visas i Datakällor. Därefter tolkas "170" som kronor med en anmärkning.
    "1,234.00" och liknande blir felrad.
  - `pay_time` → tid i datakällans tidszon.
  - `payment_id` → betalmetod med CSV-exportens ord (5 = "Card").
  - Bara `PAY_SUCCESS` utan `is_free` importeras. Gratis-, test- och hämtkodsorder, obetalda och återbetalda räknas
    som ej betalda och hoppas över utan rad i importloggen (de läses om varje körning; antalet står i importens
    `mapping.skippedUnpaid`). En order som återbetalas efter importen blir en konflikt i importloggen en gång.
    Ordern ändras inte; återbetalningen förs på ett ärende i Inkorg.
- **Samma försäljning i en CSV-källa:** en betald order vars betaltid (sekunden) och belopp redan finns i en annan
  Awish-källa i organisationen räknas som dubblett och importeras inte (importens `mapping.otherSourceDuplicates`).
  Det gör att en tidigare uppladdad orderlista inte dubbleras, även om CSV:ns "Order No." inte är samma tal som
  API:ts `id`. Det kräver samma tidszon i båda källorna: API-källan skapas därför med tidszonen från
  organisationens senaste Awish CSV-källa (annars `Asia/Shanghai`). Byt aldrig tidszon på bara den ena.
- **Online/offline (Machines):** synken sparar `is_online` och `status` per källautomat
  (`source_machines.awish_*`, migreringen `20261110000000_awish_online_konto.sql`, regeln i
  `src/analytics/health/connectivity.ts`). En automat räknas som offline när den varit online förut och Awish sagt
  offline i minst 20 minuter; den räknas som tillbaka först efter 20 minuter online (fladder: samma period
  fortsätter). En automat som aldrig varit online larmar inte, och ett läge äldre än en timme används inte. Drift
  och automatens sida visar "Online" eller "Offline sedan 14:10"; larmet `machine_offline` heter "BL-001 är offline
  sedan 14:10" (Notiser, push, Att göra) och stängs av larmjobbet när automaten är tillbaka. Eftersom larmjobbet
  bara körs en gång om dagen utvärderar `/api/cron/awish` larmen direkt efter synken för organisationer med en
  automat offline eller ett öppet offlinelarm (`src/server/awish/offline-alerts.ts`). Alla roller läser läget via
  `public.machine_connectivity(org)`; bara synken (systemrollen) kan skriva det.
- **Kontots slutdag (Merchant):** `Merchant.expired_at` läses högst en gång per dygn (i källans tidszon) och sparas i
  `data_sources.awish_expires_at`. 30 dagar före står "Awish-kontot går ut 18 apr. 2027 – förläng hos Awish" på Att
  göra, Hem, Drift och Datakällor (ägare och admin), 7 dagar före som brådskande (`src/server/awish/expiry.ts`).
- **Larm:** `expectedInterval('awish_grpc') = 10` minuter. En tyst synk syns på Drift efter 30 minuter, men push,
  e-post och sms skickas först vid nästa larmkörning (`/api/cron/larm`, en gång om dagen på Vercel Hobby). För snabb
  avisering: Sentry Cron Monitor `binderlab-awish` (kräver `SENTRY_DSN`).

## Säkerhet

- AppId, AppSecret och AppKey sparas med `public.awish_save_credentials` (bara ägare och admin) i Supabase Vault
  under organisationens namnrymd (`{organization_id}/awish_grpc:{datakälla}`). `data_sources.secret_ref` pekar dit.
  I `config` sparas bara de fyra sista tecknen av AppId, och av AppSecret och AppKey bara om värdet är minst 12
  tecken (annars ingenting; fältet visar ••••••••). `config` kan läsas av alla roller i organisationen. Funktionen
  returnerar aldrig hemligheten. AppSecret och AppKey är lösenordsfält.
- Servern läser uppgifterna med `private.awish_read_credentials` (bara systemrollen). Klientroller når varken Vault
  eller funktionen. Uppgifterna loggas aldrig och skickas aldrig till webbläsaren.
- `/api/cron/awish` kräver `CRON_SECRET` (samma kontroll som de andra cron-routerna). `scripts/deploy` skriver
  `binderlab_app_url` och `binderlab_cron_secret` i produktionens Vault. Vault är källan för CRON_SECRET: Vercel får
  samma värde. Värdet slumpas i databasen, så det står aldrig i SQL-texten. Saknas något av dem gör pg_cron-jobbet
  ingenting. Byte av CRON_SECRET: se raden i `docs/operations.md` (Vault först, sedan `scripts/deploy`).
- **Okrypterad anslutning.** Med `AWISH_GRPC_TLS=false` (standard, som i leverantörens exempel) går `appid`, `token`
  och alla order i klartext över internet till `49.51.72.74`. Token = MD5(AppSecret.AppKey) har ingen tidsstämpel
  och går inte ut: den som avlyssnar ett anrop kan återanvända den för alltid, även för skrivande anrop
  (`CreateBanner`, `UpdateBanner`, `CreatePickupCode`). Därför:
  - fråga Awish om TLS (sätt då `AWISH_GRPC_TLS=true`) eller en IP-spärr för kontot;
  - byt AppSecret/AppKey i Developer Center vid minsta misstanke, och spara de nya i Datakällor;
  - servern loggar en varning en gång per process när TLS är avslaget mot en adress som inte är lokal.

## Första gången i drift

1. Kör `scripts/deploy/all.ts` (eller `vercel.ts`). Den sista delen ska visa "Awish-synken körs var tionde
   minut". Står det att `pg_cron`-jobbet saknas: slå på pg_cron och pg_net under Supabase → Database → Extensions
   och kör `scripts/deploy` igen; det schemalägger jobbet (och rensningen av `cron.job_run_details`). En migrering
   körs aldrig om. Utan deploy: kör SQL:en som skriptet skriver ut i SQL-redigeraren.
2. Datakällor → Awish: spara uppgifterna och klicka **Testa anslutningen**. Den ska visa handlarens namn, antal
   automater, antal order och den senaste ordern.
   - "Awish nekade anropet": prova token med versaler (`TOKEN_HEX_CASE` i `src/server/awish/grpc-client.ts`), som
     inte är verifierad.
   - "Awish svarar inte": kontrollera att Vercel når `49.51.72.74:50051`, och om servern kräver TLS
     (`AWISH_GRPC_TLS=true`).
3. **Tidszonen:** gör kontrollen mot order 42780 i `docs/awish.md` igen, med API:ts `pay_time`. Proto-filen har
   ingen tidszon i `Merchant.config`, så källan börjar i CSV-källans tidszon eller `Asia/Shanghai`. Dokumentationen säger att tiderna följer
   handlarens tidszon om den är inställd, annars enhetens, annars UTC. Ändra `source_timezone` innan historiken
   används om tiden inte stämmer.
4. **Beloppet:** jämför några order med panelen (ett belopp "170.00" ska bli 170 kr, inte 1,70 kr). Stoppar
   synken med "utan decimaler": kontrollera i Awish om beloppet är öre eller kronor och rätta `parseAwishAmount`
   innan något importeras.
5. **Dubbletter:** finns en uppladdad CSV-källa, kontrollera i importloggen att `otherSourceDuplicates` räknar
   historiken och att intäkten per dag inte har dubblerats. Pausa sedan CSV-källan.
6. **Ordningen och sidfälten:** synkens läge (`data_sources.cursor`) visar i `paging.order` om Awish svarar nyast
   först (`desc`) eller äldst först (`asc`), och i `lastRun.pagingFields` vilka sidfält servern skickar.
7. **Gamla tilläggskällor:** migreringen `20261103120000_awish_api_granskning.sql` pausar datakällor av typen
   `awish_extension` och återkallar alla synk-token. Arkivera källan under Datakällor när historiken inte behövs.

## För utvecklare

| Del              | Var                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Proto (inbäddad) | `src/server/awish/provider-proto.ts` (leverantörens fil utan REST-annoteringar)                                     |
| Klienten         | `src/server/awish/grpc-client.ts`                                                                                   |
| Sidor och läge   | `src/server/awish/paging.ts`                                                                                        |
| Synk och test    | `src/server/awish/sync.ts`; Datakällor: `src/server/awish/manage.ts`                                                |
| Adaptern         | `src/import/adapters/awish-grpc.ts`                                                                                 |
| Cron             | `src/app/api/cron/awish/route.ts`; migreringarna `20261103090000_awish_api.sql`, `…120000_awish_api_granskning.sql` |
| Låtsas-Awish     | `src/server/awish/testing/fake-server.ts`                                                                           |
| Tester           | `src/server/awish/*.test.ts`, `src/import/adapters/awish-grpc.test.ts`, `test/db/awish-api.test.ts`                 |

Chrome-tillägget är borttaget. Enum-värdena `awish_extension` och `extension` och tabellen `sync_tokens` finns kvar i
databasen (migreringar ändras aldrig) men används inte; alla token är återkallade.

## Awish svar (3 nov. 2026)

| Fråga                                             | Svar                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Token                                             | MD5 som hex med gemener                                                                                      |
| `amount`                                          | Valutaenheter ("170.00" = 170 kr), inte ören                                                                 |
| IP-begränsning                                    | Ingen                                                                                                        |
| Sortering                                         | Servern sorterar själv (synken känner av ordningen)                                                          |
| TLS                                               | Ingen                                                                                                        |
| Historik                                          | Ungefär ett år bakåt                                                                                         |
| `pay_time`                                        | UTC som standard. Har kontot en tidszon används den, och automatens tidszon går före kontots                 |
| Återbetalning                                     | Bara QR-betalningar ändrar status; kortorder ändras inte (återbetalningar förs i Inkorg)                     |
| `id` / `trade_id`                                 | `id` = ID i panelen, `trade_id` = Order No.                                                                  |
| `per_page`                                        | Högst 50, standard 20 (synken begär 50)                                                                      |
| Debug Mode                                        | Rekommenderas påslaget                                                                                       |
| Ny signering (HMAC-SHA256, `cleveng/hmac-signer`) | Gäller främst ändringsanrop; Binderlab läser bara. Formen är HMAC-SHA256 över `"{timestamp}.{body}"` som hex |

Inställning hos beställaren: Developer Center → Advanced Settings: Debug Mode på, Time Zone Settings på med
Europe/Stockholm (och samma tidszon på automaterna). Datakällans tidszon i Binderlab ska då vara Europe/Stockholm.
