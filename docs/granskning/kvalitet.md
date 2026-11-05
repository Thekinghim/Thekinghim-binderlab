# Kvalitet

## Tester (körda 5 nov. 2026 på grenen `claude/release2`)

| Svit                               | Kommando           | Filer | Tester | Resultat                                                          |
| ---------------------------------- | ------------------ | ----- | ------ | ----------------------------------------------------------------- |
| Enhetstester                       | `npm test`         | 292   | 3 857  | Alla gröna                                                        |
| Databastester (riktig Postgres 16) | `npm run test:db`  | 117   | 3 566  | 3 564 gröna, 2 hoppade (`ai-live` kräver en riktig API-nyckel)    |
| E2E (Playwright, 10 flöden)        | `npm run test:e2e` | 10    | –      | Inte körda i den här granskningen (kräver egen server, se README) |

- **Enhetstester** (`src/**/*.test.ts`): rena beräkningar (öre, moms, provision, prognos,
  larm), importens tolkning (Awish och Annan automat), ZIP och CSV för exporten, adaptrarna
  mot låtsasservrar för Awish, och komponenternas logik. Beräkningar, import och seed körs
  dessutom i tre tidszoner (`test:domain:tz`, `test:import:tz`, `test:seed:tz`).
- **Databastester** (`test/db`): RLS och isolering mellan organisationer, roller, triggrar,
  RPC:er, tjänsterna mot riktig Postgres, katalogregler för varje tabell och attacktester
  ("rödteam") för varje server action och route. Varje körning återskapar databasen ur alla
  migreringar (`db:reset`).
- **Inget test anropar riktiga externa tjänster**: Awish, Supabase-API:er, Resend, Sentry och
  Anthropic har låtsasservrar eller lokala ersättare.
- Siffrorna ovan är räknade av vitest i den här körningen, inte uppskattade.

## Grinden

Varje push och pull request kör CI (`.github/workflows/ci.yml`):

1. Prettier, ESLint och `tsc` (strikt läge).
2. Enhetstester i tre tidszoner (UTC, Europe/Stockholm, Asia/Shanghai).
3. Databastester mot Postgres 16 i en servicecontainer, inklusive återställningstestet av
   säkerhetskopian (`pg_dump`/`pg_restore` 16).
4. `next build`.
5. E2E: Playwright mot en körande server med seedad databas.

## Från ändring till produktion

1. Arbete på en egen gren (en git worktree per spår). Databasändringar som en ny
   migreringsfil; gamla migreringar ändras aldrig.
2. Nya RPC:er läggs i katalogtestet (`test/db/catalog.test.ts`) och nya server actions i
   rödteamskatalogen (`test/db/redteam-fas7-catalog.ts`); annars fallerar testerna.
3. Grön grind (ovan) och granskning, sedan sammanslagning till `main`.
4. Migreringen körs med GitHub Actions (production kräver godkännande och `main`); Vercel
   driftsätter `main` ([drift.md](drift.md)).
