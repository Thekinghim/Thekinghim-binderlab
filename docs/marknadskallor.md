# Binderlab: externa källor till marknadspriser

Status: **underlag för beslut. Ingen källa är inkopplad.** Skrivet 2 nov. 2026 i en byggmiljö utan nätverksåtkomst.

Allt om villkor, priser och tillgång nedan bygger på vad som var känt fram till 2025 och har **inte** kunnat kontrolleras mot källornas webbplatser i dag. Villkor och prismodeller för de här tjänsterna har ändrats flera gånger de senaste åren. Varje rad markerad _Kontrollera_ måste stämmas av mot källans aktuella villkor innan något kopplas in, och beslutet tas av beställaren.

## Vad panelen behöver

Marknadspriset används på /marknad (sektion 02) som **referens** bredvid egna offerter och inköp:

- pris för **förseglade produkter** (booster-pack, display/booster box, ETB), inte enstaka kort,
- per titel (set), helst med datum så att utvecklingen kan visas,
- marknad som liknar bolagets: Sverige/EU och SEK eller EUR,
- bara för intern användning (beslut om inköp), ingen vidarepublicering till kunder eller butiker,
- spårbart: källa, datum och länk visas vid varje pris (adaptern kräver det, se nedan).

Egna offerter och inköp (`supplier_price_quotes`, `purchase_order_lines`) är och förblir huvudunderlaget. En extern källa ändrar inga beräkningar av vinst eller inköpspris.

## Kandidater

| Källa                 | Marknad och valuta                            | Förseglat                                                       | Tillgång (enligt kunskap t.o.m. 2025)                                                                                                                                                                      | Kostnad (osäker)                                      |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Cardmarket**        | EU (största marknaden i Europa), EUR          | Ja: displayer, booster, ETB finns som produkter                 | API (v2.0) kräver konto och app-registrering; tredjepartsappar har periodvis inte beviljats. En daglig prisguide (fil) finns för vissa kontotyper. Villkoren begränsar hur data får lagras och visas.     | Kontot gratis; API/prisguide kan kräva proffskonto    |
| **TCGplayer**         | USA, USD                                      | Ja: "sealed products" med market price                          | Ägs av eBay sedan 2022. Det öppna utvecklar-API:t slutade dela ut nya nycklar (ca 2022–2023); tillgång i praktiken bara för befintliga partner.                                                          | Gratis för godkända partner; ny tillgång osannolik    |
| **PriceCharting**     | USA, USD (bygger på sålda annonser, bl.a. eBay) | Ja: förseglade Pokémon-produkter finns i prisguiden            | Betalt abonnemang med API och nedladdningsbar prisguide (CSV). Villkoren tillåter användning inom abonnemanget men inte vidareförsäljning av datan.                                                         | Månadsabonnemang; nivå och pris måste kontrolleras   |
| Pokémon TCG API       | Speglar TCGplayer/Cardmarket                  | Nej, i huvudsak enstaka kort                                    | Öppet API med nyckel. Täcker inte förseglade produkter tillräckligt.                                                                                                                                       | Gratis                                                |
| eBay (sålda annonser) | Global, flera valutor                         | Ja, men ostrukturerat                                           | Sålda annonser kräver Marketplace Insights, som är begränsat till godkända partner.                                                                                                                       | Kräver avtal                                          |
| Tradera               | Sverige, SEK                                  | Ja, men ostrukturerat (annonser)                                | Har ett utvecklar-API; villkor och om sålda priser får hämtas är okänt.                                                                                                                                    | Okänd                                                 |

Skrapning av webbsidor är uteslutet: det bryter mot villkoren hos samtliga källor ovan och är skört.

## Det här måste kontrolleras innan beslut

För den eller de källor som väljs:

1. **Får datan användas kommersiellt och internt** i ett bolags inköpsbeslut? Krävs ett särskilt avtal för företag?
2. **Får priserna lagras** (historik i vår databas) och hur länge? Vissa villkor tillåter bara visning i realtid.
3. **Krav på källhänvisning** (namn, logotyp, länk) där priset visas.
4. **Tillgång i dag**: delar källan ut nya API-nycklar eller prisguider till nya konton? Vilken kontotyp krävs (Cardmarket: privat, kommersiell, proffs)?
5. **Kostnad** per månad och om den beror på antal anrop eller produkter.
6. **Gränser**: anrop per dag/minut, uppdateringsfrekvens för priserna.
7. **Täckning**: finns de titlar bolaget säljer (t.ex. Surging Sparks, Prismatic Evolutions, Black Bolt, Destined Rivals) som förseglade produkter, och med vilket pris (lägsta, trend, sålt)?
8. **Koppling till våra titlar**: källans produkt-id måste mappas mot `titles`. Krävs manuell mappning per titel?
9. **Valuta**: EUR/USD till SEK. Förslaget är Riksbankens dagliga kurser (öppet API) med kursdatum sparat vid varje pris.
10. **Personuppgifter**: källorna ska inte skicka säljarnamn eller annonsuppgifter som vi sparar.

## Förslag

1. **Fortsätt med egna offerter och inköp som underlag** (byggt nu). Det ger prisutveckling per titel och leverantör och flaggar ovanligt billiga eller dyra inköp utan någon extern källa.
2. **Fråga Cardmarket först.** Det är den enda kandidaten med EU-marknad i EUR och förseglade produkter, alltså närmast bolagets inköpsmarknad. Kontrollera punkterna ovan, särskilt om prisguiden får lagras och användas internt av ett bolag.
3. **PriceCharting som andrahandsval** om Cardmarket inte går: tydlig betalmodell, men amerikansk marknad i USD som bara visar riktningen.
4. TCGplayer väljs inte så länge nya nycklar inte delas ut.

Beställaren väljer källa och godkänner villkor och kostnad. Därefter byggs en adapter för källan och den kopplas in med miljövariabeln nedan.

## Så är det byggt

- Gränssnittet `MarketPriceSource` i `src/server/market/sources/types.ts`: `fetchPrices(titlar) → pris per titel` med källa, produktnamn, typ av förseglad produkt, valuta, pris i minsta enhet, pristyp, datum och länk.
- `MARKET_PRICE_SOURCE` väljer källa (`src/server/market/sources/index.ts`):
  - `none` (standard): panelen visar "Ej konfigurerad" och nämner kandidaterna.
  - `local`: `LocalMarketPriceSource` läser `.data/market-prices.json` (eller `MARKET_PRICE_LOCAL_FILE`). Bara för utveckling och test, vägrar i production, och priserna märks "Lokal testkälla" i panelen.
  - `tcgplayer`, `cardmarket`, `pricecharting`: ger läget "inte inkopplad" med förklaring. Det finns medvetet ingen implementation.
- En ny källa läggs till som en klass som implementerar `MarketPriceSource`, med nycklar i miljövariabler (aldrig i databasen), och registreras i `marketSourceStatus`. Priser som ska sparas läggs i `supplier_price_quotes` med `source = 'market'`, så att de syns i samma prisutveckling och kan skiljas från egna offerter.

Filformat för den lokala källan:

```json
{
  "prices": [
    {
      "title": "Surging Sparks",
      "productName": "Surging Sparks Booster Pack",
      "kind": "booster-pack",
      "currency": "SEK",
      "priceMinor": 5490,
      "priceType": "lowest",
      "observedOn": "2026-11-01",
      "url": null
    }
  ]
}
```
