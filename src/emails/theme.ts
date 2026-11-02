import type { CSSProperties } from "react";

/**
 * Färger och typsnitt för e-post.
 *
 * E-postklienter läser inte CSS-variabler, så värdena här är det ljusa
 * temat i src/styles/tokens.css skrivet som hex. Mejl skickas alltid
 * ljusa: många klienter inverterar mörka mejl, och ett ljust mejl tål en
 * invertering bättre än tvärtom. Ändra tokens.css först och för sedan
 * över värdet hit (report-email.test.ts jämför dem).
 */
export const EMAIL_COLOR = {
  /** --bl-bg: sidan runt mejlet */
  bg: "#f4f3ef",
  /** --bl-surface-raised: själva mejlet */
  surface: "#ffffff",
  /** --bl-line: hårfina linjer */
  line: "#e0ded8",
  /** --bl-line-strong: tabellhuvud, baslinje i stapelraden */
  lineStrong: "#c9c6bf",
  /** --bl-fg */
  fg: "#151514",
  /** --bl-fg-muted: brödtext */
  muted: "#4f4d48",
  /** --bl-fg-subtle: etiketter, andra delen av rubriken */
  subtle: "#65635e",
  /** --bl-fg-faint: endast dekor (snedstreck i etiketter) */
  faint: "#aeaba4",
  /** --bl-data-3: staplar */
  bar: "#7c7974",
  /** --bl-signal: markerad datapunkt, ringen i symbolen */
  signal: "#f0521a",
  /** --bl-signal-fg: text som kräver uppmärksamhet */
  signalFg: "#b53e0e",
  /** --bl-inverse-bg: primärknapp */
  inverseBg: "#151514",
  /** --bl-inverse-fg */
  inverseFg: "#f4f3ef",
} as const;

/** Token i tokens.css som varje e-postfärg speglar (för testet). */
export const EMAIL_COLOR_TOKEN: Record<keyof typeof EMAIL_COLOR, string> = {
  bg: "--bl-bg",
  surface: "--bl-surface-raised",
  line: "--bl-line",
  lineStrong: "--bl-line-strong",
  fg: "--bl-fg",
  muted: "--bl-fg-muted",
  subtle: "--bl-fg-subtle",
  faint: "--bl-fg-faint",
  bar: "--bl-data-3",
  signal: "--bl-signal",
  signalFg: "--bl-signal-fg",
  inverseBg: "--bl-inverse-bg",
  inverseFg: "--bl-inverse-fg",
};

/**
 * Webbsäkra typsnittsstackar. Geist används där det finns installerat,
 * annars systemets sans. Namnen står utan citattecken: giltig CSS, och
 * React behöver då inte koda om dem som &#x27; i varje style-attribut.
 */
export const EMAIL_FONT = {
  sans: "Geist, -apple-system, Segoe UI, Helvetica, Arial, sans-serif",
  mono: "Geist Mono, ui-monospace, Menlo, Consolas, monospace",
} as const;

/** Mejlets innerbredd i px. */
export const EMAIL_WIDTH = 600;

/**
 * Sidomarginal i px. Grundvärdet står inline och gäller i alla klienter,
 * även Gmail som inte läser mejlets <style>: det är valt så att mejlet
 * ryms i 375 px utan media query. Klienter som läser media queries får
 * luftigare marginal på breda skärmar och smalare under 400 px.
 */
export const EMAIL_GUTTER = 24;
export const EMAIL_GUTTER_WIDE = 32;
export const EMAIL_GUTTER_NARROW = 20;

/** Stora siffror och rubrik: grundvärde, bred skärm, smal skärm (px, radhöjd). */
export const EMAIL_DISPLAY = {
  base: { size: 24, line: 30 },
  wide: { size: 26, line: 32 },
  narrow: { size: 22, line: 28 },
} as const;

/**
 * Inline-stil med Outlook-egenskaper (mso-*) som Reacts CSSProperties
 * saknar. React skriver msoLineHeightRule som mso-line-height-rule.
 */
export function css(style: Record<string, string | number>): CSSProperties {
  return style as CSSProperties;
}

/** Monospace-etikett: VERSALER, 11 px, bred spärrning (klassen "label" i appen). */
export const labelStyle = css({
  fontFamily: EMAIL_FONT.mono,
  fontSize: "11px",
  lineHeight: "16px",
  letterSpacing: "0.9px",
  textTransform: "uppercase",
  color: EMAIL_COLOR.subtle,
});

/** Brödtext. */
export const bodyStyle = css({
  fontFamily: EMAIL_FONT.sans,
  fontSize: "14px",
  lineHeight: "22px",
  color: EMAIL_COLOR.muted,
});

/** Tabulära siffror. */
export const tnum = css({ fontVariantNumeric: "tabular-nums" });
