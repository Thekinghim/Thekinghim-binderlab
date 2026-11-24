# Awish API: automatisk hämtning

Binderlab hämtar orderna direkt från Awish officiella gRPC-API, var femte minut, på servern. Ingen behöver ladda
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
Supabase pg_cron (*/5 * * * *) → private.awish_cron_tick() → pg_net GET {APP_URL}/api/cron/awish
  Authorization: Bearer CRON_SECRET    (adress och hemlighet ur Vault: binderlab_app_url, binderlab_cron_secret)
/api/cron/awish → syncAllAwishSources → per datakälla awish_grpc:
  Vault (AppId/AppSecret/AppKey) → gRPC provider.Provider: Machines, Orders (sida 1, 2 …, 20 per sida)
  → adaptern (src/import/adapters/awish-grpc.ts) → samma pipeline som CSV → import (trigger 'schedule')
  → Products(machine_id) per kopplad automat (i varje körning, alltid vid "Synka nu")
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
    Ordern ändras inte; återbetalningen förs på ett ärende i Inkorg. För att det ska bli gjort blir ordern också
    en punkt i Att göra och ett larm på Drift ("Order 880460 i BL-001 återbetalades i Awish", typen
    `order_attention`, `src/server/awish/order-attention.ts`) som leder till ett nytt ärende med ordern och beloppet
    ifyllt, och som står kvar tills återbetalningen är införd. En betald order som inte går att läsa (betaltid
    saknas, okänt beloppsformat) blir på samma sätt "Order … från Awish kunde inte läsas" tills ordern finns i
    försäljningen. Larmen skapas ur det synken ser i varje körning, inte ur listan över det som redan är loggat.
    Gräns: bara de senaste 24 timmarnas order läses om, så en återbetalning som görs senare än ett dygn efter
    köpet syns inte.
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
- **En körning utan lästa order är ett fel.** Tar orderanropet slut på tid innan någon sida har lästs slutar
  körningen med "Awish svarade inte i tid när orderna skulle hämtas. Inga order hämtades." och "senast hämtat"
  flyttas inte fram. Förr sparades den som lyckad, så att allt såg färskt ut medan försäljningen stod still.
  Automaternas anslutning sparas ändå (den läses före orderna). Läget räknar misslyckade körningar i rad
  (`failures` i `data_sources.cursor`).
- **Larm:** tre misslyckade körningar i rad, eller 30 minuter utan lyckad hämtning, ger det kritiska larmet
  "Försäljningen har inte hämtats sedan …" (`watch:synk:<källa>`, se Vakten i `docs/operations.md`). Det skapas
  av synkens egen körning var femte minut och skickas i samma körning, och av larmjobbet om synken inte körs
  alls. Hem och Drift visar samma rad när sidan öppnas, och Hem visar datans ålder per automat. Regeln
  `import_failed` ("Ingen hämtning från Awish på …", varning efter 60 minuter) finns kvar. Sentry Cron Monitor
  `binderlab-awish` (kräver `SENTRY_DSN`) larmar den som har driften.

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

## Styrning via API:t (v1.2.41)

Awishs gRPC-API v1.2.41 (AW-DOC-110) har skrivande anrop för att styra automaterna:
starta om och stäng av (ControlPower), strömschema (SetPowerSchedule/ClearPowerSchedule),
mata ut ett pack (ExecuteShipment), fack (UpdateProduct, BatchUpdateProducts,
ReplenishProductInventory), varor och kategorier, skärm och reklam (UpdateMachineConfig),
medlemmar, tidszon (UpdateMerchant), DeleteBanner, Currencies och Version. Koden ligger i
`src/server/awish/control/` (klient, skydd, Version, plan B för påfyllning) och
`src/server/awish/sign.ts` (signering). Proto-filens fältnummer gäller för allt utom
timestamp/sign i sju skrivningar (se Fältnummer nedan).

### Fältnummer: dokumentationen och proto-filen skiljer sig

I sju skrivningar har dokumentationen (AW-DOC-110) `timestamp = 10` och `sign = 11`, medan
proto-filen har lägre nummer. Övriga fält har samma nummer i båda.

| Anrop                     | Meddelande                       | Proto | PDF   |
| ------------------------- | -------------------------------- | ----- | ----- |
| UpdateMerchant            | UpdateMerchantRequest            | 6/7   | 10/11 |
| ControlPower              | PowerControlRequest              | 3/4   | 10/11 |
| SetPowerSchedule          | PowerScheduleRequest             | 5/6   | 10/11 |
| ExecuteShipment           | ShipmentRequest                  | 8/9   | 10/11 |
| UpdateProduct             | UpdateProductRequest             | 6/7   | 10/11 |
| BatchUpdateProducts       | BatchUpdateProductRequest        | 6/7   | 10/11 |
| ReplenishProductInventory | ReplenishProductInventoryRequest | 3/4   | 10/11 |

Vi vet inte vilken numrering Awishs server följer. Därför får de sju meddelandena två extra
fält, `doc_timestamp = 10` och `doc_sign = 11` (`src/server/awish/proto-doc-fields.ts`), och
samma timestamp och signatur skickas på båda ställena. En server som följer den ena
numreringen ser det andra paret som okända fält. `AWISH_SIGN_FIELDS=proto` (bara proto-filens)
eller `=doc` (bara dokumentationens) väljer ett av dem.

**Testa signering** provar efter ett lyckat försök en gång till med bara proto-filens par och
säger vilken numrering Awish läser ("Awish läser proto-filens fältnummer" eller
"dokumentationens fältnummer (10 och 11)"). Saknar Awish signaturen helt visas "Awish fick
ingen signatur" (inte "fel signatur"), och skrivningarna pausas.

CreateBanner och UpdateBanner skiljer också (PDF 11/12, proto 10/11), men där krockar
numren (11 är `sign` i proto och `timestamp` i PDF), så där skickas bara proto-filens.
Fråga Awish vilken numrering som gäller.

### Signering

Sedan v1.2.40 kräver "riskabla" skrivningar `timestamp` (Unix-sekunder) och `sign`:

```
sign = hex_gemener(HMAC-SHA256(nyckel = appid, `${timestamp}.${request_body}`))
```

Servern godtar ±300 s. Dokumentationen säger inte vad `request_body` är. Awishs
referensbibliotek (@cakioe/hmac-signer) serialiserar ett JSON-objekt med serde_json och
sorterade nycklar och räknar inte med `sign` och `timestamp`. Vi bygger därför begäran som
kompakt JSON, utan sign och timestamp, med sorterade nycklar, uint64 som tal och
uppräkningar som tal. Tre lägen finns, eftersom det är osäkert hur Awish bygger om JSON ur
protobuf:

| Läge                      | request_body                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| present_sorted (standard) | Fälten som går över tråden (optional-fält som är satta, vanliga fält som inte har standardvärdet), sorterade |
| full_sorted               | Alla fält: null för ej satta optional-fält och meddelanden, standardvärden annars, sorterade                 |
| present_proto_order       | Som present_sorted men i fältnummerordning                                                                   |

**Datakällor → Awish API → Testa signering** gör en ofarlig signerad skrivning
(UpdateMerchant med samma tidszon igen, annars UpdateCategory med samma titel) i varje läge
och sparar det första som Awish godtar. Godtas inget, eller nekar Awish en signatur senare,
pausas alla skrivningar via API:t (påfyllning och varor går då via webbpanelen) tills
signeringen fungerar igen. `AWISH_SIGN_MODE` i miljön går före det sparade.

CreateBanner, UpdateBanner och CreatePickupCode signeras också, i samma läge som sparats.

Ett nej från Awish kan komma som gRPC-fel eller i svaret (SuccessResponse med en kod). Båda
tolkas med samma regler (signatur, klocka, offline, stöds inte); Awishs egen text visas
aldrig utan sparas bara i loggen. "invalid signature" (utan "verify failed") är Awishs
inloggningsfel för fel AppSecret/AppKey och visas som det.

### Version

Varje timme (pg_cron `binderlab-awish-version`, minut 41 → `/api/cron/awish-version`)
läses Version. Byts den (även bara ett tillägg som "1.2.41-r2") skapas ett systemlarm ("Awish
bytte API-version") och allt som skriver till fack eller automat via API:t pausas tills
ägaren eller admin trycker **Jag har kontrollerat** under Datakällor: Byt pack, Fyll fullt,
kategori per fack, påfyllning via API (går via webbpanelen så länge), strömschema, Mata ut
och Stäng av, och tidszonen (UpdateMerchant). Starta om pausas inte (den behövs ibland just
när något är fel). Bakgrund: en oannonserad omnumrering av fälten fick facken att läsas fel.

Cron räcker inte ensam (upp till en timme gammal). Före varje sådan skrivning läses Version
dessutom live: skiljer den sig från den sparade (eller, första gången, från den inbäddade
1.2.41) sparas bytet, larmet skapas och skrivningen stoppas tills någon kvitterat. Svarar
Version inte skickas inget.

### TLS (runbook)

appid är både inloggningen och signeringsnyckeln. Därför väljer styrningen aldrig den
okrypterade adressen av sig själv (`AWISH_CONTROL_ENDPOINT=auto`, standard): bara
`grpc.awish.vip:443` (TLS) provas. Svarar TLS inte visar Datakällor "TLS svarar inte" och
knappen **Använd okrypterad** (ägare och admin, med en fråga först); först då används
`49.51.72.74:50051`. Cron provar TLS igen varje timme och byter tillbaka när den svarar.
`AWISH_CONTROL_ENDPOINT=plain` låser den okrypterade i miljön (bara lokalt och i tester),
`tls` låser TLS.

Synken och kampanjerna använder fortfarande `AWISH_GRPC_ADDRESS`/`AWISH_GRPC_TLS` (standard
okrypterad). Så länge synken går okrypterat kan appid avlyssnas där. Innan skrivningar via
API slås på (Påfyllning/Varor till Awish = API) ska synken också gå över TLS. När Datakällor
visar "Anslutning: Krypterad (TLS)":

1. Sätt `AWISH_GRPC_TLS=true` och `AWISH_GRPC_ADDRESS=grpc.awish.vip:443` i Vercel.
2. Kör Hämta nu under Datakällor och kontrollera att order kommer.
3. Går det inte: ta bort variablerna igen (den okrypterade adressen gäller då) och låt
   skrivningarna gå via webbpanelen.
4. Sätt `AWISH_CONTROL_ENDPOINT=tls` i produktion.

Har Awish-kontot en IP-lista (`whitelist_ip`) kan Vercels utgående adresser nekas.

### Kategori på en vara

UpdateGood har `prices` och `media` som `repeated`: "inte skickat" och "tom lista" ser
likadana ut för Awish. Ersätter Awish listorna när de saknas skulle ett kategoribyte tömma
varans priser och bilder. Kategoribytet via API är därför avstängt tills
`AWISH_GOOD_CATEGORY_API=true` (sätt först efter ett prov på en testvara: priser och bilder
ska finnas kvar efteråt i Awishs panel). Till dess: byt kategori i Awishs egen panel.

### Skydd för varje skrivning

`runControlAction` (control/guard.ts): bara ägare och admin; en demo anropar aldrig Awish;
`AWISH_CONTROL_DISABLED=true` stänger av allt; samma bekräftelse (idempotensnyckel från
förhandsvisningen) skickas en gång; gränser (mata ut 1 per automat per 2 min, 5 i timmen,
10 per dygn; stäng av 1 per 30 min; starta om 1 per 10 min); mata ut kräver skäl och att
automaten är online. Gränserna räknas en gång till under ett lås per organisation i samma
transaktion som loggraden sparas, så två bekräftelser samtidigt (två flikar) kan inte båda
komma förbi. Varje skrivning loggas i `awish_actions` (vem, vad, när, Awishs svar) utan
sign, timestamp, hemligheter eller personuppgifter. Skrivningar provas aldrig igen
automatiskt; uteblir svaret blir utfallet "okänt" och användaren ombeds titta på automaten.

Starta om och Stäng av kräver en förhandsvisning på servern: den ger ett bevis (HMAC med
`CONTROL_CONFIRM_SECRET`, annars `CRON_SECRET`) som bara gäller den användaren, automaten,
kommandot och nyckeln i 10 minuter. Stäng av kräver också att koden skrivs. Ett strömschema
som stänger av automaten nu eller inom 15 minuter kräver också att koden skrivs.

### Påfyllning och varor: webbpanelen eller API:t

Datakällor → Awish API → **Påfyllning till Awish**: Webbpanelen (som nu, standard), API,
eller API med webbpanelen som reserv (`awish_api_state.slot_writes_via`). API används bara
när signeringen fungerar. Plan B (`control/api-push.ts`) använder samma plan som
webbvägen (höjer bara, sänker aldrig) och skriver med UpdateProduct: bara antalet (och status
när den ändras), aldrig `good_id`, under samma Awish-lås per organisation som webbvägen. Är
API-vägen av just nu (ingen adress svarar, obekräftat versionsbyte) går påfyllningen via
webbpanelen även i läget API, så att den alltid loggas. Loggraden visar vem som fyllde på.

Med "Om Awish krånglar" (hälsan per väg, `awish_path_health`, och kön av väntande
sändningar): en automat som inte kom fram via API:t blir väntande som via webben. "Försök
igen" i Fyll på och de automatiska försöken (cron var femte minut) går samma väg som
påfyllningen (`pushRefillToAwish`), alltså exakt webbvägen när läget är Webbpanelen. API-vägen
sparar hälsan för `push` (och `goods` för Ny produkt/Redigera vara) med vägen `open_api`;
webbvägen sparar `webbpanelen` med nya försök och brytare som förut. Varor via webbpanelen
har kvar sina nya försök (CreateGood läser listan före ett nytt försök) även när läget är
API med webbpanelen som reserv.

## Var finns vad (för ägaren)

| Funktion                                                                    | Var                                                               | Vem          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| Starta om, Stäng av (bakom Mer)                                             | Automater → automaten → Styr automaten → Starta om                | Ägare, admin |
| Strömschema (dagar, på/av, förifyllt från butikens tider)                   | Styr automaten → Strömschema                                      | Ägare, admin |
| Byt pack i fack, Fyll fullt                                                 | Styr automaten → Byt pack i fack                                  | Ägare, admin |
| Skärm och reklam (volym och ljusstyrka visas, går inte att ändra via API:t) | Styr automaten → Skärm och reklam                                 | Ägare, admin |
| Mata ut ett pack (skäl, skriven kod, gränser)                               | Styr automaten → Mata ut ett pack                                 | Ägare, admin |
| Loggen över skrivningar                                                     | Styr automaten, längst ner                                        | Ägare, admin |
| Kategorier på skärmen, kategori per fack                                    | Inköpspriser → Ny produkt → Kategorier (/inkopspriser/kategorier) | Ägare, admin |
| Varor via API (ny, ändra, ta bort)                                          | Inköpspriser → Ny produkt / Redigera vara                         | Ägare, admin |
| Medlemmar (lista, ny, ändra, ta bort; telefon och e-post maskerade)         | Inställningar → Medlemmar                                         | Ägare, admin |
| Awish-kontot: tidszon, valutor, giltig till                                 | Inställningar → Awish                                             | Ägare, admin |
| Ta bort kampanjbild från skärmen                                            | Kampanjer → avslutad kampanj                                      | Ägare, admin |
| Version, anslutning (TLS), signering, webb/API                              | Datakällor → Awish API                                            | Ägare, admin |

Påfyllare, butiker, läsare och demo ser inga av sidorna och kan inte anropa dem.

### Att kontrollera mot riktiga Awish efter driftsättning

1. Datakällor → Awish API → **Testa anslutning**: står det "Krypterad (TLS)"?
2. **Testa signering**: fungerar det, och vilken numrering läser Awish? Svara Awish om
   numreringen i dokumentationen.
3. Starta om en automat som står still (kvällstid) och se att den startar om.
4. Strömschema på en automat: se i Awishs panel att tiderna kom fram rätt.
5. Byt pack via API på ett tomt fack och se i Awish att varan och antalet stämmer.
6. Mata ut: bara i underhållsläge, med någon vid automaten.
