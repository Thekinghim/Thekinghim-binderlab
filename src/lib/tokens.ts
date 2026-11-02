/**
 * TS-spegling av de tokens som JS behöver (diagram, animationer).
 * Färger refereras alltid som CSS-variabler så att lägesbyte fungerar
 * utan omrendering. Källan är src/styles/tokens.css.
 */
export const color = {
  bg: "var(--bl-bg)",
  surface: "var(--bl-surface)",
  raised: "var(--bl-surface-raised)",
  line: "var(--bl-line)",
  lineStrong: "var(--bl-line-strong)",
  fg: "var(--bl-fg)",
  muted: "var(--bl-fg-muted)",
  subtle: "var(--bl-fg-subtle)",
  faint: "var(--bl-fg-faint)",
  disabled: "var(--bl-fg-disabled)",
  signal: "var(--bl-signal)",
  signalFg: "var(--bl-signal-fg)",
  signalSoft: "var(--bl-signal-soft)",
  signalLine: "var(--bl-signal-line)",
  /** Fokusring: förgrundsfärgen, aldrig signal. */
  focus: "var(--bl-focus)",
  data: [
    "var(--bl-data-1)",
    "var(--bl-data-2)",
    "var(--bl-data-3)",
    "var(--bl-data-4)",
    "var(--bl-data-5)",
  ],
  data0: "var(--bl-data-0)",
} as const;

/** Speglar --bl-dur-* (ms). I CSS: duration-fast/base/slow, animate-enter m.fl. */
export const motion = {
  fast: 120,
  base: 150,
  slow: 180,
  count: 420,
  pulse: 1600,
  ease: [0.2, 0, 0, 1] as const,
} as const;

export const space = { unit: 4, grid: 8 } as const;

export const radius = { xs: 2, sm: 4, md: 6 } as const;

export const chart = {
  /** Marginaler för axlar i diagram (px) */
  margin: { top: 16, right: 16, bottom: 28, left: 48 },
  node: 5,
  nodeActive: 7,
  stroke: 1.25,
} as const;
