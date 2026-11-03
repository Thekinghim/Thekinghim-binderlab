# Driftsättning

Skripten i `scripts/deploy/` driftsätter Binderlab utan handpåläggning: de skapar produktionsprojektet i Supabase, ställer
in inloggningen, kör migreringarna, kopplar och konfigurerar Vercel, driftsätter `main` och lägger in ägarens konto. Allt
är idempotent: samma kommando kan köras om och om igen, och det ändrar bara det som inte redan stämmer. Miljöerna beskrivs
i `docs/miljoer.md`.

## Det här kör den nya sessionen

Förutsättningar i sessionen:

- Miljövariablerna `SUPABASE_ACCESS_TOKEN` och `VERCEL_TOKEN` (se [Tokens](#tokens)).
- Nätverk till `api.supabase.com`, `*.supabase.co`, `api.vercel.com` och `*.vercel.app` (kontrollen av `/logga-in`; plus
  den egna domänen om en sådan finns).
- Repot utcheckat med `node_modules` (kör `npm ci` om katalogen saknas).

```sh
# 1. Se planen. Ändrar ingenting (bara läsningar).
npx tsx scripts/deploy/all.ts --dry-run --agare <ägarens e-post>

# 2. Kör. Tar 5–15 minuter första gången (nytt Supabase-projekt + bygge i Vercel).
npx tsx scripts/deploy/all.ts --agare <ägarens e-post>
```

Ägarens e-post bekräftas av beställaren innan steg 2 körs. Utan `--agare` görs allt utom ägarens konto, som då kan läggas
in senare med `npx tsx scripts/deploy/invite-owner.ts <e-post>`.

Skriptet avslutar med en sammanfattning: adresser, vad som ändrades och en lista **Kvar att göra för hand** (tom när
inget återstår). Utskriften är på svenska, och `→ skulle:` markerar vad dry-run skulle göra. Avslutningskod 0 betyder att
`/logga-in` svarar 200 och att appen är konfigurerad.

### Valfria flaggor och variabler

| Flagga / variabel                                                                           | Betydelse                                                                                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--app-url https://app.binderlab.se`                                                        | Appens adress i produktion. Standard: projektets egna domän i Vercel (se steg 3).                       |
| `BINDERLAB_APP_URL`                                                                         | Samma som `--app-url`.                                                                                  |
| `--vercel-team <slug>`, `VERCEL_TEAM_ID`                                                    | Vilket Vercel-team. Behövs bara om token ser flera team och inget projekt redan är kopplat till repot.  |
| `--supabase-org <id>`, `SUPABASE_ORG_ID`                                                    | Organisation för produktionsprojektet. Standard: utvecklingsprojektets.                                 |
| `--force-deploy` / `--skip-deploy`                                                          | Driftsätt även om inget ändrats / ändra bara inställningar.                                             |
| `SUPABASE_DEV_DB_PASSWORD`                                                                  | Databaslösenordet för utvecklingsprojektet. Ger Preview en `DATABASE_URL` utan att lösenordet byts.     |
| `--byt-dev-losenord`                                                                        | Får byta utvecklingsprojektets okända lösenord (bryter GitHub-hemligheten och `.env`-filer; se steg 9). |
| `RESEND_API_KEY` + `MAIL_FROM`                                                              | Kopplar Resend som SMTP i båda Supabase-projekten och sätter `MAIL_PROVIDER=resend` i Vercel.           |
| `MAIL_REPLY_TO`                                                                             | Förs vidare till Vercel.                                                                                |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                                                      | Förs vidare till Vercel (assistenten).                                                                  |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Förs vidare till Vercel.                                                                                |
| `VAPID_SUBJECT`                                                                             | Kontaktadress för Web Push. Standard: `mailto:<ägarens e-post>` när `--agare` anges.                    |

Valfria värden sätts bara när de finns i sessionens miljö. Skripten läser **inte** `.env.local` (där ligger de lokala
värdena).

### Delskript

| Skript                                                      | Gör                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/deploy/all.ts`                                     | Allt nedan i ordning.                                                                                                                                     |
| `scripts/deploy/supabase.ts`                                | Steg 1–7. Steg 3 läser bara Vercel (om `VERCEL_TOKEN` finns) för adresserna.                                                                              |
| `scripts/deploy/vercel.ts`                                  | Steg 1–3 och 8–11. Kräver att produktionsprojektet finns. I Supabase ändras bara produktionens adresser (steg 11) och ett okänt databaslösenord (steg 9). |
| `scripts/deploy/invite-owner.ts <e-post> [--miljo preview]` | Steg 12. `--miljo preview` lägger kontot i utvecklingsprojektet.                                                                                          |

Alla tar `--dry-run`. Det finns inget npm-skript (package.json ägs av andra); kör med `npx tsx`.

## Vad som sker i varje steg

1. **Supabase-projekten.** Listar projekten (`GET /v1/projects`). Utvecklingsprojektet `ukuuwokxbtwhqfnttzwr` måste
   finnas; ett pausat projekt väcks. `binderlab-prod` letas upp på namn **och organisation** (utvecklingsprojektets, eller
   `--supabase-org`). Finns ett `binderlab-prod` i en annan organisation som token ser avbryts allt innan något ändras;
   det används aldrig som produktion. Saknas det skapas det i `eu-north-1` (`POST /v1/projects`) med ett genererat
   lösenord (32 slumpbytes). Skapandet görs aldrig om automatiskt: svarar `POST` med 5xx eller tappas anslutningen läses
   listan om, och dyker projektet upp används det (med lösenordet som skickades). Skriptet väntar tills projektet är
   `ACTIVE_HEALTHY` och tjänsterna svarar.
2. **API-nycklar.** Hämtar publishable- och secret-nyckeln (`GET /v1/projects/{ref}/api-keys?reveal=true`) och skapar
   dem om de saknas. JWKS-adressen är `https://{ref}.supabase.co/auth/v1/.well-known/jwks.json`.
3. **Vercel-projektet** (läsning). Letar i alla team som token ser efter projektet kopplat till
   `Thekinghim/thekinghim-binderlab`, och skapar annars `binderlab` (Next.js) kopplat till repot. Har projekt i flera team
   en koppling till repot avbryts det (ange `--vercel-team`). Appens adress väljs:
   1. `--app-url`;
   2. en egen verifierad domän i Vercel-projektet;
   3. befintlig `APP_URL`, men bara om värden är en av projektets domäner;
   4. projektets `*.vercel.app`-domän;
   5. annars **antas** `https://binderlab.vercel.app` (projektet har ingen domän före första driftsättningen).

   En antagen adress används bara som `APP_URL` för första bygget. Den skrivs **aldrig** in i Supabase Auth, eftersom
   namnet kan tillhöra någon annan (se [Säkerhet](#säkerhet)). Blir domänen en annan efter första driftsättningen rättas
   `APP_URL` och appen driftsätts igen.

4. **Inloggning (auth)** i båda projekten (`PATCH /v1/projects/{ref}/config/auth`, bara fält som skiljer sig):
   - `disable_signup: true`, `mailer_autoconfirm: false` (bekräftad e-post krävs), e-post som inloggning på.
   - `site_url` och `uri_allow_list` i produktionen: `{APP_URL}` och `{APP_URL}/**`, men bara när adressen är bekräftad
     (steg 3, punkt 1–4). Annars sätts de i steg 11. Är Vercel-projektets domäner kända tas varje `*.vercel.app`-post som
     inte är projektets egen bort ur produktionens lista (även jokertecken), och en sådan `site_url` återställs till
     `http://localhost:3000`. Andra befintliga poster (t.ex. en egen domän) behålls.
   - Utvecklingen får `https://binderlab-*-<team>.vercel.app/**` (förhandsversionerna: `binderlab-<hash>-<team>` och
     `binderlab-git-<gren>-<team>`). Det äldre, bredare mönstret `https://*-<team>.vercel.app/**` tas bort. `site_url`
     lämnas som den är, eftersom appen alltid skickar `redirect_to`.
   - Mallarna "Invite user" och "Magic Link" på svenska med länken
     `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite` respektive `type=magiclink` (`docs/miljoer.md`).
   - Med `RESEND_API_KEY` och `MAIL_FROM`: SMTP via `smtp.resend.com:465`.
5. **JWT-nycklar.** Projektet ska signera åtkomsttoken med ES256 (appen verifierar mot JWKS och godtar inte HS256). Om
   den aktiva nyckeln är HS256: den äldre hemligheten flyttas in som nyckel, en ES256-nyckel skapas som standby och
   roteras in. Gamla token gäller tills de går ut. Sedan kontrolleras att JWKS har en asymmetrisk nyckel. Stöder inte
   API:t det skrivs ett manuellt steg ut (se [Kvar för hand](#kvar-för-hand)).
6. **Migreringar**, först i utvecklingen och sedan i produktionen, i filnamnsordning
   (`POST /v1/projects/{ref}/database/query`). Bokföringen är densamma som `scripts/db/migrate.ts`:
   `supabase_migrations.schema_migrations(version, name, statements)`. Redan körda hoppas över; en ändrad fil ger en
   varning. Varje fil skickas som en fråga: lås (`pg_advisory_xact_lock`, samma nyckel som `migrate.ts`), kontroll att den
   inte redan körts, filen, bokföringen. Postgres kör flera satser i en fråga som en transaktion, så ett fel lämnar varken
   halva filen eller en bokföringsrad. Misslyckas en migrering i utvecklingen rörs produktionen inte.
7. **Lagring.** Migreringarna skapar de privata buckets `imports`, `reports` och `contracts` med policyer. Skriptet
   kontrollerar dem via Storage-API:t och skapar de som saknas (privata).
8. **Vercel-inställningar.** Funktionsregion `arn1` (`PATCH /v9/projects/{id}`; `vercel.json` säger också `arn1`).
   Varning om Hobby-planen: larmjobbet var 10:e minut i `vercel.json` kräver Pro.
9. **Miljövariabler** för Production (produktionsprojektet) och Preview (utvecklingsprojektet):

   | Variabel                                                                  | Production                                       | Preview            | Typ             |
   | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ | --------------- |
   | `APP_ENV`, `NEXT_PUBLIC_APP_ENV`                                          | `production`                                     | `preview`          | krypterad       |
   | `AUTH_PROVIDER`                                                           | `supabase`                                       | `supabase`         | krypterad       |
   | `APP_URL`                                                                 | appens adress                                    | (Vercels adress)   | krypterad       |
   | `DATABASE_URL`                                                            | poolern, port 6543                               | poolern, port 6543 | känslig         |
   | `DATABASE_POOL_MAX`                                                       | `3`                                              | `3`                | krypterad       |
   | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_JWKS_URL`           | projektets                                       | projektets         | krypterad       |
   | `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`        | projektets                                       | projektets         | krypterad       |
   | `SUPABASE_SECRET_KEY`                                                     | projektets                                       | projektets         | känslig         |
   | `CRON_SECRET`                                                             | genererad                                        | genererad (egen)   | känslig         |
   | `PUSH_PROVIDER`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | genererade nycklar                               | egna nycklar       | privat: känslig |
   | `MAIL_PROVIDER=resend` och valfria värden                                 | om de finns i sessionen                          | samma              |                 |
   | `BINDERLAB_DEPLOY_STATE`                                                  | fingeravtryck (sha256-prefix) av känsliga värden | samma              | krypterad       |

   Regler:
   - Ett känt värde sätts bara om det skiljer sig. Känsliga värden jämförs via fingeravtrycket, eftersom Vercel inte
     lämnar ut dem.
   - Genererade värden (`CRON_SECRET`, lösenord, VAPID) sätts bara om variabeln saknas, så en omkörning byter aldrig
     fungerande hemligheter.
   - En variabel som delas mellan miljöer med fel värde delas upp. `DATABASE_URL` och `SUPABASE_SECRET_KEY` delas
     **alltid** upp när de delas, även om de inte går att läsa: samma värde kan aldrig vara rätt för båda projekten.
   - `BINDERLAB_DEPLOY_STATE` bokför vart `DATABASE_URL` pekar (`<ref>@<poolerns värd>`, inget hemligt). En känslig
     `DATABASE_URL` vars bokförda mål saknas eller skiljer sig godtas inte, och ett nytt värde tas fram.
   - Andra variabler rörs inte.

   `DATABASE_URL` byggs av poolerns adress (`GET /v1/projects/{ref}/config/database/pooler`) och lösenordet. Lösenordet
   är känt bara när produktionsprojektet skapas i samma körning (eller via `SUPABASE_DEV_DB_PASSWORD` för utvecklingen).
   När ett nytt värde behövs och lösenordet är okänt:
   - **Produktionen**: lösenordet byts. Skriptet räknar ut en SCRAM-SHA-256-verifierare lokalt och kör
     `alter role postgres with password '<verifierare>'`, så klartexten aldrig finns i SQL:en eller i databasens loggar.
     Används GitHub-hemligheten `DATABASE_URL` (production) måste den bytas; skriptet varnar.
   - **Utvecklingen**: lösenordet byts bara med `--byt-dev-losenord`, eftersom det bryter GitHub-hemligheten för
     workflowet "Migrera databasen" och lokala `.env`-filer. Utan flaggan sätts ingen `DATABASE_URL` för Preview, och
     sammanfattningen säger vad som ska göras (bäst: kör igen med `SUPABASE_DEV_DB_PASSWORD`).

10. **Driftsättning.** Om något ändrats i Production (eller projektet är nytt, eller ingen färdig version finns) startas
    en produktionsdriftsättning från `main` (`POST /v13/deployments` med `gitSource`). Ändringar bokförs som `pending` i
    `BINDERLAB_DEPLOY_STATE` (Production) tills en driftsättning blivit `READY`. Misslyckas bygget, eller körs
    `--skip-deploy`, driftsätter nästa körning därför igen, fast variablerna redan stämmer. Förhandsversioner som redan
    finns får de nya Preview-värdena först när de byggs om.
11. **Produktionens adresser i Supabase** (både `all.ts` och `vercel.ts`). Efter driftsättningen läses projektets domäner
    i Vercel. `site_url` och `uri_allow_list` i produktionsprojektet sätts till den bekräftade adressen, och främmande
    `*.vercel.app`-poster tas bort (steg 4). Sedan hämtas `{APP_URL}/logga-in`: svaret ska vara 200 och sidan får inte
    säga "inte konfigurerat". Säger den det skrivs variabelnamnen som saknas ut (aldrig värden).
12. **Awish-synken (pg_cron).** `CRON_SECRET` för Production läses ur produktionens Vault (`binderlab_cron_secret`)
    och samma värde sätts i Vercel; finns det inte skapas ett nytt och skrivs först till Vault. Den bekräftade
    adressen skrivs till `binderlab_app_url`. Båda läses av `private.awish_cron_tick()`, som pg_cron kör var tionde
    minut (`docs/awish-api.md`). Saknas pg_cron-jobbet (tilläggen pg_cron eller pg_net är inte påslagna) blir det ett
    manuellt steg i sammanfattningen.
13. **Ägaren.** Kontot skapas i produktionsprojektet med bekräftad e-post och utan lösenord
    (`POST {SUPABASE_URL}/auth/v1/admin/users` med secret key). Finns kontot bekräftas e-posten om det behövs. Ägaren gör
    sedan:
    1. Öppnar `{APP_URL}/logga-in`, skriver sin e-post och trycker på "Skicka inloggningslänk".
    2. Öppnar länken i mejlet i samma webbläsare.
    3. Skapar organisationen under Kom igång (`/kom-igang`, `create_first_organization`) och blir ägare. Sedan läggs
       datakällan upp och delägare bjuds in under Inställningar → Användare.

    Varför inte `POST /auth/v1/invite`: Supabases inbjudningslänk (`type=invite`) tas i appen bara emot på
    `/inbjudan/[token]`, som kräver en inbjudan till en organisation. Den första ägaren har ingen organisation, så länken
    skulle inte leda någonstans; inloggningslänken (`type=magiclink`) fungerar däremot direkt.

## Tokens

- **`SUPABASE_ACCESS_TOKEN`**: Supabase → Account (avataren) → Access Tokens → Generate new token. Personlig token
  (`sbp_…`) för en användare som är Owner eller Administrator i organisationen som äger `ukuuwokxbtwhqfnttzwr`. Den ger
  åtkomst till alla organisationens projekt; ta bort den när driftsättningen är klar.
- **`VERCEL_TOKEN`**: Vercel → Account Settings → Tokens → Create. Scope: teamet där projektet ska ligga. Kräver
  rätt att skapa projekt och ändra miljövariabler. Vercels GitHub-app måste ha åtkomst till
  `Thekinghim/thekinghim-binderlab` (installeras när repot importeras i Vercel; annars stoppar skriptet med en
  instruktion).

## Säkerhet

- Hemligheter skrivs aldrig ut: tokens, nycklar, lösenord och databasadresser registreras i loggerns maskning och ersätts
  med `[hemlig]`. Kända mönster (`sb_secret_…`, `sbp_…`, lösenord i `postgres://`, `Bearer …`) maskeras alltid.
- Skripten skriver inga filer och inga loggfiler; allt går till stdout/stderr.
- Databaslösenordet lämnar skriptet bara inuti `DATABASE_URL` till Vercel (känslig variabel) och, när projektet skapas,
  till Supabase. Byte av lösenord skickar bara en SCRAM-verifierare.
- Dry-run skickar bara GET och läsfrågor (`set transaction read only`); klienten vägrar allt annat.
- **Inloggningslänkar.** Mallarna skickar engångskoden till `{{ .RedirectTo }}`, som är `redirect_to` (om den finns i
  `uri_allow_list`) eller annars `site_url`. Den som kan få in en egen domän där kan alltså, med den publika nyckeln,
  begära en äkta inloggningslänk till ägarens adress som lämnar koden hos sig. Därför skrivs bara bekräftade adresser in
  (steg 3), och främmande `*.vercel.app`-poster och en främmande `site_url` tas bort i produktionen. Förhandsmönstret
  `binderlab-*-<team>.vercel.app` börjar med projektnamnet. Det smalnar av vilka värdar som matchar, men det är
  fortfarande ett jokertecken på en delad domän. Utvecklingsprojektet ska därför inte ha riktiga kunddata.
- **Fel organisation.** Produktionsprojektet väljs bara i rätt Supabase-organisation; ett namne någon annanstans ger ett
  fel.
- **Dubbletter.** HTTP-klienten gör aldrig om ett `POST` vid 5xx, nätverksfel eller tidsgräns (det kan ha gått igenom),
  bara vid 429. `database/query` görs om eftersom den skyddas av kontrollen "redan körd". Varje anrop har en tidsgräns
  (60 s, `database/query` 10 min).

## Endpoints och hur säkra de är

API:erna gick inte att nå från byggmiljön. Allt är skrivet efter dokumentationen, med tydliga felmeddelanden. Raderna
märkta **osäker** är de där form eller beteende kan skilja sig; skriptet hanterar fel där och skriver vad som ska göras.

| Endpoint                                                                                                                | Säkerhet | Om det inte fungerar                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /v1/projects`, `GET /v1/projects/{ref}`                                                                       | säker    | `POST` provas med `organization_slug` om `organization_id` nekas.                                                                                       |
| `GET /v1/projects/{ref}/health?services=…`                                                                              | säker    | Hoppas över vid 404.                                                                                                                                    |
| `POST /v1/projects/{ref}/restore` (pausat projekt)                                                                      | osäker   | Väck projektet i Supabase-panelen och kör igen.                                                                                                         |
| `GET/POST /v1/projects/{ref}/api-keys?reveal=true`                                                                      | säker    | Maskerad secret key ger ett fel som säger att token saknar rätt.                                                                                        |
| `GET/PATCH /v1/projects/{ref}/config/auth`                                                                              | säker    |                                                                                                                                                         |
| `…/config/auth/signing-keys` (+ `/legacy`, `PATCH /{id}`)                                                               | osäker   | Manuellt steg: Project Settings → JWT Keys.                                                                                                             |
| `POST /v1/projects/{ref}/database/query` med flera satser                                                               | osäker   | Felet säger det; kör då `npm run db:migrate -- --url <session-pooler, port 5432>`.                                                                      |
| Svarets form från `database/query` (rader från sista satsen)                                                            | osäker   | Både en lista med rader och en lista per sats hanteras.                                                                                                 |
| `alter role postgres` via `database/query` och att poolern tar det nya lösenordet direkt                                | osäker   | Byt lösenordet i Supabase → Database → Settings och kör med `SUPABASE_DEV_DB_PASSWORD`/ta bort `DATABASE_URL` i Vercel.                                 |
| `GET /v1/projects/{ref}/config/database/pooler`                                                                         | säker    | Faller tillbaka på `aws-0-{region}.pooler.supabase.com` med en varning. Värden ingår i den bokförda taggen, så en fel gissning rättas när API:t svarar. |
| Storage `GET/POST /storage/v1/bucket`, Auth `…/auth/v1/admin/users`                                                     | säker    |                                                                                                                                                         |
| Vercel `GET /v2/teams`, `/v2/user`, `POST /v11/projects`                                                                | säker    |                                                                                                                                                         |
| Vercel `GET /v10/projects` med `repoUrl`/`search` och bläddring via `from`                                              | osäker   | Okända filter ignoreras (listan filtreras ändå lokalt). Bläddringen stannar när en sida inte ger nya projekt.                                           |
| Vercel `POST /v9/projects/{id}/link` (koppla ett befintligt okopplat projekt)                                           | osäker   | Koppla repot under Settings → Git och kör igen.                                                                                                         |
| Vercel `GET /v10/projects/{id}/env`, `GET /v1/projects/{id}/env/{id}`, `POST /v10/…/env`, `PATCH/DELETE /v9/…/env/{id}` | säker    |                                                                                                                                                         |
| Vercel `PATCH /v9/…/env/{id}` med bara `target` (uppdelning)                                                            | osäker   | Ta bort den delade variabeln för hand och kör igen.                                                                                                     |
| Vercel `PATCH /v9/projects/{id}` (`serverlessFunctionRegion`)                                                           | säker    | `vercel.json` (`regions: ["arn1"]`) gäller ändå.                                                                                                        |
| Vercel `POST /v13/deployments` (`gitSource`), `GET /v13/deployments/{id}`, `GET /v6/deployments`                        | säker    |                                                                                                                                                         |
| Vercel `GET /v9/projects/{id}/domains`                                                                                  | säker    |                                                                                                                                                         |

## Kvar för hand

Det här kan inte skripten göra, och sammanfattningen påminner om det som gäller:

- **Vercel Pro** om larmjobbet ska gå var 10:e minut (`vercel.json`). På Hobby avvisas driftsättningen; varningen säger
  det.
- **E-post med egen domän (Resend)**: verifiera avsändardomänen (SPF/DKIM) i Resend och kör igen med `RESEND_API_KEY`
  och `MAIL_FROM`. Utan det skickar Supabase inloggningslänkar med sin inbyggda e-post, som bara når adresser som är
  medlemmar i Supabase-organisationen och bara några mejl i timmen, och rapportmejlen hamnar i serverns utkorg.
- **JWT-nycklar**, bara om API:t inte stöder dem (skrivs då ut): Supabase → Project Settings → JWT Keys → Migrate JWT
  secret, skapa en ES256-nyckel och Rotate keys.
- **Egen domän** (t.ex. `app.binderlab.se`): lägg till den i Vercel → Settings → Domains och kör igen med
  `--app-url https://app.binderlab.se`.
- **Valfritt**: Sentry, Claude API (`ANTHROPIC_API_KEY`), sms-leverantör. Kör igen med värdena i miljön.
- **`DATABASE_URL` för Preview**, om utvecklingsprojektets lösenord inte är känt: kör igen med
  `SUPABASE_DEV_DB_PASSWORD=<lösenordet>` (Supabase → Database → Settings), eller med `--byt-dev-losenord`.
- **GitHub Environments** behövs inte längre för migreringar (skripten kör dem). Workflowet "Migrera databasen" finns
  kvar och kräver då `DATABASE_URL` med det aktuella lösenordet.

## Tester

```sh
npx vitest run -c test/deploy/vitest.config.ts
```

- `test/deploy/pipeline.test.ts`: hela kedjan mot ett mockat Supabase- och Vercel-API (`test/deploy/fake-apis.ts`):
  körning från noll, andra körningen ändrar ingenting och driftsätter inte, redan körda och ändrade migreringar, en
  migrering som misslyckas, befintligt projekt med okänt lösenord, uppdelning av delade variabler, roterad nyckel,
  dry-run (bara läsningar), faserna var för sig, Hobby-varning, "inte konfigurerat", fel token, och att ingen hemlighet
  finns i utskriften. Dessutom granskningens fall: en antagen adress som blev en annan (även med `supabase.ts` följt av
  `vercel.ts`), rensning av främmande `*.vercel.app`-poster, `binderlab-prod` i fel organisation, 504 på
  `POST /v1/projects`, delad och felmärkt `DATABASE_URL`, `--byt-dev-losenord` och `SUPABASE_DEV_DB_PASSWORD`, ny
  driftsättning efter ett misslyckat bygge och efter `--skip-deploy`, flera Vercel-team och ett 422 vid ägarkontot.
- `test/db/redteam-driftsattning.test.ts` (granskningens egna tester, körs med `vitest.db.config.ts`): samma fynd sett
  utifrån.
- `test/deploy/lib.test.ts`: maskning, HTTP-klienten (omförsök bara när det är säkert, tidsgräns, fel, dry-run-spärr),
  argument, auth-diff och rensning av främmande adresser, SMTP,
  genererade hemligheter och att skripten inte skriver filer.
- `test/deploy/migrations.db.test.ts`: frågorna som skickas till `database/query` körs mot en riktig Postgres 16 med
  auth-shimmen: alla 50+ riktiga migreringar, samma bokföring som `migrate.ts`, idempotens, återställning vid fel,
  dry-run-frågorna och SCRAM-verifieraren (jämförd med Postgres egen). Egen databas: `DEPLOY_TEST_DATABASE_URL`,
  standard `postgres://postgres@127.0.0.1:54322/binderlab_test_driftsattning`.

## Felsökning

- **`… nådde inte fram`**: värden är inte öppen i sessionens nätverk. Lägg till den och kör igen.
- **`svarade 401` / `403`**: fel eller för snäv token (Supabase: Owner/Administrator; Vercel: rätt team).
- **Migreringen misslyckades**: inget av filen är kvar. Rätta med en ny migrering och kör igen; redan körda hoppas över.
- **`/logga-in säger "inte konfigurerat"`**: variablerna som saknas skrivs ut. Kör igen (eller sätt dem i Vercel) och
  kör med `--force-deploy`.
- Allt som redan gjorts ligger kvar efter ett fel. Kör samma kommando igen när felet är åtgärdat.
