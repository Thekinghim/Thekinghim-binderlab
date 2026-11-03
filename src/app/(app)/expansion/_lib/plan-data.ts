/**
 * Planen för fler automater: laddar flottans riktiga siffror (de senaste 90 dagarna med
 * data, samma enhetsekonomi som Enhetsekonomi och Lönsamhet), sparade förval och
 * effektmätningen av påfyllningstiden, och räknar med @/analytics/expansion (growthPlan).
 */

import "server-only";

import {
  compareUnitEconomics,
  growthPlan,
  refillMinutesFromMonthly,
  type GrowthMachine,
  type GrowthPlan,
} from "@/analytics/expansion";
import {
  addDays,
  addMonths,
  maxDate,
  monthOf,
  profitability,
  type IsoDate,
  type Period,
} from "@/domain";
import { dataCoverage, loadDataStart, loadDomainInput, requireRoute } from "@/server/data/core";

import { defaultInvestment } from "./model";
import { loadGrowthPlanFor, loadMeasurementsFor, type GrowthPlanRecord } from "./service";
import { currentViewer } from "./session";

/** Underlagets längd i dagar. */
export const PLAN_WINDOW_DAYS = 90;

export interface GrowthPlanPageData {
  readonly canEdit: boolean;
  readonly today: IsoDate;
  /** Perioden siffrorna per automat kommer från. null = ingen data än. */
  readonly basisPeriod: Period | null;
  readonly saved: GrowthPlanRecord;
  readonly plan: GrowthPlan;
}

/** Underlagsperioden: 90 dagar t.o.m. sista dagen med data, tidigast första ordern. */
export function planWindow(today: IsoDate, dataStart: IsoDate | null): Period | null {
  if (dataStart === null || dataStart > today) return null;
  const end = today;
  return { start: maxDate(dataStart, addDays(end, -(PLAN_WINDOW_DAYS - 1))), end };
}

export async function loadGrowthPlanPage(): Promise<GrowthPlanPageData> {
  const ctx = await requireRoute("expansion");
  const viewer = await currentViewer();
  const [dataStart, saved, measurements] = await Promise.all([
    loadDataStart(),
    loadGrowthPlanFor(viewer),
    loadMeasurementsFor(viewer),
  ]);
  const window = planWindow(ctx.today, dataStart);
  const input = await loadDomainInput({ period: window ?? { start: ctx.today, end: ctx.today } });

  const live = input.machines.filter((m) => !m.archived);
  const machinesNow = live.filter((m) => m.storeId !== null).length;

  let machines: GrowthMachine[] = [];
  let basisPeriod: Period | null = null;
  if (window) {
    const machineIds = live.map((m) => m.id).sort();
    const ueInput = { ...input.current, investments: input.investments, machineIds };
    // Sista dagen med data: i går när dagens order inte kommit (samma regel som Enhetsekonomi).
    const covered = dataCoverage(
      window,
      dataStart,
      ctx.today,
      input.current.orders.some((o) => o.businessDate === ctx.today),
    );
    basisPeriod = covered ?? window;
    const comparison = compareUnitEconomics(
      ueInput,
      input.machines.map((m) => ({ id: m.id, name: m.name })),
      covered ? { lastDataDay: covered.end } : {},
    );
    const cost = new Map(
      profitability(input.current, "machine")
        .rows.filter((r) => r.kind === "item")
        .map((r) => [r.key, r.costOre]),
    );
    const archived = new Set(input.machines.filter((m) => m.archived).map((m) => m.id));
    machines = comparison.rows
      .filter((r) => !archived.has(r.machineId))
      .map((r) => ({
        machineId: r.machineId,
        name: r.name,
        activeDays: r.activeDays,
        profitPerMonthOre: r.profitPerMonthOre,
        // Sålda pack med inköpspris: samma order som vinsten bygger på.
        orders: r.orders - r.unpricedOrders,
        costOre: cost.get(r.machineId) ?? 0,
      }));
  }

  // Påfyllningstiden: senaste mätningen för hela organisationen (Effekt), per automat och vecka.
  const refill = measurements
    .filter((m) => m.metric === "refill_hours_month" && m.scope === "organization")
    .sort((a, b) => (a.month < b.month ? 1 : -1))[0];
  const inv = defaultInvestment(input.investments, ctx.today);

  const plan = growthPlan({
    machinesNow,
    machines,
    settings: {
      targetMachines: saved.targetMachines,
      machinePriceOre: saved.machinePriceOre,
      startStockOre: saved.startStockOre,
      perMonth: saved.machinesPerMonth,
      refillMinutesPerMachineWeek: saved.refillMinutesPerMachineWeek,
      people: saved.people,
      hoursPerPersonWeek: saved.hoursPerPersonWeek,
    },
    startMonth: addMonths(monthOf(ctx.today), 1),
    fallbacks: {
      machinePriceOre: inv?.totalOre ?? null,
      refillMinutesPerMachineWeek: refill
        ? refillMinutesFromMonthly(refill.value, machinesNow)
        : null,
    },
  });

  return { canEdit: ctx.canEdit, today: ctx.today, basisPeriod, saved, plan };
}
