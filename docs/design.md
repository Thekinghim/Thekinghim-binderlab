# Binderlab: designregler

Visningssidan är `/design`. Den läser tokens ur `src/styles/tokens.css` och exempeldata ur `src/app/design/sample-data.ts` (tre automater i tre butiker och ett års Awish-ordrar). Reglerna nedan gäller allt i panelen, rapporterna och e-posten.

## Principer

| Regel                          | Innebörd                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| En signalfärg                  | `--bl-signal` betyder att någon ska göra något. Aldrig rekord, toppar, fokus eller dekor.                                 |
| Siffror först                  | Tal står i Geist med tabulära siffror (`tnum`), högerställda i tabeller. Geist Mono bara för etiketter, id, tider, axlar. |
| Konstruerade diagram           | Direktannoteringar, hjälplinjer och noder i stället för legender.                                                         |
| Status utan färgberoende       | Form och text bär status. Färg är alltid en tredje bärare.                                                                |
| Rubriker med fakta             | Tvådelad rubrik bara på sektionsnivå. Den grå delen är ett påstående med en siffra, aldrig en fyllnadsfras.               |
| Sidan pratar inte om sig själv | Inga instruktioner ("Klicka för att …") och ingen utvecklarmeta i gränssnittet.                                           |

## Signal

- Används för: tomt fack, fyllnad under påfyllningsgränsen (20 %), fel som stoppar arbete, titel utan inköpspris.
- Högst en signalmarkering per diagram och högst tre per synlig vy.
- Toppar och rekord markeras i `--bl-fg` med en annotering ("24 okt. · 7 964 kr").
- Fylld signalknapp (`danger-confirm`) bara i bekräftelsedialogens sista steg. Annars `danger`: signaltext och signalkant utan fyllning.

## Fokus

- `--bl-focus` är `--bl-fg` i båda lägena: 2 px outline med 2 px offset.
- Ett fält med fel bärs av signalkant och feltext, aldrig av fokusringen.
- Diagram går att läsa med tangentbord: Tab in i diagrammet, piltangenterna flyttar läsrutan.

## Ramar och nät

- Högst en kant per djupnivå och högst två nivåer kanter totalt. Underavsnitt står direkt på ytan, åtskilda av en 1 px linje och en etikett.
- `Panel variant="bare"` för komponentexempel som redan står i en panel.
- Radier efter storlek: etikett 2 px, kontroll 4 px, panel och dialog 6 px.
- Koordinatnät (`grid-field`) bara där något mäts: huvuddiagrammets plotyta och måttspecimen. Högst en nätyta per vy.

## Tomma lägen och fel

- En rad i mono med prefix (TOMT, FEL 503, UR DRIFT …), en mening om vad som saknas, var och när, och en åtgärd med verbet först.
- Inga illustrationer, ursäkter eller utrop. Tekniska uppgifter bakom "Visa detaljer".

## Rörelse

- `fast` 120 ms (hover, färg), `base` 150 ms (segment, värdebyte), `slow` 180 ms (dialog, notis). Uppräkning (420 ms) bara på begäran.
- Ingen rörelse vid `prefers-reduced-motion`.

## Ordlista

| Ord              | Betydelse                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| Order            | En betald Awish-order. En order är ett sålt pack.                                    |
| Fack             | En plats i automaten med en titel. Varje automat har sex fack.                       |
| Tomt fack        | Ett fack som sålt slut. Skrivs "Tomt fack 3", aldrig "slutförsäljning".              |
| Påfyllning       | Ett besök där pack läggs i automaten. Gränsen för påfyllning är 20 % fyllnad.        |
| Ur drift         | Automaten kan inte sälja (används i stället för "offline").                          |
| Intäkt           | Betalt belopp minus moms. Med dagens inställningar (moms 0) samma som betalt belopp. |
| Butiksersättning | Provision plus hyra till butiken där automaten står.                                 |
| Kortavgift       | Avgift till kortinlösaren, räknad på beloppet inklusive moms. I dag 0.               |
| Vinst            | Intäkt − inköp − avgifter − butiksersättning, bara för ordrar med inköpspris.        |
| I dag, i år      | Skrivs isär. Aldrig "Idag" eller "ÅTD".                                              |
