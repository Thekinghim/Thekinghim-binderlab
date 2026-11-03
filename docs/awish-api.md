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
```

- **Server:** `AWISH_GRPC_ADDRESS` (standard `49.51.72.74:50051`), `AWISH_GRPC_TLS` (`false`, som i dokumentationen).
- **Inloggning** (metadata på varje anrop): `appid`, `token` = MD5 av `AppSecret.AppKey` som hex (gemener) och
  `lang` = `en-US`. Bara läsande anrop: `Merchant`, `Machines`, `Orders`, `Order`. Aldrig `CreateBanner`,
  `UpdateBanner` eller `CreatePickupCode`.
- **Tidsgräns och omförsök:** 15 s per anrop; `UNAVAILABLE` och `DEADLINE_EXCEEDED` provas högst tre gånger. Awish
  fel (`appid is missing`, `merchant not found`, `token is missing`, `permission denied`) visas på svenska.
- **Vilka sidor som läses** (`src/server/awish/paging.ts`): ordningen i svaret är inte dokumenterad och avgörs vid
  varje körning (id först och sist på sidan). En körning läser från den nya änden tills den har sett en redan
  importerad order och en order äldre än ett dygn (obetalda från senaste dygnet läses alltså om, så att en sen
  betalning kommer med). Första gången läses hela historiken bakåt, högst 50 sidor per körning, och läget sparas i
  `data_sources.cursor`. Efter ett långt avbrott fortsätter nästa körning där läsningen slutade.
- **Tolkningen:**
  - `id` → ordernummer (unikt per datakälla, samma order igen är en dubblett).
  - `title` → titel (saknas: "Okänd produkt").
  - `machine_id` → källautomat; namn och maskinnummer från `Machines`, annars "Automat &lt;id&gt;".
  - `amount` → öre. Det är text i kronor ("170.00"), fast tabellen säger "cent". Utan decimaler ("170") tolkas
    det som kronor med en anmärkning. "1,234.00" och liknande blir felrad.
  - `pay_time` → tid i datakällans tidszon.
  - `payment_id` → betalmetod med CSV-exportens ord (5 = "Card").
  - Bara `PAY_SUCCESS` utan `is_free` importeras. Gratis-, test- och hämtkodsorder, obetalda och återbetalda räknas
    som ej betalda. En order som återbetalas efter importen blir en konflikt i importloggen en gång. Ordern ändras
    inte; återbetalningen förs på ett ärende i Inkorg.
- **Samma försäljning i en CSV-källa:** en betald order vars betaltid (sekunden) och belopp redan finns i en annan
  Awish-källa i organisationen räknas som dubblett och importeras inte (importens `mapping.otherSourceDuplicates`).
  Det gör att en tidigare uppladdad orderlista inte dubbleras, även om CSV:ns "Order No." inte är samma tal som
  API:ts `id`.
- **Larm:** `expectedInterval('awish_grpc') = 10` minuter, så importregeln larmar efter 30 minuter utan lyckad
  synk. Sentry Cron Monitor `binderlab-awish` om `SENTRY_DSN` finns.

## Säkerhet

- AppId, AppSecret och AppKey sparas med `public.awish_save_credentials` (bara ägare och admin) i Supabase Vault
  under organisationens namnrymd (`{organization_id}/awish_grpc:{datakälla}`). `data_sources.secret_ref` pekar dit.
  Bara de fyra sista tecknen sparas i `config` (visas som ••••1234). Funktionen returnerar aldrig hemligheten.
- Servern läser uppgifterna med `private.awish_read_credentials` (bara systemrollen). Klientroller når varken Vault
  eller funktionen. Uppgifterna loggas aldrig och skickas aldrig till webbläsaren.
- `/api/cron/awish` kräver `CRON_SECRET` (samma kontroll som de andra cron-routerna). `scripts/deploy` skriver
  `binderlab_app_url` och `binderlab_cron_secret` i produktionens Vault. Vault är källan för CRON_SECRET: Vercel får
  samma värde. Saknas något av dem gör pg_cron-jobbet ingenting.

## Första gången i drift

1. Kör `scripts/deploy/all.ts` (eller `vercel.ts`). Den sista delen ska visa "Awish-synken körs var tionde
   minut". Står det att `pg_cron`-jobbet saknas: slå på pg_cron och pg_net under Supabase → Database → Extensions
   och kör migreringen `20261103090000_awish_api.sql` igen.
2. Datakällor → Awish: spara uppgifterna och klicka **Testa anslutningen**. Den ska visa handlarens namn, antal
   automater, antal order och den senaste ordern.
   - "Awish nekade anropet": prova token med versaler (`TOKEN_HEX_CASE` i `src/server/awish/grpc-client.ts`), som
     inte är verifierad.
   - "Awish svarar inte": kontrollera att Vercel når `49.51.72.74:50051`, och om servern kräver TLS
     (`AWISH_GRPC_TLS=true`).
3. **Tidszonen:** gör kontrollen mot order 42780 i `docs/awish.md` igen, med API:ts `pay_time`. Proto-filen har
   ingen tidszon i `Merchant.config`, så källan börjar i `Asia/Shanghai`. Dokumentationen säger att tiderna följer
   handlarens tidszon om den är inställd, annars enhetens, annars UTC. Ändra `source_timezone` innan historiken
   används om tiden inte stämmer.
4. **Beloppet:** jämför några order med panelen (ett belopp "170.00" ska bli 170 kr, inte 1,70 kr).
5. **Dubbletter:** finns en uppladdad CSV-källa, kontrollera i importloggen att `otherSourceDuplicates` räknar
   historiken och att intäkten per dag inte har dubblerats. Pausa sedan CSV-källan.
6. **Ordningen:** synkens läge (`data_sources.cursor`, `paging.order`) visar om Awish svarar nyast först (`desc`)
   eller äldst först (`asc`).

## För utvecklare

| Del              | Var                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Proto (inbäddad) | `src/server/awish/provider-proto.ts` (leverantörens fil utan REST-annoteringar)                     |
| Klienten         | `src/server/awish/grpc-client.ts`                                                                   |
| Sidor och läge   | `src/server/awish/paging.ts`                                                                        |
| Synk och test    | `src/server/awish/sync.ts`; Datakällor: `src/server/awish/manage.ts`                                |
| Adaptern         | `src/import/adapters/awish-grpc.ts`                                                                 |
| Cron             | `src/app/api/cron/awish/route.ts`; migreringen `20261103090000_awish_api.sql`                       |
| Låtsas-Awish     | `src/server/awish/testing/fake-server.ts`                                                           |
| Tester           | `src/server/awish/*.test.ts`, `src/import/adapters/awish-grpc.test.ts`, `test/db/awish-api.test.ts` |

Chrome-tillägget är borttaget. Enum-värdena `awish_extension` och `extension` och tabellen `sync_tokens` finns kvar i
databasen (migreringar ändras aldrig) men används inte.
