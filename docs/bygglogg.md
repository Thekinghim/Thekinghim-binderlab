# Bygglogg

Byggets logg: läget per fas i planen och vad som gjordes, i tidsordning. Koden byggdes på grenen `claude/bygge` och
slås ihop med `main` efter varje avklarad fas när hela testsviten är grön. `main` är produktion (`docs/operations.md`).
Beslut som påverkar siffror och datamodell står i `docs/datamodell.md` (Beslut från beställaren) och
`docs/decisions.md`.

## Läge

| Fas                                     | Status | Anteckning                                                                          |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| 1 Designsystem                          | Klar   | Godkänd av beställaren; `/design` och `docs/design.md`                              |
| 1b Granska och komplettera              | Klar   | 31 granskningspunkter åtgärdade                                                     |
| 2 Data, säkerhet, inloggning, import    | Klar   | Datamodell v2 med RLS, dev- och Supabase-inloggning, Awish-import (CSV)             |
| 3 Skal, Hem, Att göra                   | Klar   |                                                                                     |
| 4 Lönsamhet, Inköpspriser               | Klar   |                                                                                     |
| 5 Order, Lager, Automater, Butiker      | Klar   |                                                                                     |
| 6 Rapporter                             | Klar   | Riktiga utskick kräver Resend (`MAIL_PROVIDER=resend`)                              |
| 6b Intelligens                          | Klar   | Assistenten kräver `ANTHROPIC_API_KEY`                                              |
| 7 Kvalitet, drift, överlämning          | Klar   | Se `docs/review/fas-7/slutrapport.md`                                               |
| 8 Drift: maskinhälsa, larm, ärenden     | Klar   | Maskinhälsan härleds ur försäljningen tills Awish maskindata finns                  |
| 9 Ekonomi: avstämning, bokföring, avtal | Klar   | Bokföringsprogram (Fortnox, Visma, Bokio) har gränssnitt men ingen implementation   |
| 10 Butiksportal, expansion              | Klar   |                                                                                     |
| 11 Marknadsintelligens                  | Klar   | Ingen extern priskälla kopplad; beställaren väljer källa (`docs/marknadskallor.md`) |
| 12 Plattform                            | Väntar | Enligt planen först när 2–3 pilotoperatörer finns (README, "Läge och kvarstående")  |

## Arbetsregler under bygget

- Lokal Postgres 16 på `127.0.0.1:54322` med databaserna `binderlab_dev` och `binderlab_test`; dev-server
  `npx next dev -p 3200`.
- Supabase, Awish, Resend, Sentry och Claude API gick inte att nå från byggmiljön (inget nät, inga nycklar). Allt
  byggdes med adaptrar och lokala implementationer för utveckling och test.
- Sammanslagning med `main` bara när `npm test`, `npm run test:db`, `tsc`, lint och `next build` går igenom.

## Logg 2 nov. 2026

### Fas 1b klar och på `main`

- Bygget typkontrollerar bara appens kod (`tsconfig.build.json`); tester och skript kontrolleras av
  `npm run typecheck` i CI.
- Saknad miljö stoppar inte servern: `/design` och `/datamodell` fungerar utan nycklar, inloggade sidor visar att
  konfigurationen saknas (`src/server/config-status.ts`). Dev-inloggningens spärr gäller som tidigare.
- `next build` och `next start` verifierade utan miljövariabler.

### Fas 2–5: alla sidor och slutkontroll (`main` 76cf22a)

- Byggda, granskade och rättade: inloggning, inbjudan, användare, Datakällor, Hem, Att göra, Lönsamhet,
  Inköpspriser, Inställningar, Order, Lager, Automater, Butiker.
- Hela testsviten grön: 1 866 databastester, 2 165 enhetstester, eslint rent. Avstämning mellan vyer
  (`test/db/consistency.test.ts`) och revisorns handräknade test; inga sifferavvikelser.
- Ny migrering `20261102160000_hardening_org_statistics.sql` (statistikskydd på `import_uploads*`).

### Fas 6–11

- Fas 6: Rapporter (butik, bokföring med SIE 4 och Excel, delägare; PDF, utskick, arkiv, schemaläggning).
- Fas 6b: Prognos & inköp, Assistent, Expansion, Enhetsekonomi, Effekt.
- Fas 8: Drift, Inkorg, larm, push, besöksplan och fältläge (PWA). Fas 11: Marknad.
- Fas 9–10: Ekonomi (avstämning, verifikationer, kassaflöde), Avtal och Butiksportal.

### Fas 7

- **Del 1:** demoorganisationen Nordljus Automater AB (demo) med 14 720 order och spärr mot att radera kunders
  organisationer, onboarding (Kom igång) och global sökning (⌘K).
- **Integration:** Hem, Att göra, Lönsamhet, Lager, Drift, Prognos och Rapporter kopplade till samma takt,
  besöksplan, förlorad försäljning, avtalspåminnelser och rapportutkast.
- **Säkerhet:** 505 attacktester (server actions, rutter, RPC:er, storage, IDOR, export, cron); säkerhetshuvuden
  (CSP, X-Frame-Options, HSTS m.m.), gallring bara som ägare, IP via Vercel-huvud, `/design` och `/datamodell`
  kräver inloggning.
- **E2E, backup och övervakning:** 18 e2e-tester i sex flöden mot egen server och databas, säkerhetskopia med
  återställningstest, larm vid misslyckad import, rapport och cron, Sentry Cron Monitors.
- **Genomgång A, B och C** av alla sidor (`docs/review/fas-7/genomgang-*.md`) med rättningar.
- **Dokumentation:** README (snabbstart provad från noll), architecture, datamodell, berakningar, decisions,
  product, operations, licenssammanställning.
- **Öppna punkter:** okänt id ger HTTP 404, diagrammen skalas före mätning, utgångna titlar ger inga
  påfyllningspunkter, demons telefonnummer är PTS fiktionsnummer, Vercel-region `arn1`, temat ur en cookie,
  licensen för `buffers` utredd.
- **Prestanda** med 109 247 order i `next start`: ingen sida över 800 ms TTFB eller målet för färdig sida
  (`docs/review/fas-7/prestanda.md`). Ny migrering `20261102230000_prestanda_stock_levels.sql`.
- **Slutverifiering:** prettier, eslint, tsc; 2 545 enhetstester i tre tidszoner; 2 408 databastester i en hel
  körning; 18 e2e-tester; `next build` utan miljö och med CI:s värden. Krocken mellan `seed.test.ts` och
  demotesterna löst.
- **Styrelsedemo-granskningen** (betyg 7/10) och rättningarna efter den: se `docs/review/fas-7/slutrapport.md`.

## Beställarens krav 2 nov. kväll

- Ingen manuell nedladdning från Awish. Byggs nu: Chrome-tillägg (MV3) som synkar var 10:e minut med användarens Awish-inloggning,
  hela historiken första gången, via ett ingest-API med återkallbar synk-token; larm om synken tystnar. Ersätts av gRPC-adaptern när Awish
  levererat app-ID/token. Frågat beställaren efter koden till det gamla ChatGPT-tillägget.
- Beställaren vill att jag driftsätter allt. Byggs nu: scripts/deploy/* (Supabase Management API, Vercel API, inbjudan av ägaren)
  - docs/driftsattning.md. Kräver SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN och nätverk till api.supabase.com, *.supabase.co, api.vercel.com
    i en ny session. Ägarens e-post bekräftas av beställaren innan inbjudan skickas.
- Arbetsflöde: wf_19bddf0c-b50.

## 2 nov. kväll – klart

- Fas 1–11 klara och på main (3761024). Awish-synk via Chrome-tillägg och driftsättningsskript klara och på main.
- Verifierat: eslint och tsc rena, 2 613 enhetstester, 2 490 databastester, 62 driftsättningstester, next build utan miljö.
- Timkontrollen (schemalagd uppgift) borttagen.
- Väntar på beställaren: nätverksåtkomst till api.supabase.com, *.supabase.co och api.vercel.com för driftsättning;
  ägare bjuds in som wille1452@live.se. De två API-nycklarna som klistrades in i chatten ska bytas efter driftsättningen.
