/**
 * Tal på sidan via src/lib/format: öre → kronor, tusendelar av pack → pack, bp → procent.
 * Ren funktion, klientsäker.
 */

import {
  formatInt,
  formatKronor,
  formatNumber,
  formatPercent,
  formatSek,
  MISSING,
  NBSP,
} from "@/lib/format";

/** 12 480 kr (hela kronor). */
export function kr(ore: number): string {
  return formatSek(ore / 100);
}

/** 49,50 kr */
export function krExact(ore: number): string {
  return formatKronor(ore / 100);
}

/** Pack med en decimal ur tusendelar: 1 450 → "1,5". */
export function packsMilli(milli: number): string {
  return formatNumber(milli / 1_000, 1);
}

/** Hela pack ur tusendelar: 1 450 → "1". */
export function packsWhole(milli: number): string {
  return formatInt(milli / 1_000);
}

/** 12,4 % ur bp. */
export function percentBp(bp: number | null, digits = 1): string {
  if (bp === null) return MISSING;
  return formatPercent(bp / 10_000, digits);
}

/** 9,5 dagar ur bp av dag. */
export function daysBp(bp: number): string {
  const v = bp / 10_000;
  return `${formatNumber(v, Number.isInteger(v) ? 0 : 1)}${NBSP}${v === 1 ? "dag" : "dagar"}`;
}

/** Slutsålda dagar summerade över titlar och automater: 19 titeldagar, 741,5 titeldagar. */
export function titleDaysBp(bp: number): string {
  const v = bp / 10_000;
  return `${formatNumber(v, Number.isInteger(v) ? 0 : 1)}${NBSP}${v === 1 ? "titeldag" : "titeldagar"}`;
}

/** 12 st / 12 pack */
export function packsText(n: number): string {
  return `${formatInt(n)}${NBSP}pack`;
}

/** Kronor (text från fält, "49,50" eller "49.50") → öre. null om ogiltigt. */
export function parseKronor(raw: string): number | null {
  const s = raw.replace(/\s| /g, "").replace(",", ".").replace(/kr$/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Heltal ur fält. null om ogiltigt. */
export function parseCount(raw: string): number | null {
  const s = raw.replace(/\s| /g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Öre som text i ett fält: 4950 → "49,50". */
export function oreToField(ore: number): string {
  const whole = Math.floor(ore / 100);
  const cents = ore - whole * 100;
  return `${whole},${String(cents).padStart(2, "0")}`;
}
