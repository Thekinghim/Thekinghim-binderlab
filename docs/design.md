# Binderlab: designregler

Binderlab är en kontrollpanel för varuautomater med samlarkortspack. Den ska kännas som ett precisionsinstrument och hålla nivå inför ledningen på ett stort bolag. Reglerna gäller panelen, rapporterna (`/rapport/*`) och e-posten (`src/emails`).

Visningssidan är `/design`. Den läser färgerna direkt ur `src/styles/tokens.css` och räknar kontrasten på servern (`src/app/design/tokens.ts`). Exempeldatan i `src/app/design/sample-data.ts` består av tre automater i tre butiker och ett års Awish-ordrar. Om den här filen och koden säger olika saker gäller koden. Rätta då filen i samma ändring.

Källor i ordning:

| Fil                     | Innehåll                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `src/styles/tokens.css` | Färg (mörkt och ljust), typsnitt, rörelse, nätstorlek. Enda källan.                         |
| `src/styles/print.css`  | Utskriftstema `data-theme="print"`, skrivbordsfärger, A4-sidsystemet.                       |
| `src/app/globals.css`   | Tailwind-temat (`@theme inline`): typskala, spacing, radier, rörelseklasser, `.label` m.fl. |
| `src/lib/tokens.ts`     | TS-spegling för diagram och animationer (`color`, `motion`, `space`, `radius`, `chart`).    |
| `src/lib/format.ts`     | All formatering av tal, belopp, datum och perioder.                                         |
| `src/emails/theme.ts`   | Ljusa temat som hex för e-post. `report-email.test.ts` jämför värdena med `tokens.css`.     |

---

## 1. Principer

### Precisionsinstrument

Varje linje, siffra och etikett har en uppgift. Det som inte mäter, avgränsar eller förklarar något tas bort.

- **Gör:** använd 1 px linjer, raka hörn med små radier, mono-etiketter med mått ("02.2 / INTÄKT TILL VINST · 30 D") och siffror som kommer ur datan.
- **Gör inte:** skuggor, gradienter, glassmorphism, färgade ikonrutor, pill-knappar, dekorativa vänsterkantlinjer, illustrationer, emoji, ikonbibliotek. Tailwind-temat nollställer skuggor, standardpaletter och radier (`--shadow-*: initial` m.fl.), så de går inte att använda av misstag.

### Siffror först

Siffran är huvudpersonen och texten runt den är biroll.

- **Gör:** ge varje vy en huvudperson. I en KPI-remsa är det `primary`, som spänner två kolumner och får `text-3xl`. Skriv jämförelseperioden en gång. Låt rubriken bära en siffra ("Vinst 41 612 kr, 23,7 % av intäkten med inköpspris.").
- **Gör inte:** fyra lika kort med samma vikt, "mot föregående period" i varje cell, uppräkning som visar fel värde under en halv sekund.

### En signal

`--bl-signal` (#FF5A1F) betyder att någon ska göra något. Allt annat är gråskala. Se avsnitt 3.

### Konstruerade diagram

Diagram ritas som en ritning: direktannoteringar, hjälplinjer, noder och enheter, inga legender. Se avsnitt 7.

### Täthet med luft

Tätt inom en grupp och rymligt mellan grupper. Tabeller och remsor ska kunna läsas i en hel skärm, och sektionerna får andas.

- **Gör:** använd 8 px-steg mellan element, 32–48 px mellan grupper och 48–96 px mellan sektioner (avsnitt 5).
- **Gör inte:** lägg allt i paneler med samma padding, ramar i ramar eller lika stora rutor i ett symmetriskt rutnät.

### Status bärs aldrig bara av färg

Form och text bär status. Färgen är alltid en tredje bärare, och vyn ska gå att läsa i svartvitt.

---

## 2. Tokens

Använd alltid tokens via Tailwind-klasserna (`bg-surface`, `text-muted`, `border-line` …) eller `var(--bl-*)`. Hårdkodade färger får bara finnas i `tokens.css`, `print.css` och `src/emails/theme.ts`.

En ny token läggs in i `tokens.css` (båda lägena) och i `@theme inline` i `globals.css`. Behöver JS den läggs den också i `src/lib/tokens.ts`. Ett eget utskriftsvärde läggs i `print.css` och e-postens värde i `src/emails/theme.ts`. Färgtabellen på `/design` uppdateras själv.

### 2.1 Färg

Kontrasten är räknad enligt WCAG 2.2 mot `bg` / `surface` / `raised`. Krav: text ≥ 4,5:1, kontrollkanter och grafiska markeringar ≥ 3:1.

#### Ytor och linjer

| Token                 | Klass                 | Mörkt                     | Ljust                     | Användning                                                                                                                 |
| --------------------- | --------------------- | ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--bl-bg`             | `bg-bg`               | #0A0A0B                   | #F4F3EF                   | Sidan. Även fyllning i fält (`Input`).                                                                                     |
| `--bl-surface`        | `bg-surface`          | #111113                   | #FBFAF8                   | Panel, sekundärknapp.                                                                                                      |
| `--bl-surface-raised` | `bg-raised`           | #18181B                   | #FFFFFF                   | Dialog, läsruta, meny, notis.                                                                                              |
| `--bl-surface-hover`  | `bg-hover`            | #1E1E22                   | #EEECE7                   | Hover på rad och knapp, valt segment, skeleton.                                                                            |
| `--bl-line`           | `border-line`         | #232327 (1,3:1)           | #E0DED8 (1,2:1)           | Hårfina avdelare, tabellrader, panelkant.                                                                                  |
| `--bl-line-strong`    | `border-line-strong`  | #36363C (1,7:1)           | #C9C6BF (1,5:1)           | Tabellhuvud, sekundärknapp, dialogkant, streckad inaktiv kant.                                                             |
| `--bl-line-control`   | `border-line-control` | #63615C (3,2 / 3,1 / 2,9) | #8F8C86 (3,0 / 3,2 / 3,4) | Kant på kontroller och varningsetikett. Mot `hover` i mörkt läge bara 2,7:1, så lägg inte kontroller direkt på `bg-hover`. |
| `--bl-grid`           | (`.grid-field`)       | fg · 4,5 %                | fg · 5,5 %                | Koordinatnät. Bara på utvalda ytor (avsnitt 5.4).                                                                          |
| `--bl-grid-mark`      | (`CornerMarks`)       | fg · 22 %                 | fg · 30 %                 | Korsmarkeringar i hörnen på en mätyta.                                                                                     |
| `--bl-overlay`        | `bg-overlay`          | #050506 · 72 %            | #151514 · 40 %            | Bakgrund bakom `<dialog>`.                                                                                                 |

#### Text

| Token              | Klass           | Mörkt                        | Ljust                        | Användning                                                                     |
| ------------------ | --------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `--bl-fg`          | `text-fg`       | #EDEAE4 · 16,5 / 15,7 / 14,8 | #151514 · 16,5 / 17,5 / 18,3 | Rubriker, siffror, aktiv text, fokusring, topp och rekord.                     |
| `--bl-fg-muted`    | `text-muted`    | #A6A39D · 7,9 / 7,5 / 7,0    | #4F4D48 · 7,6 / 8,1 / 8,4    | Brödtext, beskrivningar, etiketter i paneler.                                  |
| `--bl-fg-subtle`   | `text-subtle`   | #8F8C86 · 5,9 / 5,6 / 5,3    | #65635E · 5,4 / 5,8 / 6,0    | Rubrikens grå del, metadata, axeltext, löpnummer. Lägsta nivå för läsbar text. |
| `--bl-fg-faint`    | `text-faint`    | #57554F · 2,7 / 2,5 / 2,4    | #AEABA4 · 2,1 / 2,2 / 2,3    | **Bara dekor:** snedstrecket i "01 / …", pilar. Aldrig text som ska läsas.     |
| `--bl-fg-disabled` | `text-disabled` | #8A8781 · 5,5 / 5,3 / 5,0    | #6A6863 · 5,0 / 5,3 / 5,6    | Inaktiv kontroll. Läsbar, och formen (streckad kant) bär läget.                |

#### Signal

| Token               | Klass                | Mörkt                                     | Ljust                                     | Användning                                                                                                    |
| ------------------- | -------------------- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--bl-signal`       | `bg-signal`          | #FF5A1F · 6,4 / 6,1 / 5,7                 | #F0521A · 3,2 / 3,4 / 3,5                 | Glyfer, noder, staplar och fyllningar som kräver åtgärd. I ljust läge **aldrig som textfärg**.                |
| `--bl-signal-fg`    | `text-signal-fg`     | #FF6D38 · 7,1 / 6,7 / 6,3                 | #B53E0E · 5,2 / 5,5 / 5,7                 | Text som kräver åtgärd (`KpiAlert`, "! Tomt fack 3", `danger`-knapp).                                         |
| `--bl-signal-line`  | `border-signal-line` | signal · 70 % (3,6 / 3,5 / 3,4)           | #B53E0E · 70 % (3,1 / 3,2 / 3,3)          | Kant på kritisk statusetikett, kritisk notis, `danger`-knapp, fält med fel. Ersätter alla `signal/50`, `/60`. |
| `--bl-signal-soft`  | `bg-signal-soft`     | signal · 13 %                             | signal · 10 %                             | Hover på `danger`-knapp.                                                                                      |
| `--bl-signal-hover` | `bg-signal-hover`    | #FF6D38                                   | #F46A38                                   | `danger-confirm` under pekaren.                                                                               |
| `--bl-on-signal`    | `text-on-signal`     | #0A0A0B (6,4:1 på signal, 7,1:1 på hover) | #151514 (5,2:1 på signal, 6,1:1 på hover) | Text på fylld signal (bara `danger-confirm`).                                                                 |

#### Inverterat, data och fokus

| Token                     | Klass                            | Mörkt                                                                | Ljust                                                                | Användning                                                                                  |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--bl-inverse-bg` / `-fg` | `bg-inverse` / `text-on-inverse` | #EDEAE4 / #0A0A0B (16,5:1)                                           | #151514 / #F4F3EF (16,5:1)                                           | Primärknapp. Högst en per yta.                                                              |
| `--bl-inverse-hover`      | `bg-inverse-hover`               | #FFFFFF                                                              | #2A2A28                                                              | Primärknapp under pekaren.                                                                  |
| `--bl-data-1` … `-5`      | `bg-data-1` …                    | #EDEAE4 16,5 · #B3B0AA 9,2 · #84817C 5,1 · #5B5955 2,8 · #383734 1,7 | #151514 16,5 · #4A4844 8,2 · #7C7974 3,9 · #AAA7A0 2,2 · #D3D0CA 1,4 | Gråskaleramp, 1 = starkast. Betonad post `data-1`, övriga `data-3`. 4–5 bara i värmekartan. |
| `--bl-data-0`             | `bg-data-0`                      | #161618                                                              | #F0EEE9                                                              | Lägsta steg i värmekarta (0 ritas som tom ruta med kant).                                   |
| `--bl-focus`              | `outline-focus`                  | = `--bl-fg`                                                          | = `--bl-fg`                                                          | Fokusring. Aldrig signal: ett tabbsteg är inget larm.                                       |

#### Utskrift (`data-theme="print"`, `src/styles/print.css`)

Papper är vitt och allt är gråskala. Kontrast mot #FFFFFF:

| Token                           | Värde                                            | Kontrast                     | Not                                                             |
| ------------------------------- | ------------------------------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `--bl-bg`, `surface`, `raised`  | #FFFFFF                                          | –                            | `surface-hover` #F2F2F2.                                        |
| `--bl-fg`                       | #111111                                          | 18,9:1                       |                                                                 |
| `--bl-fg-muted`                 | #3D3D3D                                          | 10,9:1                       |                                                                 |
| `--bl-fg-subtle`                | #595959                                          | 7,0:1                        |                                                                 |
| `--bl-fg-faint`                 | #8C8C8C                                          | 3,4:1                        | Bara dekor och axlar.                                           |
| `--bl-line` / `line-strong`     | #BDBDBD / #6E6E6E                                | 1,9 / 5,1                    | Mörka nog att överleva rastrering på laserskrivare.             |
| `--bl-grid`                     | transparent                                      | –                            | Koordinatnätet är av på papper.                                 |
| `--bl-signal`, `--bl-signal-fg` | #111111                                          | 18,9:1                       | Signalen blir den mörkaste tonen. Markeringen bärs av **form**. |
| `--bl-data-1` … `-5`            | #111 · #4D4D4D · #808080 · #B0B0B0 · #D6D6D6     | 18,9 · 8,5 · 4,0 · 2,2 · 1,5 | Fem steg med ungefär 20 % ljushet emellan.                      |
| `--bl-desk`, `--bl-desk-edge`   | mörkt #232326 / #3A3A3F, ljust #DDDBD6 / #B9B6AF | –                            | Skrivbordet runt arken på skärmen (följer appens läge).         |

Med `data-tone="signal"` på rapporten behålls kulören för PDF som läses på skärm: `--bl-signal` #F0521A (3,5:1) och `--bl-signal-fg` #B53E0E (5,7:1). Formkodningen gäller ändå, så samma sida går att skriva ut i svartvitt.

#### Lägen

- Mörkt är standard (`<html data-theme="dark">`, `themeColor` #0A0A0B). Ljust sätts med `data-theme="light"` på valfritt element, och variablerna ärvs nedåt. Valet sparas i `localStorage` (`binderlab-theme`) och sätts före rendering av `themeInitScript` i `src/lib/theme.ts`.
- Varianten `light:` i Tailwind följer `data-theme`, inte `prefers-color-scheme`.
- E-post är alltid ljus (avsnitt 8).

### 2.2 Typskala

Geist för ord och tal, Geist Mono för etiketter, id, tider och axlar. Vikterna är 400 och 500 (`font-medium`). Semibold används bara i ordmärket.

| Klass          | Storlek / radhöjd | Spärrning | Användning                                                                                                 |
| -------------- | ----------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `.label`       | 11 / 16 mono      | 0,08 em   | VERSAL-etikett: "01 / FÖRSÄLJNING", kolumnrubrik, statusetikett, `Kbd`. Minsta tillåtna storlek.           |
| `.meta`        | 12 / 16 mono      | 0         | Gemener: tider, id, deltatext, tokennamn, metadata. Komplement till `.label`, aldrig `.label normal-case`. |
| `text-xs`      | 12 / 16           | –         | Hjälptext, läsrutans seriernamn.                                                                           |
| `text-sm`      | 13 / 20           | –         | Sekundär text, knapp `sm`, listor i diagram.                                                               |
| `text-base`    | 14 / 20           | –         | Brödtext (`body`), tabellceller, fält, knapp `md`.                                                         |
| `text-md`      | 16 / 24           | −0,005 em | Ingress, underrubrik (mening med siffra under en mono-etikett).                                            |
| `text-lg`      | 20 / 28           | −0,015 em | Dialogrubrik.                                                                                              |
| `text-xl`      | 24 / 32           | −0,02 em  | Sektionsrubrik på mobil, KPI-värde under 640 px.                                                           |
| `text-2xl`     | 32 / 36           | −0,025 em | Sektionsrubrik från `md`, KPI-värde från `sm`.                                                             |
| `text-3xl`     | 44 / 48           | −0,03 em  | Huvudpersonens KPI-värde (`primary`), H1 på mobil.                                                         |
| `text-display` | 64 / 64           | −0,04 em  | H1 från `md`. En per sida.                                                                                 |
| `.tnum`        | –                 | –         | Tabulära siffror utan streckad nolla. På alla tal som står i kolumn eller byts ut.                         |

`text-[..px]`, `leading-[..]` och `tracking-[..]` får inte användas. Behövs ett steg som saknas läggs det in i skalan. Undantag: rapportsidor som sätts i millimeter (`src/components/report/**`, `src/app/rapport/**`) och måttspecimen på `/design`.

### 2.3 Avstånd

Basen är 4 px (`--spacing: 4px`, alltså `p-1` = 4 px) och rytmen 8 px. 4 px-steg används bara för finjustering inuti en komponent.

| Steg | px  | Typisk användning                                                        |
| ---- | --- | ------------------------------------------------------------------------ |
| `1`  | 4   | Glyf till text, delta under värde.                                       |
| `2`  | 8   | Mellan knappar, rader i en etikettgrupp.                                 |
| `3`  | 12  | Etikett till KPI-värde, rubrik till beskrivning.                         |
| `4`  | 16  | Panelens padding på mobil, tätt rutnät (`tiles`), sidomarginal på mobil. |
| `5`  | 20  | Panelens padding från `md`, dialogens padding.                           |
| `8`  | 32  | Kolumnmellanrum i 12-kolumnsrutnätet, avstånd mellan `PanelSection`.     |
| `10` | 40  | Rubrik till innehåll i en sektion, `PanelSection` från `md`.             |
| `12` | 48  | Radavstånd i sektionsrutnätet, tät sektion (`py-12`).                    |
| `16` | 64  | Standardsektion (`py-16`).                                               |
| `24` | 96  | Rymlig sektion från `md` (`md:py-24`), där siffrorna är huvudperson.     |

Höjder: knapp `md` 36 px och `sm` 28 px, fält 36 px, segmentväljare 32 px (`sm` 28), statusetikett 24 px, tabellrad 44 px (`dense` 36), tabellhuvud 36 px.

### 2.4 Radier

Radien följer storleken. Inga helt rundade former (`rounded-full`), utom cirkelnoden för jämförelseserier i diagram.

| Token         | Klass        | px  | Användning                                                     |
| ------------- | ------------ | --- | -------------------------------------------------------------- |
| `--radius-xs` | `rounded-xs` | 2   | Statusetikett, `Kbd`, skeleton, textknappar, länkar med fokus. |
| `--radius-sm` | `rounded-sm` | 4   | Knapp, fält, segmentväljare, läsruta, meny.                    |
| `--radius-md` | `rounded-md` | 6   | Panel, dialog, notis, tom yta med ram.                         |

### 2.5 Kanter

1 px överallt. Det finns tre undantag: fokusringen (2 px), valt segment (2 px indexstreck längs underkanten, inuti ramen) och signalmarkerad stapel eller avdrag i diagram (2 px ram). En streckad kant betyder att något är inaktivt, ur drift eller inte ingår.

### 2.6 Rörelse

| Token / klass                                  | Värde                        | Användning                                                                                                       |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--bl-dur-fast` · `duration-fast`              | 120 ms                       | Hover och färgbyte. Standard för `transition-colors` utan duration.                                              |
| `--bl-dur-base` · `duration-base`              | 150 ms                       | Segmentbyte, värdebyte (KPI tonar 0,4 → 1).                                                                      |
| `--bl-dur-slow` · `duration-slow`              | 180 ms                       | Dialog och notis (`animate-enter`, `animate-fade`).                                                              |
| `--bl-dur-count`                               | 420 ms                       | Uppräkning, bara med `motion="count"`. Standard är `fade`. Räknas inte som övergång och visas inte på `/design`. |
| `--bl-dur-pulse` · `animate-pulse-soft`        | 1 600 ms                     | Skeleton (opacitet 0,55 ↔ 1).                                                                                    |
| `--bl-dur-tick` · `animate-tick` + `.bl-ticks` | 960 ms                       | Knappens laddning: tre punkter tänds i tur och ordning.                                                          |
| `animate-toast-progress`                       | `--toast-dur` (5 000 ms)     | Notisens tidsstapel, `scaleX` (aldrig `width`).                                                                  |
| `--bl-ease` · `ease-instrument`                | cubic-bezier(0.2, 0, 0, 1)   | All rörelse. Inget studsar.                                                                                      |
| `--bl-ease-in-out` · `ease-instrument-in-out`  | cubic-bezier(0.4, 0, 0.2, 1) | Pulserande laddning.                                                                                             |

- Skriv `duration-fast/base/slow`, aldrig `duration-[..ms]`. I JS läses värdena från `motion` i `src/lib/tokens.ts`.
- Animera `opacity` och `transform`, aldrig bredd, höjd eller layout.
- Vid `prefers-reduced-motion: reduce` sätter `globals.css` alla övergångar och animationer till 1 ms. Laddningspunkterna står då fast (···), och KPI-värden byts direkt.

---

## 3. Regler för signalfärgen

Signalen (#FF5A1F i mörkt, #F0521A i ljust) är den enda kulören i systemet. Den betyder **att någon ska göra något**.

### Får användas för

| Fall                   | Exempel i koden                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kritiskt lager         | Tomt fack: `KpiAlert` "BL-002 fack 3", `alertIndex` i `LineChart`, `StatusTag status="critical"`.                                                                                                |
| Fel som stoppar arbete | `StateMessage kind="error"` och `"loading-failed"`: signal bara på glyfen. Fält med fel: signalkant plus ikon och feltext.                                                                       |
| Avvikelse över gräns   | Svinn över mål, titel utan inköpspris, negativ vinst ("Förlust", "! Under noll" i `ProfitBridge`).                                                                                               |
| Kritisk status         | `StatusTag status="critical"`: ram i `--bl-signal-line` och signalkvadrat. Texten är `fg`.                                                                                                       |
| Destruktiv åtgärd      | `Button variant="danger"`: ofylld, med signaltext och signalkant.                                                                                                                                |
| Destruktiv bekräftelse | `Button variant="danger-confirm"`: fylld. **Bara** i bekräftelsedialogens sista steg.                                                                                                            |
| Varumärke              | Ringen i symbolen (`SYMBOL_PARTS.ring`), **bara från 28 px** (`SIGNAL_RING_MIN_PX`): rapporthuvud och omslag. Mindre än så (sidomeny, flik, favicon, e-post) och i `mono` är den `currentColor`. |

### Får inte användas för

- **Rekord, toppar, "bäst".** Toppen ritas i `--bl-fg` med en annotering ("24 okt. · 7 964 kr"). `peakIndex`, `highlightIndex` och `markMax` ger aldrig signal.
- **Fokus.** `--bl-focus` är `--bl-fg`.
- **Dekor:** kvadrater före rubriker, bakgrunder, avdelare, ikoner, markering av vald rad eller valt segment.
- **CTA.** Huvudåtgärden är `primary` (inverterad). `variant="signal"` är föråldrad och ritas som `danger`.
- **Varumärkesytor** utöver symbolens ring från 28 px: ingen orange logotyp, rubrik, favicon, e-postram eller ring i sidomenyn.
- **Information som inte kräver åtgärd:** tomt läge, ur drift, saknar behörighet, varning. De är grå och bärs av form. Fyllnad under påfyllningsgränsen (20 %) är en **varning**: statusetiketten `warning`, siffran halvfet i `fg` och stapeln i `fg` (`FillMeter` på `/design`). Signal är för tomt fack.
- **Ett annat mått än det som ritas.** En intäktsstapel färgas aldrig av ett lagerlarm. Larmet står som text under stapeln (`BarDatum.noteAlert`, "! Tomt fack 3") och stapeln ritas som vanligt. `flag` används bara när själva värdet kräver åtgärd.

### Budget

- Högst **en signalmarkering per diagram**. Om flera poster kräver åtgärd markeras den viktigaste, och de andra nämns i text ("och 2 till").
- Högst **tre signalmarkeringar per synlig vy** (en skärmhöjd). En markering är ett objekt som kräver åtgärd. Glyf, kant och text på samma objekt räknas som en.
- En markering har en bärare per objekt: ram och glyf, eller glyf och text. Aldrig fyllning, ram, signaltext och radmarkör på samma rad.
- Undantag: referensytorna på `/design` (färgtabellen och kontrollerna) som visar signalen som exempel.

### Alltid med text och form

Signal står aldrig ensam. Varje signalmarkering har:

1. **Form** som överlever svartvitt: fylld kvadrat med ring (`Node variant="signal-ring"`, `ReportMark`), signalskraffering med 2 px ram, eller en fylld kvadrat bredvid text.
2. **Text** som säger vad och hur mycket: "! Tomt fack 3 i BL-002", "Gräns 3 st", "FEL 503". Diagramnoteringar börjar med `! `. Skärmläsare får "Kräver åtgärd: " (`sr-only`).

---

## 4. Typografi, siffror och formatering

### Rubriker

- **Tvådelad rubrik** bara på sektionsnivå (`SectionHeader`, `SpecSection`): första delen i `fg`, andra i `text-subtle`. Den grå delen är ett påstående med en siffra eller ett faktum, räknat ur datan: "Intäkt per dag. Snitt 2 412 kr, topp 24 okt."
- **Underavsnitt** (`Sub`): mono-etikett med mått ("02.3 / INTÄKT PER AUTOMAT · 30 D") och en mening i `fg` med en siffra.
- Alla rubriknivåer slutar med punkt. En rubrik som slutar på en förkortning med punkt ("24 okt.") får ingen extra.
- `text-balance` och `hyphens-none` på rubriker. Avstavning mitt i ord är förbjuden.
- Rubrikordningen följer dokumentet: h1 en gång, h2 för sektioner, h3 för underavsnitt.

### Etiketter

- Mono VERSAL (`.label`) med numrering och snedstreck i `text-faint`: "01 / FÖRSÄLJNING". Numret står i `fg`.
- Etiketten namnger måttet, aldrig diagramtypen ("INTÄKT PER AUTOMAT", inte "STAPEL").
- Enheter i axlar och värden skrivs i gemener: "tkr", "köp/tim", "kr". `AxisText upper={false}` för tal och enheter.

### Siffror

- Tal i löptext, tabeller och KPI sätts i **Geist sans med `.tnum`**, högerställda i kolumner. `Column.numeric` ger detta automatiskt.
- I diagram (axlar, direktetiketter, läsruta) och i id, tider och metadata används **Geist Mono**. De hör till mätapparaten. Alla rader i en direktetikett är mono; vikt och färg bär hierarkin (`title` 12 px halvfet fg, `body` 12 px muted, `value` 11 px). Text i SVG är minst 11 px.
- Hela meningar står aldrig i mono, inte heller i tillståndsmeddelanden eller fotnoter. Mono är för etiketter, id, tider och mätvärden.
- Datum i diagram skrivs som i löptexten: "24 okt." med punkt och gemener, även på axeln.
- Ett tal och dess enhet hålls ihop med hårt mellanslag. Använd `NBSP` från `format.ts` när du sätter ihop egna strängar ("1{NBSP}signalfärg").
- Id bryts aldrig: `BL‑002` skrivs med hårt bindestreck (U+2011) där det kan bryta.

### Formatering: `src/lib/format.ts`

All formatering av tal, belopp, datum och perioder går via `src/lib/format.ts`. Inga egna `toLocaleString`, `Intl.NumberFormat` eller strängbyggen med `-`. Funktionerna testas i `src/lib/format.test.ts`.

| Regel           | Tecken             | Exempel                                                                               |
| --------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Hårt mellanslag | U+00A0 (`NBSP`)    | "79 987,00 kr", "33,1 %". Intl:s U+202F och U+2009 normaliseras.                      |
| Äkta minus      | U+2212 (`MINUS`)   | "−1 240 kr". Aldrig bindestreck (utom i CSV).                                         |
| Tankstreck      | U+2013 (`EN_DASH`) | "1–30 nov." tätt. Med hårda mellanslag när ändarna har mellanslag: "3 okt. – 1 nov.". |
| Saknat värde    | `MISSING` = "–"    | NaN, ±Infinity och ogiltigt datum. Aldrig "NaN" eller tom cell.                       |
| Decimalkomma    | ,                  | "4,5:1", "1,25 px". Aldrig decimalpunkt i UI-text.                                    |

| Behov                   | Funktion                                            | Utdata                                                              |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Belopp med ören         | `formatKronor(v)`                                   | 79 987,00 kr                                                        |
| Belopp i hela kronor    | `formatSek(v)` / `formatKronor(v, { decimals: 0 })` | 12 480 kr                                                           |
| Beloppsförändring       | `formatSignedKronor(v)`                             | +1 240,00 kr · −1 240,00 kr · ±0,00 kr                              |
| Tkr                     | `formatTkr(v)`                                      | 31,1 tkr                                                            |
| Heltal / decimal        | `formatInt`, `formatNumber(v, d)`, `formatDecimal`  | 12 480 · 12,4                                                       |
| Andel som procent       | `formatPercent(share, digits = 1)`                  | 33,1 % · (v, 0) → 33 %                                              |
| Förändring som andel    | `formatDelta(change, digits = 0)`                   | +42 % · −8 % · ±0 %                                                 |
| Datum                   | `formatDate(d)`                                     | 1 nov. 2026 (`year: "auto"` utelämnar innevarande år)               |
| Datum och tid           | `formatDateTime(d)`                                 | 1 nov. 17:17                                                        |
| Tid                     | `formatTime(d)`                                     | 09:05                                                               |
| Månad                   | `formatMonth(d)`                                    | november 2026                                                       |
| Axel och täta etiketter | `formatDay(d)`, `formatWeekdayDay(d)`               | 26 okt · tis 26 okt (utan punkt)                                    |
| Period, med år          | `formatPeriod(p)`                                   | 1–30 nov. 2026 · oktober–november 2026 · 28 dec. 2025 – 3 jan. 2026 |
| Period, kort            | `formatPeriodShort(p)`                              | 3 okt. – 1 nov. · nov.                                              |
| Relativ tid (logg)      | `formatRelative(d)`                                 | nyss · för 4 min sedan · tor 08:00                                  |
| Varaktighet             | `formatDuration(ms)`                                | 45 s · 2 h 14 min                                                   |
| CSV                     | `formatCsvNumber(v)`                                | 79987,00 (ingen avgränsare, ASCII-minus)                            |

- Månader förkortas enligt Språkrådet: punkt bara där ordet är förkortat ("okt.", "maj", "juni").
- Deltan i KPI: relativ förändring med en decimal under 10 % (annars heltal) som standard. I en remsa där deltan står bredvid varandra ges alla samma antal decimaler (`KpiDeltaSpec.format`, `/design` använder en decimal). Räknare visas absolut med enhet ("+2 st"), procentenheter som "p.e.". Tecknet skrivs alltid ut.
- En summa i en mening eller rubrik skrivs i hela kronor (`formatSek`), också i tabellens summarad när rubriken säger samma belopp.
- Perioder och jämförelser beräknas med `src/lib/period.ts` (`periodFromPreset`, `previousPeriod`), inte med egen datumaritmetik.

---

## 5. Layout

### 5.1 Rutnät

- Sidans behållare: `mx-auto max-w-[1280px] px-4 md:px-8`. Sidomarginalen är 16 px på mobil.
- Brytpunkter: `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536 px.
- Från `lg` ligger allt i ett **12-kolumnsrutnät** (`lg:grid-cols-12`, `gap-x-8 gap-y-12`). Under `lg` står allt i en kolumn.
- Varje sektion fördelar kolumnerna efter sitt innehåll. Diagrammet som är huvudperson får 12. Därefter kommer par som 7 + 5 eller 8 + 4 (vattenfall 7 / staplar 5, värmekarta 7 / andelar 5). Tre eller fyra lika rutor i rad undviks.
- Paneler som står tätt (exempelpaneler) använder `tiles` (`gap-4`).
- Ingen horisontell scroll vid 375 px. `ChartFigure` har `contain: inline-size`, så att diagram inte kan göra sidan bredare.
- Ett belopp får aldrig klippas. Under md döljs sekundära kolumner (`hideOnMobile`) så att id, status och belopp ryms: statusen står då på en egen rad under namnet i första kolumnen (`MachineCell` på `/design`), och i en virtualiserad tabell räknas minsta bredden bara på kolumnerna som syns. Horisontell scroll i tabellen är en sista utväg.

### 5.2 Sektionsrytm

| Sektion (`SpecSection space=`) | Luft             | Används för                                       |
| ------------------------------ | ---------------- | ------------------------------------------------- |
| `tight`                        | `py-12` (48)     | Referens: typ, mått, formatering, tillstånd.      |
| `base`                         | `py-16` (64)     | Standard.                                         |
| `loose`                        | `py-16 md:py-24` | Där siffrorna är huvudperson: nyckeltal, diagram. |

En sektion inleds med `border-t border-line`, sedan kommer rubriken. Innehållet börjar 40 px under (48 px från `md`). Ankarmål har `scroll-mt-28`, så att rubriken inte hamnar under toppbaren.

### 5.3 Ramar

- **Högst en kant per djupnivå och högst två nivåer totalt.** `Panel` sköter det: en panel i en panel ritar ingen egen ram utan blir en avdelning med en linje överst. Linjen utelämnas när den inre panelen står först, direkt efter en `PanelHeader` eller i en `PanelSection`.
- Underavsnitt i en panel skrivs med `PanelSection` (linje, etikett, 32/40 px luft), inte med nya paneler.
- `Panel variant="bare"` (ingen kant, bara padding) för komponentexempel och för allt som redan står i en panel.
- `KpiStrip` i en panel går ut till panelens kanter, så att avdelarna möter ramen. `KpiCard` släpper sin kant i en panel.
- `EmptyState` har egen ram som standard. Sätt `framed={false}` när den ligger i en `Panel`.
- Vänsterkantlinjer som accent på kort, notiser eller citat är förbjudna. Det enda undantaget är aktiv rad i sidomenyn, som har en 1 px indexlinje i `fg` (`side-nav.tsx`). Den är en positionsmarkör, inte en färgaccent.

### 5.4 Koordinatnät

- `.grid-field` (32 px) och `.grid-field-fine` (16 px) används **bara där något mäts**: huvuddiagrammets plotyta (`Panel grid marks`), måttspecimen och konstruktionsritningen av symbolen.
- Högst en nätyta per vy. Aldrig bakom hero, text, tomma lägen eller hela paneler.
- `CornerMarks` bara på samma yta som nätet.
- Nätet stängs av i utskrift (`--bl-grid: transparent`).

### 5.5 Rubrikmönster

```
05 / NYCKELTAL                                        PERIOD     30 d
Intäkt 72 360 kr. 9,6 % mer än 3 sep. – 2 okt.        ORDRAR    1 483
                                                      SIGNAL   1 st
```

- `SectionHeader`: etikett och rubrik i kolumn 1–8. Metadata (`meta`, en lista med etikett och värde i mono) eller åtgärder (`actions`) står i kolumn 9–12. Med `meta` toppställs blocket mot etiketten, med bara `actions` står de i höjd med rubrikens nederkant.
- Storlekar: `xl` (24 → 32 → 44), `lg` standard (24 → 32), `md` 20, `sm` 16.
- Den grå delen räknas fram ur samma data som vyn och hårdkodas aldrig.
- Metablocket används bara när det säger något som rubriken inte säger (period, urval, antal). Det är inte en mall som varje sektion ska ha; utan något att säga står rubriken ensam. Antal i metan räknas fram, och samma sak har samma tal och ord i index, sektion och kolofon.
- På en lång visningssida kommer siffrorna först (nyckeltal, diagram, tillstånd, rapport, mejl) och grunderna efter. Sidan visar produkten, inte koden: funktionsnamn, attribut, CSS och sökvägar står här i docs.

---

## 6. Komponenter

Komponenterna ligger i `src/components/ui`, `charts`, `shell`, `brand` och `report`. Alla har sin dokumentation i JSDoc. Här står när man väljer vilken.

### Knappar och kontroller

| Komponent                    | När                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button variant="primary"`   | Huvudåtgärden. Högst en per yta. Inverterad, aldrig signal.                                                                                                                           |
| `secondary` (standard)       | Vanliga åtgärder.                                                                                                                                                                     |
| `ghost`                      | Verktygsrader och tabellrader. Inaktiv ghost får ingen kant.                                                                                                                          |
| `danger` / `danger-confirm`  | Se avsnitt 3.                                                                                                                                                                         |
| `loading`                    | Tre punkter, `aria-busy`, `aria-disabled`. Fokus stannar och klick spärras. Använd inte `disabled` under laddning.                                                                    |
| `IconButton`                 | Ikon utan text. `label` är obligatorisk (blir `aria-label` och `title`).                                                                                                              |
| `Segmented`                  | 2–5 ömsesidigt uteslutande lägen (period, vy). Radiogrupp: piltangenter flyttar.                                                                                                      |
| `Input` / `Select` / `Field` | Formulär. `Select` är native. Enheten står efter talet (`suffix`). Fel visas med signalkant, ikon och text.                                                                           |
| `Kbd` / `HotkeyHint`         | Kortkommandon. Visar "⌘K" på Apple och "Ctrl K" annars, och ingenting innan plattformen är känd. Alltid `.label` (versal), full textfärg, och "Ctrl K" med hårt mellanslag i löptext. |
| `Icon`                       | Egen uppsättning på 16 px-rutnät, 1,25 px linje, raka ändar. Inga ikonbibliotek och inga ikoner i färgade rutor.                                                                      |

### Nyckeltal

| Komponent                | När                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KpiStrip`               | **Standard** för två till sju nyckeltal. En sammanhängande remsa med 1 px avdelare och en `primary`. `comparison` skrivs en gång i huvudet. Under 640 px blir den 2 × 2 utan trendlinjer. |
| `KpiCard`                | Ett ensamt nyckeltal. Sätt `deltaLabel=""` när jämförelsen står i rubriken. Flera i rad blir `KpiStrip`.                                                                                  |
| `KpiTrace` / `Sparkline` | 1 px linje utan fyllning och en streckad referenslinje. Noden visas bara vid larm.                                                                                                        |

- `alert` kräver alltid `alertText` ("Gräns 3 st").
- `motion="fade"` är standard. Använd `count` bara när uppräkningen har en poäng.
- Förbättring och försämring visas i `fg` med samma tyngd. Glyf och tecken bär riktningen, och `invert` används när en minskning är bra.

### Tabeller

| Läge                 | Val                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Upp till 200 rader   | `DataTable` som vanlig tabell. Celler kan bryta rad.                                                              |
| Över 200 rader       | Virtualiseras automatiskt (`virtualize`, `maxHeight` 560). Fast radhöjd, text kortas med ellips.                  |
| Stora datamängder    | `dense` (36 px), `columnPicker`, `exportFileName` (CSV med BOM, semikolon och decimalkomma via `src/lib/csv.ts`). |
| Rapport och utskrift | `ReportTable` (statisk). Långa tabeller delas med `splitRows` och `continued`.                                    |

- `caption` är obligatorisk (visuellt dold om inte `showCaption`).
- `columns` definieras utanför komponenten eller med `useMemo`. Annars sorteras tabellen om vid varje rendering.
- Status i tabell: `StatusTag` i egen kolumn, som aldrig döljs på mobil. `isFlagged` bara för rader som kräver åtgärd (räknas i signalbudgeten).
- Tom tabell: `DataTable` saknar eget tomt läge. Rendera `StateMessage` i stället för tabellen, eller `StateRow` i en egen tabell.

### Status

`StatusTag` och `StatusGlyph`. Tyngden följer allvaret:

| Status     | Form                      | Kant                | Text                |
| ---------- | ------------------------- | ------------------- | ------------------- |
| `ok`       | liten fylld kvadrat, 6 px | ingen               | "I drift", `muted`  |
| `neutral`  | liten kvadrat             | ingen               | "Info", `muted`     |
| `warning`  | halvfylld kvadrat         | 1 px `line-control` | "Varning", `fg`     |
| `offline`  | streckad kvadrat          | streckad            | "Ur drift", `muted` |
| `critical` | fylld kvadrat i signal    | 1 px `signal-line`  | "Kritisk", `fg`     |

### Tom-, fel- och laddningslägen

- `StateMessage` för alla lägen: `empty` (0 RADER), `no-results` (0 TRÄFFAR), `error` (FEL), `loading-failed` (EJ LADDAD), `offline` (UR DRIFT), `denied` (SAKNAR BEHÖRIGHET) och `not-configured` (EJ KONFIGURERAD).
- Mönstret är ett prefix i mono, en mening om vad som saknas, var och när, och en åtgärd med verbet först och `→`. Tekniska uppgifter (request-id, tid, tjänst, svar) står bakom "Visa detaljer" och kan kopieras. Ingen stacktrace.
- `compact` i panel eller tabellrad (`StateRow`). Blockläget används när läget ersätter en hel yta.
- `error` och `loading-failed` har `role="alert"` och signal på glyfen. Övriga har `role="status"` och är grå.
- Laddning: `Skeleton`, `KpiSkeleton`, `TableSkeleton` (pulserar, ingen gradient) med `aria-busy`. I diagram ersätter det kompakta läget plotytan medan axeln står kvar.
- `EmptyState` finns kvar som tunn wrapper. Ny kod använder `StateMessage`.

### Notis

`useToast()` inuti `ToastProvider` (monterad i `app/layout.tsx`). Används för kvitton på något användaren just gjort: "Rapport skickad", "Påfyllning registrerad". Högst tre åt gången, 5 s, pausas vid hover. `tone="critical"` ger `role="alert"` och signalkant, men fel som stoppar arbete visas på platsen med `StateMessage`, inte bara i en notis.

### Dialog

`Modal` (byggd på `<dialog>`): fokusfälla, Esc, inert bakgrund. Fokus går tillbaka till knappen som öppnade den. Den är ett ark från botten på mobil. Använd den för beslut som behöver bekräftas eller för korta formulär, inte för att visa information som kunde stå på sidan. Knappraden har avbryt till vänster och åtgärd till höger, och på mobil står åtgärden överst. `ModalPanel` för statiska exempel.

### Kommandopalett

`CommandPalette` med `useCommandPaletteHotkey` (⌘K på Apple, Ctrl+K annars, "/" utanför fält). Används för navigation och åtgärder som kan nås från var som helst. Registrera genvägen **en gång** (i toppbaren), annars växlar paletten två gånger. Bygg `groups` med `useMemo`. Lägg maskin-id i `hint` och ort i `keywords`. Träffar markeras i `fg`, aldrig i färg. Samma automatnamn som i resten av panelen ("BL-002 Mobilia"), platsen i butiken som `hint`. Esc rensar fältet först och stänger dialogen andra gången; i flödet (`inline`) rensar den. Sökraden får en synlig fokusmarkering i `inline`-läget.

### Skal och varumärke

- `AppShell` (sidomeny, toppbar, periodrad, mobilnavigering). Perioden ligger i URL:en (`period-state.ts`, `usePeriod`).
- `Wordmark` (`sm` 16/18, `md` 20/23, `lg` 24/28 för rapporthuvud, `xl` 64/73) och `Symbol`. Minsta symbol är 12 px (`MIN_SYMBOL_PX`), och friytan är halva symbolhöjden. `mono` används för svartvitt.

---

## 7. Diagram

Komponenter i `src/components/charts`: `LineChart`, `BarChart`, `WaterfallChart`, `ProfitBridge`, `Heatmap`, `ShareBar` och `Sparkline`. En brygga som står nära ett nyckeltal för intäkt börjar på **samma** intäkt och drar av "Utan inköpspris" som eget steg (`WaterfallChart` direkt, `showShare={false}`), så att samma ord aldrig betyder två tal på samma skärm. Steg som är 0 ritas inte. Byggstenarna (`AxisText`, `AxisUnitLabel`, `LabelBlock`, `Node`, `HatchPattern`, `Readout`, `ChartFigure`) finns i `primitives.tsx`, etikettplaceringen i `layout.ts` och axelenheterna i `axis.ts`.

### Konstruktion

- **Annoteringar i stället för legender.** Serier namnges direkt vid linjen ("Föreg. 30 d" via `compareName`). Toppen får datum och värde, och händelser får text ("Släpp: Black Bolt"). `layout.place()` provar kandidatlägen och lägger aldrig en etikett över huvudserien (`opts.hard`).
- **Hjälplinjer:** referens eller snitt streckad i `fg-subtle` med etikett ("SNITT 4 131 kr"), mål som hjälplinje.
- **Raka segment** (`curveLinear`). Inga utjämnade kurvor som hittar på mellanvärden.
- **Noder** bara för topp, botten, senaste och aktiv punkt. Inget pärlband.
- **Toppen i fg**, aldrig i signal (`peakIndex`, `markMax`). Larmet i signal har alltid en notering (`alertIndex` + `alertNote`, `flag` + `note`).
- **Huvudpersonen** får full bredd och nät (`Panel grid marks`). Övriga diagram står utan nät.

### Axlar och enheter

- En enhet per axel, skriven en gång ovanför axeln i gemener: "tkr", "köp". `axisScale` väljer kr, tkr eller mkr utifrån största tick, så att en axel aldrig blandar "5 000" och "15 tkr". Skicka `unit`, inte egna `formatAxis` (föråldrat och ignorerat).
- Tickarna har bara tal ("0 2 4 6") med samma antal decimaler.
- Kategorier på x-axeln är id i mono ("BL-010"), inte avkortade namn. Liggande `BarChart` (standard) ger alla poster etikett.
- En tick döljs aldrig för en annotering. Annoteringen flyttas i stället. Sista datumet högerställs mot kanten.

### Svartvitt

Varje diagram ska gå att läsa utan färg. Formen bär betydelsen:

| Betydelse                  | Form                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Aktuell serie / jämförelse | Heldragen linje / streckad linje med ihåliga cirkelnoder.                                                |
| Topp, aktiv punkt          | Fylld kvadrat i `fg`.                                                                                    |
| Kräver åtgärd              | Fylld kvadrat med ring (`signal-ring`), signalskraffering med 2 px ram, alltid text med `! `.            |
| Minskning / avdrag         | Skraffering (`HatchPattern`, 1 px i `fg-muted`, minst 3:1).                                              |
| Ökning                     | Ihålig stapel.                                                                                           |
| Ingår inte                 | Streckad kontur, avskild med en lodlinje.                                                                |
| Andelar                    | `ShareBar` som lista: egen 4 px stapel per rad, högst tre gråtoner.                                      |
| Värmekarta                 | Högst fem fyllda steg (`thresholds`), 0 som tom ruta med kant, etikett vid varje gräns, enheten en gång. |

### Interaktion

- **Läslinje och läsruta** (`Readout`) vid hover visar datum eller kategori och exakt värde i mono. Läsrutan vänder vid kanten.
- **Tangentbord:** `LineChart`, stående `BarChart`, `WaterfallChart` och `Heatmap` är ett tabbstopp (`tabIndex=0`, `role="img"`). ← och → flyttar läsrutan. I `LineChart` går Home och End till ändarna, och i `Heatmap` flyttar ↑ och ↓ mellan rader. Vid fokus visas läsrutan direkt: på toppen i linje- och stapeldiagram och på resultatet i vattenfallet. Fokusringen ligger 4 px utanför ritytan. Nya diagram följer samma mönster: `tabIndex=0`, `role="img"`, `onKeyDown` och `focus-visible:outline-solid`, aldrig `outline-none`.
- **Skärmläsare:** `summary` är obligatorisk och ska innehålla siffrorna ("Totalt 72 360 kr, snitt 2 412 kr per dag."). Den blir `figcaption` och `aria-label` och nämner piltangenterna. Liggande staplar och andelslistan är vanliga listor.
- Diagram mäter sin bredd (`useMeasure`) och fungerar från 375 px. Etiketter som inte ryms får kort form (`short`), två rader eller en lista.

---

## 8. Utskrift och e-post

### Utskrift och PDF

- Rapporter byggs med `ReportDocument` och `ReportPage` från `@/components/report`. Varje `ReportPage` är ett A4-ark (210 × 297 mm, padding 16 × 18 mm) med sidhuvud (`Wordmark size="lg" mono`), sidnummer och genereringsdatum. Exempel finns i `/rapport/exempel`.
- Temat är `data-theme="print"` (sätts av `ReportDocument`): vitt papper, gråskala, och signalen blir #111. `tone="signal"` behåller kulören för skärm-PDF.
- Använd utskriftsvarianterna `ReportLineChart`, `ReportBarChart`, `ReportShareBar` och `ReportTimeline`, inte skärmdiagrammen. De har ingen hover och ingen mätning. Serier skiljs med linjestil och markör och namnges vid linjens slut.
- Markerad rad, nyckeltal eller förklaring: `ReportMark` (fylld kvadrat med ring) plus text. Markerad stapel är fylld svart mot ljusgrå staplar med värdeetikett.
- Innehåll som inte ryms klipps vid utskrift. På skärmen flaggas det ("Innehållet är N px för högt för arket"). Dela långa tabeller med `splitRows`.
- `data-print="hide"` på verktygsrader och knappar som inte ska skrivas ut.
- Rubrikerna i rapporten följer samma mönster som skärmen: "01 / SAMMANFATTNING", tvådelad med fakta. Använd `as` och `headingLevel` när rapporten bäddas in.

### E-post

- Mallen finns i `src/emails/report-email.tsx` och renderas med `renderReportEmail(props)`, som ger `{ subject, preheader, html, text }`. Det finns tre mottagare: `butik`, `bokforing` och `delagare`.
- Mejl är **alltid ljusa**. Färgerna är hex i `src/emails/theme.ts` och speglar det ljusa temat. Ändra `tokens.css` först och för sedan över värdet (testet jämför dem).
- Innerbredden är 600 px. Grundvärdena inline (marginal 24 px, rubrik och nyckeltal 24 px) ska rymmas i 375 px utan `<style>`, eftersom Gmail inte läser media queries. Media queries får bara lägga till luft.
- Mejlet får inte innehålla `class=`, `<svg`, externa stilmallar eller bilder, och HTML:en ska vara under 100 kB. Symbolen ritas som tabellceller (`EmailSymbol`) och staplar som celler.
- Tal byggs med `format.ts`, precis som i appen. Textversionen (`text/plain`) ska innehålla samma uppgifter.
- Signalen följer samma regler som i appen: bara för det som kräver åtgärd, alltid med text bredvid (`8 × 8 px`-markör).
- Efter ändringar i `src/emails/` skrivs `src/app/design/epost/rendered-samples.json` om: `UPDATE_EMAIL_SAMPLES=1 npx vitest run src/app/design/epost`.
- Förhandsvisning finns på `/design/epost?typ=butik|bokforing|delagare`. Mallen är bara testad i Chromium. Outlook för Windows och Gmail testas med ett riktigt utskick före lansering.

---

## 9. Text

### Ton

Saklig, kort och konkret, som en instrumentpanel och inte en säljsida. Skriv vad som är sant, med siffran först.

- Konkreta rubriker: "BL-003 har 17 % kvar, gränsen är 20 %." Inte "Lagerstatus" eller "Toppen sticker ut."
- Tom- och fellägen: säg vad som saknas, var och när ("Inga köp av Black Bolt i BL-002 sedan 31 okt. 16:40."). Säg vad som fortfarande gäller ("Senaste lyckade synk 14:32."). Åtgärden skrivs med verbet först ("Försök igen", "Rensa sökningen", "Begär behörighet").
- Inga ursäkter, utrop, emoji eller "Hoppsan!".
- **Inga metatexter.** Gränssnittet pratar inte om sig självt: inga instruktioner som "Klicka för att …", "Hovra över …" eller "Testa båda", och ingen utvecklarmeta ("tnum", "aria-live", "v0.1", filsökvägar) i UI:t. Tangentbordsstöd beskrivs i `aria-label` och här, inte i brödtext.
- Siffror i text räknas fram ur datan och hårdkodas aldrig.

### Ordlista

| Ord              | Betydelse                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order            | En betald Awish-order. En order är ett sålt pack.                                                                                                                                                                                             |
| Fack             | En plats i automaten med en titel. Varje automat har sex fack.                                                                                                                                                                                |
| Tomt fack        | Ett fack som sålt slut. Skrivs "Tomt fack 3", med enheten "st" i nyckeltal.                                                                                                                                                                   |
| Påfyllning       | Ett besök där pack läggs i automaten. Gränsen för påfyllning är 20 % fyllnad.                                                                                                                                                                 |
| Ur drift         | Automaten kan inte sälja.                                                                                                                                                                                                                     |
| Intäkt           | Betalt belopp minus moms. Med dagens inställningar (moms 0) samma som betalt belopp.                                                                                                                                                          |
| Butiksersättning | Provision plus hyra till butiken där automaten står.                                                                                                                                                                                          |
| Kortavgift       | Avgift till kortinlösaren, räknad på beloppet inklusive moms. I dag 0.                                                                                                                                                                        |
| Vinst / Förlust  | Intäkt − inköp − avgifter − butiksersättning, bara för ordrar med inköpspris. Negativ vinst heter "Förlust". Skriv aldrig "Resultat", varken i panel, rapport eller mejl. Står en titel utanför vinsten (saknar inköpspris) säger texten det. |
| Svinn            | Pack som försvunnit eller skadats.                                                                                                                                                                                                            |
| I dag, i år      | Skrivs isär.                                                                                                                                                                                                                                  |

### Ord att undvika

| Undvik                                                    | Skriv                             |
| --------------------------------------------------------- | --------------------------------- |
| Slutförsäljning, Slutförsäljn.                            | Tomt fack                         |
| Offline, OFFLINE                                          | Ur drift                          |
| Idag, Igår                                                | I dag, i går                      |
| ÅTD, YTD                                                  | I år                              |
| Dashboard                                                 | Översikt                          |
| Spacing                                                   | Avstånd                           |
| Skeleton, Loading                                         | Laddar                            |
| Toast                                                     | Notis                             |
| Crosshair, Hovra                                          | Läslinje, peka på                 |
| Copy                                                      | Text, formuleringar               |
| Linje / yta                                               | Linje                             |
| Ingen data                                                | Vad som saknas, var och sedan när |
| Omsättning (för intäkt)                                   | Intäkt                            |
| Förkortningar med punkt i etiketter (Slutförsäljn., Ant.) | Hela ordet                        |
| 4.5:1, 4px                                                | 4,5:1, 4 px                       |

---

## 10. Tillgänglighet

### Krav

| Krav                    | Hur                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kontrast text ≥ 4,5:1   | Text i `fg`, `muted`, `subtle`, `disabled` eller `signal-fg`. Aldrig `faint` och aldrig `signal` som text i ljust läge.                                                                              |
| Kontrast grafik ≥ 3:1   | Kontrollkanter i `line-control` mot `bg`, `signal-line`, skraffering, diagramlinjer i `data-1`–`data-3`.                                                                                             |
| Synligt fokus           | Global `:focus-visible`: 2 px `--bl-focus` med 2 px offset. Ta aldrig bort det med `outline-none` utan ersättning. Ringen ligger utanför en eventuell signalkant.                                    |
| Status aldrig bara färg | Form och text i varje status, larm och diagrammarkering (avsnitt 3 och 7).                                                                                                                           |
| Tangentbord             | Allt som går att klicka går att nå med Tab. Segment och paletter används med piltangenter, dialoger stängs med Esc och fokus återställs. Diagram läses med piltangenterna.                           |
| Skärmläsare             | `lang="sv"`. Landmärken (`nav aria-label`, `section aria-labelledby`), `caption` på tabeller, `summary` på diagram, `aria-sort`, `aria-live` på radräknare och notiser, `role="alert"` bara för fel. |
| Rörelse                 | `prefers-reduced-motion` stänger av all rörelse.                                                                                                                                                     |
| Mobil                   | 375 px utan horisontell scroll. Tryckytor minst 28 px höga (knapp `sm`), helst 36.                                                                                                                   |
| Rubrikordning           | En h1 per sida, inga hopp.                                                                                                                                                                           |

### Så testas det

1. **Kontrast:** färgtabellen på `/design` räknar kontrasten ur `tokens.css` med `contrast()` i `src/app/design/tokens.ts`. En ny färgtoken kontrolleras där i båda lägena och i utskrift.
2. **Tangentbord:** gå igenom vyn med bara Tab, Skift+Tab, piltangenter, Enter, Mellanslag och Esc. Fokus ska alltid synas och aldrig hamna på `body`.
3. **Svartvitt:** lägg på `html { filter: grayscale(1) }` (DevTools → Rendering → Emulate vision deficiencies → Achromatopsia). Varje status och larm ska gå att läsa. Skriv ut rapporten till PDF (`/rapport/exempel`) och granska den i gråskala.
4. **375 px och reducerad rörelse** med Playwright (dev-servern på port 3200):

   ```js
   // NODE_PATH=$(npm root -g) node check.js
   const { chromium } = require("playwright");
   (async () => {
     const b = await chromium.launch({ args: ["--no-proxy-server"] });
     const ctx = await b.newContext({
       viewport: { width: 375, height: 800 },
       reducedMotion: "reduce",
     });
     const p = await ctx.newPage();
     p.on("console", (m) => m.type() === "error" && console.log("konsolfel:", m.text()));
     await p.goto("http://localhost:3200/design", { waitUntil: "load" });
     await p.waitForTimeout(2500);
     console.log("scrollWidth", await p.evaluate(() => document.documentElement.scrollWidth)); // ska vara 375
     await p.addStyleTag({ content: "html{filter:grayscale(1)}" });
     await p.screenshot({ path: "gra.png", fullPage: true });
     await b.close();
   })();
   ```

5. **Signalbudget:** räkna objekt med signalfärg per skärmhöjd (computed `color`, `background-color`, `border-color`, `fill`, `stroke` mot värdena i avsnitt 2.1). Högst tre per vy och högst en per diagram.
6. **Enhetstester:** `npm test` (formatering, CSV, sökning, perioder, e-post). `npm run typecheck`, `npm run lint` och `npm run format:check`.
7. **Godtyckliga värden:** `grep -rnE 'text-\[[0-9]+px\]|tracking-\[|duration-\[' src --exclude-dir=report --exclude-dir=rapport` ska inte ge några nya träffar.

---

## 11. Checklista före merge av ny vy

**Innehåll och text**

- [ ] Vyn har en huvudperson, och siffran står först.
- [ ] Sektionsrubriker är tvådelade med en siffra eller ett faktum i den grå delen, räknat ur datan.
- [ ] Etiketterna är mono VERSAL med mått ("02 / INTÄKT PER AUTOMAT · 30 D").
- [ ] Ingen metatext, inga instruktioner och ingen utvecklarmeta i UI:t. Bara svenska ord (se 9).
- [ ] Alla tal, belopp, datum och perioder går via `src/lib/format.ts`.

**Signal och status**

- [ ] Signalen används bara för det som kräver åtgärd. Högst en per diagram och högst tre per vy.
- [ ] Toppar och rekord är `fg` med annotering.
- [ ] Varje status och larm har form och text. Vyn går att läsa i gråskala.

**Form**

- [ ] Bara tokens: inga hex-värden, `text-[..]`, `tracking-[..]` eller `duration-[..]`.
- [ ] Högst två nivåer ramar. Underavsnitt med `PanelSection` eller `Sub`, inte nya paneler.
- [ ] Koordinatnät bara på en yta där något mäts, eller inget nät alls.
- [ ] Radier 2/4/6 efter storlek. Inga skuggor, gradienter, pill-former eller färgade ikonrutor.
- [ ] 12-kolumnsrutnät från `lg`, med fördelning efter innehåll och 8 px-rytm.

**Tillstånd**

- [ ] Tomt läge, laddning och fel är gjorda med `StateMessage` och `Skeleton`.
- [ ] Knappar som laddar använder `loading`, inte `disabled`.

**Diagram**

- [ ] Annoteringar i stället för legend, en enhet per axel och `summary` med siffror.
- [ ] Diagrammet går att läsa med tangentbordet och i svartvitt.

**Tillgänglighet och bredd**

- [ ] Fokus syns överallt, Esc stänger och fokus återställs.
- [ ] 375 px utan horisontell scroll, och inga konsolfel.
- [ ] Mörkt och ljust läge är kontrollerade, och utskrift om vyn har en rapport.
- [ ] `npm test`, `typecheck`, `lint` och `format:check` går igenom.

---

## Kända avvikelser (2 nov. 2026)

Det här bryter mot reglerna ovan och ska rättas av den som äger filen:

1. **`formatRelative`** skriver "igår". Ordlistan säger "i går". Utdatan används i `automater/_components/machine-table.tsx` och testas i `src/import`, så ändringen görs samlat.
2. **Utskriftstemat saknar `--bl-signal-line`, `--bl-signal-hover` och `--bl-fg-disabled`.** De ärvs från appens läge, så en kritisk statusetikett får orange kant på ett ark med `tone="mono"`.
3. **`::selection`** i `globals.css` använder `--bl-signal-soft`. Markering är inte en åtgärd.
4. **Inloggningssidan** (`app/logga-in/auth-frame.tsx`) har nät bakom formuläret och en gradientmask.
5. **`--bl-line-control`** når bara 2,7–2,9:1 mot `hover` och `raised` i mörkt läge. Kontroller står därför på `bg-bg` (fältets fyllning).
6. **Gråskalesnapshots per diagram (G15)** saknas. Kontrollen är manuell tills vidare.
7. **`ReportMark`** på den markerade tabellraden i månadsrapporten (släppet) är signal i `tone="signal"`. Släppet är inget som kräver åtgärd; markeringen bör bli `fg`.
8. **Next.js dev-indikator** ligger över användarnamnet i sidomenyn i utvecklingsläge. `devIndicators: false` i `next.config.ts` tar bort den.
9. **Apple-ikonen och `favicon.ico`** har kvar ringen i signalfärg. `app/icon.svg` är rättad.
