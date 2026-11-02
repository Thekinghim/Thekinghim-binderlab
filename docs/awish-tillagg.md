# Awish Chrome-tillägget: automatisk synk

Beställaren ska aldrig behöva ladda ner något från Awish. Binderlabs Chrome-tillägg läser orderlistan i
Awish-panelen (`https://dash.awish.vip/dashboard/orders/index`) med användarens egen inloggning i Chrome och
skickar ordrarna till Binderlab var tionde minut. Ordrarna går genom samma importflöde som en uppladdad CSV
(`docs/awish.md`). När Awish har levererat app-ID, token och specifikationen för gRPC ersätter
`awish_grpc`-adaptern tillägget (se sist).

## Så fungerar det

```
Chrome (inloggad på dash.awish.vip)
  └─ tillägget (service worker, var 10:e minut)
       1. GET  {Binderlab}/api/ingest/awish/status   → senaste ordernumren
       2. GET  dash.awish.vip/dashboard/orders/index → sida 1, 2, … (JSON om panelen har det, annars HTML)
       3. POST {Binderlab}/api/ingest/awish          → batcher om högst 200 rader
       4. POST {Binderlab}/api/ingest/awish          → rapport (ok / utloggad / fel)
Binderlab
  └─ token → datakälla (awish_extension) → samma pipeline som CSV → import med trigger 'extension'
```

- **Avläsning.** Kolumnerna hittas på rubriktexterna (ID, Date, Name, Order No., Order Machine, Payment Method,
  Order Amount, Is Paid, Payment Time, Actions), aldrig på ordningen. Skiftläge, mellanslag och skiljetecken
  spelar ingen roll, och en fast rubrik i en egen tabell (som Bootstrap Table och Layui ritar) fungerar.
  Actions ignoreras. Värdena skickas som Awish visar dem ("Amount: 170.00", "Paid Success", Payment Time i
  källans tid). Binderlab tolkar dem med CSV-adapterns regler, så "Discount Amount" och "Paid Amount" tas
  aldrig som belopp.
- **JSON i första hand.** Om panelen laddar tabellen med XHR eller fetch använder tillägget samma API. Det
  hittas på två sätt: ett innehållsskript i panelen noterar adressen när panelen själv hämtar ordrar som JSON
  (bara adressen, aldrig svaret), eller så frågar tillägget orderlistans adress som ett XHR-anrop
  (`X-Requested-With: XMLHttpRequest`, med `offset`/`limit` som FastAdmin-paneler svarar på). Svarar inget med
  JSON läses HTML-tabellen. Det provas igen efter ett dygn.
- **HTML.** En service worker har ingen DOM, så HTML-sidan tolkas med `DOMParser` i ett offscreen-dokument.
  Går det inte att starta används en inbyggd tolk som reserv.
- **Var den slutar läsa.** Status-API:t ger de 500 senaste ordernumren. En vanlig synk läser från sida 1 tills
  den når ett känt ordernummer, och sedan en sida till. Den skickar bara ordrar som Binderlab inte har. En ej
  betald order skickas en gång, och igen när den blivit betald.
- **Hela historiken.** Första gången (eller när Binderlab inte har några order från källan, eller efter
  **Läs hela historiken igen**) läses alla sidor bakåt, en sida i sekunden. Läget sparas i `chrome.storage`
  efter varje skickad batch, så att en avbruten läsning fortsätter där den slutade vid nästa alarm.
- **Återförsök.** 429 (med `Retry-After`), 5xx och nätverksfel prövas igen efter 2, 4, 8, 16 och 32 sekunder.
  401 och 403 stoppar synken direkt: token är ogiltig eller återkallad.
- **Utloggad.** Leder Awish till inloggningen, eller svarar med ett lösenordsfält utan ordertabell eller med
  JSON som säger att man ska logga in, läses ingenting. Popupen visar _"Logga in på dash.awish.vip i Chrome så
  fortsätter synken"_, ikonen får ett utropstecken, och Binderlab får en rapport som syns under Datakällor.
- **Larm.** Varje lyckad synk (även utan nya ordrar) uppdaterar `data_sources.last_synced_at`. Har tillägget
  inte rapporterat på mer än två timmar slår importregeln till (`importAlerts` i
  `src/analytics/alerts/rules.ts`; `expectedInterval('awish_extension') = 40` minuter × 3). Klockan startar när
  källan skapas, så en ny källa larmar inte innan tillägget har hunnit installeras.
- **Idempotens.** Ordernumret är unikt per datakälla. Samma rad igen blir en dubblett. En rad med samma
  ordernummer men andra värden blir en konflikt i importloggen, och ordern ändras aldrig.
- **Tidszon.** Payment Time tolkas i datakällans `source_timezone` (Asia/Shanghai tills den kontrollerats mot
  order 42780, se `docs/awish.md`). JSON-tider som är Unix-tidsstämplar skickas som UTC med `Z`.

## Installation (beställaren)

Under **Datakällor → Automatisk synk (Chrome-tillägg)**:

1. **Skapa datakälla för tillägget** (typ Awish-tillägg, källans tidszon Asia/Shanghai) och **Skapa token**
   (en per dator). Token visas en gång: kopiera den. Klicka sedan **Ladda ner binderlab-awish-sync.zip** och
   packa upp zip-filen i en mapp som du behåller.
2. Öppna `chrome://extensions`, slå på **Utvecklarläge**, klicka **Läs in okomprimerat** och välj mappen.
3. Klicka på Binderlab-ikonen i Chrome och klistra in Binderlabs adress (visas på sidan) och token. Klicka
   **Spara**.
4. Klart. Var inloggad på dash.awish.vip i Chrome. Första synken läser hela historiken. Därefter hämtas nya
   ordrar var tionde minut så länge Chrome är öppet på datorn. Statusen syns under Datakällor och i
   tilläggets popup.

Samma Awish-konto ska inte samtidigt importeras som CSV till en annan datakälla. Ordernumret är unikt per
datakälla, så orderna blir annars dubbla.

## Felsökning

| Det syns                                  | Orsak och åtgärd                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "Utloggad från Awish"                     | Sessionen i Awish har gått ut. Logga in på dash.awish.vip i samma Chrome. Synken fortsätter vid nästa alarm, eller klicka Synka nu. |
| "Tyst > 2 h" / larm "Ingen hämtning från" | Chrome är stängt, datorn sover eller tillägget är avstängt. Öppna Chrome. Tillägget synkar inom 10 minuter.                         |
| "Binderlab nekar token"                   | Token är återkallad, eller skaparen är inte längre ägare eller admin. Skapa en ny token och klistra in den.                         |
| "Hittar inte ordertabellen"               | Awish har ändrat sidan så att rubrikerna inte känns igen. Rubrikernas synonymer finns i `extensions/awish-sync/src/reader.ts`.      |
| Rader med fel i importloggen              | Samma regler som CSV (`docs/awish.md`), t.ex. ett tvetydigt belopp. Se importens radlogg under Datakällor.                          |
| Fel tid på ordrarna                       | Källans tidszon är fel. Ändra den på datakällan (gäller nästa batch) enligt kontrollen mot order 42780.                             |

Tilläggets egen logg finns under `chrome://extensions` → Binderlab → **Service worker** (Inspektera).
Popupen visar senaste körning, antal sidor och rader, om JSON eller HTML lästes, och senaste fel.

## Säkerhet

- **Token.** `blsync_` följt av 256 slumpade bitar. Binderlab sparar bara sha256 (`sync_tokens.token_hash`) och
  de första tecknen. En token är bunden till en organisation och en datakälla av typen `awish_extension`.
  Organisationen och datakällan tas alltid ur token, aldrig ur det som skickas. Ägare och admin skapar och
  återkallar tokens; läsare, påfyllare och butiker ser dem inte (RLS). En återkallad token kan inte
  återställas (trigger). Skapande, namnbyte och återkallelse loggas i `audit_log`. Hash och kontaktfält tas
  bort ur loggraden.
- **Skrivningar med RLS.** Allt som batchen skriver (import, order, titlar, källautomater, `last_synced_at`)
  görs som den som skapade token, med RLS och bara medan hen är ägare eller admin. Tappar hen rollen slutar
  token att fungera.
- **API:t.** `/api/ingest/*` är öppet i proxyn (`src/server/auth/paths.ts`); skyddet är token i
  `Authorization: Bearer`. Cookies läses aldrig och svaret sätter aldrig cookies. CORS tillåter bara
  `chrome-extension://`-ursprung. En begäran från en webbsida (`Origin: https://…`) nekas med 403, även med
  giltig token. Gränser: 120 batcher och 120 statusfrågor per token och minut, högst 500 rader och 2 MB per
  batch, och 20 ogiltiga tokenförsök per IP och minut. Gränserna räknas i minnet per serverinstans.
- **Tilläggets behörigheter.** `storage`, `alarms`, `offscreen` och host-behörighet för
  `https://dash.awish.vip/*`. Binderlabs adress är en valfri behörighet som efterfrågas när adressen sparas.
  Utan den går anropen via CORS. Tillägget har inga behörigheter för `tabs`, `cookies`, `webRequest` eller
  `<all_urls>`. Det läser bara Awish-panelen och skickar bara till den Binderlab-adress som användaren angett
  (https, eller http mot localhost för utveckling). Token sparas i `chrome.storage.local` på datorn och visas
  aldrig igen i popupen.
- **Innehållsskripten** i Awish-panelen ändrar inget på sidan. Det ena (sidans egen värld) noterar adressen
  när panelen hämtar ordrar som JSON, och det andra lämnar adressen till tillägget. Svaren lämnar aldrig
  sidan.

## För utvecklare

| Del                 | Var                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Tillägget (MV3)     | `extensions/awish-sync/` (`manifest.json`, `src/*.ts`, `popup.html`, `offscreen.html`)                |
| Bygget och zip      | `node scripts/extension/build.mjs` → `extensions/awish-sync/dist/` och `public/downloads/…zip`        |
| Adaptern            | `src/import/adapters/awish-extension.ts` (batch → CSV-regler → `RawOrder`)                            |
| Ingest              | `src/server/ingest/` (token, gränser, import, status, Datakällor-funktioner, server actions)          |
| Rutterna            | `src/app/api/ingest/awish/route.ts` (POST, OPTIONS), `…/status/route.ts` (GET, OPTIONS)               |
| Datakällor          | `src/app/(app)/datakallor/_components/extension-section.tsx`, `extension-panel.tsx`                   |
| Migreringar         | `20261102235500_tillagg_enums.sql`, `20261102235600_tillagg_sync_tokens.sql`                          |
| Tester (enhet)      | `src/import/adapters/awish-extension*.test.ts` (adapter, avläsning, synk, zip)                        |
| Tester (databas)    | `test/db/ingest-api.test.ts`                                                                          |
| Tester (end-to-end) | `npx vitest run -c extensions/awish-sync/vitest.e2e.config.ts` (dev-servern på 3200 och dess databas) |

Zip-filen är incheckad, och testet `awish-extension-build.test.ts` fallerar om den inte är byggd från
källkoden. Kör bygget efter varje ändring i `extensions/awish-sync/`. Testbygget med `--awish-origin` (bara för
e2e) byter Awish-adressen och behörigheterna.

API (för felsökning med curl):

```
GET  /api/ingest/awish/status        Authorization: Bearer blsync_…
  → { ok, dataSource, lastSyncedAt, orders: { count, latestExternalId, latestOrderedAt, knownExternalIds }, limits }
POST /api/ingest/awish               Authorization: Bearer blsync_…   Content-Type: application/json
  { rows: [{ externalId, title, machine, amount, isPaid, paidAt, paymentMethod?, rowId?, orderDate?, page?, pageRow? }],
    absent?: ["paymentMethod"], report?: { state: "ok"|"logged_out"|"error", message? }, client?: { version } }
  → { ok, importId, summary: { total, new, duplicate, conflict, error, notPaid }, unknownMachines, newTitles, lastSyncedAt }
  Fel: { ok: false, error, code } med 400, 401, 403, 409 (pausad källa), 413, 429 (Retry-After), 500.
```

En tom `rows` med `report` är en hjärtslag. Den skapar ingen import, men `report.state = "ok"` uppdaterar
`last_synced_at`.

## När gRPC kommer

Tillägget är en brygga tills Awish har levererat det som står i `docs/awish.md` ("Vad vi behöver från Awish
för gRPC"): app-ID, token och specifikationen. Då:

1. Bygg `awish_grpc`-adaptern (samma `RawOrder`, samma pipeline) och det schemalagda jobbet.
2. Skapa ingen ny datakälla. Ordernumret är unikt per datakälla, så en ny källa för samma Awish-konto ger
   dubbla order. Byt i stället den befintliga källans typ och flytta dess order, eller pausa tilläggets källa
   och låt gRPC-källan börja efter tilläggets sista order. Beslutet tas när gRPC finns.
3. Återkalla tilläggets tokens under Datakällor och ta bort tillägget i Chrome.
