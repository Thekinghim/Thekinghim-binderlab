/**
 * Pengar och Hem (G4): vinst per stad och automat för vald period. Vinsten per automat är
 * Lönsamhets rader (profitability per automat), förra perioden samma beräkning på
 * jämförelseperiodens indata. Staden är butikens stad i dag (flottans läge).
 */

import "server-only";

import { profitability } from "@/domain";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadFleetState } from "@/server/data/v2/fleet";

import { loadMoneyProfit, moneyKey } from "./money-base";
import { profitByCity, type CityProfit, type MachineProfit } from "./money-model";

export interface MoneyGeo {
  readonly cities: readonly CityProfit[];
  readonly totalOre: number;
  readonly machines: number;
}

export async function loadMoneyGeo(sp: SearchParamsInput): Promise<MoneyGeo | null> {
  const [data, fleet] = await Promise.all([loadMoneyProfit(moneyKey(sp)), loadFleetState()]);
  if (!data) return null;
  const cityOf = new Map(fleet.machines.map((m) => [m.id, m.store?.city ?? null]));
  const previous = new Map<string, number>();
  if (data.p.key !== "idag" && data.input.previous && data.input.previous.orders.length > 0) {
    for (const r of profitability(data.input.previous, "machine").rows) {
      if (r.kind === "item") previous.set(r.key, r.profitOre);
    }
  }
  const machines: MachineProfit[] = data.model.views.machine
    .filter((l) => l.kind === "item")
    .map((l) => ({
      machineId: l.key,
      code: l.code,
      name: l.name,
      city: cityOf.get(l.key) ?? null,
      profitOre: l.profitOre,
      previousProfitOre: previous.get(l.key) ?? null,
    }));
  return {
    cities: profitByCity(machines),
    totalOre: machines.reduce((a, m) => a + m.profitOre, 0),
    machines: machines.length,
  };
}
