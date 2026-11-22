/**
 * Rena hjälpfunktioner för designgranskningen. De körs både i Node (enhetstesterna) och i
 * sidan (probe.ts skickar in deras källkod med toString), så de får inte använda importer,
 * modulvariabler eller något utanför sina egna argument.
 */

/** "a, 'B c', \"D\"" → ["a", "B c", "D"] (computed font-family). */
export function parseFontFamilies(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Typsnittsnamnet utan next/font-prefix och hash: "__Google_Sans_5a3b2c" → "google sans",
 * "__GeistMono_Fallback_1a2b3c" → "geistmono", "Google Sans Code" → "google sans code".
 */
export function normalizeFamily(name: string): string {
  return name
    .trim()
    .replace(/^_+/, "")
    .replace(/_[0-9a-f]{5,}$/i, "")
    .replace(/[_\s]+fallback$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export type FontClass = "google-sans" | "google-sans-code" | "monospace" | "other";

/** Det första (använda) typsnittet i en computed font-family. */
export function classifyFont(fontFamily: string): { family: string; kind: FontClass } {
  const first = parseFontFamilies(fontFamily)[0] ?? "";
  const family = normalizeFamily(first);
  if (family === "google sans" || family === "v2 google sans fallback") {
    return { family: first, kind: "google-sans" };
  }
  if (family === "google sans code") return { family: first, kind: "google-sans-code" };
  if (/mono|code|courier|menlo|consolas|monaco/.test(family)) {
    return { family: first, kind: "monospace" };
  }
  return { family: first, kind: "other" };
}

/**
 * Typsnittet är fel: allt ska vara Google Sans, utom Google Sans Code i kommandopalettens
 * tangentvisning (Ctrl K).
 */
export function isWrongFont(kind: FontClass, inCommandHint: boolean): boolean {
  if (kind === "google-sans") return false;
  if (kind === "google-sans-code") return !inCommandHint;
  return true;
}

/** VERSALER med spärrning över 0,02 em (gamla etiketten .label). */
export function isSpacedUppercase(
  textTransform: string,
  letterSpacing: string,
  fontSize: string,
): boolean {
  if (textTransform !== "uppercase") return false;
  const spacing = parseFloat(letterSpacing);
  const size = parseFloat(fontSize);
  if (!Number.isFinite(spacing) || !Number.isFinite(size) || size <= 0) return false;
  return spacing / size > 0.02;
}

/**
 * Klasser ur den gamla designen (src/app/globals.css och src/styles/tokens.css): .label,
 * .meta, rutnät och skraffering, rörelseklasserna, font-mono och Tailwind-klasserna som
 * läser de gamla --bl-*-tokens (bg-surface, text-muted, border-line, text-sm, rounded-xs …).
 * V2 använder v2-* och *-v2-*. Varianter (hover:, md:, max-md:) räknas också.
 */
export function legacyClasses(classNames: readonly string[]): string[] {
  const exact =
    /^(label|meta|grid-field|grid-field-fine|hatch|lift|rise|fade-in|live-dot|bl-ticks|grow-y|grow-x|draw|font-mono)$/;
  const token =
    "(bg|surface|raised|hover|line|line-strong|line-control|fg|muted|subtle|faint|disabled|signal|signal-fg|signal-soft|signal-line|signal-hover|on-signal|up|up-line|fill-mid|fill-ok|inverse|on-inverse|inverse-hover|data-[0-5]|focus|overlay)";
  const color = new RegExp(
    `^(bg|text|border|border-[trblxyse]|divide|ring|outline|fill|stroke|decoration|accent|caret|from|via|to|placeholder|shadow)-${token}(/\\d+)?$`,
  );
  const typeScale = /^text-(label|xs|sm|base|md|lg|xl|2xl|3xl|display)$/;
  const radius = /^rounded(-[trblse]{1,2})?-(xs|sm|md)$/;
  const out: string[] = [];
  for (const raw of classNames) {
    const base = raw.split(":").pop() ?? raw;
    const bare = base.replace(/^!/, "");
    if (exact.test(bare) || color.test(bare) || typeScale.test(bare) || radius.test(bare)) {
      out.push(raw);
    }
  }
  return out;
}

/** Inline-stil som läser de gamla variablerna (--bl-*, --font-geist-*). */
export function legacyVariables(styleText: string): string[] {
  const found = styleText.match(/var\(\s*--(bl-[a-z0-9-]+|font-geist-[a-z]+)/g) ?? [];
  return Array.from(new Set(found.map((m) => m.replace(/^var\(\s*/, ""))));
}

/**
 * Tomma ytor: delar av sidan (sidkoordinater) där inget syns på minst en skärmhöjd.
 * `intervals` är y-intervallen [top, bottom] för synligt innehåll.
 */
export function findBlankGaps(
  intervals: ReadonlyArray<readonly [number, number]>,
  documentHeight: number,
  viewportHeight: number,
): Array<{ start: number; end: number }> {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .map(([a, b]) => [Math.max(0, a), Math.min(documentHeight, b)] as const)
    .sort((x, y) => x[0] - y[0]);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const [top, bottom] of sorted) {
    if (top - cursor >= viewportHeight) gaps.push({ start: cursor, end: top });
    cursor = Math.max(cursor, bottom);
  }
  if (sorted.length > 0 && documentHeight - cursor >= viewportHeight) {
    gaps.push({ start: cursor, end: documentHeight });
  }
  return gaps;
}

/** Packbilden är för liten (under 32 px hög). */
export function isPackTooSmall(heightPx: number): boolean {
  return heightPx > 0 && heightPx < 32;
}

/** Texten är avklippt (bredd eller rader) utan att hela texten finns som title. */
export function isTruncated(m: {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  overflowX: string;
  textOverflow: string;
  lineClamp: string;
}): boolean {
  const clipsX = m.textOverflow === "ellipsis" || /hidden|clip/.test(m.overflowX);
  if (clipsX && m.clientWidth > 0 && m.scrollWidth > m.clientWidth + 1) return true;
  const clamped = m.lineClamp !== "" && m.lineClamp !== "none";
  return clamped && m.clientHeight > 0 && m.scrollHeight > m.clientHeight + 1;
}

/** Kort, jämförbar text för rapporten (blanksteg ihop, högst `max` tecken). */
export function shortText(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
