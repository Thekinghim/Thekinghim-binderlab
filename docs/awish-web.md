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

## Ny produkt: skapa varor och lägga dem i fack

**Godkännande.** DingShang (som gör Awishs panel) bekräftade skriftligt 2026-11-05: "Yes, that's fine.
You can build a feature that allows you to create products directly on your website." Skärmbild:
[`docs/img/awish-godkannande-produkter-2026-11-05.png`](img/awish-godkannande-produkter-2026-11-05.png).

Inköpspriser → **Varor i Awish** (`/inkopspriser/ny-produkt`, flikarna **Redigera vara** och **Ny
produkt** (`?flik=ny`); länk även från Datakällor → Awish). Bara ägare och admin, och bara när
**Skicka påfyllningar till Awish** är på och inloggningen sparad. Redigera vara beskrivs i nästa
avsnitt.

- **Ny produkt**: namn, försäljningspris (det kunden betalar i automaten), inköpspris (bara i
  Binderlab), Egen produkt och en valfri bild (jpg/png/webp, högst 4 MB; stora bilder krymps i
  webbläsaren). Skapar varan i Awish och sedan titeln, aliaset (varans namn), inköpspriset (från
  idag) och Egen produkt i Binderlab, i en transaktion. Försäljning med varans namn kopplas då av sig
  själv till titeln.
- **Lägg i fack**: automat (Binderlab-automater med `source_machines.external_id`), fack (läses ur
  Awish med vara och antal) och vara (alla varor i Awish, även en nyss skapad), valfritt antal.

### Säkerhet

- **Förhandsgranska först.** Varje skrivning visar exakt vad som ändras ("Awish: ny vara X, 79 kr",
  "Fack A1: Mystery Pack 5 st → X 7 st") före knappen **Skicka till Awish**. Förhandsvisningen ger ett
  fingeravtryck av planen; vid Skicka räknar servern fram planen igen (läser Awish och Binderlab på
  nytt) och skickar ingenting om den skiljer sig (annan bild, annat pris, facket ändrat under tiden).
- **Bekräftelse.** Ett fack som har pack byter aldrig vara, och får aldrig lägre antal, utan att
  användaren kryssar i frågan ("Fack A1 har 5 Mystery Pack – byt ändå?"). Servern kräver det också.
- **Egen produkt slås bara på, aldrig av, härifrån.** Är en befintlig titel redan Egen produkt
  behålls den (med en varning i förhandsvisningen), precis som ett befintligt inköpspris.
- **Fack med antal men utan vara** räknas som fack med pack: byte kräver bekräftelse.
- **Inga prisändringar här.** En vara som redan finns i Awish (samma namn, normaliserat) skapas inte
  igen och dess pris ändras inte av Ny produkt; den kopplas bara i Binderlab. Priset ändras under
  Redigera vara. Har titeln redan ett inköpspris behålls det (ändras under Inköpspriser).
- **Inget halvgjort.** Awish anropas först; misslyckas något där (valuta, bild, varan) sparas
  ingenting i Binderlab. Binderlab skrivs sedan i en transaktion. Skulle just den misslyckas finns
  varan i Awish och nästa försök kopplar den (planen blir "finns redan").
- **Dubbelklick.** En skrivning till Awish i taget per organisation (`pg_try_advisory_xact_lock`),
  plus att knappen är låst medan anropet pågår.
- Gränser: försäljningspris 0,01–10 000 kr, inköpspris 0–10 000 kr, namn högst 100 tecken, antal
  0–fackets kapacitet (`inventory`, annars `channel.total`), fack med `floor_status` ≠ `ERR_NORMAL`
  ändras inte (som i panelen).
- Inloggningen läses ur Vault och lämnar aldrig servern; inget hemligt loggas (bara felets namn och
  SQLSTATE).

## Redigera vara och listan "Varor i Awish"

Godkännandet ovan (DingShang 2026-11-05) gäller även att ändra varor. Fliken **Redigera vara** visar
alla varor i Awish med det en chef behöver se, räknat ur Binderlab (Awish visar bara id, kod och
pris). Inga andra anrop än `Goods` (alla sidor) och `Products` per kopplad automat.

- **Per vara:** kvadratisk bild, namn, pris; sålt senaste 30 dagarna (st och kr, order via titelns
  alias som importen); fack och pack just nu per automat; vårt lager (summan av de egna lagren);
  inköpspris och **kvar per order** (hela beloppet, samma `currentPriceEconomics` som Inköpspriser;
  vår del bara när en butik eller automat är vald i filtret).
- **Flaggor** (en per problem): Samma namn två gånger i Awish · Inte kopplad till Binderlab (knappen
  **Koppla**: ny titel med varans namn eller alias på en befintlig titel) · Saknar inköpspris (länk
  till Inköpspriser) · Ingen bild · Ligger inte i något fack · Låg marginal (inköp ≥ 80 % av priset) ·
  Sålt 0 st på 30 d (bara när varan ligger i ett fack och inget filter är valt).
- **Ordning:** det som behöver åtgärd först, sedan bäst säljande, sedan namn. Sökruta (namn, titel,
  id) och filter Alla / Behöver åtgärd / I automat / Inte i automat. På mobilen syns tre varor och
  "Alla N varor" fäller ut resten.
- **Inköpspriser → titel → "Redigera namn, pris och bild i Awish →"** öppnar fliken med varan vald
  (`?titel=<id>`, varan vars namn hör till titeln; flera: sökningen fylls i).
- **Bilder** visas via `/inkopspriser/ny-produkt/bild?u=…&s=…` (sidornas CSP tillåter bara `'self'`).
  Adressen är HMAC-signerad av servern, som bara signerar bildadresser Awish svarat med, så det är
  ingen öppen proxy. Bara ägare och admin, bara bildtyper, högst 5 MB, inga omdirigeringar, och i
  drift aldrig interna adresser (localhost, privata nät, 169.254.x.x).

**Redigera:** namn (1–100 tecken), försäljningspris (0,01–10 000 kr) och bild (samma kvadrat 600×600
som Ny produkt, med förhandsbild). Inköpspris och Egen produkt ändras under Inköpspriser (länk).

1. **Förhandsgranska** visar t.ex. "Namn: Delta Reign → Delta Reign ETB", "Pris: 150 kr → 160 kr",
   "Bild: byts", "Binderlab: lägger till namnet … så försäljningen kopplas rätt", och för ett nytt
   pris "Kvar per order: 67 kr → 77 kr" och "≈ +300 kr per månad om försäljningen håller i sig (12
   sålda senaste 30 d). En uppskattning." Effekten räknas med samma ekonomi som Inköpspriser:
   titelns betalda order de senaste 30 dagarna räknas om till det nya priset (kortavgift, VMB,
   butikens andel och dagens inköpspris följer med); utan försäljning räknas ett tänkt pack. Inget
   ändrat → ingen knapp.
2. **Spara i Awish** räknar fram allt igen och skickar bara om fingeravtrycket stämmer. Det täcker
   planen OCH hela varan som den lästes i Awish (och kontots behörigheter): har någon ändrat varan i
   panelen under tiden skickas ingenting.
3. Efteråt läses varan tillbaka. Listan uppdateras direkt (optimistiskt) och sedan med det Awish
   faktiskt sparade. Sparades inte allt sägs det ("Awish sparade inte priset …").

**Namnbyte och Binderlab:** det nya namnet läggs till som alias på samma titel; det gamla aliaset
finns kvar så gamla order hamnar rätt (var titeln bara kopplad via sitt namn läggs även det gamla
namnet till som alias). Titeln byter namn bara om den hette exakt som varan (normaliserat), och inte
om en annan titel redan heter det nya namnet. Beskrivning och innehåll i Awish som var namnet (det
Ny produkt sätter) följer med; en egen beskrivning rörs inte.

**Stopp:** två varor i Awish skulle heta samma (normaliserat) · det nya namnet hör redan till en
annan titel i Binderlab · titeln är arkiverad · varan saknar SEK-pris · varan skulle sakna bild
(panelen sparar aldrig en vara utan bild) · kontot saknar `goods:update`/`goods:create` i Awish ·
varan har ordinarie pris, medlemspris, kostnadspris eller egenskaper som kontot saknar behörighet
för (panelen skickar då 0/[] och skulle nollställa dem; Binderlab stoppar i stället och ber ägaren
ändra varan direkt i Awish).

**Ordningen:** bilden laddas upp först (en bild som blir över är ofarlig). Sedan, i en transaktion i
Binderlab: alias och titelnamn skrivs, `UpdateGood` skickas, varan läses tillbaka. Nekar Awish, eller
sparades inte namnet, rullas Binderlab tillbaka. Går svaret på `UpdateGood` förlorat (tidsgräns, 503) läses varan först: har Awish ändå sparat det nya namnet sparas Binderlab (annars skulle
försäljningen under det nya namnet hamna på en ny titel). Går varan inte att läsa tillbaka efter ett "ja"
sparas Binderlab (aliaset är ofarligt) och användaren ombeds kontrollera. Samma lås per organisation
som Ny produkt stoppar dubbelklick.

### Anropen (ordagrant panelens, ur dess publika JavaScript, version 1.30.4)

Dokumenten finns i `src/server/awish/web-documents.ts`. Låtsas-panelen har en egen kopia
(`testing/dashboard-documents.ts`) och nekar allt som avviker: annan operation, andra variabler eller
typer, andra argument, urval på en skalär mutation, saknat urval, fält som panelen inte frågar efter
(utom `products.good_id`, som påfyllningen använt i drift), okända fält i indata, priser som strängar.

```graphql
query Profile {
  profile {
    id
    email
    username
    profile_url
    status
    email_verified_at
    permissions
    merchant {
      id
      title
      logo
      verified_at
      expired_at
      is_dev
      debug
      tax_enabled
    }
    role {
      id
      name
      display_name
    }
    is_readonly
    is_email_verified
    agent {
      id
      parent_id
      agent_level_id
      agent_type_id
      commission_rate
      name
      path
      status
      region_code
    }
  }
}

query UnitsAndCurrencies($input: CurrenciesQueryInput!) {
  units {
    id
    name
    display_name
    multiplier
    base_unit
    description
  }
  currencies(input: $input) {
    id
    name
    code
    symbol
  }
}
#   variables: { input: { merchant_id: <profile.merchant.id> } }  → valutan med code "SEK"

query Goods($input: GoodsQueryInput!) {
  goods(input: $input) {
    total
    currentPage
    perPage
    lastPage
    data {
      id
      name
      description
      multi_currency_enabled
      prices {
        id
        price
        original_price
        member_price
        cost_price
        currency {
          id
          name
          code
          symbol
        }
      }
      thumb
      media
      content
      slug
      updated_at
      age_verification_enabled
      age_verification_min
      unit {
        id
        name
        display_name
        multiplier
        base_unit
        description
      }
      attributes {
        id
        label_name
        label_value
        immutable
      }
      is_tax_exempt
      tax_rate
      is_returnable
    }
  }
  goodsStatistics {
    id
    title
    header_extra
    value
    footer
    link
    disabled
  }
}
#   variables: { input: { per_page: 20, current_page: n } }  (som panelens "Välj vara"; alla sidor läses)

mutation CreateGood($input: GoodInput!) {
  createGood(input: $input)
}
#   skalärt svar. input som panelens "Ny vara" (GoodsCreate), fältordningen bevarad:
#   { name, description: name, thumb: <bildens url eller "">, content: "<p>name</p>", media: [url] eller [],
#     multi_currency_enabled: false, slug: "", unit_id: null, attributes: [], is_tax_exempt: true,
#     tax_rate: 0, is_returnable: false,
#     prices: [{ id: 0, currency_id: <SEK>, price: 79.5, original_price: 0, member_price: 0, cost_price: 0 }] }

mutation UpdateGood($id: Int!, $input: GoodInput!) {
  updateGood(id: $id, input: $input)
}
#   skalärt svar (inget urval). Panelens sida "Redigera vara" (create-*.js, samma komponent som
#   "Ny vara" med id) läser varan och skickar HELA varan tillbaka. Ur panelens handler, ordagrant:
#     prices.map(e => ({ id: e.id, good_id: e.good_id, currency_id: e.currency_id, price: e.price,
#       original_price: hasPermission(["goods:original_price:update"]) ? e.original_price : 0,
#       member_price:   hasPermission(["goods:member_price:update"])   ? e.member_price   : 0,
#       cost_price:     hasPermission(["goods:cost_price:update"])     ? e.cost_price     : 0 }))
#     { name, description, thumb: thumb ?? media[0], content, media, multi_currency_enabled, slug,
#       unit_id, attributes: hasPermission(["goods:attributes:update"]) ? attributes : [],
#       is_tax_exempt, tax_rate: parseFloat(tax_rate), is_returnable, prices }
#     await updateGood({ id, input })
#   Vid läsningen gör panelen om priserna till tal (parseFloat), currency_id = currency?.id ?? 1,
#   unit_id = unit?.id. good_id finns inte i panelens prisfråga och blir undefined (utelämnas i JSON),
#   så Binderlab skickar det inte heller. Behörigheterna är Profile.permissions (lista strängar;
#   hasPermission = någon av dem). Panelen sparar inte utan "goods:create" eller "goods:update" och
#   inte en vara utan bild (media tom). Binderlab läser varan med samma Goods-fråga som listan
#   (samma fält som panelens Good-fråga utom category_id, som inte skickas) och ändrar bara:
#     name, SEK-priset (samma pris-id; andra valutor oförändrade), thumb + media[0] vid ny bild
#     (gamla huvudbilden ut, övriga bilder kvar, högst 5), och description/content om de var namnet.
#   unit_id skickas som null när varan saknar enhet (panelen utelämnar det; null är detsamma för ett
#   frivilligt fält och är vad CreateGood redan skickar).

query Products($input: String!) {
  products(input: $input) {
    id
    machine_id
    status
    floor_status
    lock_status
    lock_id
    current_inventory
    inventory
    channel {
      id
      model_id
      name
      total
      sort_id
      motor_id
      x
      y
      addr
      is_dc
      is_lp
    }
    locker {
      id
      model_id
      name
      total
      sort_id
      motor_id
      x
      y
      addr
    }
    good {
      id
      name
      description
      price
      original_price
      multi_currency_enabled
      prices {
        id
        price
        original_price
        currency {
          id
          name
          code
          symbol
        }
      }
      thumb
      media
      content
      slug
      updated_at
      age_verification_enabled
      age_verification_min
      unit {
        id
        name
        display_name
        multiplier
        base_unit
        description
        immutable
      }
      attributes {
        id
        label_name
        label_value
        immutable
      }
      is_returnable
    }
  }
}
#   input: signerad base64 av { machine_id }

mutation UpdateProduct($id: Int!, $input: ProductInput!) {
  updateProduct(id: $id, input: $input)
}
#   skalärt svar. input som panelens facksida: { good_id, status (oförändrad), current_inventory }
```

Bilden laddas upp som panelens MediumUpload: `POST https://dash.awish.vip/api/v1/files`
(`VITE_GLOB_UPLOAD_URL`), `multipart/form-data` med fälten `compress={"quality":80}`,
`crop`, `thumbnail`, `resize` (alla `{"width":400,"height":400}`) och filen som `file`. Headers:
`Authorization: <access_token>` (utan "Bearer", som panelen), `Appid`, `timestamp` (sekunder). Svaret
har `file_url`, som blir `thumb` och `media[0]`. Panelen tar 5 MB; Binderlab högst 4 MB (Vercel tar
emot 4,5 MB per anrop).

Varans id: `createGood` svarar med ett skalärt värde som inte används; Binderlab läser Goods före och
efter och tar den enda nya varan med samma namn.

Dokumenterade men **inte** använda:

```graphql
mutation UpdateGood($id: Int!, $input: GoodInput!) {
  updateGood(id: $id, input: $input)
} # priser ändras inte här
query Categories($machine_id: Int!) {
  categories(machine_id: $machine_id) {
    id
    title
    machine_id
    sort_id
    is_visible
    priority
  }
}
mutation CreateProduct($machine_id: Int!) {
  createProduct(machine_id: $machine_id)
} # "Synka fack", bara root
query Channels($addr: Int, $model_id: Int!) {
  channels(addr: $addr, model_id: $model_id) {
    id
    model_id
    name
    total
    motor_id
    floor_type
    x
    y
    addr
    is_auxiliary
    is_dc
    is_lp
  }
}
```

- **Kategori:** panelens GoodInput har ingen kategori. Kategorier hör till automatens skärm
  (`categories(machine_id)`) och sätts per fack (`ProductInput.category_id`, bara i panelens låsdialog).
  Binderlab sätter därför ingen kategori; facket behåller sin.
- **Fack skapas inte:** `CreateProduct` är panelens "Synka fack" och kräver root. Facken måste finnas.
- **Byte av vara:** panelens "Välj vara" använder `BatchUpdateProducts(machine_id, { ids, good_id })`;
  Binderlab använder i stället samma `UpdateProduct` som påfyllningen (panelens Redigera skickar
  `good_id` i den, och "Koppla loss" sätter `good_id: null` med den), så att vara och antal sätts i
  ett anrop.
- **Bild krävs i panelen:** panelens formulär stoppar en vara utan bild innan den skickas. Binderlab
  skickar då `media: []` och `thumb: ""`; om riktiga Awish nekar det visas Awishs fel och inget sparas i
  Binderlab. Välj en bild för att vara säker.

### Prova lokalt

```bash
npx tsx scripts/dev/fake-awish-web.ts                       # låtsas-panel på 127.0.0.1:4555
AWISH_WEB_BASE_URL=http://127.0.0.1:4555 NEXT_DIST_DIR=.next-dev npx next dev --webpack
```

`AWISH_WEB_BASE_URL` gäller bara https, eller http mot 127.0.0.1/localhost utanför drift.
