# Fas 7: genomgång C, sida för sida

**Genomgång av Rapporter (med `/rapport/*`), Drift (med besöksplan, larm, påfyllning och tidslinje), Inkorg, Ekonomi, Avtal, Marknad, Expansion (med säljunderlag), Effekt, Assistent, Butiksportalen (`/portal`), `/design` och `/datamodell`, 2 nov. 2026.** Varje sida är kontrollerad för alla roller som når den:

- ägare (`agare@`)
- läsare (`delagare@`)
- påfyllare (`pafyllare@`)
- butik (`butik@`, portalen)
- en organisation utan data (Kortautomater Öst AB, `ny-operator-2@`)

Kontrollerna gjordes i mörkt och ljust läge, på 1 440 och 375 px, med seed-datan.

| Utfall                                    | Antal |
| ----------------------------------------- | ----: |
| Fynd                                      |    52 |
| Rättade                                   |    43 |
| Kvar (delade komponenter, andras filer)   |     7 |
| Noterade (ingen åtgärd behövs nu)         |     2 |
| Sidor över 1,5 s till `load` (dev, efter) |     4 |

De allvarligaste fynden:

1. **Ingen av sidorna hade eget fel-, laddnings- eller 404-läge.** Ett fel i databasen gav Next.js engelska standardsida eller, i dev, en stacktrace. En okänd adress gav "404 This page could not be found." på engelska.
2. **`/rapport/[id]` svarade 500** för en sparad rapport vars underlag inte går att läsa.
3. **Service workern visade "Sidan finns inte sparad i telefonen"** (503) för `/drift/besok`, fast telefonen var uppkopplad. Det hände när servern svarade långsammare än 4 s och ingen sparad kopia fanns.

Alla tre är rättade.

## Så kontrollerades det

- **Skript** (Playwright, `chromium.launch({ args: ["--no-proxy-server"] })`, reducerad rörelse). De ligger i `scratchpad/genomgang/c/`.
- **`crawl.cjs`** går igenom sida × roll × läge och mäter:
  - kontrast för varje synlig textnod mot den sammansatta bakgrunden (4,5:1, och 3:1 för stor text)
  - etiketter: fält, knappar och länkar utan namn, `svg role="img"` utan namn
  - rubrikordning: en h1 och inga hopp
  - dubbla id och `tabindex` > 0
  - element som sticker ut till höger, och `scrollWidth`
  - signalobjekt i första skärmhöjden
  - engelska ord, `NaN`, `undefined` och konsolfel
  - TTFB och `load`
- **`tab.cjs`** tabbar igenom varje sida (upp till 120 steg). Den kontrollerar att fokus syns, aldrig hamnar på `body` mitt i sidan och aldrig fastnar.
- **`timing.cjs`** mäter tiderna: tre varma laddningar per sida, median, med service workern avstängd.
- **`qcount.cjs`** räknar databasfrågor och deras tid per sidladdning. Under mätningen var `log_min_duration_statement = 0` satt bara på kopians databas.
- **Ljust läge** sattes på två sätt, inte med temaknappen:
  - med `data-theme="light"` på `<html>` efter laddningen
  - med `localStorage` (`binderlab-theme`) före laddningen
- **Felläget simulerades** i en egen kopia av projektet:
  - Kopian körs med `next dev -p 3310`, hårdlänkade `node_modules` och databasen `binderlab_test_genomgang_c` (en kopia av dev).
  - I den databasen togs rättigheterna för `authenticated` bort på en tabell per sida: `report_recipients`, `alert_subscriptions`, `incidents`, `payout_imports`, `store_agreements`, `releases`, `expansion_leads`, `effect_measurements` och `assistant_logs`.
  - Skalet laddas då som vanligt, och bara sidans egen fråga misslyckas.
  - När hela databasen är nere tar `app/error.tsx` (genomgång A) felet.
- **Dev-servern på 3200 slutade svara** mitt i genomgången (processen fanns inte längre). Den startades inte om. Efterbilderna och eftermätningarna kördes mot kopian på 3310, med `src` och `public` kopierade från projektet före varje körning och rättigheterna återställda.
- **Tiderna är från dev-läget** på en maskin som delas med flera agenter (belastning 6–9 på 4 kärnor). Spridningen är stor.

Bilder:

| Mapp        | Innehåll                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `c/before/` | Före. Ägaren i fyra lägen, `viewer/`, `refiller/`, `store/` och `empty/`. |
| `c/after/`  | Efter, samma sidor plus `refiller/`, `store/`, `empty/` och `x/` (404).   |
| `c/fault/`  | Fellägena med borttagna rättigheter, mörkt och ljust 375 px.              |
| `c/view/`   | Kontaktark som användes i granskningen.                                   |

## Delade ändringar

| Fil                                           | Ändring                                                                                                                                                                                                                                                                                                                                                                          | Varför                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/route-error.tsx` (ny)      | `RouteError` för `error.tsx`:<br>- tvådelad h1 ("Ekonomi kunde inte visas. Inget har ändrats. Uppgifterna finns kvar.")<br>- `StateMessage kind="loading-failed"`<br>- "Försök igen" (Next 16 `retry`, i en transition, med laddningsläge)<br>- "Till Hem" eller en egen länk<br>- felkod (`digest`), tid och sida bakom "Visa detaljer"<br>Serverns felmeddelande visas aldrig. | Används av mina elva `error.tsx`. Andra grupper använder den redan i Automater, Butiker, Lager, Order, Prognos och Datakällor. Genomgång A har en egen variant för skalet (`app/_fel/route-error.tsx`). Texten och åtgärderna är desamma. |
| `src/components/ui/route-loading.tsx` (ny)    | `RouteLoading` för `loading.tsx`: rubrik, nyckeltal, diagram, formulär eller tabell som `Skeleton`, med `aria-busy`, `role="status"` och en etikett ("Laddar ekonomi").                                                                                                                                                                                                          | Navigering mellan sidorna visade den gamla sidan tills den nya var färdigräknad. Periodbyten är transitioner och visar inte skelettet; fokus står kvar (kontrollerat på Lönsamhet).                                                       |
| `src/components/ui/route-error.test.tsx` (ny) | 18 tester:<br>- rubrik och åtgärder<br>- serverns meddelande läcker inte<br>- egen rubrik och länk<br>- laddningens `aria-busy`<br>- `error.tsx` finns i alla elva segment<br>- `not-found.tsx` med h1 i de fyra id-segmenten                                                                                                                                                    |                                                                                                                                                                                                                                           |
| `src/app/not-found.tsx` (ny)                  | Svensk 404 för adresser som ingen sida svarar på: "Sidan finns inte. Adressen kan vara fel eller gammal." Ramen är densamma som i `app/error.tsx` (ordmärke, inget skal).                                                                                                                                                                                                        | Next visade sin engelska standardsida. Filen gäller hela appen.                                                                                                                                                                           |
| `src/components/ui/kpi-strip.tsx`             | Inte ändrad av mig. `headingLevel={2}` (tillagt av en annan agent) används nu på Inkorg, Ekonomi, Avtal och Portalen, där remsan står direkt under h1.                                                                                                                                                                                                                           | Rubrikhopp h1 → h3.                                                                                                                                                                                                                       |

## Rapporter (`/rapporter`)

Roller: ägare och admin skapar och skickar, och läsaren ser förhandsvisning, arkiv och filer. Påfyllaren skickas till Att göra, och butiken till `/portal`.

| Kontroll            | Fynd                                                                                                                                                            | Åtgärd                                                                                                                                                       | Status |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Rubrik mot meta     | Rubriken sa "Alla 4 utskick för oktober är gjorda", men metan sa "SKICKADE 5" (rapporter, inklusive en ersatt version). Samma sak hade två tal (design.md 5.5). | Metan visar "Utskick 4 av 4" och "Utkast 0". Det räknas ur samma `expected` som rubriken.                                                                    | Rättat |
| Utvecklarmeta       | "Sätt MAIL_PROVIDER=resend, RESEND_API_KEY och MAIL_FROM för riktiga utskick." stod synligt i Granska och skicka. Ledningen ser det.                            | Texten är nu "Riktiga utskick kräver en e-postleverantör." Variabelnamnen står bakom "Visa detaljer" (`service-lines.tsx`). Detsamma gäller PDF och lagring. | Rättat |
| Fel                 | Inget eget felläge.                                                                                                                                             | `error.tsx`. Kontrollerat med borttagen läsrätt: "Rapporter kunde inte visas." Skalet står kvar.                                                             | Rättat |
| Laddning            | Ingen.                                                                                                                                                          | `loading.tsx` (formulär, förhandsvisning, tabell).                                                                                                           | Rättat |
| Tomt läge (ny org)  | "Inga mottagare för oktober. Lägg till butiker, bokhållare och delägare under Mottagare." Förhandsvisningen har ett `StateMessage` med åtgärd.                  | –                                                                                                                                                            | OK     |
| Kontrast, etiketter | 0 fynd i fyra lägen. 48 tabbsteg, och fokus syns i alla.                                                                                                        | –                                                                                                                                                            | OK     |
| 375 px              | Ingen horisontell scroll. Förhandsvisningen (A4-arken) skalas i sin ram.                                                                                        | –                                                                                                                                                            | OK     |
| Kod                 | Ternärer med samma text i båda grenarna ("utkast väntar" och "mottagare kan").                                                                                  | Förenklade.                                                                                                                                                  | Rättat |

## Rapporten (`/rapport/[id]`, `/rapport/[id]/epost`, `/rapport/exempel`)

| Kontroll                       | Fynd                                                                                                                                                                                                                         | Åtgärd                                                                                                                                                                                                      | Status |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Underlag som inte går att läsa | `/rapport/7659855e…` (delägarrapport med `data_snapshot = {}` och beräkningsversionen "integrationstest", kvar i dev) gav 500. `asSnapshot` kastar `DomainError`. Arkivet hoppar redan över raden, men länken går att öppna. | Sidan fångar `DomainError` och visar "Rapportens underlag kan inte visas. Skapa en ny version av rapporten under Rapporter." med länk.                                                                      | Rättat |
| Okänt id                       | Next:s engelska 404.                                                                                                                                                                                                         | `rapport/[id]/not-found.tsx`: "Rapporten finns inte." med en h1 för skärmläsare och länken "Alla rapporter". HTTP 404 är kvar, eftersom sidan inte har `loading.tsx` (PDF-utskriften väntar på hela sidan). | Rättat |
| Fel                            | Inget.                                                                                                                                                                                                                       | `error.tsx` med "Till Rapporter".                                                                                                                                                                           | Rättat |
| Mejlsidan, rubrik              | Ingen h1.                                                                                                                                                                                                                    | "1 mejl med butiksrapporten. Så som mottagarna får dem." Typen står i bestämd form (butiksrapporten, bokföringsunderlaget, delägarrapporten).                                                               | Rättat |
| Mejlsidan, tomt läge           | Ett vanligt stycke: "Lägg till en under Rapporter → Mottagare."                                                                                                                                                              | `StateMessage kind="empty"` med åtgärden "Lägg till mottagare" (`/rapporter#mottagare`).                                                                                                                    | Rättat |
| Mejlsidan, typografi           | `label` med `normal-case` för e-postadressen, och "Mejlen renderas …" i mono. Båda är förbjudna (design.md 2.2 och 4).                                                                                                       | `.label` för namnet, `.meta` för adressen, och sans för meningen (`role="status"`).                                                                                                                         | Rättat |
| Kontrast, 375 px, ljust        | 0 fynd. Arken ligger på skrivbordet (`bl-desk`), och utskriftstemat är oförändrat.                                                                                                                                           | –                                                                                                                                                                                                           | OK     |

## Drift (`/drift`, `/drift/besok`, `/drift/larm`, `/drift/pafyllning`, `/drift/automat/[id]`)

Roller: alla fyra approller.

| Kontroll                 | Fynd                                                                                                                                                                                                                                                                                                                                         | Åtgärd                                                                                                                                                                                                                                                          | Status  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Fältsidan utan nät       | `/drift/besok` gav 503 "Sidan finns inte sparad i telefonen" för påfyllaren och läsaren, fast uppkopplingen fanns. Orsaken: `public/sw.js` lät nätet tävla mot 4 s även när ingen sparad kopia fanns, och första besöket på Drift hämtar båda fältsidorna i bakgrunden samtidigt. Länken "Försök igen" gick dessutom alltid till Påfyllning. | Väntetiden gäller bara när det finns en sparad sida att visa i stället. Utan sparad sida väntar workern på nätet. När nätet är för långsamt visas den sparade sidan, och det nya svaret sparas när det kommer. "Försök igen" går till sidan man försökte öppna. | Rättat  |
| Utvecklarmeta            | "Status härleds ur försäljningen tills Awish gRPC är kopplad."                                                                                                                                                                                                                                                                               | "… tills maskindata från Awish är kopplad." Jobbet och `CRON_SECRET` står redan bakom "Visa detaljer".                                                                                                                                                          | Rättat  |
| Mono för hela meningar   | "Sett 3 gånger, aviserat 1 gång, senast sett …" i larmlistan.                                                                                                                                                                                                                                                                                | Sans `text-sm`.                                                                                                                                                                                                                                                 | Rättat  |
| Okänd automat            | Next:s engelska 404.                                                                                                                                                                                                                                                                                                                         | `automat/[id]/not-found.tsx`: "Automaten finns inte." med länken "Till Drift".                                                                                                                                                                                  | Rättat  |
| Fel och laddning         | Inga.                                                                                                                                                                                                                                                                                                                                        | `error.tsx` och `loading.tsx` (`inset`, Drifts egen layout ger marginalerna). Kontrollerat: Larminställningar med borttagen läsrätt ger "Drift kunde inte visas.", och flikarna står kvar.                                                                      | Rättat  |
| Tomt läge (ny org)       | Rubrikerna "Inga automater i drift.", "Inga besök behövs i veckan." och "Ingen påfyllning registrerad i dag." har tomma lägen med åtgärd.                                                                                                                                                                                                    | –                                                                                                                                                                                                                                                               | OK      |
| Tid i Larminställningar  | Tidsfälten visar "10:00 PM" i en engelsk webbläsare. Det är webbläsarens eget format för `<input type="time">`; med svenska inställningar blir det 22:00.                                                                                                                                                                                    | –                                                                                                                                                                                                                                                               | OK      |
| Tangentbord              | 42–83 tabbsteg per sida. Fokus syns överallt, och kryssrutorna nås via sina etiketter.                                                                                                                                                                                                                                                       | –                                                                                                                                                                                                                                                               | OK      |
| Prestanda, tidslinjen    | `/drift/automat/[id]` tar 1,7–2,0 s till `load`. Sidan gör 98 frågor på sammanlagt 21 ms; resten är appkod (timserier och 60 händelser) i dev-läge.                                                                                                                                                                                          | –                                                                                                                                                                                                                                                               | Kvar    |
| HTTP-status vid okänt id | Med `loading.tsx` strömmar svaret, så en okänd automat eller ett okänt ärende ger svenska 404-sidan med HTTP 200. Det spelar ingen roll i en inloggad app, men en sökmotor eller ett övervakningsverktyg ser 200.                                                                                                                            | –                                                                                                                                                                                                                                                               | Noterat |

## Inkorg (`/inkorg`, `/inkorg/nytt`, `/inkorg/[id]`)

| Kontroll                 | Fynd                                                                                                                                                                 | Åtgärd                                                                                                                   | Status |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Rubrikordning            | Nyckeltalsremsans etikett var h3 direkt efter h1.                                                                                                                    | `headingLevel={2}`.                                                                                                      | Rättat |
| Utvecklarmeta            | "(docs/berakningar.md, avsnitt 14)" stod i brödtexten.                                                                                                               | Borttaget.                                                                                                               | Rättat |
| Mono för hela meningar   | "Fler än 500 ärenden rör perioden …" i `font-mono text-xs`.                                                                                                          | Sans `text-sm`.                                                                                                          | Rättat |
| Påfyllaren på ett ärende | Påfyllaren fick Next:s engelska 404 på `/inkorg/[id]`. Listan och `/inkorg/nytt` säger i stället "Kundärenden hanteras av ägare och admin."                          | Omdirigering till `/inkorg`. Redteam-testet (`redteam-fas7-komplettering`) godtar omdirigering som nekad och går igenom. | Rättat |
| Okänt ärende             | Engelsk 404.                                                                                                                                                         | `[id]/not-found.tsx`: "Ärendet finns inte." med länken "Till Inkorg".                                                    | Rättat |
| Fel och laddning         | Inga.                                                                                                                                                                | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `incidents`.                                        | Rättat |
| Tomt läge, 375 px, ljust | "Inga öppna ärenden. Inga återbetalningar 4 okt. – 2 nov. 2026." OK. Ett kontrastfynd i ljust läge var en mätning mitt i temabytet, och det gick inte att återskapa. | –                                                                                                                        | OK     |

## Ekonomi (`/ekonomi`)

| Kontroll                      | Fynd                                                                                                                                                       | Åtgärd                                                                                                          | Status |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| Rubrikordning                 | Remsan "Avstämning · 4 okt. – 2 nov." var h3 efter h1.                                                                                                     | `headingLevel={2}` (`EconomyKpis` tar emot nivån).                                                              | Rättat |
| Belopp i rubrik               | "Utbetalt 73 912 kr mot väntade 74 625 kr …, skillnad −713,00 kr." blandade hela kronor och ören. En summa i en rubrik skrivs i hela kronor (design.md 4). | Ny `signedSek` i `ekonomi/_lib/view.ts`: "skillnad −713 kr". Detsamma gäller "Netto …" i kassaflödets meningar. | Rättat |
| Belopp i sektion 01           | Den grå delen kommer från `result.summary` i `@/analytics/reconciliation` ("(−713,00 kr)").                                                                | Inte min fil.                                                                                                   | Kvar   |
| Fel och laddning              | Inga.                                                                                                                                                      | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `payout_imports`.                          | Rättat |
| Tomt läge (ny org)            | "Ingen utbetalning för 4 okt. – 2 nov. Utbetalningarna laddas upp som CSV från Awish." med uppladdningen bredvid.                                          | –                                                                                                               | OK     |
| Kontrast, 375 px, tangentbord | 0 fynd. 52 tabbsteg.                                                                                                                                       | –                                                                                                               | OK     |

## Avtal (`/avtal`)

| Kontroll          | Fynd                                                                                          | Åtgärd                                                                                                                           | Status |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Rubrikordning     | Remsan "Intäkt 2 nov. 2025 – 1 nov. 2026" var h3 efter h1.                                    | `headingLevel={2}`.                                                                                                              | Rättat |
| Tvådelad rubrik   | Den grå delen i 03 Intäkt per butik var fem meningar, 70 ord (`o.summary`), och upprepade h1. | Den grå delen är ett faktum: "56 % kommer från butiker utan gällande avtal." Hela förklaringen står i ett stycke under rubriken. | Rättat |
| Fel och laddning  | Inga.                                                                                         | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `store_agreements`.                                         | Rättat |
| Signal            | En markering, "Säg upp eller förläng" (åtgärd). Inom budgeten.                                | –                                                                                                                                | OK     |
| Tomt läge, 375 px | "Ingen intäkt de senaste 12 månaderna." och "Inga avtal registrerade." med åtgärd.            | –                                                                                                                                | OK     |

## Marknad (`/marknad`)

| Kontroll               | Fynd                                                                                                                                                                                               | Åtgärd                                                                           | Status |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| Mono för hela meningar | Sex meningar stod i `.meta`, till exempel "Förslaget räknat per …, dagen före släppet.", "Marknadspris: … Testdata, inte riktiga marknadspriser." och "Bästa omfördelningen ger …".                | Sans `text-sm`. Mätrader med "·" står kvar i mono.                               | Rättat |
| Fel och laddning       | Inga.                                                                                                                                                                                              | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `releases`. | Rättat |
| 375 px                 | Under laddningen var sidan 673 px bred i vissa körningar. Prisdiagrammet ritas med 640 px tills `useMeasure` har mätt, och svg:n är `absolute` med `overflow-visible` (`src/components/charts/*`). | Delad diagramkomponent, se Kvarstående.                                          | Kvar   |
| Prestanda              | 1,6–2,1 s till `load`, 138 frågor på 33 ms. Resten är appkod i dev-läge.                                                                                                                           | –                                                                                | Kvar   |
| Tomt läge, kontrast    | "Inget släpp inlagt. Inga inköpspriser registrerade ännu." med fyra delar som var och en har ett tomt läge. 0 kontrastfynd.                                                                        | –                                                                                | OK     |

## Expansion (`/expansion`, `/expansion/saljunderlag`)

| Kontroll               | Fynd                                                                                                                    | Åtgärd                                                                                  | Status |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| Tvådelad rubrik        | Utan uppskattning var den grå delen en instruktion: "Lägg in platser i pipelinen eller räkna på en ny automat nedan."   | Ett faktum ur datan: "1 öppen plats i pipelinen, 3 butiker att jämföra med."            | Rättat |
| Mono för hela meningar | "Räknat från första ordern 13 okt.; perioden … Dagar utan data räknas inte …" (`DataStartNote`).                        | Sans `text-sm`.                                                                         | Rättat |
| Fel och laddning       | Inga.                                                                                                                   | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `expansion_leads`. | Rättat |
| Säljunderlaget         | Färre än tre partnerbutiker ger "Underlaget har 0 butiker … så inga belopp visas." Det är ett tomt läge med förklaring. | –                                                                                       | OK     |
| Prestanda              | 1,2–1,7 s till `load`, 195 frågor på 33 ms.                                                                             | –                                                                                       | Kvar   |

## Effekt (`/effekt`)

| Kontroll               | Fynd                                                                                                            | Åtgärd                                                                                      | Status |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| Mono för hela meningar | "Vinst per automat i oktober 2026 räknas från första ordern …"                                                  | Sans `text-sm`.                                                                             | Rättat |
| Fel och laddning       | Inga.                                                                                                           | `error.tsx` och `loading.tsx`. Kontrollerat med borttagen läsrätt på `effect_measurements`. | Rättat |
| 375 px                 | Under laddningen var sidan 656 px bred i en körning. Det är samma diagramorsak som på Marknad.                  | –                                                                                           | Kvar   |
| Tomt läge              | "Utgångsläget före Binderlab är inte registrerat." Den grå delen säger vad som ska anges. Tomt läge med åtgärd. | –                                                                                           | OK     |

## Assistent (`/assistent`)

| Kontroll         | Fynd                                                                                                                                                               | Åtgärd                                                                                                                                                                                                                            | Status |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Utvecklarmeta    | H1 "Assistenten är inte konfigurerad. Den kräver ANTHROPIC_API_KEY.", samma variabel i `StateMessage`, och "docs/miljoer.md, avsnittet Assistent" i inställningen. | "Den kräver en nyckel till Claude API." och "Nyckeln sätts i serverns miljövariabler (se Inställning nedan)." Sökvägen är borttagen. Inställningstabellen med variabelnamn (04 / Inställning) står kvar som referens för driften. | Rättat |
| Fel och laddning | Inga.                                                                                                                                                              | `error.tsx` ("Assistenten kunde inte visas.") och `loading.tsx`. Kontrollerat med borttagen läsrätt på `assistant_logs`.                                                                                                          | Rättat |
| Övrigt           | 65 tabbsteg, 0 kontrastfynd, 375 px OK. Påfyllaren och läsaren ser samma tomma läge.                                                                               | –                                                                                                                                                                                                                                 | OK     |

## Butiksportalen (`/portal`, `/portal/rapporter`, `/portal/rapporter/[id]`, `/portal/felanmalan`)

Roll: butik. Alla approutter (`/rapporter`, `/drift` …) skickar butiken till `/portal`. Portalen har eget tema (`data-theme` på portalens rot), och båda lägena är kontrollerade.

| Kontroll      | Fynd                                                                                           | Åtgärd                                                                                         | Status |
| ------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| Rubrikordning | Remsan "Månaden" var h3 efter h1.                                                              | `headingLevel={2}` i `overview-charts.tsx`.                                                    | Rättat |
| Okänd rapport | Engelsk 404.                                                                                   | `rapporter/[id]/not-found.tsx`: "Rapporten finns inte." med länken "Alla rapporter". HTTP 404. | Rättat |
| Fel           | Inget.                                                                                         | `portal/error.tsx` i portalens ram, med "Till översikten".                                     | Rättat |
| Övrigt        | 375 px, kontrast och etiketter utan fynd. Felanmälan har ett radiogruppformulär med etiketter. | –                                                                                              | OK     |

## `/design` och `/design/epost`

| Kontroll        | Fynd                                                                                                                                                                                                                                                                                           | Åtgärd         | Status  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------- |
| Kontrast, ljust | Bildtexterna under rapportarken ("Sida 1 · Sammanfattning") var `text-subtle` på skrivbordet (`bl-desk`), 4,3:1.                                                                                                                                                                               | `text-muted`.  | Rättat  |
| Dekor           | Mittpunkterna i "600 px · tabellayout · inline-stilar" i `text-faint` lästes upp.                                                                                                                                                                                                              | `aria-hidden`. | Rättat  |
| `NaN`           | "NaN %" och "aldrig 0 eller NaN" är avsiktliga exempel i formateringsavsnittet (överstrukna).                                                                                                                                                                                                  | –              | OK      |
| Hydrering       | En varning om hydrering ("attributes … didn't match") syntes i vissa körningar i dev. Den gick inte att återskapa med samma inställningar: varken med tema i `localStorage`, reducerad rörelse eller fyra laddningar i rad. Den kommer troligen från andra agenters samtidiga ändringar (HMR). | –              | Noterat |
| 375 px          | Diagrammen gör sidan 673 px bred innan de har mätts (se Marknad).                                                                                                                                                                                                                              | –              | Kvar    |

## `/datamodell`

| Kontroll    | Fynd                                                                                                                         | Åtgärd | Status |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| Tangentbord | Tabellnoderna i diagrammet är tabbstopp. Fokus syns genom att ramen i `--bl-focus` ersätter `outline-none`, så det godkänns. | –      | OK     |
| Övrigt      | TTFB 0,15–0,3 s. 0 kontrastfynd, 375 px OK, och alla roller som når sidan är kontrollerade.                                  | –      | OK     |

## Prestanda

Tiderna är medianen av tre varma laddningar som ägare, i ms (`load`). Före: dev-servern på 3200. Efter: kopian på 3310 (belastning 9). Båda är dev-läge. Över 1,5 s är i fetstil.

| Sida                    |      Före |     Efter | Frågor / databastid |
| ----------------------- | --------: | --------: | ------------------: |
| `/rapporter`            |     1 570 |       972 |         170 / 30 ms |
| `/rapport/[id]` (butik) |       843 |     1 213 |                   – |
| `/drift`                |     1 366 |     1 058 |                   – |
| `/drift/besok`          |     1 526 |       903 |          93 / 29 ms |
| `/drift/automat/[id]`   | **1 869** | **1 980** |          98 / 21 ms |
| `/inkorg`               |     1 020 |     1 148 |                   – |
| `/ekonomi`              |     1 075 |     1 142 |         246 / 48 ms |
| `/avtal`                |       571 |       728 |                   – |
| `/marknad`              | **1 578** | **2 059** |         138 / 33 ms |
| `/expansion`            |       953 | **1 661** |         195 / 33 ms |
| `/effekt`               |     1 227 |     1 056 |         157 / 23 ms |
| `/assistent`            |       948 |       747 |                   – |
| `/portal`               |         – | **1 958** |                   – |
| `/design`               |     1 176 |     1 288 |                   – |
| `/datamodell`           |       528 |       538 |                   – |

- **Databasen är inte flaskhalsen.**
  - Ingen fråga tog över 115 ms med seed-datan.
  - En sida gör 93–246 frågor på sammanlagt 21–48 ms.
  - Resten är appkoden (beräkningar och React-rendering i dev-läge) på en delad maskin.
  - Sidorna bör mätas om i `next start` innan något optimeras.
- **Med `loading.tsx` kommer skalet och skelettet direkt.** TTFB går därför ner, medan tiden till `load` är densamma.
- **`/drift/besok` var långsam bara med service workern.** Det första besöket på Drift hämtar båda fältsidorna i bakgrunden, så servern renderar besöksplanen tre gånger samtidigt. Utan worker tar sidan 0,9–1,1 s.

## Kvarstående

1. **Diagram vid 375 px innan de har mätts.** `useMeasure` börjar på 640 px, och svg:n är `absolute` med `overflow-visible` (`line-chart.tsx`, `bar-chart.tsx`, `waterfall-chart.tsx`, `heatmap.tsx`). Tills webbläsaren har kört JS blir sidan 650–673 px bred på mobil.
   - Förslag till diagrammens ägare: börja på 0 (eller rita inget) före mätningen, eller `overflow-x: clip` med `overflow-clip-margin` på ritytan, så att fokusringen inte klipps.
   - Det gäller också andra gruppers sidor.
2. **`result.summary` i `@/analytics/reconciliation`** skriver belopp med ören i rubrikens grå del ("(−713,00 kr)").
3. **Prestanda:** fyra sidor ligger över 1,5 s till `load` i dev under belastning: tidslinjen, Marknad, Expansion och Portalen. Det ska mätas i `next start` innan något åtgärdas.
4. **HTTP 200 för okänt id** i segment med `loading.tsx` (`/inkorg/[id]`, `/drift/automat/[id]`). Sidan visas rätt, men statuskoden blir 200.
5. **Assistentens inställningstabell** visar variabelnamnen (`ASSISTANT_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`). Den är avsiktligt kvar som referens för driften, men kan flyttas bakom "Visa detaljer" om sidan ska visas för ledningen.
6. **Inloggningens rotlayout** ger i dev konsolfelet "Encountered a script tag while rendering React component" (`themeInitScript` i `app/layout.tsx`) när en felsida renderas på klienten. Det syns bara i dev och ligger i genomgång A:s fil.
7. **Dev-servern på 3200 är nere** (processen försvann under genomgången och startades inte om). Kopian på 3310 och databasen `binderlab_test_genomgang_c` är borttagna efter genomgången.

## Tester

- `npx vitest run`: 160 filer, **2 435 tester**, alla gröna. 18 av dem är nya (`src/components/ui/route-error.test.tsx`).
- `DATABASE_URL_TEST=…/binderlab_test_genomgang_ct npm run test:db -- test/db/redteam-fas7-komplettering.test.ts test/db/redteam-fas7-routes.test.ts test/db/ekonomi.test.ts`: **268 tester**, alla gröna. Där ingår omdirigeringen av påfyllaren från `/inkorg/[id]`.
- `npx tsc --noEmit`: inga fel i mina filer. Det enda felet är `scripts/db/backup-lib.ts(306)`, som inte är min fil.
- `eslint` och `prettier --check` är rena för alla ändrade filer.
- Inga migreringar.
