# Assistent och förslag

## Assistenten (/assistent)

Frågor på svenska som besvaras med verktyg mot er data (RLS, inga fria SQL-frågor). Varje tal i svaret
kontrolleras mot verktygsresultaten. Kod: `src/server/assistant/`.

## Förslag (AI-rådgivaren)

Varje morgon tar Claude fram högst 5 förslag per organisation. De visas överst i **Att göra** och under
**Förslag** på Assistent-sidan (ägare och admin).

- Varje förslag har rubrik, varför (med tal), åtgärd, uppskattad effekt i kr/mån och säkerhet.
- **Klar** och **Avfärda** tar bort förslaget (Ångra finns i notisen). **Fråga assistenten** öppnar
  assistenten med förslaget ifyllt.
- **Generera nya förslag**: högst 3 gånger per dag och organisation.
- Rådgivaren får inte tidigare förslag igen (de senaste 30 dagarnas rubriker skickas med).

### Så fungerar det

1. Underlag (`advisor/snapshot.ts`): senaste 30 och 7 hela dagarna mot perioderna före. Nyckeltal, titlar,
   automater, butiker med butiksandel, veckodagar, timmar, lagerrisk (under 7 dagar kvar), pris- och
   inköpsprisändringar och avvikelser. Allt räknas med `@/domain` och `@/analytics`.
2. Claude (`advisor/model.ts`, standard `claude-sonnet-5-5`) svarar med verktyget `spara_forslag` (strikt
   schema). Instruktioner och underlag cachas. `max_tokens` 4000, tidsgräns 90 s, ett nytt försök.
3. Kontroll (`advisor/grounding.ts`): ett förslag sparas bara om varje tal i rubrik, varför och åtgärd finns i
   underlaget, rubriken har högst 8 ord och effekten är ett heltal mellan 0 och vinsten för 30 dagar.
   Kontrollen ser bara att talet finns någonstans i underlaget, inte att det hör till rätt sak (0, 1, 3, 7
   och 30 finns på många ställen). Effekten (kr/mån) är modellens uppskattning och visas som det.
   Underlaget skickas inom `<underlag>` och räknas som data (titelnamn kommer från Awish).
4. Tabeller: `ai_runs` (körning, tokens, kostnad, kastade förslag) och `ai_suggestions` (status new, done,
   dismissed). Ägare och admin läser och ändrar status. Bara servern skriver.

### Schema

pg_cron kör `private.ai_cron_tick()` kl. 04:43 UTC. Funktionen gör `GET /api/cron/ai` med
`Authorization: Bearer <CRON_SECRET>` och läser adress och hemlighet ur Vault (`binderlab_app_url`,
`binderlab_cron_secret`), som Awish-synken. Migreringen schemalägger jobbet `binderlab-ai-advisor` där pg_cron
och pg_net finns (Supabase). En andra körning samma dag gör ingenting. Demoorganisationen hoppas över. I produktion
(`NODE_ENV=production`) anropar demoorganisationerna (`nordljus-demo*`) aldrig Claude, varken förslag eller frågor,
så att de inte delar taket med verksamheten. Lokalt fungerar knappen även i demon.

### Kostnad och tak

| Variabel                | Standard            | Betydelse                                               |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | –                   | Krävs.                                                  |
| `ANTHROPIC_MODEL_CHAT`  | `claude-opus-5-5`   | Assistentens frågor (`ANTHROPIC_MODEL` som äldre namn). |
| `ANTHROPIC_EFFORT_CHAT` | `high`              | Tänkandets djup: `high`, `medium` eller `low`.          |
| `AI_ADVISOR_MODEL`      | `claude-sonnet-5-5` | Förslagen.                                              |
| `AI_MONTHLY_BUDGET_SEK` | `300`               | Tak per kalendermånad för förslag och frågor.           |
| `AI_USD_SEK`            | `11`                | Växelkurs för listpriset.                               |

Månadens kostnad = `ai_runs.cost_ore` + tokens i `assistant_logs.usage`, räknat med listpriset. När taket är nått
görs inga fler anrop: förslagen får status `budget` och assistenten svarar att budgeten är slut. En körning
kostar ungefär 0,30 kr. En fråga med Opus 5.5 på hög insats kostar ungefär 1,5–2 kr (listpris $4/$20 per miljon
tokens in/ut, cacheläsning $0,20, cacheskrivning $5): verktygen och första systemblocket (ca 7 000 tokens) läses ur
cachen, tänkandet och svaret (några tusen tokens ut) är det mesta av kostnaden. 300 kr räcker då till ungefär
150 frågor i månaden plus förslagen (ca 9 kr). `ANTHROPIC_EFFORT_CHAT=medium` ungefär halverar kostnaden per fråga.
AI-panelen visar en rad när mindre än 20 % av budgeten är kvar. Kan taket inte läsas skickas inget till Claude.

### AI-panelen (Fråga AI)

Knappen "Fråga AI" i toppraden (⌘J / Ctrl J, på telefon en flytande knapp ovanför bottenraden) öppnar en
sidopanel med samma samtal på alla sidor (`src/components/assistant`, monterad i `app-frame.tsx`). Frågan går till
samma route som sidan Assistent och skickar med sidan (rutt, period, filter, Med VMB, detaljsida;
`src/server/assistant/page-context.ts`). Servern kör sidans verktyg i förväg (t.ex. `nyckeltal` på Lönsamhet,
`inkopspriser` på Inköpspriser, `butiksandel` på en butik) och ger modellen sammanfattningen; den räknas som
underlag i kontrollen av talen. Varje sida har 2–3 förslag (chips). Gnistan "Förklara …" under rubriken på Hem,
Lönsamhet, Automater, Butik, Inköpspriser och Ekonomi fyller i frågan; rådgivarens förslag visas som en tipsrad
på sidan de hör till (`page-tips.ts`, annars på Hem) och kan döljas. Assistenten kan föreslå knappar
(`foresla_knapp`): bara navigering till sidor rollen ser, aldrig skrivningar.

### Utvärdering

`src/server/assistant/eval/cases.ts` har 24 frågor om seedens data. `test/db/assistent-eval.test.ts` kör dem med
den lokala testmodellen (verktyg, parametrar, kontrollen av talen, knappar och några exakta tal). Mot Claude API:
`npx tsx scripts/assistant-eval.ts --live --antal 3` (högst 8 frågor, kostar pengar, loggas och räknas mot taket).

Kända gränser: en körning som misslyckas (tidsgräns, avbruten vid `maxDuration`) räknas som 0 kr fast den kan
debiteras, och månadssumman läses utanför låset per organisation. Överskridandet blir högst några kronor.

### Testa

```sh
npm test -- src/server/assistant/advisor     # underlag, kontroll, pris (utan API)
npm run test:db -- test/db/ai-radgivare.test.ts   # RLS, gräns, tak (mockad modell)

# LIVE (inte i CI): riktig nyckel mot lokal demodata, skriver svar och förslag.
set -a; . /path/till/nyckel.env; set +a
AI_LIVE=1 AI_LIVE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/binderlab_dev \
  NODE_USE_ENV_PROXY=1 npx vitest run -c vitest.db.config.ts test/db/ai-live.test.ts
```
