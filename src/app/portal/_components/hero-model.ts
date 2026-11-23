/**
 * Ren logik för översiktens nya delar (ersättningen överst, pallen, staplarna och
 * felanmälans steg). Inga belopp räknas här: allt kommer ur StoreReport och trenden
 * (@/reports, samma beräkning som månadsrapporten). Här väljs bara vad som visas.
 */

import type { StoreCompensationBreakdown, StoreTopTitle } from "@/reports";
import type { PortalTrendMonth } from "@/server/portal/model";

/** En del av stapeln "Er ersättning". */
export interface CompSegment {
  readonly kind: "share" | "commission" | "rent";
  readonly label: string;
  readonly ore: number;
}

const SEGMENT_LABEL: Record<CompSegment["kind"], string> = {
  share: "Andel",
  commission: "Provision",
  rent: "Hyra",
};

/** Ersättningens delar som en stapel: andel, provision och hyra, bara de som är större än 0. */
export function compSegments(
  c: Pick<StoreCompensationBreakdown, "shareOre" | "commissionOre" | "rentOre" | "pending">,
): CompSegment[] {
  const parts: [CompSegment["kind"], number][] = [
    // En vinstandel som inte kunde räknas (pending) står i månadsrapporten, inte i stapeln.
    ["share", c.pending ? 0 : c.shareOre],
    ["commission", c.commissionOre],
    ["rent", c.rentOre],
  ];
  return parts
    .filter(([, ore]) => ore > 0)
    .map(([kind, ore]) => ({ kind, label: SEGMENT_LABEL[kind], ore }));
}

/**
 * Ersättningen mot månaden före: i baspunkter, eller null när den inte går att jämföra
 * (pågående månad, ingen månad före, okänd andel eller 0 kr månaden före).
 */
export function compensationChange(
  trend: readonly PortalTrendMonth[],
  month: string,
): { prevOre: number; prevMonth: string; changeBp: number } | null {
  const i = trend.findIndex((t) => t.month === month);
  if (i <= 0) return null;
  const cur = trend[i]!;
  const prev = trend[i - 1]!;
  if (cur.partial || cur.compensationPending || prev.compensationPending) return null;
  if (prev.compensationOre <= 0) return null;
  return {
    prevOre: prev.compensationOre,
    prevMonth: prev.month,
    changeBp: Math.round(
      ((cur.compensationOre - prev.compensationOre) * 10_000) / prev.compensationOre,
    ),
  };
}

/**
 * "Bästa månaden hittills": månaden har sålt mer än varje annan månad i trenden, och det finns
 * minst en annan månad med försäljning att jämföra med.
 */
export function isBestMonth(trend: readonly PortalTrendMonth[], month: string): boolean {
  const cur = trend.find((t) => t.month === month);
  if (!cur || cur.revenueOre <= 0) return false;
  const others = trend.filter((t) => t.month !== month && t.revenueOre > 0);
  return others.length > 0 && others.every((t) => cur.revenueOre > t.revenueOre);
}

/** En plats på pallen. */
export interface PodiumPlace {
  readonly rank: number;
  readonly name: string;
  readonly orders: number;
}

/**
 * Butikens fem mest köpta pack (flest sålda, sedan mest försäljning), i pallens ordning:
 * 4, 2, 1, 3, 5 (etta i mitten). Färre än fem: samma ordning utan luckor.
 */
export function podium(top: readonly Pick<StoreTopTitle, "name" | "orders" | "revenueOre">[]): {
  places: PodiumPlace[];
  ordersTop: number;
} {
  const ranked = [...top]
    .filter((t) => t.orders > 0)
    .sort((a, b) => b.orders - a.orders || b.revenueOre - a.revenueOre)
    .slice(0, 5)
    .map((t, i) => ({ rank: i + 1, name: t.name, orders: t.orders }));
  const order = [4, 2, 1, 3, 5];
  const places = order.flatMap((r) => ranked.filter((p) => p.rank === r));
  return { places, ordersTop: ranked.reduce((s, p) => s + p.orders, 0) };
}

/** Pack per dag i snitt, avrundat till hela pack (minst en dag). */
export function packsPerDay(orders: number, days: number): number {
  return Math.round(orders / Math.max(1, days));
}

/** Kort kronbelopp för staplarna: "37,5k", "940". Öre in. */
export function compactKr(ore: number): string {
  const kr = Math.round(ore / 100);
  if (Math.abs(kr) < 10_000) return kr.toLocaleString("sv-SE");
  return `${(kr / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
}

// ---------------------------------------------------------------------------
// Felanmälan
// ---------------------------------------------------------------------------

/** Delen av automaten man trycker på (de har inga synliga fack). */
export type MachinePart = "screen" | "payment" | "hatch";

export const PART_LABEL: Record<MachinePart, string> = {
  screen: "Skärmen",
  payment: "Betalningen",
  hatch: "Luckan",
};

/** Felet som en del av automaten pekar på (tryck på delen = välj felet om inget är valt). */
export const PART_KIND = {
  screen: "store_screen",
  payment: "store_payment",
  hatch: "store_stuck",
} as const;

/** Beskrivningen som skickas: delen först när den säger något utöver felet. */
export function faultDescription(
  kind: string,
  part: MachinePart | null,
  text: string,
): string | undefined {
  const t = text.trim();
  const lead = part && PART_KIND[part] !== kind ? `Gäller ${PART_LABEL[part].toLowerCase()}.` : "";
  const out = [lead, t].filter(Boolean).join(" ");
  return out === "" ? undefined : out;
}

/** Ärendets steg: Skickad → Sedd → Åtgärdad. */
export type FaultStep = "sent" | "seen" | "fixed";

export function faultStepIndex(status: "open" | "in_progress" | "resolved"): 0 | 1 | 2 {
  return status === "resolved" ? 2 : status === "in_progress" ? 1 : 0;
}
