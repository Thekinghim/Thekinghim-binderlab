# Bygglogg

Plan: [Binderlab – prompter till Claude Code](https://claude.ai/artifact/BmmkHvJAqJdoB4nDfJTwGe) (Claude Docs).
Beställaren är borta. Arbetet går självständigt igenom planen tills alla faser är klara och avbockade.
Kod: `claude/bygge` i Thekinghim/thekinghim-binderlab. `main` innehåller bara grunden tills beställaren slår ihop.

## Läge

| Fas                                     | Status      | Anteckning                                                              |
| --------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| 1 Designsystem                          | Klar        | Godkänd av beställaren                                                  |
| 1b Granska och komplettera              | Pågår       | Granskning klar (31 punkter, `scratchpad/critique.json`); tillägg byggs |
| 2 Data, säkerhet, inloggning, import    | Pågår       | Datamodell v2 godkänd; backend byggs; UI efter 1b                       |
| 3 Skal, Hem, Att göra                   | Ej påbörjad |                                                                         |
| 4 Lönsamhet, Inköpspriser               | Ej påbörjad | Beräkningar byggs i fas 2                                               |
| 5 Order, Lager, Automater, Butiker      | Ej påbörjad |                                                                         |
| 6 Rapporter                             | Ej påbörjad | Kräver e-postleverantör (Resend) för riktiga utskick                    |
| 6b Intelligens                          | Ej påbörjad | Assistenten kräver Claude API-nyckel                                    |
| 7 Kvalitet, drift, överlämning          | Ej påbörjad |                                                                         |
| 8 Drift: maskinhälsa, larm, ärenden     | Ej påbörjad |                                                                         |
| 9 Ekonomi: avstämning, bokföring, avtal | Ej påbörjad |                                                                         |
| 10 Butiksportal, expansion              | Ej påbörjad |                                                                         |
| 11 Marknadsintelligens                  | Ej påbörjad | Externa priskällor kopplas inte utan beställarens OK                    |
| 12 Plattform                            | Väntar      | Enligt planen först när 2–3 pilotoperatörer finns                       |

## Arbetsregler

- Lokal Postgres 16: `127.0.0.1:54322`, databaser `binderlab_dev` och `binderlab_test`. Starta med
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/user/.pgdata -o '-p 54322 -k /tmp' -l /home/user/.pgdata/log.txt start"`.
- Dev-server: `npx next dev -p 3200`.
- Supabase, Awish, Resend och Claude API går inte att nå från byggmiljön (nätverket blockerat, nycklar saknas). Allt byggs med
  adaptrar, med lokala implementationer för utveckling och test.
- Commit och push löpande till claude/bygge (säkerhetskopia). Beställaren har bett mig slå ihop med main själv: görs vid varje avklarad fas,
  bara när npm test, npm run test:db, tsc, lint och next build går igenom. Inga pull requests.

## Beslut under bygget

Se `docs/datamodell.md` (Beslut från beställaren) och planens avsnitt "Beslut under bygget".

## Schemalagd kontroll

Timvis kontroll av bygget: schemalagd uppgift `trig_011jdLLdDXA6g2gBGTGoFBzJ` ("Binderlab: fortsätt bygget", kl. xx:35 UTC).
Tas bort när alla faser är klara.

## Arbetsflöden 2 nov. (kl. 10:50)

- Fas 1b slutsteg: wf_36bd270a-1ca (ny /design, docs/design.md, före/efter).
- Fas 2–5 sidor, fyra parallella delar av fas2-5-ui-part.js: inloggning+datakällor+hem, att-göra+lönsamhet, inköpspriser+order, lager+automater+butiker.
  Datalagrets rapport: scratchpad/ui-core-report.md. Efter alla fyra: avstämningsagent (summor mellan vyer, prisändring mitt i period) körs separat.
- Fas 6–11 sidor, fyra parallella delar av fas6-11-ui.js: rapporter+prognos, assistent+expansion(+enhetsekonomi, effekt), drift(+inkorg, PWA)+marknad, ekonomi(+avtal)+portal.
- Omkörning av logik: prognos/förlorad försäljning/inköp, avstämning/kassaflöde/avtal, expansion-fix (logic-ahead-rerun).
- Menyposter och platshållare för fas 6–11 lades in i src/components/shell/nav.ts av huvudagenten.
- Efter allt: fas 7 (kvalitet, onboarding, demoläge, e2e, dokumentation) och integration (Hem/Att göra kopplas till förlorad försäljning, avtal, rapporter).

## 12:40 – fas 1b klar och på main

- Bygget typkontrollerar bara appens kod (tsconfig.build.json); tester och skript kontrolleras av `npm run typecheck` i CI.
- Saknad miljö stoppar inte servern: /design och /datamodell fungerar utan nycklar, inloggade sidor visar ConfigMissing
  (src/server/config-status.ts). Dev-inloggningens spärr gäller som tidigare.
- Verifierat: `next build` och `next start` utan miljövariabler i en separat worktree (/home/user/wt-build).

## Att ta i fas 7 (integration och dokumentation)

- docs/berakningar.md: avsnitt om Att göra (2,5 dagar, 14 dagars fönster, belopp i risk = påfyllning + tysta automater, 48 h, 30 dagar för saknat inköpspris, tiondelar av dag).
- docs/datamodell.md: list_members, todo_dismissals, import_uploads m.fl. tabeller från fas 2–11.
- Brödsmulor och kommandopalett: mål för Inställningar → Användare.
- Avbockade punkter i Att göra: filtrera bort sådana vars orsak är löst (kräver att loadTodosFor returnerar punkter före avbockning).
- toast.tsx: timern startar om vid omrendering.
- Hem/Att göra: koppla förlorad försäljning (lostSalesSummary), avtalspåminnelser och rapportutkast.

## 13:10 – alla sidor i fas 2–5 klara

- Byggda, granskade och rättade: inloggning, inbjudan, användare, Datakällor, Hem, Att göra, Lönsamhet, Inköpspriser, Inställningar, Order, Lager, Automater, Butiker.
- Fas 9–10 (Ekonomi, Avtal, Butiksportal) och fas 6b (Assistent, Expansion, Enhetsekonomi, Effekt) klara.
- Pågår: slutkontroll fas 2–5 (wf_2c6fb7c8-67a), fas 6 Rapporter+Prognos, fas 8+11 Drift+Marknad, fas 7 del 1 (demo, onboarding, sökning).
- Öppet till integrationen: /lager och /drift planerar besök från olika dagar (gårdagens resp. dagens takt).
- 13:30 Fas 8 (Drift, Inkorg, larm, PWA, besöksplan) och fas 11 (Marknad) klara. Öppet till integrationen: Automater ska använda
  healthInputOf/loadHealthData (samma status som Drift), återbetalningar i Lönsamhet via applyRefunds, cron för /api/cron/larm i vercel.json.
- 13:45 Fas 6 (Rapporter: butik, bokföring med SIE och Excel, delägare; PDF, utskick, arkiv, schemaläggning) och fas 6b Prognos & inköp klara.
  Öppet till integrationen: Att göra-punkt "rapportutkast väntar på granskning"; REPORT_SIE_SERIES/FIRST_NUMBER bestäms med bokhållaren.
  Alla sidor för fas 2–11 är nu byggda. Kvar: slutkontroll fas 2–5 (pågår), fas 7 del 1 (pågår), fas 7 integration/kvalitet/dokumentation.

## 14:05 – fas 2–5 klara och på main (76cf22a)

- Hela testsviten grön: 1 866 databastester, 2 165 enhetstester, eslint rent. Avstämning (test/db/consistency.test.ts) + revisorns
  handräknade test. Revisorn hittade inga sifferavvikelser; noterade att consistency-testet delvis är cirkulärt (samma profitability).
- Ny migrering 20261102160000_hardening_org_statistics.sql (statistikskydd på import_uploads*).
- Planen: prompt 5 avbockad, lägestabell uppdaterad.
- Kvar: seed.test.ts krockar med demo-isolering.test.ts (fas 7-agenten äger), fas 7.
- 14:45 Fas 7 startad i tre spår parallellt med fas 7 del 1: integration (wf_0ceb3b4f-49c), säkerhetsgranskning (wf_78b49347-40d),
  e2e + backup + övervakning (wf_5edd7611-a2e). Efter integrationen: genomgång av hela appen (spåret "genomgang"), sedan prestanda
  (100 000 order), dokumentation (README, architecture, operations, decisions, product) och slutverifiering.
- 15:00 Fas 7 del 1 klar: demo-organisation (Nordljus Automater AB (demo), 14 720 order, spärr mot att radera kunders org),
  onboarding (/kom-igang, create_first_organization), global sökning i ⌘K. Till genomgången: /lager horisontell scroll vid 375 px
  (stock-matrix.tsx saknar relative), Hem klipper sexsiffriga belopp i Intäkt-rutan, demons telefonnummer → PTS fiktionsnummer.
- 15:20 Integration klar (Hem/Att göra/Lönsamhet/Lager/Drift/Prognos/Rapporter kopplade, samma takt och besöksplan överallt,
  "Vinst före fasta kostnader" på Hem). Genomgång av hela appen startad i tre grupper (genomgang-a/b/c).
  Inför visning: `npm run db:reset -- dev && npm run db:seed && npm run db:seed-demo` (dev har ett testutkast som inte går att radera).
- 15:50 Säkerhetsgranskning av hela appen klar: 505 attacktester gröna (server actions, rutter, RPC:er, storage, IDOR, export, cron).
  Täppt: säkerhetshuvuden (CSP, X-Frame-Options, HSTS m.m.), smalare CSP för PDF, gallring bara som ägare, IP via Vercel-huvud,
  /design och /datamodell kräver inloggning, smalare regel för statiska filer. Kvar: nonce-CSP, gräns för utskick, stora avtalsfiler på Vercel (4,5 MB).
- E2E, backup och övervakning klara: 17 e2e-tester i 6 flöden (inloggning, import, påfyllning, prisändring, rapportutskick,
  felövervakning) gröna 3 av 3 körningar; backup/återställning testad; larm vid misslyckad import/rapport/cron + Sentry Cron Monitors.
  E2E kör mot egen server på port 3210 och egen databas. Dev-servern på 3200 hade stannat och startades om.
- Genomgång A och C klara. Öppet till slutsteget: diagram 640 px breda före mätning (mobil bredare vid laddning),
  okända id ger HTTP 200, "0 bp" i avstämningen, öre i avstämningssammanfattningen, laddtider mät med next start,
  temaskriptet (kort fel tema före hydrering), jämförelsen räknar med dagen som pågår.
- Dokumentation klar: README (snabbstart provad från noll), architecture, datamodell (alla tabeller och 23 RPC:er), berakningar,
  decisions (ADR), product (siffror från ny databas), operations (backup, personuppgifter och biträden), licenssammanställning.
  Öppet: licensen för paketet "buffers", demons telefonnummer/"Seriecentralen" ska bli fiktiva, Vercel-region (EU) i vercel.json.
