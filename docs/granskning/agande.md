# Ägande och licenser

## Koden

- **Upphovsman:** all kod i repot är skriven för Binderlab. Git-historiken (166 commits sedan
  2 nov. 2026, `git shortlog -sne HEAD`) har två författare: ägaren (`Wilsterb`, GitHub
  `Thekinghim`) och Claude (Anthropic), som skrivit koden på ägarens uppdrag; 153 commits har
  raden `Co-Authored-By: Claude`. Ägaren har beställt och styrt arbetet. Hur rättigheterna
  till AI-skriven kod ska beskrivas i köpeavtalet bör en jurist bekräfta.
- **Ingen LICENSE-fil** och `"private": true` i `package.json`: koden är inte öppen källkod.
  Vad en köpare får (överlåtelse eller licens) ska stå i köpeavtalet och sedan i en
  LICENSE-fil i roten.
- **Ingen kod är kopierad från tredje part** utöver npm-paketen nedan. Två delar bygger på
  leverantörens material: Awish gRPC-definitionen (`src/server/awish/provider-proto.ts`, ur
  Awish dokumentation till kunder) och anropen till Awish webbpanel
  (`src/server/awish/web-documents.ts`, avlästa ur panelens publika JavaScript, se
  [integrationer.md](integrationer.md)).
- **Domän, konton och nycklar** (Vercel, Supabase, GitHub, Sentry, Resend, Anthropic, Awish)
  står på ägaren och flyttas vid en överlåtelse enligt
  [docs/operations.md](../operations.md#överlämning-till-en-ny-ägare).

## Tredjepartslicenser

Listan genereras ur `node_modules` med `node scripts/granskning/licenser.mjs`; hela listan
finns i [licenser.md](licenser.md). Produktionsberoenden (inte utvecklingsverktyg): **499 paket**,
varav 430 installerade i byggmiljön (resten är plattformsbinärer för andra operativsystem).

| Licens                                                             | Paket                  |
| ------------------------------------------------------------------ | ---------------------- |
| MIT                                                                | 367                    |
| ISC                                                                | 40                     |
| Apache-2.0                                                         | 38                     |
| BSD-3-Clause                                                       | 15                     |
| LGPL-3.0-or-later (libvips)                                        | 10 (+4 med Apache-2.0) |
| 0BSD, BlueOak-1.0.0, Unlicense, MIT-0, BSD-2-Clause, MIT/X11 m.fl. | 17                     |
| MPL-2.0                                                            | 1                      |
| FSL-1.1-Apache-2.0                                                 | 1                      |
| CC-BY-4.0, SIL OFL                                                 | 1 + 1                  |
| Ingen licens angiven                                               | 1                      |

### Flaggat (copyleft eller ingen licens)

| Paket                                                             | Licens                      | Varifrån och bedömning                                                                                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@img/sharp-libvips-*`, `@img/sharp-win32-*`, `@img/sharp-wasm32` | LGPL-3.0-or-later (libvips) | Bildbiblioteket `sharp` som Next.js använder (`next → sharp`). Dynamiskt länkat; LGPL kräver bara att biblioteket går att byta ut om det sprids. Binderlab sprider inte programvaran (tjänst på webben). |
| `web-push` 3.6.7                                                  | MPL-2.0                     | Web Push. Copyleft per fil: ändringar i paketets egna filer ska delas; Binderlab ändrar dem inte.                                                                                                        |
| `jszip` 3.10.2                                                    | MIT eller GPL-3.0-or-later  | Via `exceljs`. Dubbellicens: välj MIT.                                                                                                                                                                   |
| `buffers` 0.1.1                                                   | ingen angiven               | Via `exceljs → unzipper → binary`. Koden används aldrig (bara Excel-läsning i strömmar); kan tas bort med en `overrides` (README, "Licens och ägande").                                                  |

Inte copyleft men värt att känna till: `sentry` 0.45.0 (Sentry CLI, FSL-1.1-Apache-2.0, bara vid
bygget för källkartor; fri att använda men inte i en konkurrerande tjänst), `caniuse-lite`
(CC-BY-4.0, webbläsardata vid bygget) och `geist` (SIL Open Font License, typsnitten).

Ingen GPL- eller AGPL-kod ingår (utom `jszip`, som också är MIT). Sammanställningen är gjord
med ett skript, inte av jurist.
