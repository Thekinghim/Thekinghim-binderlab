/**
 * Flottans läge (V2, byggplanen 3.1): ren sammanställning av en rad per aktiv automat ur
 * laddarnas data. Ingen databas här (fleet.ts laddar), så att reglerna kan testas.
 *
 *   status  = fleetStatusOf (@/analytics/fleet-status): offline (maskinhälsan, aldrig när strömmen
 *             är av enligt schemat), tom, fyll på i dag, startklar, ström av, tom om N d, i drift
 *   pack    = lagret i appen per titel, annars Awish-läsningen (machineFill, samma som Fyll på);
 *             kapacitet och tomma fack ur Awish (stock_locations.awish_fill)
 *   takt    = sålda pack de 14 hela dagarna t.o.m. i går (som besöksplanen)
 *   tom om  = pack ÷ takt
 *   förlust = lossProfitPerDayOre (bara ekonomiroller)
 */

import {
  compareFleetRows,
  daysLeftOf,
  FLEET_STATUS_TONE,
  fleetStatusLabel,
  fleetStatusOf,
  lossProfitPerDayOre,
  machineFill,
  outTitleIdsOf,
  PACE_WINDOW_DAYS,
  unitsPerDayMilli,
  type AwishFillRow,
  type FleetStatus,
} from "@/analytics/fleet-status";
import { isPowerOffAt, type PowerHours } from "@/analytics/health/power";
import { assortmentKey, retiredPairs, type SlotPeriod } from "@/analytics/todos/assortment";
import { isMachineActive } from "@/analytics/todos/common";
import { addDays, type IsoDate } from "@/domain";
import { DEFAULT_MACHINE_LOOK, type MachineLook } from "@/lib/machine-look";

import type { FleetMachine, FleetState, FleetStore } from "./types";

export interface FleetMachineInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeId: string | null;
  readonly activeFrom: IsoDate | null;
  readonly activeTo: IsoDate | null;
  readonly archived?: boolean;
  /** Utseende (machines.appearance). Saknas = svart med stjärnor. */
  readonly appearance?: MachineLook;
}

export interface FleetEconomyInput {
  readonly rows: ReadonlyMap<
    string,
    {
      readonly profitPerDayOre: number | null;
      readonly vsMedianOre: number | null;
      readonly verdict: string | null;
      readonly unitsPerDayTenths?: number | null;
    }
  >;
  readonly medianProfitPerDayOre: number | null;
}

export interface FleetInput {
  readonly today: IsoDate;
  readonly now: Date;
  readonly timeZone: string;
  readonly machines: readonly FleetMachineInput[];
  readonly stores: ReadonlyMap<string, FleetStore>;
  /** Maskinhälsan: offline (och sedan när). Bara status "offline" räknas. */
  readonly health: ReadonlyMap<string, { readonly status: string; readonly since: string | null }>;
  /** Strömtider per automat (butikens). */
  readonly power: ReadonlyMap<string, PowerHours>;
  /** Awish-facken per automat (null = inte läst). */
  readonly fills: ReadonlyMap<string, readonly AwishFillRow[] | null>;
  /** Lagret i appen per automat och titel (när Awish-läsning saknas). */
  readonly stock: readonly {
    readonly machineId: string;
    readonly titleId: string;
    readonly onHand: number;
  }[];
  /** Försäljningen (en rad per sålt pack). */
  readonly sales: readonly {
    readonly machineId: string | null;
    readonly titleId: string;
    readonly businessDate: IsoDate;
  }[];
  readonly lastRefill: ReadonlyMap<string, string>;
  /** Nya automater med steg kvar (bara ägare och admin får något här). */
  readonly startklar: ReadonlySet<string>;
  /** null för roller utan ekonomi: inga öre i svaret. */
  readonly economy: FleetEconomyInput | null;
  /**
   * Sortimentet (lager_slot_periods): titlarna i automaten i dag och de som gått ur, för
   * regeln om slut titlar (outTitleIdsOf). Utelämnat = inget känt sortiment.
   */
  readonly slotPeriods?: readonly SlotPeriod[];
}

const STATUSES: readonly FleetStatus[] = [
  "offline",
  "tom",
  "fyll-pa",
  "startklar",
  "strom-av",
  "tom-snart",
  "i-drift",
];

export function buildFleetState(input: FleetInput): FleetState {
  const { today, now, timeZone } = input;
  const rateStart = addDays(today, -PACE_WINDOW_DAYS);
  const rateEnd = addDays(today, -1);
  const sparkStart = addDays(today, -29);

  // Sålt per automat (takt), per automat och titel (tomma fack), per automat och dag (linjen).
  const sold = new Map<string, number>();
  const soldTitle = new Map<string, number>();
  const daily = new Map<string, Map<IsoDate, number>>();
  for (const s of input.sales) {
    if (!s.machineId) continue;
    if (s.businessDate >= rateStart && s.businessDate <= rateEnd) {
      sold.set(s.machineId, (sold.get(s.machineId) ?? 0) + 1);
      const k = `${s.machineId}:${s.titleId}`;
      soldTitle.set(k, (soldTitle.get(k) ?? 0) + 1);
    }
    if (s.businessDate >= sparkStart && s.businessDate <= today) {
      const m = daily.get(s.machineId) ?? new Map<IsoDate, number>();
      m.set(s.businessDate, (m.get(s.businessDate) ?? 0) + 1);
      daily.set(s.machineId, m);
    }
  }
  const stockUnits = new Map<string, number>();
  const ledger = new Map<string, Map<string, number>>();
  for (const s of input.stock) {
    stockUnits.set(s.machineId, (stockUnits.get(s.machineId) ?? 0) + Math.max(0, s.onHand));
    const m = ledger.get(s.machineId) ?? new Map<string, number>();
    m.set(s.titleId, (m.get(s.titleId) ?? 0) + s.onHand);
    ledger.set(s.machineId, m);
  }
  const days30: IsoDate[] = Array.from({ length: 30 }, (_, i) => addDays(sparkStart, i));
  // Sortimentet per automat: i dag och utgånget (samma som Fyll på).
  const periods = input.slotPeriods ?? [];
  const retired = retiredPairs(periods, today);
  const current = new Map<string, Set<string>>();
  const retiredBy = new Map<string, Set<string>>();
  for (const p of periods) {
    if (retired.has(assortmentKey(p.machineId, p.titleId))) {
      const r = retiredBy.get(p.machineId) ?? new Set<string>();
      r.add(p.titleId);
      retiredBy.set(p.machineId, r);
    } else if (p.validFrom <= today && (p.validTo === null || p.validTo >= today)) {
      const c = current.get(p.machineId) ?? new Set<string>();
      c.add(p.titleId);
      current.set(p.machineId, c);
    }
  }
  const soldBy = new Map<string, Set<string>>();
  for (const k of soldTitle.keys()) {
    const [machineId, titleId] = k.split(":") as [string, string];
    const set = soldBy.get(machineId) ?? new Set<string>();
    set.add(titleId);
    soldBy.set(machineId, set);
  }
  const none: ReadonlySet<string> = new Set();

  const machines: FleetMachine[] = input.machines
    .filter((m) => isMachineActive({ ...m, archived: m.archived ?? false }, today))
    .map((m) => {
      // Samma regel som Fyll på (machineFill): lagret i appen per titel, annars Awish.
      const fill = machineFill(input.fills.get(m.id) ?? null, ledger.get(m.id));
      const units = fill ? fill.units : stockUnits.has(m.id) ? stockUnits.get(m.id)! : null;
      const perDay = unitsPerDayMilli(sold.get(m.id) ?? 0);
      const daysLeft = units === null ? null : daysLeftOf(units, perDay);
      const power = input.power.get(m.id) ?? null;
      const powerOffNow = isPowerOffAt(power, now.getTime());
      const health = input.health.get(m.id);
      const offline = health?.status === "offline";
      // Slut titlar (0 pack), även utan Awish-läsning: samma regel som Fyll på.
      const outTitleIds = outTitleIdsOf({
        awish: input.fills.get(m.id) ?? null,
        ledger: ledger.get(m.id),
        sold: soldBy.get(m.id) ?? none,
        current: current.get(m.id) ?? none,
        retired: retiredBy.get(m.id) ?? none,
      });
      const status = fleetStatusOf({
        offline,
        powerOff: powerOffNow,
        startklar: input.startklar.has(m.id),
        units,
        fillBp: fill?.fillBp ?? null,
        emptyChannels: fill?.emptyChannels ?? 0,
        outTitles: outTitleIds.length,
        daysLeft,
      });
      // Titlar med tomt fack (Awish) eller slut (0 pack).
      const emptyTitleIds = [...new Set([...(fill?.emptyTitleIds ?? []), ...outTitleIds])].sort();
      const eco = input.economy;
      const row = eco?.rows.get(m.id);
      const economy = eco
        ? {
            profitPerDayOre: row?.profitPerDayOre ?? null,
            vsMedianOre: row?.vsMedianOre ?? null,
            verdict: row?.verdict ?? null,
            lossProfitPerDayOre: lossProfitPerDayOre({
              status,
              profitPerDayOre: row?.profitPerDayOre ?? null,
              unitsPerDayMilli: perDay,
              medianProfitPerDayOre: eco.medianProfitPerDayOre,
              daysLeft,
              emptyTitles: emptyTitleIds.map((t) => ({
                unitsPerDayMilli: unitsPerDayMilli(soldTitle.get(`${m.id}:${t}`) ?? 0),
              })),
            }),
          }
        : null;
      const series = daily.get(m.id);
      return {
        id: m.id,
        code: m.code,
        name: m.name,
        appearance: m.appearance ?? DEFAULT_MACHINE_LOOK,
        store: m.storeId ? (input.stores.get(m.storeId) ?? null) : null,
        status,
        statusLabel: fleetStatusLabel(status, daysLeft),
        tone: FLEET_STATUS_TONE[status],
        fill,
        units,
        unitsPerDayMilli: perDay,
        daysLeft,
        lastRefillAt: input.lastRefill.get(m.id) ?? null,
        sales30: days30.map((d) => series?.get(d) ?? 0),
        powerOffNow,
        offlineSince: offline ? (health?.since ?? null) : null,
        emptyTitleIds,
        economy,
      };
    })
    .sort(compareFleetRows);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<FleetStatus, number>;
  for (const m of machines) counts[m.status] += 1;

  return {
    today,
    now: now.toISOString(),
    timeZone,
    machines,
    counts,
    economy: input.economy !== null,
    // Bara med ekonomi: annars finns inga öre-fält alls i svaret (red-team-testerna).
    ...(input.economy ? { medianProfitPerDayOre: input.economy.medianProfitPerDayOre } : {}),
  };
}
