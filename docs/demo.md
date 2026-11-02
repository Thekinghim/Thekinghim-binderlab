# Demoläge

Demon är en egen organisation, **Nordljus Automater AB (demo)**, med påhittad men realistisk data för
1 feb – 2 nov 2026. Med den kan panelen visas för ledning, köpare eller investerare utan att de riktiga
siffrorna syns. Allt finns i `src/seed/demo/`, skriptet heter `scripts/db/seed-demo.ts`, och testerna ligger i
`src/seed/demo/*.test.ts` och `test/db/demo-*.test.ts`.

## Skapa demon

```sh
npm run db:seed-demo                   # binderlab_dev (DATABASE_URL)
npm run db:seed-demo -- test           # binderlab_test (DATABASE_URL_TEST)
npm run db:seed-demo -- --url <url>    # annan lokal databas
```

- Det tar ungefär 25 sekunder. Databasen måste ha alla migreringar (`npm run db:reset -- dev` eller `npm run db:migrate`).
- Seeden är **idempotent**. En andra körning skapar inget nytt.
- Den är **deterministisk**: samma kod ger alltid samma demo, på öret.
- Den är **lokal som standard**. En värd som inte är `127.0.0.1` eller `localhost` nekas om du inte lägger till
  `--allow-remote`. Mot en fjärrdatabas skapas inga användare. De måste då redan finnas i Supabase Auth.

### Inloggning

Lösenordet är `DEV_SEED_PASSWORD`, standard `binderlab-dev` (bara lokalt).

| Användare                        | Roll      | Namn i demon |
| -------------------------------- | --------- | ------------ |
| `demo@binderlab.local`           | Ägare     | Elin Strand  |
| `demo-lasare@binderlab.local`    | Läsare    | Johan Berg   |
| `demo-pafyllare@binderlab.local` | Påfyllare | Amir Haddad  |

Demoanvändarna är bara medlemmar i demoorganisationen, så de landar direkt i demon. Den riktiga organisationens
användare (`agare@`, `delagare@`) ser aldrig demon. RLS skyddar detta, och `test/db/demo-isolering.test.ts` testar det.

## Återställa demon

```sh
npm run db:seed-demo -- --aterstall    # radera demon och skapa den på nytt
npm run db:seed-demo -- --radera       # bara radera demon
```

Återställningen raderar demoorganisationen och alla dess rader i gallringsläget (`binderlab.allow_purge`).
Användarna och de uppladdade filerna under `.data/` finns kvar.

Slug räcker inte för att känna igen demon: appen sätter slug ur namnet, så en kund som döper sin organisation
till "Nordljus (demo)" får slug `nordljus-demo`. Spärren i `src/seed/demo/guard.ts` släpper därför bara igenom en
organisation som uppfyller allt detta:

- slug är `nordljus-demo` eller `nordljus-demo-stor` och namnet innehåller "(demo",
- den skapades av `demo@binderlab.local` (`organizations.created_by`) och den användaren är ägare i den,
- vid radering: alla medlemmar är demons egna användare (`demo@`, `demo-lasare@`, `demo-pafyllare@`).

Annars vägrar både seeden och återställningen och säger varför. Har någon utanför demon bjudits in för att titta
på den, ta bort den medlemmen i appen innan du återställer. Är sluggen upptagen av en kundorganisation rör demon
den inte alls; då går det inte att seeda demon i den databasen. Kontrollen görs igen med organisationsraden låst i
samma transaktion som raderingen.

Återställ efter en visning där någon har ändrat saker. Återställ också när generatorn har ändrats: annars krockar
de nya filerna med de importerade orderna, och seeden stoppar med ett meddelande om `--aterstall`.

Radering och inköpsorderrader skrivs som databasägare med `session_replication_role = replica`, vilket kräver
superuser. Det fungerar lokalt. Mot Supabase kan det kräva att rollen har den rättigheten.

## Visa demon

Logga in som `demo@binderlab.local` på http://localhost:3200. Välj **30 dagar** eller **Allt** i periodväljaren.

| Sida            | Vad som syns                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hem             | Cirka 405 000 kr de senaste 30 dagarna (+14 %), vinst före fasta kostnader, "Slutsålt kostade ca 7 400 kr" och två iakttagelser. Två titlar saknar inköpspris.                                               |
| Att göra        | 18 punkter, först Automat 07 som inte har sålt på 62 timmar (9 684 kr av 15 915 kr i risk de närmaste 7 dagarna), påfyllningar och titlar som är slut.                                                       |
| Lönsamhet       | Marginalen per automat och titel, prisändringar mitt i perioden och de två titlarna utan inköpspris.                                                                                                         |
| Order           | Cirka 14 700 order från tio månadsfiler som importerats genom Awish-importen.                                                                                                                                |
| Lager           | Saldon per automat och i centrallagret. Några platser är slut.                                                                                                                                               |
| Automater       | Tio automater. NA-05 flyttade 15 juni från Arboga till Sala. NA-10 är ny sedan september.                                                                                                                    |
| Butiker         | Sju butiker med provision, hyra eller båda. Arboga-avtalet är avslutat.                                                                                                                                      |
| Prognos & inköp | Prognos, förlorad försäljning (ca 7 400 kr för 30 d, ca 64 500 kr för Allt; störst Mega Evolution i september och Prismatic Evolution i juli), inköpsorder (mottagna, en på väg, ett utkast) och fyra släpp. |
| Expansion       | Sex platser i pipelinen, från intressent till installerad och förlorad. Spelhallen Nova har bäst potential (8 667 kr per månad) och är standard i scenariot.                                                 |
| Drift           | Automat 07 är troligen ur drift (kortläsaren), tyst i 62 timmar fram till importens slut 2 nov. 11:56. 9 öppna larm, 2 kritiska.                                                                             |
| Inkorg          | Fem kundärenden: två återbetalda, ett pågående och ett öppet fel.                                                                                                                                            |
| Ekonomi         | Utbetalningarna stämmer för alla månader utom augusti. Där saknas två order i utbetalningen (−328 kr, ordernumren pekas ut). Välj aug. för att se det.                                                       |
| Avtal           | Kvarnhagens hyresavtal löper ut 31 dec. 2026 (sista uppsägningsdag 30 nov.).                                                                                                                                 |
| Effekt          | Vinst per automat och månad +119 % mot utgångsläget i oktober. Standard är periodens månader (okt.–nov.); "Visa alla månader" visar hela mätningen **Utgångsläget är påhittat**; säg det när sidan visas.    |

Siffrorna ovan är avlästa i panelen 2 nov. 2026 efter `npm run db:seed-demo -- --aterstall`. Förlorad försäljning
räknas sedan fas 7:s slutsteg med lagerhändelsernas riktiga tidpunkt inom dagen (`queryMachineStockEvents` skickar
ISO-tid). Före rättningen var siffrorna ca 4 100 kr (30 d) och ca 44 700 kr (Allt).

Logga in som `demo-pafyllare@` för att visa påfyllarens vy: Att göra, Lager och fältläget. Påfyllaren ser inga belopp.
Logga in som `demo-lasare@` för att visa läsarens vy, där allt syns men inget kan ändras.

## Vad demon innehåller

Katalogen (`src/seed/demo/catalog.ts`) har fasta värden. Generatorn (`generate.ts`) simulerar försäljning, lager och
inköp dag för dag med en seedad slumpgenerator.

- **Butiker och automater.** Sju påhittade butiker i Mälardalen: Västerås, Eskilstuna, Arboga, Örebro, Köping,
  Enköping och Sala. Butikerna är en spelbutik, ett köpcentrum, en kiosk, en leksaksbutik, en bowlinghall, en biograf
  och en seriebutik.
  - Det finns tio automater. Sex startade 1 feb och resten tillkom i mars, april, maj och september.
  - NA-05 flyttar 15 juni.
  - NA-07 slutar sälja 31 okt. på grund av ett fel.
- **Avtal.**
  - Avtalen har provision (10–15 %), fast hyra eller båda.
  - Ett avtal är uppsagt (Arboga) och ett är omförhandlat (Sala, 1 juli).
  - Kvarnhagens avtal löper ut 31 dec. 2026, alltså inom 90 dagar.
  - Det finns ett kontrakt per butik och investeringar per automat.
- **Titlar och priser.**
  - Femton titlar. Två gamla titlar utgår ur sortimentet och fem titlar släpps under perioden.
  - Försäljningspriserna ändras för fyra titlar.
  - Inköpspriserna ändras för tre titlar.
  - Två titlar saknar inköpspris: _One Piece: Romance Dawn_ och _Lorcana: Into the Inklands_.
- **Mönster.**
  - Veckodagar: lördag säljer mest.
  - Säsong: juli är svag, och september–oktober är starka.
  - Lov: sportlov, påsklov, sommarlov, höstlov och midsommar.
  - Tillväxt: 2 % per månad.
  - Nystart: nya automater säljer mindre de första två veckorna.
  - Släppkurvor: efterfrågan är som högst på släppdagen och klingar sedan av.
- **Lager och slutsålt.**
  - En påfyllare fyller på automaterna två gånger i veckan (vissa en gång) och inventerar vid månadens första besök.
    Ibland kasseras ett skadat pack som svinn.
  - Centrallagret inventeras sista dagen i varje månad.
  - När en titel är slut i en automat går halva efterfrågan förlorad. Det är det som Prognos visar som förlorad
    försäljning.
  - Stora slutsålda perioder: Mega Evolution efter släppet 19 sep. och Prismatic Evolution i juli. Prismatic
    Evolution var restnoterad hos leverantören från 8 juni och levererades först 27 juli.
- **Inköp.**
  - Det finns två leverantörer med ledtid och lådstorlek.
  - En inköpsrutin körs varje måndag, och förhandsbeställningar läggs fyra veckor före varje släpp.
  - Mottagna order har inleveranser med rätt historisk tid. En order är på väg och dagens förslag är ett utkast.
  - Det finns fyra släpp med fördelning per automat. Ett av dem, _Phantasmal Flames_ 14 nov., ligger i framtiden.
- **Ekonomi.**
  - Utbetalningar per månad för feb–okt, betalda den 2:a nästa månad.
  - För augusti finns en specifikation per order. I den saknas två order: det är den avsiktliga avvikelsen.
  - Sex fasta kostnader: försäkring, licens, bil, förråd, redovisning och service.
  - Ägarandelarna är 60/40.
- **Mål och effekt.**
  - Mål per månad för intäkt, vinst och antal automater. Vissa månader nås målet och andra inte.
  - Utgångsläget är från januari, med effektmätningar för feb–okt.
- **Drift.**
  - Fem kundärenden, varav två är kopplade till återbetalda order.
  - Larmen är larmjobbets egna, utvärderade vid demons "nu" (2 nov. kl. 12). Det finns 9 öppna larm, varav 2 kritiska.
- **Rapportmottagare och expansion.** Sju rapportmottagare (butiker, redovisningsbyrå och delägare) och sex
  expansionsplatser. E-postadresserna slutar på `.example` och når aldrig någon.

Orderna går **genom importen**, precis som i den riktiga seeden. Varje månad blir en Awish-CSV (UTF-8 med BOM,
Shanghai-tid) som importeras med `runImport` som ägaren. Allt annat skrivs som användare med RLS. Det finns två undantag,
som skrivs som databasägare:

- **Inköpsorderraderna.** Mottagningstriggern skulle annars stämpla inleveransen med dagens tid.
- **Larmen.** Larmjobbet skriver dem.

## Stor demo för prestanda (`--stor`)

```sh
npm run db:seed-demo -- --stor            # nordljus-demo-stor, cirka 109 000 order
npm run db:seed-demo -- --stor --aterstall
```

`--stor` skalar efterfrågan och kapaciteten med 7,4. Det ger cirka 109 000 order (18,3 Mkr) i en egen organisation,
**Nordljus Automater AB (demo, stor)**. Den organisationen har bara demoägaren som medlem.

En körning tar ungefär 1,5 minut lokalt, varav importen av de tio månadsfilerna tar cirka 90 sekunder. Logga in som
`demo@binderlab.local` och byt organisation i skalet för att mäta sidorna med fas 7:s datamängd.

## Kända begränsningar

- Datumen är fasta (feb–nov 2026). Sidor som räknar från dagens datum (t.ex. "senaste 30 dagarna", avtal som löper
  ut och larm) ser annorlunda ut när verklig tid passerat 2 nov. 2026. Välj då perioden manuellt.
- Ingen månad är stängd (`period_closes`). Det gör att demon går att återställa och visa ändringar fritt.
- Inga rapporter eller PDF:er är genererade. Mottagarna finns, och en rapport kan skapas live under Rapporter.
- Kontrakten saknar avtalsfil (PDF).
