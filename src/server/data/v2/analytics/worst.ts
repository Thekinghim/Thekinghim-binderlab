/**
 * Pengar och Hem (G4): automaterna som underpresterar. Appens regel, inte prototypens:
 * rangordningens omdöme "weak" (högst 50 % av medianens vinst per dag, minst 14 dagar,
 * src/analytics/ranking/fleet.ts) ur flottans läge, 30 dagar. Svagast först.
 */

import "server-only";

import { loadFleetState } from "@/server/data/v2/fleet";

export interface WeakMachine {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
  readonly city: string | null;
  readonly phone: string | null;
  readonly contactName: string | null;
  readonly profitPerDayOre: number;
  /** Mot medianen i bp (−6 000 = 60 % under). */
  readonly vsMedianBp: number | null;
  readonly emptySlots: number;
  readonly power: { readonly off: string; readonly on: string } | null;
}

export interface MoneyWorst {
  readonly rows: readonly WeakMachine[];
  readonly medianProfitPerDayOre: number | null;
}

export async function loadMoneyWorst(): Promise<MoneyWorst | null> {
  const fleet = await loadFleetState();
  if (!fleet.economy) return null;
  const median = fleet.medianProfitPerDayOre ?? null;
  const rows: WeakMachine[] = fleet.machines
    .filter((m) => m.economy?.verdict === "weak" && m.economy.profitPerDayOre !== null)
    .map((m) => {
      const ppd = m.economy!.profitPerDayOre!;
      return {
        machineId: m.id,
        code: m.code,
        name: m.name,
        storeName: m.store?.name ?? null,
        city: m.store?.city ?? null,
        phone: m.store?.phone ?? null,
        contactName: m.store?.contactName ?? null,
        profitPerDayOre: ppd,
        vsMedianBp:
          median !== null && median > 0 ? Math.round(((ppd - median) * 10_000) / median) : null,
        emptySlots: m.emptyTitleIds.length,
        power: m.store?.power ?? null,
      };
    })
    .sort((a, b) => a.profitPerDayOre - b.profitPerDayOre || a.code.localeCompare(b.code));
  return { rows, medianProfitPerDayOre: median };
}
