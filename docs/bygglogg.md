# Bygglogg

Plan: [Binderlab – prompter till Claude Code](https://claude.ai/artifact/BmmkHvJAqJdoB4nDfJTwGe) (Claude Docs).
Beställaren är borta. Arbetet går självständigt igenom planen tills alla faser är klara och avbockade.
Kod: `claude/bygge` i Thekinghim/thekinghim-binderlab. `main` innehåller bara grunden tills beställaren slår ihop.

## Läge

| Fas | Status | Anteckning |
|---|---|---|
| 1 Designsystem | Klar | Godkänd av beställaren |
| 1b Granska och komplettera | Pågår | Granskning klar (31 punkter, `scratchpad/critique.json`); tillägg byggs |
| 2 Data, säkerhet, inloggning, import | Pågår | Datamodell v2 godkänd; backend byggs; UI efter 1b |
| 3 Skal, Hem, Att göra | Ej påbörjad | |
| 4 Lönsamhet, Inköpspriser | Ej påbörjad | Beräkningar byggs i fas 2 |
| 5 Order, Lager, Automater, Butiker | Ej påbörjad | |
| 6 Rapporter | Ej påbörjad | Kräver e-postleverantör (Resend) för riktiga utskick |
| 6b Intelligens | Ej påbörjad | Assistenten kräver Claude API-nyckel |
| 7 Kvalitet, drift, överlämning | Ej påbörjad | |
| 8 Drift: maskinhälsa, larm, ärenden | Ej påbörjad | |
| 9 Ekonomi: avstämning, bokföring, avtal | Ej påbörjad | |
| 10 Butiksportal, expansion | Ej påbörjad | |
| 11 Marknadsintelligens | Ej påbörjad | Externa priskällor kopplas inte utan beställarens OK |
| 12 Plattform | Väntar | Enligt planen först när 2–3 pilotoperatörer finns |

## Arbetsregler

- Lokal Postgres 16: `127.0.0.1:54322`, databaser `binderlab_dev` och `binderlab_test`. Starta med
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/user/.pgdata -o '-p 54322 -k /tmp' -l /home/user/.pgdata/log.txt start"`.
- Dev-server: `npx next dev -p 3200`.
- Supabase, Awish, Resend och Claude API går inte att nå från byggmiljön (nätverket blockerat, nycklar saknas). Allt byggs med
  adaptrar, med lokala implementationer för utveckling och test.
- Commit och push vid varje avklarad fas. Inga pull requests utan att beställaren ber om det.

## Beslut under bygget

Se `docs/datamodell.md` (Beslut från beställaren) och planens avsnitt "Beslut under bygget".

## Schemalagd kontroll

Timvis kontroll av bygget: schemalagd uppgift `trig_011jdLLdDXA6g2gBGTGoFBzJ` ("Binderlab: fortsätt bygget", kl. xx:35 UTC).
Tas bort när alla faser är klara.
