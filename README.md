# Binderlab

Kontrollpanel för varuautomater med samlarkortspack. Fas 1: projekt och designsystem.

```bash
npm install
npm run dev        # http://localhost:3000/design
npm run lint       # ESLint (next/core-web-vitals + typescript)
npm run typecheck  # tsc, strikt läge + noUncheckedIndexedAccess
npm run format     # Prettier (+ sortering av Tailwind-klasser)
```

## Struktur

```
src/
  styles/tokens.css        Alla designtokens (färg för båda lägena, typsnitt, rörelse)
  app/globals.css          Tailwind @theme → tokens. Standardpaletter/skuggor/radier nollställda
  app/design/              /design: visning av tokens och komponenter med exempeldata
  lib/                     tokens.ts (TS-spegling), format.ts (sv-SE), hooks, tema
  components/ui/           Knapp, ikonknapp, fält, select, segment, tabell, KPI-kort,
                           statusetikett, sektionsrubrik, tomt läge, skeleton, toast, modal
  components/charts/       Linje/yta, stapel, vattenfall, värmekarta, andelsstapel, sparkline
                           (d3-scale/d3-shape för matematik, egen SVG för rendering)
  components/shell/        Sidomeny, toppbar med periodval, lägesväxlare, app-skal
```

## Regler i korthet

- Färg bara via tokens (`bg-surface`, `text-muted`, `border-line` …). Tailwinds standardfärger är avstängda.
- En signalfärg (`signal`) för det som kräver uppmärksamhet. Allt annat i gråskala.
- Status bärs alltid av form + text, aldrig enbart färg.
- Tal formateras via `lib/format.ts` och visas med `tnum`.
- Lägen: `data-theme="dark" | "light"` på valfritt element.
