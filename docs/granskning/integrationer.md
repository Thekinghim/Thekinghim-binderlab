# Integrationer

## Awish (DingShang): två vägar

| Väg                                            | Vad                                                                                                                                                | Grund                                                                       | Kod                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Officiella gRPC-API**                        | Läser: konto (Merchant), automater, order, fack och antal (Products). Skriver bara kampanjbilder och gratis-pack-koder, efter bekräftelse i appen. | Leverantörens API-dokumentation; AppId/AppSecret/AppKey per kund            | `src/server/awish/grpc-client.ts`, `sync.ts`, `stock.ts`, [docs/awish-api.md](../awish-api.md)             |
| **Webbpanelens API** (dash.awish.vip, GraphQL) | Skriver: antal i facken efter en påfyllning, nya varor, vara i fack                                                                                | DingShangs skriftliga svar 2026-11-05 (nedan); kundens egen panelinloggning | `src/server/awish/web-client.ts`, `web-service.ts`, `new-product.ts`, [docs/awish-web.md](../awish-web.md) |
| **Orderlistan (CSV)**                          | Reserv om API:t inte svarar: exporten från panelen laddas upp                                                                                      | Kundens egen export                                                         | `src/import/adapters/awish-csv.ts`                                                                         |

**Godkännandet 2026-11-05.** DingShang svarade skriftligt: "Yes, that's fine. You can build a
feature that allows you to create products directly on your website." Skärmbild:
[`docs/img/awish-godkannande-produkter-2026-11-05.png`](../img/awish-godkannande-produkter-2026-11-05.png).
Svaret gäller ordagrant att **skapa produkter**. Att skriva **antal i facken** (påfyllning) via
samma API nämns inte uttryckligen; den funktionen fanns före svaret och är avstängd som
standard per organisation.

### Risker och hur de möts

| Risk                                                                         | Åtgärd i koden                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Awish ändrar sin webbpanel (inofficiellt API) och skrivningen slutar fungera | Påfyllningen sparas i Binderlab först; ett fel mot Awish fäller aldrig sparandet ("Skicka till Awish" för hand). Låtsas-panelen i testerna nekar allt som avviker från panelens egna anrop (`testing/dashboard-documents.ts`). |
| Felaktig skrivning (fel fack, sänkt antal)                                   | Påfyllning höjer bara, aldrig sänker. Ny produkt: förhandsvisning med fingeravtryck, servern räknar om planen och skickar inget om den ändrats; byte av vara i ett fack med pack kräver bekräftelse.                           |
| Läckt inloggning                                                             | Inloggningarna i Supabase Vault, aldrig till webbläsaren eller loggar.                                                                                                                                                         |
| gRPC utan TLS (leverantörens adress har ingen TLS i dokumentationen)         | Varning i loggen; `AWISH_GRPC_TLS` slår på TLS när Awish erbjuder det ([docs/awish-api.md](../awish-api.md)).                                                                                                                  |
| API:t svarar inte                                                            | Synken försöker igen var 10:e minut med sidläge och tidsbudget; larm "datakällan är inaktuell"; CSV-uppladdning som reserv.                                                                                                    |
| Leverantören stänger eller byts ut                                           | Plattformsgränssnittet nedan: allt efter importen är oberoende av Awish, och "Annan automat (CSV)" fungerar utan någon integration.                                                                                            |
| Utan avtal kan Awish dra tillbaka åtkomsten                                  | **Ägaren behöver ett skriftligt avtal** med Awish om API-åtkomst och om skrivning av fack-antal (se nedan).                                                                                                                    |

Inget test anropar riktiga Awish: gRPC-testerna kör mot en låtsasserver på 127.0.0.1
(`src/server/awish/testing/fake-server.ts`) och webbtesterna mot en låtsaspanel
(`fake-web-server.ts`).

## Plattformsgränssnittet (oberoende av leverantör)

`src/server/platforms` beskriver vad Binderlab behöver från en automatplattform:

| Förmåga           | Krävs | Awish            | Annan automat (CSV)             |
| ----------------- | ----- | ---------------- | ------------------------------- |
| Order in (fil)    | en av | ja (orderlistan) | ja                              |
| Order in (API)    | en av | ja (gRPC)        | nej                             |
| Lista automater   | nej   | ja               | nej (skapas ur filen)           |
| Läsa fack/saldo   | nej   | ja               | nej (saldot räknas i Binderlab) |
| Skriva påfyllning | nej   | ja (webbpanelen) | nej                             |
| Skriva varor/pris | nej   | ja (webbpanelen) | nej                             |

- `types.ts`: gränssnittet (`MachinePlatform`, `PlatformConnection`, `PlatformCapabilities`).
- `catalog.ts`: vilka datakällor (`data_sources.provider`) som hör till vilken plattform och
  vad de kan. Används av Datakällor (tar källan emot filer?), larmen (laddas den upp för hand?)
  och, med samma regel, databasens täckningsfunktion `private.sales_data_until_rows`.
- `awish.ts`: tunt omslag runt den befintliga Awish-koden, utan ändrat beteende. Testat mot
  låtsas-Awish: samma tolkning som synken och samma resultat som CSV-adaptern
  (`src/server/platforms/platforms.test.ts`).
- `manual-csv.ts`: "Annan automat (CSV)", nedan.

### Annan automat (CSV)

En operatör med ett annat märke (eller utan API) väljer **Datakällor → Lägg till datakälla →
Automater: Annat märke (CSV)** och laddar upp försäljningen. Mallen (knappen **Ladda ner mall**):

```
Datum;Tid;Automat;Produkt;Belopp;Antal
2026-11-03;14:05;Butik Centrum;Pokémon Scarlet & Violet Booster;79;1
2026-11-03;16:40;Butik Centrum;Pokémon 151 Booster;178;2
```

- Rubrikerna hittas automatiskt (svenska, engelska eller danska/norska, t.ex.
  Date/Machine/Product/Amount eller Dato/Automat/Produkt/Beløb);
  komma, semikolon eller tab; UTF-8 eller Windows-1252.
- Datum `ÅÅÅÅ-MM-DD` eller `DD.MM.ÅÅÅÅ`; utan klockslag används kl. 12.00. Belopp är radens
  belopp; med Antal delas det lika per pack (en order per pack, som för Awish).
- Utan ordernummer räknas ett fast id fram ur raden, så att samma fil (eller samma dagar igen)
  blir dubbletter och inte dubbel försäljning. Ladda upp hela dagar.
- Sedan är allt som för Awish: koppla automaterna en gång, nya titlar får inköpspris, och
  lönsamhet, prognos, rapporter och export fungerar likadant. Saldot i automaten räknas från
  påfyllningar och försäljning (plattformen kan inte läsas).

Kod och tester: `src/import/adapters/manual-csv.ts`, `src/import/manual-csv.test.ts`,
`test/db/granskning.test.ts` (import, dubbletter, lager och täckning mot riktig Postgres).

### Lägga till en ny plattform

Steg för steg i [`src/server/platforms/README.md`](../../src/server/platforms/README.md).

## Övriga integrationer

E-post (Resend), fel (Sentry), push (Web Push), assistent (Anthropic) och bokföring (SIE 4-fil;
Fortnox, Visma och Bokio har gränssnittet men ingen implementation): se
[arkitektur.md](arkitektur.md) och [docs/architecture.md](../architecture.md).
