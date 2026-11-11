/**
 * Veckans form per automat: hur stor del av veckans försäljning som faller på varje veckodag.
 *
 * En automat i en butik säljer inte lika mycket varje dag: helgen är ofta dubbelt så stark.
 * Med formen säger sellOut() "tar slut på lördag" när det platta snittet säger måndag.
 *
 *   form = sålda pack per veckodag de senaste 28 dagarna (fyra hela veckor t.o.m. `asOf`),
 *          alla titlar i automaten tillsammans, delat med summan
 *
 * Alltid exakt 28 dagar: fyra av varje veckodag, och samma fönster överallt. Att göra (45
 * dagar i laddningen), larmen (70) och besöksplanen får då samma form och samma dag.
 *
 * Ingen form (null → platt snitt, `basis: 'flat'`) när
 *   - automaten har under 28 dagars försäljning: den har inte sålt i var och en av fönstrets
 *     fyra veckor (ny automat, eller en som stått still), eller är aktiv först inom fönstret
 *     (`activeFrom`),
 *   - automaten har sålt färre än `minUnits` pack i fönstret (för lite att se en form i),
 *   - indatat inte täcker hela fönstret (weekShapes: en laddning med bara de senaste dagarnas
 *     order får aldrig en form som bygger på halva fönstret).
 * Reglerna tittar bara på det som ligger i fönstret, så att alla laddningar som täcker det
 * får exakt samma svar.
 *
 * Rena funktioner: ingen databas, ingen klocka.
 */

import { addDays, dayOfWeek, daysBetween, type IsoDate } from "@/domain";

import type { WeekShare } from "./index";

/** Dagar i fönstret: fyra hela veckor. */
export const WEEK_SHAPE_DAYS = 28;

/** Minst så här många sålda pack i fönstret, annars platt snitt. */
export const WEEK_SHAPE_MIN_UNITS = 20;

/** En såld rad: det formen behöver av en order. En order är ett pack (som domain.dailyUnits). */
export interface ShapeSale {
  readonly machineId: string | null;
  readonly businessDate: IsoDate;
}

export interface WeekShapeOptions {
  /** Sista dagen i fönstret (i går: dagens försäljning är inte klar). */
  readonly asOf: IsoDate;
  /** Dagen automaten togs i drift, om känd. */
  readonly activeFrom?: IsoDate | null;
  readonly minUnits?: number;
}

/** Första dagen i fönstret: 28 dagar t.o.m. `asOf`. */
export function weekShapeStart(asOf: IsoDate): IsoDate {
  return addDays(asOf, -(WEEK_SHAPE_DAYS - 1));
}

/**
 * Formen för EN automat ur dess försäljning (alla titlar). Förutsätter att `sales` täcker
 * hela fönstret (se weekShapes). Dagar utanför fönstret räknas inte.
 *
 * weekShape(sales, { asOf }) → [0.1, 0.1, 0.1, 0.1, 0.14, 0.3, 0.16]  (måndag först)
 */
export function weekShape(
  sales: readonly Pick<ShapeSale, "businessDate">[],
  options: WeekShapeOptions,
): WeekShare | null {
  const start = weekShapeStart(options.asOf);
  if (options.activeFrom && options.activeFrom > start) return null;
  let total = 0;
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  const perWeek = [0, 0, 0, 0];
  for (const s of sales) {
    if (s.businessDate < start || s.businessDate > options.asOf) continue;
    perDay[dayOfWeek(s.businessDate) - 1]! += 1;
    perWeek[Math.floor(daysBetween(start, s.businessDate) / 7)]! += 1;
    total += 1;
  }
  // Under 28 dagars försäljning: någon av de fyra veckorna är tom.
  if (perWeek.some((n) => n === 0)) return null;
  if (total < (options.minUnits ?? WEEK_SHAPE_MIN_UNITS)) return null;
  return perDay.map((u) => u / total) as unknown as WeekShare;
}

/**
 * Formen per automat (bara de som har en). Automater utan form saknas i svaret.
 *
 * `covered`: täcker `sales` hela fönstret? Utelämnad: ja om någon order (vilken automat som
 * helst) ligger före fönstrets första dag, vilket visar att laddningen går längre bak än
 * fönstret. En laddning med bara 15 dagars order ger därför inga former.
 */
export function weekShapes(
  sales: readonly ShapeSale[],
  options: {
    readonly asOf: IsoDate;
    readonly machines?: readonly { readonly id: string; readonly activeFrom?: IsoDate | null }[];
    readonly minUnits?: number;
    readonly covered?: boolean;
  },
): Map<string, WeekShare> {
  const out = new Map<string, WeekShare>();
  const start = weekShapeStart(options.asOf);
  const covered = options.covered ?? sales.some((s) => s.businessDate < start);
  if (!covered) return out;
  const byMachine = new Map<string, ShapeSale[]>();
  for (const s of sales) {
    if (s.machineId === null || s.businessDate < start || s.businessDate > options.asOf) continue;
    const list = byMachine.get(s.machineId);
    if (list) list.push(s);
    else byMachine.set(s.machineId, [s]);
  }
  const activeFrom = new Map((options.machines ?? []).map((m) => [m.id, m.activeFrom ?? null]));
  for (const [machineId, list] of byMachine) {
    const shape = weekShape(list, {
      asOf: options.asOf,
      activeFrom: activeFrom.get(machineId) ?? null,
      ...(options.minUnits !== undefined ? { minUnits: options.minUnits } : {}),
    });
    if (shape) out.set(machineId, shape);
  }
  return out;
}
