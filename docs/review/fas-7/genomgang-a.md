# Fas 7: genomgång A, sida för sida

**Genomgång av Hem, Att göra, Lönsamhet, Inköpspriser, Inställningar (med Användare), Kom igång, inloggningen och inbjudan, 2 nov. 2026.** Varje sida är kontrollerad för alla roller som når den, i mörkt och ljust läge, på 1440 och 375 px, med seed-datan (Binderlab, 460 order på 30 dagar), demo-organisationen (Nordljus Automater AB (demo), 14 720 order) och en ny organisation utan data (Kortautomater Väst AB).

| Utfall                                  | Antal |
| --------------------------------------- | ----: |
| Fynd                                    |    32 |
| Rättade                                 |    23 |
| Delvis (prestanda)                      |     2 |
| Kvar (andras filer eller delad laddare) |     7 |
| Sidor över 1,5 s TTFB, demo, före       |     2 |

Det allvarligaste fyndet var att **ingen sida hade en egen felsida**. När databasen inte svarade visade alla sidor Next.js engelska standardtext ("This page couldn't load. A server error occurred."), även `/logga-in`. Det näst allvarligaste var att **nyckeltalsremsan klippte belopp** mellan 640 och 1 440 px. Med demo-datan stod Intäkt som "2 461 9…" på en 1280 px-skärm. Båda är rättade.

## Så kontrollerades det

- **Skript** (Playwright, `chromium.launch({ args: ["--no-proxy-server"] })`, reducerad rörelse) i `scratchpad/genomgang/`:
  - `audit.cjs` går igenom sida × roll × läge och mäter:
    - kontrast för varje synlig textnod mot den sammansatta bakgrunden (WCAG, 4,5:1 och 3:1 för stor text);
    - etiketter: fält utan namn, knappar och länkar utan text, `role="img"` utan namn och tabeller utan `caption`;
    - rubrikordning (en h1 och inga hopp);
    - klippta tal (`overflow` eller ellips med siffror) och element som sticker ut till höger;
    - signalobjekt inom en skärmhöjd och ramar i ramar;
    - engelska ord, `NaN`, `undefined` och dubbla id;
    - konsolfel;
    - 40 tabbsteg med synlig fokusring;
    - TTFB och tid till innehåll.
  - `kpiclip.cjs` mäter klippta nyckeltal på åtta bredder (375–1440 px).
  - `forms.cjs` provar inloggning och inbjudan: tomt, ogiltig e-post, fel lösenord, för kort och olika lösenord. Webbläsaren är engelsk, så att webbläsarens egna felrutor skulle synas.
  - `dbdown.cjs` kör en egen dev-server mot en databasport som inte svarar (se nedan).
- **Ljust läge** sattes med `data-theme="light"` på `<html>` (och i `localStorage`), inte med temaknappen.
- **Databasen nere:** en kopia av projektet (hårdlänkade `node_modules`) kördes med `next dev -p 3250` och `DATABASE_URL` mot port 54399. Kakan från inloggningen på 3200 gäller också på 3250, eftersom båda ligger på localhost.
- **Dev-servern på 3200 slutade svara** mitt i genomgången (processen fanns inte längre). Den startades inte om. Eftersläpande kontroller och efterbilderna kördes mot kopian på 3250, med samma databas och `src` kopierad från projektet före varje körning.
- **Tiderna är från dev-läget** (`next dev`, ingen produktionsbygg) på en maskin som delas med flera agenter. Spridningen är stor. Varje sida mättes 3–4 gånger med `curl` och kakan, och tabellen visar spannet.

## Delade ändringar

Fyra delade filer ändrades, alla vid tydliga fel och så lite som möjligt. Testerna för `src/components` körs och går igenom (se Tester).

| Fil                                                                                                              | Ändring                                                                                                                                                                                                                                                                                                                                                                                                                               | Varför                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/kpi-strip.tsx`                                                                                | Lägena följer remsans bredd (container queries `@xl` 576 px, `@4xl` 896 px) i stället för fönstrets. Huvudpersonen står först på egen rad i mellanläget, och en ofull sista rad fylls. Ett värde som inte ryms tas ner ett storlekssteg i taget (`useFitStep`, mäts om när bredden eller typsnittet ändras). Layouten är en ren funktion, `kpiStripLayout`, med fyra tester. (`headingLevel` lades till av en annan agent samtidigt.) | "Ett belopp får aldrig klippas" (design.md 5.1). Bredvid sidomenyn är innehållet 312 px smalare än fönstret, så `lg:grid-cols-6` gav 79 px breda celler på 1024 px. |
| `src/components/charts/profit-bridge.tsx`                                                                        | Avgiftssteget ritas inte när avgiften är 0, utom när det är flaggat.                                                                                                                                                                                                                                                                                                                                                                  | "Steg som är 0 ritas inte" (design.md 7). Med kortavgift 0 % stod det "+0,0" i vattenfallet. Bryggan används bara på Lönsamhet.                                     |
| `src/app/error.tsx`, `src/app/(app)/error.tsx`, `src/app/global-error.tsx`, `src/app/_fel/route-error.tsx` (nya) | Svenska felgränser. Rubriken är tvådelad, och `StateMessage kind="loading-failed"` har signal bara på glyfen. Åtgärderna är "Försök igen" (`retry`) och "Till Hem". Fel-id (`digest`), tid och sida står bakom "Visa detaljer". `(app)/error.tsx` håller skalet kvar; `app/error.tsx` tar fel i själva skalet, som när databasen är nere.                                                                                             | Gäller alla sidor, även de andra gruppernas.                                                                                                                        |
| `docs/design.md`                                                                                                 | `KpiStrip`-raden beskriver de nya lägena. Känd avvikelse 4 (nät bakom inloggningen) är struken: koden är redan rättad.                                                                                                                                                                                                                                                                                                                | Filen och koden ska säga samma sak.                                                                                                                                 |

## Hem (`/`)

Roller: ägare, admin och läsare. Påfyllaren skickas till `/att-gora` med 307.

| Kontroll                   | Fynd                                                                                                                                                                                                                      | Åtgärd                                                                                                                                                        | Status |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Belopp i nyckeltalen       | Intäkten klipptes ("405 494 k…", "2 461 9…") med demo-datan från 640 till 1 440 px. På 1 024 px klipptes alla sex celler, även etiketterna. Känt fynd från fas 7 del 1.                                                   | `KpiStrip` (se Delade ändringar). `kpiclip.cjs` hittar inga klippta tal på någon av de åtta bredderna, varken för 30 dagar eller för Allt.                    | Rättat |
| Mellanläget i remsan       | På 640–1 023 px stod Intäkt ensam på första raden och vinsten under den, med en tom rad bredvid.                                                                                                                          | Huvudpersonen står först i mellanläget (CSS `order`).                                                                                                         | Rättat |
| Mobil 375 px               | Etiketten "Vinst före fasta kostnader" bryts på två rader och sänkte talet en rad under Intäkt (öppet från Hem-agenten).                                                                                                  | Etiketterna i remsan har två raders höjd under 640 px (`max-sm:[&_dt]:min-h-8`).                                                                              | Rättat |
| Mono för hela meningar     | "varav 2 utan inköpspris, ingår inte i vinsten" stod i mono under Övriga titlar.                                                                                                                                          | Sans `text-xs`: "Varav 2 utan inköpspris, som inte ingår i vinsten."                                                                                          | Rättat |
| Laddning                   | Ingen `loading.tsx` och ingen Suspense. Hela sidan väntade på Att göra och förlorad försäljning innan något skickades.                                                                                                    | Sidan kontrollerar rollen först (påfyllaren får en riktig 307) och strömmar sedan innehållet bakom `HemSkeleton`, som har samma rutnät som sidan.             | Rättat |
| Prestanda                  | TTFB för demo var 1,5–3,1 s, för seed 0,9–2,4 s. Laddarna för demo: `loadRankedTodoState` 0,96–1,33 s och `lostSalesSummary` 0,61–0,92 s (parallellt), Kom igång 0,16–0,49 s, ordrarna 0,10–0,15 s.                       | Strömningen ger TTFB 0,57–1,11 s för demo. Det som är kvar av TTFB är skalet (`(app)/layout.tsx` väntar på menyns räknare för Att göra, samma tunga laddare). | Delvis |
| Fel                        | Engelsk standardsida när databasen är nere.                                                                                                                                                                               | `app/error.tsx`: "Sidan kunde inte laddas. Servern fick inget svar när uppgifterna skulle hämtas kl. 13:55."                                                  | Rättat |
| Tomt läge (ny org)         | Rubriken "Inga order än." ovanför checklistan, och `not-configured` med "Lägg till datakälla". Inga fel.                                                                                                                  | –                                                                                                                                                             | OK     |
| Kontrast, etiketter, fokus | 0 kontrastfel i båda lägena. Inga fält eller kontroller utan namn, och alla tabeller har `caption`. En h1 och inga hopp i rubrikerna. Tabbordningen går genom meny, period, länkar, diagram och Att göra med synlig ring. | –                                                                                                                                                             | OK     |
| Signal                     | Tre objekt i första skärmen: menyns räknare, den kritiska punkten i Att göra och "4,8 % av intäkten saknar inköpspris". Ligger inom budgeten.                                                                             | –                                                                                                                                                             | OK     |
| Värt att veta              | Seed-datan ger 1 iakttagelse, inte 3–4. `@/analytics/insights` behöver fler regler.                                                                                                                                       | Inte i sidans filer.                                                                                                                                          | Kvar   |

## Att göra (`/att-gora`)

Roller: ägare, admin och påfyllare. Läsaren skickas till `/`.

| Kontroll                  | Fynd                                                                                                                                                                         | Åtgärd                                                                             | Status |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| Text                      | Rubriken för sektion 03 sa "2 titlar utan inköpspris, 3 825 kr i intäkt saknar inköpspris". Samma ord stod två gånger.                                                       | "…, 3 825 kr i intäkt räknas inte in i vinsten." Testet är uppdaterat.             | Rättat |
| Tomt läge                 | Åtgärden "Visa lagret →" fick två pilar, eftersom `StateMessage` själv lägger till `→`.                                                                                      | Etiketten är nu "Visa lagret".                                                     | Rättat |
| Tomt läge (ny org)        | Rubriken säger "Lagret räcker, automaterna säljer, …" också i en organisation utan automater och order.                                                                      | Modellen vet inte om organisationen har data. Det behöver en flagga från laddaren. | Kvar   |
| Laddning                  | Ingen `loading.tsx`.                                                                                                                                                         | `att-gora/loading.tsx`: rubrik, metablock och tre punkter.                         | Rättat |
| Prestanda                 | TTFB för seed var 0,57–1,77 s, för demo 0,91–1,99 s. En körning med demo tog 10,9 s under kompilering; den kom inte tillbaka.                                                | Se Prestanda. Tiden ligger i `loadTodoState` (delad).                              | Delvis |
| Fel, kontrast, fokus, 375 | Felgränsen fungerar som på Hem. 0 kontrastfel och 0 namnlösa kontroller. Ingen horisontell scroll. Fokus går till nästa punkt efter avbockning (Att göra-agentens rättning). | –                                                                                  | OK     |

## Lönsamhet (`/lonsamhet`)

Roller: ägare, admin och läsare. Påfyllaren skickas till `/att-gora`.

| Kontroll                  | Fynd                                                                                                                                                                           | Åtgärd                                                                                                                                                        | Status |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Ordlistan                 | "Resultat efter fasta kostnader" och "Resultat efter återbetalningar". Ordlistan säger att "Resultat" aldrig får skrivas.                                                      | "Vinst efter fasta kostnader" (samma ord som "Vinst före fasta kostnader" på Hem). Utan fasta kostnader: "Vinst efter återbetalningar, utan fasta kostnader". | Rättat |
| Rubrikordning             | Rubrikerna hoppade från h1 till h3: remsans etikett "Nyckeltal · 4 okt. – 2 nov." var h3 direkt under sidans h1.                                                               | `headingLevel={2}`.                                                                                                                                           | Rättat |
| Vattenfallet              | Steget "Avgifter +0,0" ritades fast avgiften är 0.                                                                                                                             | `ProfitBridge` hoppar över steg som är 0.                                                                                                                     | Rättat |
| Nät utan mätning          | Diagrampanelen sträcktes ut till högerkolumnens höjd. Det gav ungefär 600 px tomt koordinatnät under diagrammet.                                                               | `lg:self-start` på panelen.                                                                                                                                   | Rättat |
| Mono för hela meningar    | Fem meningar stod i mono: "Samma som vattenfallet ovan …", "1 ärende, räknat på …", "Gemensamma 391 kr fördelade …", veckonoten och "Hyra som ingen order med inköpspris bär". | Sans `text-xs text-subtle`.                                                                                                                                   | Rättat |
| Belopp i nyckeltalen      | Med demo-datan för Allt klipptes Intäkt och Butiksersättning på 640–1 440 px, och etiketten "Butiksersättning" på 1 024 px.                                                    | `KpiStrip`.                                                                                                                                                   | Rättat |
| Vattenfallets etikett     | Etiketten är förkortad till "BUTIKSERS." Kortformen är tillåten i diagram (design.md 7, `short`), men ordlistan avråder från förkortningar med punkt.                          | Lämnad. Den delas med `/design` och följer diagramregeln.                                                                                                     | Kvar   |
| 375 px, ljust, fel, fokus | Ingen horisontell scroll. Bryggans etiketter står förskjutna och klipps inte längre. 0 kontrastfel. Felgränsen fungerar. `loading.tsx` fanns redan.                            | –                                                                                                                                                             | OK     |

## Inköpspriser (`/inkopspriser`)

Roller: ägare och admin (ändrar), läsare (läser). Påfyllaren skickas till `/att-gora`.

| Kontroll            | Fynd                                                                                                                             | Åtgärd                                                                                                                | Status |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| 375 px              | "Kvar per order" klipptes ("60,01 k…") och tabellen scrollade 24 px i sidled (öppet från Inköpspris-agenten och slutkontrollen). | Under md står statusen på egen rad under titeln, som design.md 5.1 säger, och statuskolumnen döljs. Beloppen ryms nu. | Rättat |
| Tomt läge (ny org)  | Rubriken sa "Alla 0 titlar har inköpspris. Ingen försäljning i perioden."                                                        | "Inga titlar ännu. Titlar skapas när order importeras." Nytt enhetstest.                                              | Rättat |
| Laddning            | Ingen `loading.tsx`.                                                                                                             | `inkopspriser/loading.tsx`.                                                                                           | Rättat |
| Prestanda           | TTFB för seed 0,58–0,91 s, för demo 0,47–0,77 s. En körning med demo tog 3,5 s under kompilering.                                | –                                                                                                                     | OK     |
| Kontrast, etiketter | 0 fel. Signalen bara på "Saknar pris" (två rader) och menyns räknare.                                                            | –                                                                                                                     | OK     |

## Inställningar (`/installningar`) och Användare (`/installningar/anvandare`)

Roller: ägare och admin. Läsaren skickas till `/` och påfyllaren till `/att-gora`.

| Kontroll            | Fynd                                                                                                                                                                    | Åtgärd                                                                                       | Status |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| 375 px, Användare   | E-postadresser klipptes med ellips ("dk-granskare-admin@binderlab.loc…").                                                                                               | Adresserna bryts i stället (`overflow-wrap: anywhere`), både för medlemmar och inbjudningar. | Rättat |
| Laddning            | Ingen `loading.tsx`.                                                                                                                                                    | `installningar/loading.tsx` (gäller också Användare).                                        | Rättat |
| Fokus               | Tabbskriptet hittade ingen ring på datumfältet "Gäller från". Det visade sig vara en mätning som gjordes för tidigt: fältet matchar `:focus-visible` och har 2 px ring. | –                                                                                            | OK     |
| Datumfältet         | Visar "11/02/2026" i en engelsk webbläsare. Formatet kommer från webbläsarens språk, och en svensk webbläsare visar 2026-11-02.                                         | –                                                                                            | OK     |
| Etiketter, kontrast | 0 fel i båda lägena, för ägare och admin. Fälten har etiketter, och enheten (%) står efter talet.                                                                       | –                                                                                            | OK     |
| Brödsmulor          | Användare har egen rad "Inställningar / Användare". Skalets brödsmula och kommandopalettens mål saknas fortfarande.                                                     | Skalets filer.                                                                               | Kvar   |

## Kom igång (`/kom-igang`)

Fas 7 del 1 äger sidans filer, så jag har bara granskat den. Felgränsen (`(app)/error.tsx`) gäller också här.

| Kontroll | Fynd                                                                                                                                                          | Åtgärd             | Status |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| Skalet   | Periodraden visas, fast sidan inte har någon period (`nav.ts` saknar `context: false` för `kom-igang`).                                                       | Skalets fil.       | Kvar   |
| Dekor    | Snedstrecket i checklistans etikett (`onboarding-checklist.tsx` rad 217, `text-faint`, 2,2–2,5:1) saknar `aria-hidden`, så skärmläsare läser upp "/".         | Fas 7 del 1:s fil. | Kvar   |
| Text     | "räknat ur datan" i sektionsrubriken pratar om gränssnittet (design.md 9, inga metatexter).                                                                   | Fas 7 del 1:s fil. | Kvar   |
| Övrigt   | 375 px utan scroll. 0 kontrastfel utom snedstrecket. Laddningstiden är 0,4–1,0 s. Med ny organisation visas 2 av 6 steg klara och "Nästa" pekar på rätt steg. | –                  | OK     |

## Inloggning (`/logga-in`, `/logga-in/bekrafta`) och inbjudan (`/inbjudan/[token]`)

Provat utan inloggning med en giltig inbjudan, som lades in i dev-databasen för genomgången och togs bort efteråt, och med en okänd och en ofullständig länk.

| Kontroll                | Fynd                                                                                                                                                                                    | Åtgärd                                                                                                                                                                                             | Status |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Databasen nere          | `/logga-in` gav 500 med den engelska standardsidan för den som hade en sessionskaka, eftersom `getSessionUser` frågar databasen. Ett inloggningsförsök kastade i stället för att svara. | Sidan visar formuläret ändå, och statusraden säger "Databasen svarar inte". `signIn` fångar felet och svarar "Inloggningen svarar inte just nu. Försök igen om en stund." Inbjudan får felgränsen. | Rättat |
| Fokus vid fel           | Vid fel i formuläret stod fokus kvar på knappen. Texten syntes, men skärmläsaren fick inte veta var felet satt.                                                                         | Fokus flyttas till första fältet med fel: e-post eller lösenord vid inloggning, och lösenord eller upprepning i inbjudan. Kontrollerat med `forms.cjs`.                                            | Rättat |
| Svenska fel             | "Skriv din e-postadress.", "Skriv ditt lösenord.", "Fel e-postadress eller lösenord." och "Lösenorden är inte lika." visas, också i en engelsk webbläsare (`noValidate`).               | –                                                                                                                                                                                                  | OK     |
| Nät och gradient        | Design.md listade nät och gradientmask bakom formuläret som en känd avvikelse. Koden har inget av dem.                                                                                  | Avvikelsen är struken i design.md.                                                                                                                                                                 | Rättat |
| 375 px, ljust, kontrast | Ingen scroll. 0 kontrastfel och 0 fält utan etikett. Svar på 0,1–0,9 s.                                                                                                                 | –                                                                                                                                                                                                  | OK     |

## Prestanda

TTFB i sekunder, 3–4 mätningar per sida med `curl` och sessionskaka mot dev-servern. Gränsen är 1,5 s.

| Sida               | Seed före | Demo före |           Demo efter, 3200 | Efter, 3250: seed / demo (median) | Över 1,5 s?                                       |
| ------------------ | --------: | --------: | -------------------------: | --------------------------------: | ------------------------------------------------- |
| Hem                | 0,94–2,43 | 1,50–3,15 | 0,57–1,11 (hela 1,28–1,78) |                       0,51 / 0,69 | Före ja (demo). Efter nej                         |
| Att göra           | 0,57–1,77 | 0,91–1,99 |                          – |                       0,38 / 0,48 | Före delvis (demo). Efter nej                     |
| Lönsamhet          | 0,39–3,75 | 0,69–0,86 |                          – |                       0,41 / 0,72 | Nej (en avvikande mätning före)                   |
| Inköpspriser       | 0,58–0,91 | 0,47–0,77 |                          – |                       0,44 / 0,52 | Nej                                               |
| Inställningar      | 0,57–1,19 | 0,48–0,61 |                          – |                       0,68 / 0,55 | Nej (en mätning på 3,6 s under kompilering efter) |
| Användare          | 0,43–1,12 |         – |                          – |                       0,47 / 0,41 | Nej                                               |
| Kom igång          | 0,41–0,97 | 0,46–0,57 |                          – |                       0,53 / 0,47 | Nej                                               |
| Logga in, inbjudan | 0,12–0,92 |         – |                          – |                                 – | Nej                                               |

"Efter, 3250" är min egen dev-server under efterkörningen (`audit.cjs`, 4–16 mätningar per sida). Den hade mindre last än 3200 hade under förekörningen, eftersom 3200 då inte längre fanns, så den kolumnen är inte direkt jämförbar med "före". Jämförelsen före och efter strömningen på Hem gjordes på samma server (3200).

Det som tar tid är **Att göra-laddaren** (`loadTodoState` och rankningen efter förlorad försäljning, 1,0–1,3 s med demo-datan). Den körs i skalet för menyns räknare och på Hem och Att göra. Laddaren är memoiserad per förfrågan, så den räknas en gång per sidladdning, men skalet väntar på den innan något skickas. Mitt förslag till prestandaspåret:

1. Låt menyns räknare strömma in (Suspense runt räknaren i `app-frame.tsx`) i stället för att `(app)/layout.tsx` väntar på `countTodos()`.
2. Profilera `loadTodoState` med 100 000 order.

## Kvarstående

1. **Skalet väntar på Att göra-räknaren** (`(app)/layout.tsx`), så TTFB är ungefär 0,6–1,1 s med demo-datan även efter strömningen. Filen är skalets.
2. **Periodraden i skalet** säger "mot 4 sep. – 3 okt." när sidorna säger "ingen jämförelse, datan börjar 13 okt." (`period-bar.tsx`, öppet sedan slutkontrollen). Den visas också på Kom igång, som saknar `context: false` i `nav.ts`.
3. **Kom igång**: snedstrecket utan `aria-hidden` och "räknat ur datan" i rubriken (fas 7 del 1:s filer).
4. **Att göra, tomt läge i en ny organisation**: rubriken påstår att automaterna säljer. Det behöver en flagga för "har data" från laddaren.
5. **Värt att veta** på Hem har bara 1 iakttagelse med seed-datan (`@/analytics/insights`).
6. **Nyckeltalen visar ellips före hydrering** när ett belopp inte ryms i största storleken. Storleken räknas i webbläsaren. I dev syns ellipsen ungefär en sekund på en bred skärm med sjusiffriga belopp; i produktion borde det gå fortare. Det har inte gått att verifiera med en produktionsbygg.
7. **Next.js dev-indikator och "Issues"-knappen** ligger över användaren i sidomenyn och på mobilen. Det gäller bara dev-läget (känd avvikelse 8).

## Tester

- `src/components/ui/kpi-strip.test.ts` (ny, 4 tester): remsans layout i tre lägen för Hem, Lönsamhet och fallen med och utan huvudperson.
- `src/app/(app)/inkopspriser/_lib/model.test.ts`: +1 test (ny organisation utan titlar).
- `src/app/(app)/att-gora/_lib/model.test.ts`: förväntad text uppdaterad.
- Enhetstester för mina sidor, inloggning, inbjudan, `src/components` och `/design`: 14 filer, 192 tester, gröna (räknat med andra agenters nya tester i samma mappar).
- Databastester mot `binderlab_test_genomgang_a` (Hem, Lönsamhet, Att göra, Inköpspriser, Inställningar, Användare, inloggning): 7 filer, 72 tester, gröna.
- `tsc --noEmit` är rent. Under arbetet fanns ett tillfälligt fel i `scripts/db/backup-lib.ts:306`, en annan agents pågående arbete. eslint och prettier är rena på mina filer.

## Bilder

Alla bilder ligger i `/tmp/claude-0/-home-user/5f93e12b-6575-52f8-bc28-2d68a4fd5afb/scratchpad/genomgang/`:

- `before/full/`, `before/full2/`, `before/anon/`, `before/anon-inv/`: före, per roll, läge och bredd (`<roll>-<läge>-<bredd>_<sida>.png`).
- `before/dbdown/` och `after/dbdown/`: databasen nere före (Next.js engelska standardsida) och efter (svensk felsida). `after/dbdown/login-submit-375.png` visar inloggningsförsöket med databasen nere.
- `after/kpi/`: nyckeltalen med demo-datan och Allt på 375, 768, 1100, 1280 och 1440 px.
- `after/sidor/`: Lönsamhet, Inköpspriser och Att göra efter rättningarna (1440 mörkt, 375 ljust).
- `after/full/`: efterkörningen av `audit.cjs` för alla roller och lägen, med `results.json`.
- `before/login-*.png`, `after/inbjudan-fel-375.png`: formulärens fel.
