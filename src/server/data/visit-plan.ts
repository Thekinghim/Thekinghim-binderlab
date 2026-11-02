/**
 * Besöksplanen för veckan, gemensam för /lager och /drift (och /drift/besok), så att de
 * alltid föreslår samma besöksdagar.
 *
 * Planeraren är @/analytics/visits (`planVisits`). Här bestäms bara de gemensamma valen:
 *
 *   takt     = de 14 hela dagarna t.o.m. i går (`planNow`), samma fönster som matrisen på
 *              Lager och påfyllningsregeln i Att göra; dagens försäljning är redan dragen
 *              från saldot men räknas inte i takten (dagen är inte slut)
 *   saldo    = lagret just nu (`stockDate: today`): till ett besök i dag dras ingen
 *              försäljning, till ett besök i morgon en dags, osv. Samma packlista som Lager
 *   start    = i dag; besöksdagar mån–fre
 *   automater = de som är i drift i dag
 *   extra    = automater med misstänkt fel, fel eller ur drift (maskinhälsan, samma som
 *              Drift visar) ska besökas i dag
 *
 * Ren modul utan databas, så att Lagers vymodell kan använda den direkt.
 */

import type { MachineHealth } from "@/analytics/health";
import { isMachineActive } from "@/analytics/todos/common";
import { businessDateAt } from "@/analytics/todos/time";
import type { AnalyticsOrder, StockLevelRef, TitleRef } from "@/analytics/todos/types";
import { planVisits, type ExtraVisit, type VisitMachine, type VisitPlan } from "@/analytics/visits";
import { addDays, type IsoDate } from "@/domain";

/**
 * Tidpunkten planen räknar från: mitt på dagen `asOf` (i går) i tidszonen, så att planens
 * "i dag" blir `asOf` och fönstret för takten slutar där, precis som påfyllningsregeln.
 */
export function planNow(asOf: IsoDate, timeZone: string, now: Date): Date {
  for (const hour of ["12", "00", "22"]) {
    const at = new Date(`${asOf}T${hour}:00:00Z`);
    if (businessDateAt(at, timeZone) === asOf) return at;
  }
  return new Date(now.getTime() - 24 * 3_600_000);
}

/** Extra besök ur maskinhälsan: misstänkt fel, fel och ur drift ska besökas i dag. */
export function extraVisitsFromHealth(
  health: readonly Pick<MachineHealth, "machineId" | "status">[],
  today: IsoDate,
): ExtraVisit[] {
  const reason: Partial<Record<MachineHealth["status"], string>> = {
    offline: "Ur drift",
    fault: "Fel rapporterat",
    suspected_fault: "Misstänkt fel",
  };
  return health
    .filter((h) => reason[h.status])
    .map((h) => ({ machineId: h.machineId, reason: reason[h.status] as string, needBy: today }));
}

export interface WeeklyPlanInput {
  readonly orders: readonly AnalyticsOrder[];
  readonly machines: readonly VisitMachine[];
  readonly titles: readonly TitleRef[];
  /** Saldo i automaterna just nu. */
  readonly stock: readonly StockLevelRef[];
  /** Saldo i centrallagret, eller null när organisationen saknar centrallager. */
  readonly warehouseStock: readonly { titleId: string; onHand: number }[] | null;
  /** Maskinhälsan (som på Drift). null/utelämnad = inga extra besök. */
  readonly health?: readonly Pick<MachineHealth, "machineId" | "status">[] | null;
  /** Dagens affärsdatum i tidszonen. */
  readonly today: IsoDate;
  readonly timeZone: string;
  readonly now: Date;
}

/** Veckans besöksplan, likadan på Lager och Drift. */
export function weeklyVisitPlan(input: WeeklyPlanInput): VisitPlan {
  const { today, timeZone, now } = input;
  return planVisits(
    {
      orders: input.orders,
      machines: input.machines.filter((m) => isMachineActive(m, today)),
      titles: input.titles,
      stock: input.stock,
      ...(input.warehouseStock ? { warehouseStock: input.warehouseStock } : {}),
      extraVisits: input.health ? extraVisitsFromHealth(input.health, today) : [],
      options: { timeZone, start: today, stockDate: today },
    },
    planNow(addDays(today, -1), timeZone, now),
  );
}
