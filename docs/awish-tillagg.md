# Awish Chrome-tillägget: automatisk synk

Beställaren ska aldrig behöva ladda ner något från Awish. Binderlabs Chrome-tillägg läser orderlistan i
Awish-panelen (`https://dash.awish.vip/dashboard/orders/index`) med användarens egen inloggning i Chrome och
skickar ordrarna till Binderlab var tionde minut. Ordrarna går genom samma importflöde som en uppladdad CSV
(`docs/awish.md`). När Awish har levererat app-ID, token och specifikationen för gRPC ersätter
`awish_grpc`-adaptern tillägget (se sist).

> **Status:** provat mot en låtsas-Awish (i Chrome: HTML-tabellen, utloggning och en sida som ritas med
> JavaScript; JSON-API:t i enhetstester), inte mot riktiga dash.awish.vip. Gör kontrollen under
> [Före första riktiga synken](#före-första-riktiga-synken) en gång innan synken räknas som klar.

## Före första riktiga synken

Inloggningen (cookie eller en token som sidan själv skickar), svarsformatet och tabellens rubriker är gissade
efter hur FastAdmin-paneler brukar fungera. Kontrollera en gång, på datorn där tillägget ska köra:

1. **Testa avläsningen.** Klicka på Binderlab-ikonen i Chrome → **Testa avläsningen** (under Kontroll). Den
   läser första sidan som synken gör, men skickar inget till Binderlab. Kontrollera att
   - _Läser via_ är `HTML-tabellen` eller `JSON-API` med sökvägen `/dashboard/orders/index` (inte `öppen flik`);
   - kolumnerna är rätt: `Ordernummer ← Order No.`, `Belopp ← Order Amount` (eller `order_amount`),
     `Betald ← Is Paid` (eller `is_paid`/`pay_status`), `Betaltid ← Payment Time`, `Automat ← Order Machine`;
   - de första raderna har samma ordernummer, belopp och betalstatus som panelen visar.
2. **Inloggningen (DevTools).** Öppna orderlistan på dash.awish.vip, tryck F12 → **Nätverk**, ladda om och
   klicka på anropet som hämtar ordrarna. Under _Request Headers_: står det `Cookie:` (då fungerar tillägget)
   eller `Authorization: Bearer …` (då når tillägget inte listan direkt och läser bara en öppen flik med
   orderlistan, se Reserv nedan)? Under _Response_: HTML eller JSON, och vilka nycklar?
3. **Efter första synken:** Datakällor → Automatisk synk visar _Avläsning_ med samma kolumner. Jämför antal
   ordrar och summan för en dag med panelen.

Visar något fel: kontakta utvecklaren med texten från **Testa avläsningen** (den innehåller inga
inloggningsuppgifter).

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
  - Bara orderlistan godtas som källa: `/dashboard/orders/index` (med eller utan `.html`) eller ett API som
    uttryckligen är en orderlista (`…/order/list`, `…/orders/index`). Återbetalningar, topplistor, statistik
    och annat på samma adress med ordernummer i svaret används aldrig (`isOrdersApiPath` i `reader.ts`,
    kontrolleras både i innehållsskriptet och i service workern).
  - Panelens egna parametrar följer inte med: filter, sökning och sortering som användaren hade i panelen tas
    bort, och tillägget begär alltid `sort=id&order=desc` (nyast först).
  - Belopp och betalstatus kräver entydiga nycklar: `order_amount`/`amount` och `is_paid`/`pay_status`/
    `payment_status`. En allmän `status`, `paid`, `price`, `money` eller `pay_amount` tas aldrig. Saknas de
    läses HTML-tabellen i stället.
  - Visar API:t äldst först trots `order=desc` används det inte.
- **HTML.** En service worker har ingen DOM, så HTML-sidan tolkas med `DOMParser` i ett offscreen-dokument.
  Går det inte att starta används en inbyggd tolk som reserv. En allmän kolumn _Status_ eller _Price_ tas
  aldrig som betalstatus eller belopp. Visar listan äldsta ordern först blir det ett fel ("Sortera på ID").
- **Reserv: den öppna fliken.** Hittar tillägget ingen ordertabell i det som Awish svarar (sidan är ett skal som
  ritas med JavaScript, eller listan är tom fast Binderlab har ordrar), och det finns en öppen flik med
  orderlistan, läses den färdigritade tabellen i fliken (`chrome.scripting`, bara DOM:en, bara sida 1). Det
  ger de senaste ordrarna men inte historiken, och popupen och Datakällor säger det. Reserven används aldrig
  när Awish säger att man är utloggad: en flik som öppnades före utloggningen visar gamla ordrar, och då ska
  det stå "Utloggad" i stället.
- **Var den slutar läsa.** Status-API:t ger de 500 senaste ordernumren i organisationens alla Awish-källor
  (tillägget, CSV, …). En vanlig synk läser från sida 1 tills den når ett känt ordernummer, och sedan en sida
  till. Den skickar bara ordrar som Binderlab inte har.
- **Sena betalningar.** En ej betald order skickas en gång, och igen när den blivit betald. Ej betalda ordrar
  från det senaste dygnet (orderns egen tid) bevakas: så länge en av dem inte har setts läser synken vidare,
  högst 15 sidor, så att en betalning som kommer sent inte missas fast nya ordrar hamnat ovanför den. Ej
  betalda ordrar ur gammal historik bevakas inte.
- **Tom lista.** Är orderlistan tom på sida 1 fast Binderlab redan har ordrar (ett filter, en tabell som ritas
  med JavaScript, ett nytt sidformat) är det ett fel, inte en lyckad synk. Då förnyas inte `last_synced_at`,
  och larmet slår till efter två timmar.
- **Hela historiken.** Första gången (när tilläggets källa är tom och historiken aldrig lästs klart, när
  organisationen inte har några Awish-ordrar, eller efter **Läs hela historiken igen**) läses alla sidor
  bakåt, en sida i sekunden. Läget sparas i `chrome.storage` efter varje skickad batch, så att en avbruten
  läsning fortsätter där den slutade vid nästa alarm. Trycks knappen medan en synk pågår sparas begäran under
  en egen nyckel och körs direkt efteråt.
- **Återförsök.** 429 (med `Retry-After`), 5xx och nätverksfel prövas igen efter 2, 4, 8, 16 och 32 sekunder.
  401 och 403 stoppar synken direkt: token är ogiltig eller återkallad.
- **Utloggad.** Leder Awish till inloggningen, eller svarar med ett lösenordsfält utan ordertabell eller med
  JSON som säger att man ska logga in, läses ingenting. Popupen visar _"Logga in på dash.awish.vip i Chrome så
  fortsätter synken"_, ikonen får ett utropstecken, och Binderlab får en rapport som syns under Datakällor.
- **Larm.** Varje lyckad synk (även utan nya ordrar) uppdaterar `data_sources.last_synced_at`, utom när
  källan är pausad i Binderlab. Har tillägget
  inte rapporterat på mer än två timmar slår importregeln till (`importAlerts` i
  `src/analytics/alerts/rules.ts`; `expectedInterval('awish_extension') = 40` minuter × 3). Klockan startar när
  källan skapas, så en ny källa larmar inte innan tillägget har hunnit installeras.
- **Idempotens.** Ordernumret är unikt per datakälla. Samma rad igen blir en dubblett. En rad med samma
  ordernummer men andra värden blir en konflikt i importloggen, och ordern ändras aldrig.
- **Samma order i flera källor.** Har organisationen redan Awish-ordrar i en annan källa (en uppladdad CSV,
  `awish_csv`, eller en annan Awish-källa), räknas en betald rad vars ordernummer redan finns där som
  dubblett och importeras inte igen (`imports.mapping.otherSourceDuplicates`). Hela historiken kan alltså
  läsas utan att intäkterna dubbleras. Datakällor visar de andra källorna och hur många ordrar de har.
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

Har du redan laddat upp Awish orderlista som CSV behöver du inte göra något: ordrar som redan finns där
importeras inte igen. Ladda däremot inte upp fler Awish-CSV:er när tillägget är igång, för CSV-importen
jämför bara mot sin egen källa. Pausa CSV-källan när tillägget har läst hela historiken.

Gör sedan kontrollen under [Före första riktiga synken](#före-första-riktiga-synken).

## Felsökning

| Det syns                                  | Orsak och åtgärd                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Utloggad från Awish"                     | Sessionen i Awish har gått ut. Logga in på dash.awish.vip i samma Chrome. Synken fortsätter vid nästa alarm, eller klicka Synka nu.                                           |
| "Tyst > 2 h" / larm "Ingen hämtning från" | Chrome är stängt, datorn sover eller tillägget är avstängt. Öppna Chrome. Tillägget synkar inom 10 minuter.                                                                   |
| "Binderlab nekar token"                   | Token är återkallad, eller skaparen är inte längre ägare eller admin. Skapa en ny token och klistra in den.                                                                   |
| "Hittar inte ordertabellen"               | Awish har ändrat sidan så att rubrikerna inte känns igen. Rubrikernas synonymer finns i `extensions/awish-sync/src/reader.ts`.                                                |
| "Awish orderlista är tom, fast …"         | Ett filter eller en sökning sitter kvar i orderlistan, eller tabellen ritas med JavaScript. Rensa filtret, eller låt en flik med orderlistan vara öppen.                      |
| "… visar äldsta ordern först"             | Orderlistan är sorterad äldst först. Sortera på ID (nyast först) eller rensa sorteringen i panelen.                                                                           |
| "Läser bara den öppna Awish-fliken"       | Tillägget når inte orderlistan direkt (troligen en inloggning med token i stället för cookie). Låt fliken vara öppen; kontakta utvecklaren med texten från Testa avläsningen. |
| Fel belopp eller betalstatus              | Kontrollera kolumnerna under Avläsning i Datakällor eller med Testa avläsningen.                                                                                              |
| Rader med fel i importloggen              | Samma regler som CSV (`docs/awish.md`), t.ex. ett tvetydigt belopp. Se importens radlogg under Datakällor.                                                                    |
| Fel tid på ordrarna                       | Källans tidszon är fel. Ändra den på datakällan (gäller nästa batch) enligt kontrollen mot order 42780.                                                                       |

Tilläggets egen logg finns under `chrome://extensions` → Binderlab → **Service worker** (Inspektera).
Popupen visar senaste körning, antal sidor och rader, om JSON, HTML eller den öppna fliken lästes, och senaste
fel. **Testa avläsningen** visar sätt, sökväg, kolumner och de första raderna utan att skicka något.

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
  batch, och 20 ogiltiga tokenförsök per IP och minut. Spärren för ogiltiga försök gäller bara misslyckade
  försök: en giltig token släpps alltid fram, även bakom samma IP. Gränserna räknas i minnet per
  serverinstans.
- **Tilläggets behörigheter.** `storage`, `alarms`, `offscreen`, `scripting` och host-behörighet för
  `https://dash.awish.vip/*`. `scripting` används bara för reserven som läser orderlistan i en öppen
  Awish-flik, och fungerar bara på flikar som host-behörigheten täcker. Binderlabs adress är en valfri behörighet som efterfrågas när adressen sparas.
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
| Tester (databas)    | `test/db/ingest-api.test.ts`, `ingest-granskning.test.ts`, `redteam-tillagg.test.ts`                  |
| Tester (end-to-end) | `npx vitest run -c extensions/awish-sync/vitest.e2e.config.ts` (dev-servern på 3200 och dess databas) |

Zip-filen är incheckad, och testet `awish-extension-build.test.ts` fallerar om den inte är byggd från
källkoden. Kör bygget efter varje ändring i `extensions/awish-sync/`. Testbygget med `--awish-origin` (bara för
e2e) byter Awish-adressen och behörigheterna.

API (för felsökning med curl):

```
GET  /api/ingest/awish/status        Authorization: Bearer blsync_…
  → { ok, dataSource, lastSyncedAt,
      orders: { count, sourceCount, latestExternalId, latestOrderedAt, knownExternalIds }, limits }
    count och knownExternalIds gäller alla Awish-källor i organisationen, sourceCount bara den här.
POST /api/ingest/awish               Authorization: Bearer blsync_…   Content-Type: application/json
  { rows: [{ externalId, title, machine, amount, isPaid, paidAt, paymentMethod?, rowId?, orderDate?, page?, pageRow? }],
    absent?: ["paymentMethod"],
    report?: { state: "ok"|"logged_out"|"error", message?, mode?: "json"|"html"|"tab", path?, columns? },
    client?: { version } }
  → { ok, importId, summary: { total, new, duplicate, conflict, error, notPaid }, otherSourceDuplicates,
      unknownMachines, newTitles, lastSyncedAt }
  Fel: { ok: false, error, code } med 400, 401, 403, 409 (pausad källa), 413, 429 (Retry-After), 500.
```

En tom `rows` med `report` är en hjärtslag. Den skapar ingen import, men `report.state = "ok"` uppdaterar
`last_synced_at`.

## När gRPC kommer

Tillägget är en brygga tills Awish har levererat det som står i `docs/awish.md` ("Vad vi behöver från Awish
för gRPC"): app-ID, token och specifikationen. Då:

1. Bygg `awish_grpc`-adaptern (samma `RawOrder`, samma pipeline) och det schemalagda jobbet.
2. Skapa ingen ny datakälla utan att lösa dubbletterna. Kontrollen mot andra Awish-källor finns bara i
   tilläggets ingest (`src/server/ingest/service.ts`), inte i den vanliga importen (`runImport`), så en ny
   gRPC-källa för samma Awish-konto ger dubbla order. Flytta kontrollen till pipelinen, byt den befintliga
   källans typ, eller låt gRPC-källan börja efter tilläggets sista order. Beslutet tas när gRPC finns.
3. Återkalla tilläggets tokens under Datakällor och ta bort tillägget i Chrome.
