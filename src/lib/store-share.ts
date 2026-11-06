/**
 * Etiketter för butikernas andel, samma på alla sidor.
 *
 * Utan vald butik: "Butikernas andel" (summan av varje butiks andel enligt dess eget avtal).
 * Med vald butik: butikens namn och villkor, "Sega gubben 50 % av vinsten", så att det syns
 * vilken procent som dragits. Ren funktion, inga beräkningar av belopp.
 */

import type { IsoDate, Period, StoreAgreement } from "@/domain";

import { formatPercent, formatSek } from "./format";

/** Etiketten utan vald butik. */
export const STORES_SHARE_LABEL = "Butikernas andel";
/** Vår vinst efter butikernas andel. */
export const OUR_PART_LABEL = "Vår del";

function percent(bp: number): string {
  return formatPercent(bp / 10_000, bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2);
}

/** Avtalet som gällde en dag (det senast startade), eller null. */
function agreementOn(
  agreements: readonly StoreAgreement[],
  storeId: string,
  day: IsoDate,
): StoreAgreement | null {
  let best: StoreAgreement | null = null;
  for (const a of agreements) {
    if (a.storeId !== storeId || a.validFrom > day) continue;
    if (a.validTo !== null && a.validTo < day) continue;
    if (best === null || a.validFrom > best.validFrom) best = a;
  }
  return best;
}

/**
 * Villkoren i klartext: "50 % av vinsten", "10 % av försäljningen", "hyra 500 kr/mån",
 * "10 % av försäljningen + hyra 500 kr/mån". Avtalet som gällde periodens sista dag (annars
 * det senaste i perioden). null utan avtal eller utan andel och hyra.
 */
export function storeShareTerms(
  agreements: readonly StoreAgreement[],
  storeId: string,
  period: Period,
): string | null {
  let a = agreementOn(agreements, storeId, period.end);
  if (!a) {
    for (const x of agreements) {
      if (x.storeId !== storeId || x.validFrom > period.end) continue;
      if (x.validTo !== null && x.validTo < period.start) continue;
      if (a === null || x.validFrom > a.validFrom) a = x;
    }
  }
  if (!a) return null;
  const parts: string[] = [];
  if ((a.commissionBp ?? 0) > 0) {
    parts.push(
      `${percent(a.commissionBp!)} av ${a.commissionBase === "profit_after_costs" ? "vinsten" : "försäljningen"}`,
    );
  }
  if ((a.monthlyRentOre ?? 0) > 0) parts.push(`hyra ${formatSek(a.monthlyRentOre! / 100)}/mån`);
  return parts.length > 0 ? parts.join(" + ") : null;
}

/**
 * Etiketten för andelen: utan butik "Butikernas andel", med vald butik "Sega gubben 50 % av
 * vinsten" (namnet ensamt utan villkor: "Sega gubbens andel" skulle kräva böjning, så
 * "Andel till Sega gubben").
 */
export function storeShareLabel(store: { name: string; terms: string | null } | null): string {
  if (!store) return STORES_SHARE_LABEL;
  return store.terms ? `${store.name} ${store.terms}` : `Andel till ${store.name}`;
}

/**
 * Namnet på vår vinst i en vy: "Vår vinst" före butikernas andel (standard), "Vår del" när
 * andelen är dragen (vyknappen eller vald butik). "Förlust" när talet är negativt.
 */
export function ourProfitLabel(storeShareDeducted: boolean, valueOre = 0): string {
  if (valueOre < 0) return "Förlust";
  return storeShareDeducted ? OUR_PART_LABEL : "Vår vinst";
}

/**
 * Namnet på marginalen: "Vår marginal" före butikernas andel, "Marginal efter andel" efter
 * den. En kort etikett (`base`, t.ex. "Marginal" i Automaters smala rutor) behålls i båda
 * lägena: där står vyknappens "Före/Efter butikernas andel" bredvid.
 */
export function ourMarginLabel(storeShareDeducted: boolean, base = "Vår marginal"): string {
  if (base !== "Vår marginal") return base;
  return storeShareDeducted ? "Marginal efter andel" : base;
}
