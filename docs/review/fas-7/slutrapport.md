# Fas 7: slutrapport

**Fas 7 (kvalitet, drift och överlämning) är klar 2 nov. 2026.** Panelen har testats i fyra lager, säkerhetsgranskats
med attacktester, mätts med 109 000 order, gåtts igenom sida för sida och dokumenterats för en köpare. En oberoende
granskning inför en styrelsedemo gav 7/10; alla punkter med allvar hög och medel är rättade och provade i
webbläsaren. Det som återstår kräver nycklar, avtal eller beslut från beställaren (sist i rapporten och i README,
"Läge och kvarstående").

| Område        | Resultat                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tester        | 2 546 enhetstester (UTC, Stockholm, Shanghai), 2 409 databastester i en hel körning, 18 e2e-tester i sex flöden; alla gröna                            |
| Säkerhet      | 505 attacktester gröna; säkerhetshuvuden; inga kända hål med allvar hög                                                                                |
| Prestanda     | 0 av 40 mätningar över 800 ms TTFB med 109 247 order; längsta färdiga sida 2,0 s (30 d) och 2,8 s (Allt)                                               |
| Genomgång     | 113 fynd i tre genomgångar, 89 rättade direkt; styrelsedemo-granskningen: 7 höga och 25 medel, alla rättade utom laddtiden i `next dev` (dokumenterad) |
| Dokumentation | README, architecture, datamodell, berakningar, decisions, product, operations, miljoer, demo, design                                                   |

## Tester

- **Enhetstester** (`npm test`): 2 546 tester i 174 filer, gröna i UTC, Europe/Stockholm och Asia/Shanghai.
  Tidszonssviterna för beräkningar och seed (`test:domain:tz`, `test:seed:tz`) är gröna i alla tre.
- **Databastester** (`npm run test:db`): 2 409 tester mot riktig Postgres 16 i en hel körning: RLS och isolering
  mellan organisationer, triggrar, RPC:er, tjänster, attacktester och avstämning mellan vyerna.
- **E2E** (`npm run test:e2e`): 18 tester i sex flöden (inloggning, import, påfyllning, prisändring,
  rapportutskick, felövervakning) mot en egen dev-server och databas.
- **Typer, lint och format:** `tsc --noEmit` i strikt läge, ESLint och Prettier utan anmärkning. `next build`
  går igenom.
- Två tester som slumpvis föll i en hel körning är gjorda deterministiska: två rapportversioner med samma
  `generatedAt` (`monitoring-closing.test.ts`) och en kopia av läsarens egen profil (`rls-roles.test.ts`).
- Nya tester i slutsteget: lagerhändelsernas ISO-tid mot vyn `stock_levels` (`test/db/prestanda.test.ts`),
  tystnaden fram till importens slut (`stale-machine.test.ts`), beloppet för den första punkten i Att göra,
  portalens standardmånad, butikens namn i inbjudan och ny text i mejl och PDF.

## Säkerhet

- 505 attacktester: server actions, rutter, RPC:er, storage, IDOR, export, cron, sökning och demoåterställningen.
  All dataåtkomst går via `withUserDb` och RLS; rollerna kontrolleras med `requireRole`.
- Säkerhetshuvuden (CSP, X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy, COOP). Permissions-Policy
  innehåller bara funktioner som Chromium känner igen, så sidorna ger inga konsolvarningar.
- Inbjudningssidan visar inte längre systemstatus (databasens svarstid, miljö, inloggningssätt) för mottagare
  utanför bolaget.
- Kvar (README): nonce-CSP i stället för `'unsafe-inline'`, `includeSubDomains` i HSTS, gränser för utskick och
  gemensamma gränser för alla serverinstanser.

## Prestanda

Mätt i `next start` med 109 247 order (`docs/review/fas-7/prestanda.md`): ingen av 40 mätningar över 800 ms TTFB,
alla sidor under målet för färdig sida. Ekonomi 30 d ligger på gränsen (2,0 s). Rättningen av förlorad försäljning
ändrar inte frågan, bara formatet på tidpunkten.

## Styrelsedemo-granskningen

Rättat och provat på 3200 som `demo@` och `agare@` (Playwright, 1 440 och 375 px):

| Punkt (allvar)                        | Åtgärd                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Förlorad försäljning fel (hög)        | `queryMachineStockEvents` skickar ISO-tid, så händelserna inom en dag ordnas på tid som vyn. Demon: ca 7 400 kr (30 d) i stället för 4 100 kr, ca 64 500 kr (Allt) i stället för 44 700 kr |
| Ekonomi visar fel period (hög)        | Rubriken säger "för försäljningen i oktober 2026", utbetalningens egen period                                                                                                              |
| Tystnaden för automat 07 (hög)        | Att göra och Hem räknar fram till importens slut som Drift: 62 timmar överallt                                                                                                             |
| Beloppet i Att göra (hög)             | "Den står för 9 684 kr av 15 915 kr i intäkt i risk"                                                                                                                                       |
| Engelska ord (hög)                    | "ur drift" / "saknar anslutning", "Prövad på 6 veckor", "Fel per dag", "För högt/lågt", "Intressent"                                                                                       |
| Dev-indikatorn (hög)                  | `devIndicators: false`                                                                                                                                                                     |
| Git och `main` (hög)                  | Ändringarna committade med riktiga meddelanden och `claude/bygge` sammanslagen med `main` efter grön körning                                                                               |
| Prognos, förlorad försäljning (medel) | Perioder utan kostnad döljs (antalet står under tabellen), "Pris saknas" i stället för "–", "titeldagar" förklarade                                                                        |
| Expansion (medel)                     | Scenariot räknar som standard på platsen i rubriken (Spelhallen Nova); "Mål som ligger efter"                                                                                              |
| Butiksrapporten (medel)               | Avsändaren i sidhuvud och sidfot, "gav mest försäljning", rad för övriga titlar och totalsumma, en decimal som mejlet, "Flest köp" i båda, butikens länk går till portalen                 |
| Ekonomi, försenad utbetalning (medel) | "Utbetalningen på 74 625 kr som väntades 31 okt. har inte kommit"                                                                                                                          |
| Portalen (medel)                      | Öppnar på senaste hela månaden; inbjudan nämner butiken; ingen systemstatus                                                                                                                |
| Automatnamn (medel)                   | Automatens namn i meningar på Lager, Att göra och Prognos; koden i taggar och tabeller                                                                                                     |
| Docs (medel)                          | `demo.md`, `product.md`, `operations.md` ("Inför en visning"), `berakningar.md` och `bygglogg.md` stämmer med panelen                                                                      |
| Mindre (medel)                        | Permissions-Policy utan `bluetooth`, "2 523 order", Effekt märkt som påhittad i demo.md och operations.md                                                                                  |

## Kvarstående

1. **Extern drift är inte provad:** Supabase, Resend, Sentry, Vercel Cron, Web Push och e2e i CI har aldrig körts
   mot riktiga tjänster. Kräver nycklar och projekt (`docs/miljoer.md`).
2. **Avtal:** personuppgiftsbiträdesavtal, lagringstider och gallring, LICENSE-fil och köpeavtal, avtal med Awish.
3. **Awish:** automatisk import (`awish_grpc`) och maskindata kräver Awish dokumentation.
4. **Säkerhet:** nonce-CSP, HSTS `includeSubDomains`, gränser för utskick och gemensamma gränser.
5. **Plattformsfasen (fas 12):** fler operatörer, fakturering, plan och automatgräns, när 2–3 pilotoperatörer finns.
6. **Effekt:** beställarens utgångsläge och tre hela mätmånader.
7. **Mindre:** bokföringsmejlets länk kräver inloggning (underlaget är bifogat); i `next dev` tar första laddningen
   av Ekonomi och Assistent flera sekunder.
