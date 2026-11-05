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

Inköpspriser → **+ Ny produkt** (`/inkopspriser/ny-produkt`, länk även från Datakällor → Awish). Bara
ägare och admin, och bara när **Skicka påfyllningar till Awish** är på och inloggningen sparad.

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
- **Inga prisändringar.** En vara som redan finns i Awish (samma namn, normaliserat) skapas inte igen
  och dess pris ändras inte (`UpdateGood` används aldrig); den kopplas bara i Binderlab. Har titeln
  redan ett inköpspris behålls det (ändras under Inköpspriser).
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
