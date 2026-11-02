# Miljöer, inloggning och drift

Binderlab körs i tre miljöer. Koden är densamma; skillnaden är miljövariablerna
(se `.env.example`, valideras vid start av `src/lib/env.ts`).

| Miljö      | `APP_ENV`     | Databas                                           | Inloggning               | Webb                               |
| ---------- | ------------- | ------------------------------------------------- | ------------------------ | ---------------------------------- |
| Lokal      | `development` | Postgres 16 på `127.0.0.1:54322` med auth-shimmen | `AUTH_PROVIDER=dev`      | `npx next dev -p 3200`             |
| Utveckling | `preview`     | Supabase-projektet för utveckling                 | `AUTH_PROVIDER=supabase` | Vercel Preview, en adress per gren |
| Produktion | `production`  | Supabase-projektet för produktion                 | `AUTH_PROVIDER=supabase` | Vercel Production (`main`)         |

## Lokal

1. Starta Postgres (se `docs/bygglogg.md`) och kör `npm run db:reset -- dev`.
2. Kopiera `.env.example` till `.env.local` och sätt `DEV_AUTH_SECRET`
   (`openssl rand -base64 48`).
3. Skapa en första användare: bjud in via en ägare, eller sätt ett lösenord direkt
   i `auth.users.encrypted_password` med `hashPassword()` från
   `src/server/auth/password.ts`.

Dev-inloggningen (`src/server/auth/dev-provider.ts`) har en hård spärr. Den
kastar vid start om `APP_ENV` inte är `development`, om `NODE_ENV=production`
(`next start`), om `VERCEL`/`VERCEL_ENV` är satt, eller om `DATABASE_URL`
pekar på något annat än localhost/127.0.0.1. Adressen tolkas som postgres.js
gör: `?host=`, `?hostaddr=`, flera värdar och tecken som `#` och `\` nekas.
Lösenorden hashas med scrypt.
Sessionen är en HS256-JWT i en httpOnly-cookie med SameSite=Lax.
Inbjudningsmejl hamnar i `.data/mail/*.eml`, och sökvägen skrivs ut i serverloggen.

Tester:

| Kommando                 | Vad som körs                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `npm run test`           | Enhetstester                                                  |
| `npm run test:db`        | Databastester; återställer `binderlab_test` vid varje körning |
| `npm run test:domain:tz` | Beräkningarna under tre tidszoner                             |

## Inloggning och behörighet i koden

- **Vem?** `getSessionUser()` och `requireUser()` i `src/server/session.ts` frågar
  AuthProvidern. Den verifierar alltid token: Supabase mot JWKS med issuer,
  audience `authenticated` och exp, och dev-sessionen mot `DEV_AUTH_SECRET`.
- **Vad får personen göra?** `requireRole(orgId, roller)` läser `memberships`
  under RLS. Varje server action som ändrar något anropar den.
- **Data:** all dataåtkomst på uppdrag av en användare går via `withUserDb(fn)`.
  Funktionen kör som rollen `authenticated` med claims från den verifierade
  sessionen (`sub`, `email`), så RLS gäller fullt ut.
- **`getServiceDb()` kringgår RLS.** Den används bara i systemjobb och skript:
  schemalagd import, gallring, migrering och seed. Den används aldrig för att svara
  på en användares förfrågan. Det finns två dokumenterade undantag, som båda gäller
  steget innan någon är inloggad:
  - inloggningstjänstens egen tabell `auth.users` i dev-providern
  - uppslaget av en inbjudan från länken (`src/server/invitations.ts`)
- **Proxyn** (`src/proxy.ts`) skickar oinloggade till `/logga-in` och förnyar
  Supabase-sessionen. Den är bara en bekvämlighet; skyddet sitter i serverkoden
  och i RLS.
- **Aktiv organisation:** cookien `bl_org`. Medlemskapet kontrolleras under RLS
  vid varje läsning (`getActiveOrganization()`).

Server actions finns i `src/server/actions/auth.ts`: `login`, `logout`,
`createInvite`, `acceptInvite` och `switchOrganization`. Alla returnerar
`{ ok, error? }` med svenska felmeddelanden. Inloggningen har en enkel gräns
per 15 minuter: 5 försök per IP och e-post, 20 per konto oavsett IP, och 5
per IP för ogiltiga adresser. Försöket räknas innan lösenordet prövas, så
parallella förfrågningar kommer inte förbi gränsen. Spärrade räknare tas
aldrig bort i förtid. Gränsen räknas i minnet per serverinstans.

Supabase-sessionens cookies är `httpOnly`, `SameSite=Lax` och `Secure`
utanför development. Appen har ingen webbläsarklient mot Supabase.
`SUPABASE_URL` och `SUPABASE_JWKS_URL` måste vara https utanför development.

## Migreringar per miljö

| Miljö                     | Hur                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Lokal                     | `npm run db:reset -- dev` (raderar och bygger om) eller `npm run db:migrate` (bara nya) |
| CI                        | En Postgres 16-container. `npm run db:reset -- test` följt av `npm run test:db`         |
| Utveckling och produktion | GitHub Actions, se nedan                                                                |

Migreringar mot utveckling och produktion körs med GitHub Actions → "Migrera
databasen" → Run workflow → välj `development` eller `production`. Workflowet kör
`npm run db:migrate` med hemligheten `DATABASE_URL` från GitHub Environment med
samma namn. Production kräver godkännande och körs bara från `main`.

Migreringarna bokförs i `supabase_migrations.schema_migrations`. Auth-shimmen körs
aldrig mot Supabase. Varje migrering körs i en egen transaktion, så kör alltid mot
utveckling först.

## Hemligheter

Hemligheter ligger aldrig i repot. `.env.local` är gitignorerad och `.env.example`
innehåller bara exempel.

| Var                                                               | Vad                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Vercel → Project → Settings → Environment Variables               | Allt som appen behöver, separat för Preview och Production |
| GitHub → Settings → Environments → `development` och `production` | `DATABASE_URL` för migreringar                             |

- `SUPABASE_SECRET_KEY` och `SENTRY_AUTH_TOKEN` är hemliga och används bara på
  servern respektive vid bygget.
- Värden i `NEXT_PUBLIC_*` hamnar i webbläsaren. Valideringen stoppar en hemlig
  Supabase-nyckel där.

## Sentry

Sentry är aktivt bara när `SENTRY_DSN` (server) eller `NEXT_PUBLIC_SENTRY_DSN`
(webbläsare) finns. Inställningarna:

- `environment` är `APP_ENV`.
- `sendDefaultPii` är `false`.
- `beforeSend` tar bort e-postadresser, cookies, `Authorization` och
  inbjudningstoken.
- `tracesSampleRate` är 0,05 i production och 0,1 annars.

Källkartor laddas upp vid bygget bara när `SENTRY_AUTH_TOKEN` finns, eftersom
`withSentryConfig` i `next.config.ts` bara används då. Fel i serverkomponenter och
route handlers fångas av `onRequestError` i `src/instrumentation.ts`.

## Assistent

Assistenten (`/assistent`) svarar på frågor på svenska med Claude API och verktyg som
anropar beräkningslagret (`src/server/assistant`). Modellen kör aldrig SQL: varje verktyg
läser via serverladdarna som användaren (RLS) och räknar med `@/domain` och `@/analytics`.

| Variabel             | Värde                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `ASSISTANT_PROVIDER` | `anthropic` (standard) eller `local` (lokal testmodell, bara lokalt)        |
| `ANTHROPIC_API_KEY`  | Nyckeln till Claude API. HEMLIG, bara på servern.                           |
| `ANTHROPIC_MODEL`    | `claude-opus-5-5` (standard) eller `claude-sonnet-5-5`. Inget annat godtas. |

- **Utan nyckel** visar sidan "Assistenten kräver ANTHROPIC_API_KEY", frågefältet är
  avstängt och inget skickas någonstans.
- **Lokal testmodell** (`ASSISTANT_PROVIDER=local`): ingen AI. Den väljer ett verktyg med
  nyckelord och svarar med verktygets egen sammanfattning, så att kedjan (roller, verktyg,
  strömning, logg, kontroll av talen) kan provas utan nyckel. Sidan märker svaren
  "Lokal testmodell · ingen AI". Värdet nekas utanför `APP_ENV=development`.
- **Anropet**: strömmat (`client.beta.messages.stream`), adaptivt tänkande, insats
  `medium`, cachning av systemprompt och verktyg, serverstyrd reserv vid avböjande
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Högst 8 varv per fråga
  och 60 frågor per användare och timme (per serverinstans).
- **Roller**: ägare och admin får alla tio verktyg, läsaren alla utom Att göra, påfyllaren
  bara lagerverktygen (sålda pack, lager, räckvidd, Att göra, stamdata). Urvalet görs på
  servern och kontrolleras igen innan ett verktyg körs.
- **Kontroll av talen**: efter svaret kontrolleras att varje tal i texten finns i något
  verktygsresultat (eller i frågan). Saknas ett tal markeras det i svaret och frågan får
  status `unverified` i loggen.
- **Logg**: varje fråga sparas i `assistant_logs` (append-only, RLS) med svar, verktyg,
  parametrar, resultat, kontroll, modell och tokenåtgång. Var och en ser sina egna frågor;
  ägare och admin ser alla i organisationen.
- **Tester**: verktygen, loggen, rollerna och hela loopen med en mockad klient körs mot
  testdatabasen (`test/db/assistent-*.test.ts`); ingen test anropar Claude API.

Beställaren: skapa en nyckel i Claude Console (API Keys), lägg den som `ANTHROPIC_API_KEY`
i Vercel (Preview och Production) och sätt en månadsgräns för kostnaden i Console.

## Butiksportal

Butiksportalen (`/portal`, egen layout utanför appen) visar en butik dess egen
försäljning per månad och vecka, mest sålda titlar, ersättningen steg för steg, sina
månadsrapporter och låter butiken felanmäla en automat. Inga nya miljövariabler: portalen
använder inloggningen (`AUTH_PROVIDER`), e-posten för inbjudningar och rapportlagringen
(`REPORT_STORAGE`) som redan finns.

- **Roll**: `store` i `memberships`, med `store_id` (check: bara för rollen store, och
  rollen kräver en butik). Migreringar: `20261102130000_portal_store_role.sql` (rollen)
  och `20261102130100_portal_store_access.sql` (kolumner, funktioner, policy).
- **Inbjudan**: ägare eller admin bjuder in från butiken (`InviteStoreUser` i
  `src/app/portal/_components/invite-store-user.tsx`, server action `inviteStoreUser`,
  RPC `create_store_invitation`). Mottagaren tar emot på `/inbjudan/[token]` som vanligt;
  `accept_invitation` skapar medlemskapet med inbjudans `store_id`.
- **Dataåtkomst**: rollen store har inga rättigheter i appens tabeller, vyer, RPC:er
  eller filer (ingen policy nämner den). Allt i portalen går via `portal_*`-funktionerna
  (security definer, `search_path = ''`) som först kontrollerar att anroparen är
  butiksanvändare för just den butiken, och som bara lämnar ut butikens försäljning,
  avtalsvillkor (provision, hyra), automaternas perioder i butiken, butiksrapporter och
  butikens egna felanmälningar. Ersättningen räknas i appen med `buildStoreReport`
  (`@/reports`), samma beräkning som månadsrapporten.
- **Rapporter**: innehållet visas bara om ögonblicksbilden är en butiksrapport för just
  den butiken utan förbjudna fält (kontrolleras i databasen och igen med
  `assertStoreReportSafe`). PDF:en hämtas via `/portal/rapporter/[id]/pdf` med
  användarens session; storage-policyn `binderlab_reports_select_store` släpper bara
  igenom butikens egna butiksrapporter.
- **Felanmälan**: blir ett ärende i `incidents` med `kind = store_*` och
  `created_by` = butiksanvändaren (syns i Inkorgen). Högst 10 per användare och timme
  (per serverinstans) och 20 per dygn (databasen, `BL030`).
- **Tema**: ljust som standard; valet sparas i `localStorage` (`binderlab-portal-theme`),
  skilt från appens.
- **Tester**: `test/db/portal-isolation.test.ts` (varje tabell och vy, RPC:er, filer,
  requireRole) och `test/db/portal-functions.test.ts` (funktionerna, felmeddelanden,
  rapporter, felanmälan, samma ersättning som appens beräkning);
  `src/server/portal/model.test.ts` för den rena logiken.

Beställaren: inget extra utöver inloggning och e-post. Bjud in butiken från Butiker när
inbjudningsrutan är inkopplad där.

## Ekonomi

Ekonomi (`/ekonomi`) stämmer av automatleverantörens utbetalningar mot försäljningen,
föreslår verifikationer per månad (SIE 4), visar kassaflödet och de fasta kostnaderna.
Avtal (`/avtal`) håller butiksavtalen med villkor, uppsägningstid och avtalsfil. Koden
finns i `src/server/accounting` (tjänster, adaptrar, frågor) och beräkningarna i
`@/analytics/reconciliation`, `@/analytics/cashflow`, `@/analytics/contracts` och
`@/reports` (SIE 4).

| Variabel                | Värden                                            | Standard                                           |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `ACCOUNTING_PROVIDER`   | `none`, `local`, `fortnox`, `visma_enet`, `bokio` | `none`                                             |
| `ACCOUNTING_OUTBOX_DIR` | katalog                                           | `.data/outbox/bokforing`                           |
| `PAYOUT_SOURCE`         | `csv`, `awish_api`                                | `csv`                                              |
| `CONTRACT_FILE_STORE`   | `local`, `supabase`                               | `local` med `AUTH_PROVIDER=dev`, annars `supabase` |
| `CONTRACT_FILE_DIR`     | katalog                                           | `.data/contracts`                                  |

- **Utbetalningar**: laddas upp som CSV på `/ekonomi` (ägare och admin). Två format känns
  igen på rubrikerna: utbetalningar (Referens, Period från, Period till, Utbetald, Belopp,
  Avgifter, Återbetalningar) och specifikation per order (Referens, Ordernummer, Belopp).
  Samma referens igen är dubblett; med andra belopp blir den konflikt och den sparade
  ändras inte. Filen sparas som underlag i `.data/imports/{org}/payouts/` (lokalt, samma
  FileStore som orderimporten). `PAYOUT_SOURCE=awish_api` är förberedd
  (`AwishPayoutApi`) men kastar tills Awish lämnat dokumentation för avräkningen.
- **Avstämning**: väntad utbetalning = försäljning − avgifter − återbetalningar, per
  utbetalningsperiod. Avvikelser förklaras (avgift, saknade order, tidszon, dubbletter …)
  och kan markeras som utredda med en anteckning (`deviation_reviews`, append-only, även
  i `audit_log`). Servern räknar om avvikelsen innan den sparas och sparar sitt eget
  fingerprint: ändras avvikelsen senare gäller inte utredningen.
- **Bokföring**: verifikationerna kommer från `sie4Verifications` (`@/reports`) med
  kontona i `ledger_accounts`. `GET /ekonomi/sie?manad=ÅÅÅÅ-MM` ger SIE 4-filen (CP437).
  Med `ACCOUNTING_PROVIDER=none` visar sidan "Ej konfigurerad" och SIE-filen. `local`
  skriver filen och en JSON till utkorgen. Fortnox, Visma och Bokio har gränssnittet
  (`BookkeepingAdapter` i `src/server/accounting/bookkeeping.ts`) men ingen
  implementation ännu.
- **Fasta kostnader**: `fixed_costs` (försäkring, programvara, transport, lager, övrigt),
  per månad, kvartal eller år, gemensamma eller per automat. Arkiveras i stället för att
  raderas; ändringar som påverkar en stängd månad stoppas (BL004) och loggas.
  **Lönsamhet efter fasta kostnader** (för sidan Lönsamhet, som ägs av annan): anropa
  `profitabilityWithFixedCosts({ ...input.current, fixedCosts, machines }, "revenue")`
  från `@/analytics/cashflow` med perioden från `loadDomainInput` och de fasta
  kostnaderna (`fixed_costs` som inte är arkiverade, mappade som i
  `src/server/accounting/service.ts`, `toFixedCost`). Resultatet har en rad per automat
  med `profitOre`, `fixedCostOre` och `profitAfterFixedOre`, och totalen. Ekonomi visar
  totalen redan.
- **Avtal**: `contracts` har fått rubrik, villkor, förlängning, uppsägningstid i månader,
  uppsägningsdag och uppgifter om avtalsfilen. Villkoren för ersättningen är
  `store_agreements` kopplade med `contract_id` (bara samma butik, BL041). Filen sparas
  via FileStore i bucket `contracts` (`{org}/{avtal}/{sha256}.{pdf|png|jpg|docx}`),
  typen kontrolleras mot innehållet, högst 20 MB. Hämtas via `GET /avtal/{id}/fil`.
- **Påminnelse i Att göra**: regeln finns i `@/analytics/contracts`
  (`contractReminders`): påminnelse 90 dagar före sista uppsägningsdag, nyckel
  `contract:{id}:{slut}`, fingerprint som ändras när status eller datum ändras. Att göra
  (`computeTodos`, ägs av annan) behöver en punkttyp `contract` som tar `due` ur
  resultatet; avtalen läses med `queryContracts` i `src/server/accounting/queries.ts`.
- **Tester**: `test/db/ekonomi.test.ts` (import, avstämning med avsiktliga avvikelser,
  utredning, fasta kostnader, SIE, kassaflöde, avtal, filer, roller och RLS) och
  `src/server/accounting/payout-csv.test.ts`.

Beställaren: välj bokföringsprogram och skaffa API-åtkomst (Fortnox: integration i
utvecklarportalen; Visma eEkonomi: Visma Developer; Bokio: API-nyckel), be Awish om
avräkningens API-dokumentation, och lägg in kontoplanen (BAS) under Inställningar om den
avviker från standard. Med Supabase: sätt `CONTRACT_FILE_STORE=supabase` (standard i
preview och production) så att avtalsfilerna hamnar i bucket `contracts`.

## Prognos & inköp

Sidan `/prognos` (förlorad försäljning, prognos med backtest, inköpsförslag, inköpsorder, lagervärde, leverantörer) använder inga externa tjänster och inga nycklar. Allt räknas på servern ur databasen med `@/analytics/forecast`, `lost-sales` och `purchasing`; ändringar går via server actions i `src/app/(app)/prognos/actions.ts` till `src/server/purchasing` (RLS, bara ägare och admin). Inga nya tabeller: `suppliers`, `supplier_items`, `purchase_orders` och `purchase_order_lines` finns sedan grundmigreringen, och mottagning skriver `stock_events` (`receipt`) i centrallagret via databasens trigger.

Leverantörsorder skickas inte elektroniskt: en inköpsorder markeras som beställd när den lagts hos leverantören (e-post, telefon, portal). Ska order skickas automatiskt krävs leverantörens API och ett beslut om adapter.

## Drift: larm, push och sms

Larmjobbet (`GET /api/cron/larm`, `src/server/alerts`) utvärderar för varje organisation
maskinhälsa (`@/analytics/health`), titel nära slut, misslyckade importer och gårdagens
försäljning, sparar incidenterna i `alerts` (samma problem är en rad, se
`@/analytics/alerts`) och skickar utskicken i `alert_deliveries` som är på tur. Varje körning
loggas i `alert_runs`. Jobbet kör som systemroll (`getServiceDb`) eftersom ingen användare är
inloggad; proxyn släpper igenom `/api/cron/*` och routen kräver `CRON_SECRET`.

| Variabel            | Värde                                                            | Lokalt                                        |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `CRON_SECRET`       | Minst 16 tecken. Vercel Cron skickar `Authorization: Bearer …`.  | Valfritt; utan den svarar routen 503.         |
| `PUSH_PROVIDER`     | `webpush` (VAPID) eller `outbox`                                 | `outbox`: `.data/outbox/push/*.json`          |
| `VAPID_PUBLIC_KEY`  | Publik nyckel (base64url), skickas till webbläsaren              | Skapas i `.data/vapid-dev.json` om den saknas |
| `VAPID_PRIVATE_KEY` | Hemlig nyckel                                                    | Som ovan                                      |
| `VAPID_SUBJECT`     | `mailto:`-adress eller https-adress till den som driver tjänsten | Behövs inte                                   |
| `SMS_PROVIDER`      | `outbox` eller `off` (ingen leverantör vald)                     | `outbox`: `.data/outbox/sms/*.json`           |
| `MAIL_PROVIDER` …   | Samma som rapporterna (Resend eller outbox)                      | `outbox`: `.data/outbox/<id>/`                |

Kör jobbet lokalt:

```sh
CRON_SECRET=lokal-hemlighet-1234 npx next dev -p 3200   # eller lägg den i .env.local
curl -H "Authorization: Bearer lokal-hemlighet-1234" http://localhost:3200/api/cron/larm
```

Schemaläggning i drift (Vercel): lägg till i `vercel.json`

```json
{ "crons": [{ "path": "/api/cron/larm", "schedule": "*/10 * * * *" }] }
```

och sätt `CRON_SECRET` i projektets miljövariabler. Vercel Hobby kör cron högst en gång om
dagen; var 10:e minut kräver Pro.

**Push** (Web Push): skapa nycklar med `npx web-push generate-vapid-keys` och sätt
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` och `VAPID_SUBJECT`. Varje användare slår på push per
enhet under Drift → Larminställningar. På iPhone kräver push att Binderlab är tillagd på
hemskärmen (iOS 16.4 eller senare). Enheter som push-tjänsten svarar 404/410 för stängs av.

**Sms**: ingen leverantör är vald. En leverantör läggs till som en klass som implementerar
`SmsSender` i `src/server/notify/sms.ts` och väljs med `SMS_PROVIDER`.

**Fältläget (PWA)**: `src/app/manifest.ts` (installerbar, startar i `/drift`) och
`public/sw.js` (service worker). Påfyllning (`/drift/pafyllning`) och besöksplanen
(`/drift/besok`) sparas i webbläsaren och fungerar utan nät; påfyllningar köas i IndexedDB och
skickas med ett id från webbläsaren (`register_refill_once`), så ett omförsök blir aldrig en
dubbel lagerhändelse.

## Marknad

Sidan `/marknad` (releasekalender, leverantörspriser, sortiment, prissättning) räknar allt på
servern ur databasen med `@/analytics/releases`, `pricing` och `assortment`; laddare och
ändringar ligger i `src/server/market` (RLS, ändringar bara för ägare och admin, läsaren ser
allt, påfyllaren ingenting). Tabeller: `releases`, `release_allocations`,
`supplier_price_quotes`, `machine_slots`, `assortment_changes`, `price_experiments` och
`price_experiment_machines` (migreringarna `…122500_marknad_market_intelligence.sql` och
`…132000_marknad_experiment_arms.sql`).

Externa marknadspriser är **inte inkopplade**: beställaren väljer källa först (underlag och
förslag i `docs/marknadskallor.md`). Adaptern väljs med miljövariabler:

| Variabel                  | Värde                                                                                       | Lokalt                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `MARKET_PRICE_SOURCE`     | `none` (standard). `tcgplayer`, `cardmarket`, `pricecharting` ger läget "inte inkopplad".   | `local`: testpriser ur en fil              |
| `MARKET_PRICE_LOCAL_FILE` | Fil för `local` (standard `.data/market-prices.json`). `local` vägrar i production.         | Formatet står i `docs/marknadskallor.md`   |

Pristester ändrar inget pris i automaterna: panelen planerar testet och mäter effekten mot
kontrollautomaterna, priset ställs om i Awish av operatören.

## Det här måste beställaren göra

1. **Supabase, två projekt.** Behåll det befintliga
   (`ukuuwokxbtwhqfnttzwr`) som utveckling, och skapa ett för produktion i en EU-region.
   I båda:
   - Authentication → Sign In / Providers → Email: kräv bekräftad e-post. Det krävs
     eftersom `accept_invitation` litar på e-posten i JWT:n.
   - Stäng av "Allow new users to sign up". Nya användare kommer bara via inbjudan.
   - Project Settings → JWT Keys: använd asymmetriska signeringsnycklar (ES256).
     Appen verifierar mot JWKS och godtar inte HS256.
   - Authentication → URL Configuration: Site URL = appens adress. Lägg till
     `https://*-<team>.vercel.app/**` under Redirect URLs för förhandsversionerna.
   - Authentication → Emails → mallen "Invite user": länken ska vara
     `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`.
   - Authentication → Emails → mallen "Magic Link": länken ska vara
     `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink`.
   - Koppla en egen SMTP-tjänst (till exempel Resend). Supabases inbyggda SMTP har
     mycket låga gränser.
2. **Vercel.** Importera repot och sätt miljövariablerna enligt `.env.example`:
   - Preview: `APP_ENV=preview` och nycklarna från utvecklingsprojektet.
   - Production: `APP_ENV=production`, `APP_URL` och nycklarna från
     produktionsprojektet.
   - `DATABASE_URL`: poolern på port 6543. Sätt också `DATABASE_POOL_MAX=3`.
3. **GitHub.** Skapa två environments:
   - `development`, med hemligheten `DATABASE_URL`.
   - `production`, med hemligheten `DATABASE_URL`, Required reviewers och
     Deployment branches = `main`.

   Använd Supabase-poolern i "session mode" (port 5432 på `pooler.supabase.com`),
   eftersom GitHubs maskiner saknar IPv6 och den direkta adressen
   `db.<ref>.supabase.co` bara har IPv6.

4. **Sentry.** Skapa ett projekt (Next.js, gärna EU-region). Sätt sedan:
   - `SENTRY_DSN` och `NEXT_PUBLIC_SENTRY_DSN` i Vercel.
   - `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` och `SENTRY_PROJECT` för källkartor.
5. **Första migreringen.** Kör "Migrera databasen" mot `development` och sedan mot
   `production`.
6. **Första ägaren.** Skapa ägarens användare i Supabase (Authentication → Users →
   Invite). Logga sedan in och skapa organisationen. RPC:n `create_organization`
   gör den inloggade till ägare.
7. **Larm (Drift).** Sätt `CRON_SECRET` och schemalägg `/api/cron/larm` var 10:e minut
   (`vercel.json`, se avsnittet Drift). Skapa VAPID-nycklar för push och sätt
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` och `VAPID_SUBJECT`. Välj en sms-leverantör om
   sms behövs (ingen är kopplad).
