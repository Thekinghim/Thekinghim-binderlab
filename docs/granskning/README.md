# Granskning (due diligence)

Underlag för den som granskar Binderlab inför ett köp eller ett avtal. Kort och sakligt; varje
påstående ska gå att kontrollera i koden eller genom att köra kommandot som står bredvid. Läget
gäller 5 nov. 2026 (gren `claude/dd`).

| Fil                                  | Innehåll                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [oversikt.md](oversikt.md)           | Vad produkten gör, för vem, och hur kunderna hålls isär (organisationer) |
| [arkitektur.md](arkitektur.md)       | Teknik, dataflöde, schemalagda jobb, externa tjänster och vad de gör     |
| [sakerhet.md](sakerhet.md)           | Inloggning, roller, RLS, Vault, hemligheter, loggar, säkerhetskopior     |
| [data.md](data.md)                   | Vilken data som sparas, var, vem som äger den, export och GDPR           |
| [integrationer.md](integrationer.md) | Awish (API och webbpanel), plattformsgränssnittet och andra märken       |
| [kvalitet.md](kvalitet.md)           | Tester (antal, körda), grind och hur en ändring når produktion           |
| [drift.md](drift.md)                 | Driftsättning, övervakning och incidenter                                |
| [agande.md](agande.md)               | Kodens ägande och tredjepartslicenser (copyleft flaggat)                 |
| [licenser.md](licenser.md)           | Hela licenslistan (genererad ur `node_modules`)                          |

Längre dokumentation finns i `docs/` (arkitektur, datamodell, beräkningar, drift); filerna här
hänvisar dit i stället för att upprepa.
