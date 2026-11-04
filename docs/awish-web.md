# Awish: skicka påfyllningar till Awish

Binderlab kan skriva tillbaka till Awish så att ägaren **bara registrerar i Binderlabs app** och
aldrig behöver skriva antal på dash.awish.vip. Detta kompletterar den läsande gRPC-kopplingen
(`docs/awish-api.md`), som bara kan läsa lager.

## Hur det fungerar

Awishs egen webbpanel (dash.awish.vip, "DingShang Cloud Management System") sätter ett facks antal
via ett GraphQL-API på `https://dash.awish.vip/graphql`. Binderlab gör samma anrop med butikens egen
inloggning:

1. **Inloggning.** `mutation Signin($input: String!)` där `input` är en base64-kodad, signerad JSON
   `{ email, password, timestamp, sign }`. Svar: `access_token`, `refresh_token`, `expires_in`.
   Signeringen (`src/server/awish/web-sign.ts`) är panelens egen: platta ut fälten, hoppa över tomma
   och `NULL`, `encodeURI`, sortera, `&key=<appKey>`, MD5 som versaler. Headers på varje anrop:
   `Appid`, `APP-VERSION`, `X-Sent-At-Time`, `Authorization: Bearer <token>`, `Lang`.
2. **Läsa fack.** `query Products($input)` (signerad `machine_id`) ger facken med `good`, `channel.total`
   (kapacitet) och `current_inventory`.
3. **Sätta antal.** `mutation UpdateProduct($id, $input)` med `current_inventory`.

Koden:

- `src/server/awish/web-sign.ts` – signering (ren, testad mot en oberoende port av panelens kod).
- `src/server/awish/web-client.ts` – `createAwishWebClient`: login, products, setProductInventory.
  Bas-URL, appId/appKey och `fetch`/klocka går att skicka in (tester mot låtsas-server).
- `src/server/awish/web-push.ts` – `planAwishPush`: ren funktion som räknar ut vilka fack som ska
  höjas. **Höjer bara**, aldrig sänker (Awish äger försäljningen). Fördelar en titels antal över
  dess fack upp till kapaciteten.
- `src/server/awish/web-service.ts` – `pushMachinesToAwish(orgId, machineIds)`: läser inloggningen
  ur Vault, hämtar Binderlabs maskinlager, planerar och skickar. Bäst-möjligt.
- `src/server/awish/testing/fake-web-server.ts` – låtsas-panel för tester (aldrig riktiga Awish).

## När push sker

Efter att en påfyllning sparats i appen (`/fyll-pa` → `syncRefills`) skickas de påfyllda automaternas
nya antal till Awish. Påfyllningen är redan sparad i Binderlab, så ett fel i push:en fäller aldrig
sparandet: användaren får beskedet "Skicka till Awish" och kan skriva antalet där den gången.

Mappningen Binderlab-automat → Awish-automat är `source_machines.external_id` (Awishs numeriska
maskin-id), samma koppling som orderimporten och lagerläsningen använder.

## Inställningar och säkerhet

- Datakällor → Awish: fyll i **e-post och lösenord** till Awish och slå på **Skicka påfyllningar till
  Awish**. Bara ägare och admin.
- Inloggningen sparas krypterat i Supabase Vault under `{organization_id}/awish_web:{data_source_id}`
  (`public.awish_save_web_credentials`). Den returneras aldrig till webbläsaren och loggas aldrig.
  `data_sources.config.awishWeb` håller bara maskad e-post, `hasPassword` och `enabled`.
- Servern läser inloggningen med `private.awish_read_web_credentials` (systemrollen), aldrig en
  klientroll.
- Push är **av** som standard och kräver sparad inloggning.

## Gränser och framtid

- Detta är **inte** Awishs officiella väg (den officiella gRPC-kopplingen kan bara läsa). Bygger Awish
  om sin panel kan det sluta fungera; då säger Binderlab till och ägaren skriver antalet i Awish den
  gången. Be gärna Awish om ett officiellt API för att skriva lager.
- Push sker vid påfyllning. Om ett enstaka försök misslyckas görs ingen automatisk omförsök i denna
  version; en framtida förbättring är att stämma av i timsynken.
