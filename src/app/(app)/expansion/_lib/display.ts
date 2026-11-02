/**
 * Visning av tal ur @/analytics och @/domain: belopp i öre, andelar i bp, tiondelar och
 * minuter som svensk text. Bara formatering (via src/lib/format och analysens
 * texthjälp), ingen beräkning. Fungerar på servern och i klienten.
 */

import type { ScenarioFigure } from "@/analytics/expansion";
import { minutesText } from "@/analytics/effect";
import { kr, krExact, pct, tenths } from "@/analytics/todos/text";
import { formatInt, formatMonth, MISSING, NBSP } from "@/lib/format";

export { kr, krExact, pct, tenths, minutesText };

/** Hela kronor, eller "–" för null. */
export function krOrMissing(ore: number | null | undefined): string {
  return ore === null || ore === undefined ? MISSING : kr(ore);
}

/** Procent från bp, eller "–". */
export function pctOrMissing(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? MISSING : pct(bp);
}

/** Återbetalningstid i tiondels månader: 72 → "7,2 mån". null → "–". */
export function paybackShort(t: number | null | undefined): string {
  return t === null || t === undefined ? MISSING : `${tenths(t)}${NBSP}mån`;
}

/** Hundradelar som decimaltal: 339 → "3,39". */
export function hundredthsText(v: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  return `${sign}${formatInt(Math.floor(a / 100))},${String(a % 100).padStart(2, "0")}`;
}

/** Ett tal i underlaget, i sin enhet. */
export function figureText(f: Pick<ScenarioFigure, "value" | "unit">): string {
  switch (f.unit) {
    case "ore":
      return Math.abs(f.value) % 100 === 0 ? kr(f.value) : krExact(f.value);
    case "bp":
      return pct(f.value);
    case "days":
      return `${formatInt(f.value)}${NBSP}${f.value === 1 ? "dag" : "dagar"}`;
    case "packs":
      return `${formatInt(f.value)}${NBSP}pack`;
    case "hours":
      return `${formatInt(f.value)}${NBSP}h`;
    case "minutes":
      return minutesText(f.value);
    case "tenths":
      return tenths(f.value);
    case "hundredths":
      return hundredthsText(f.value);
    default:
      return formatInt(f.value);
  }
}

/** 'ÅÅÅÅ-MM' → "november 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return formatMonth(new Date(y, m - 1, 1));
}

/** Öre → kronor som text för ett formulärfält ("12 500" eller "12 500,50"). */
export function oreToInput(ore: number | null | undefined): string {
  if (ore === null || ore === undefined) return "";
  const sign = ore < 0 ? "-" : "";
  const a = Math.abs(ore);
  const cents = a % 100;
  const whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${whole}${cents === 0 ? "" : `,${String(cents).padStart(2, "0")}`}`;
}

/** bp → procent som text för ett formulärfält ("12,5"). */
export function bpToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "";
  const r = bp % 100;
  return `${Math.floor(bp / 100)}${r === 0 ? "" : `,${String(r).padStart(2, "0").replace(/0$/, "")}`}`;
}

/** Minuter → timmar som text för ett formulärfält ("12,5"). */
export function minutesToHoursInput(min: number): string {
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (rest === 0) return String(h);
  const hundredths = Math.round((rest * 100) / 60);
  return `${h},${String(hundredths).padStart(2, "0").replace(/0$/, "")}`;
}
