/**
 * Prisråd på Lönsamhet: rubriken och tolkningen av målet. Rent och klientsäkert.
 */

import { MAX_TARGET_MARGIN_BP, MIN_TARGET_MARGIN_BP } from "@/domain";
import { formatDay, formatInt, formatMarginBp } from "@/lib/format";

/** "2 produkter tjänar för lite." · "Ingen produkt är under målet 25 %." */
export function adviceHeadline(n: number, targetBp: number): string {
  // Inte "alla når målet": utan köp de senaste 30 dagarna är ingen produkt räknad.
  if (n === 0) return `Ingen produkt är under målet ${formatMarginBp(targetBp, 0)}.`;
  return `${formatInt(n)} ${n === 1 ? "produkt" : "produkter"} tjänar för lite.`;
}

/**
 * Marginalen på en rad under målet: hela procent ("23 %"). Skulle avrundningen se ut som
 * målet (24,6 % → "25 %" med målet 25 %) visas en decimal, avrundad neråt ("24,6 %").
 */
export function adviceMargin(marginBp: number, targetBp: number): string {
  const whole = formatMarginBp(marginBp, 0);
  if (marginBp >= targetBp || Math.round(marginBp / 100) < Math.round(targetBp / 100)) return whole;
  return formatMarginBp(Math.floor(marginBp / 10) * 10, 1);
}

/**
 * "i BL-002 (senast 9 nov)": var det låga priset finns när automaterna har olika pris.
 * Tom sträng när alla automater har samma pris.
 */
export function adviceWhere(where: { code: string; soldOn: string } | null): string {
  if (!where) return "";
  const [y, m, d] = where.soldOn.split("-").map(Number);
  return ` i ${where.code} (senast ${formatDay(new Date(y!, m! - 1, d!))})`;
}

/** "25" → 2 500 bp. Hela procent, 1–90. null = ogiltigt. */
export function parseTargetPercent(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, "");
  if (!/^\d{1,2}$/.test(t)) return null;
  const bp = Number(t) * 100;
  return bp >= MIN_TARGET_MARGIN_BP && bp <= MAX_TARGET_MARGIN_BP ? bp : null;
}
