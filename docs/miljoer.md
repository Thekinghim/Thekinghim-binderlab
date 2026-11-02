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
