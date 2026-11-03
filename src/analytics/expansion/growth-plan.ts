/**
 * Plan för fler automater: vad en ny automat ger och kostar, och vad det betyder vid N
 * automater (vinst, inköp, kapital, arbetstid) månad för månad fram till målet.
 *
 * Underlaget är flottans riktiga siffror per automat (domänens enhetsekonomi, samma vinst
 * per månad som Enhetsekonomi och Lönsamhet). Allt i heltal: öre, minuter, tiondels
 * månader. Avrundning halva bort från noll (domänens roundHalfUp).
 *
 * Regler:
 * - Med i underlaget: automater med minst `minActiveDays` dagar (standard 14). Finns
 *   ingen sådan räknas alla automater med minst en dag.
 * - Vinst per ny automat = medianen av automaternas vinst per månad; spannet är lägsta
 *   och högsta. Pack och inköp per månad = medianen av automatens pack / inköp per
 *   aktiv dag × 1461/48 (snittmånadens 30,4375 dagar).
 * - Kapital per ny automat = automatpris + startlager. Startlager utan värde = en
 *   månads inköp (medianen ovan).
 * - Återbetalning = kapital / vinst per månad, i tiondels månader.
 * - Tidslinjen: varje månad köps `perMonth` automater tills målet nås. En automat som
 *   köps en månad ger vinst från månaden efter. Kassan börjar på 0 och är Σ vinst
 *   − Σ köp; största minus är vad som behöver lånas eller skjutas till.
 * - Med vinsten (utan lån): varje månad köps så många automater som kassan räcker till.
 * - Påfyllningstid över 10 h per automat och vecka (sparad eller mätt) används inte
 *   (`refillIgnored`); då gäller nästa källa eller förvalet 45 min.
 * - Arbetstid = automater × minuter per automat och vecka, delat på personerna. Hjälp
 *   behövs från den automat där tiden per person blir mer än personernas tid.
 */

import { addMonths, roundHalfUp, type IsoMonth } from "@/domain";

/** Snittmånadens dagar som bråk: 365,25 / 12 = 1461 / 48. */
const MONTH_DAYS_NUM = 1461;
const MONTH_DAYS_DEN = 48;

/** Över så många minuter påfyllning per automat och vecka (10 h) används värdet inte. */
export const MAX_REFILL_MINUTES_PER_MACHINE_WEEK = 600;

/** Längsta plan (månader) innan vi ger upp om målet. */
export const GROWTH_PLAN_MAX_MONTHS = 120;

/** Standardval när inget sparats. */
export const GROWTH_PLAN_DEFAULTS = {
  targetMachines: 20,
  people: 2,
  hoursPerPersonWeek: 10,
  refillMinutesPerMachineWeek: 45,
  /** Målet på så många månader när takten inte är vald. */
  monthsToTarget: 12,
  minActiveDays: 14,
} as const;

/** En automats siffror i underlaget (från enhetsekonomin). */
export interface GrowthMachine {
  readonly machineId: string;
  readonly name: string;
  readonly activeDays: number;
  /** Vinst per aktiv månad före avskrivning (domänen). null = inte aktiv. */
  readonly profitPerMonthOre: number | null;
  /** Sålda pack (order) i perioden. */
  readonly orders: number;
  /** Inköp (kostnad för sålda pack) i perioden. */
  readonly costOre: number;
}

/** Val i planen. null = standard. */
export interface GrowthPlanSettings {
  readonly targetMachines: number;
  /** Automat inklusive installation. null = snittet av registrerade investeringar. */
  readonly machinePriceOre: number | null;
  /** Startlager per automat. null = en månads inköp. */
  readonly startStockOre: number | null;
  /** Nya automater per månad. null = målet på 12 månader. */
  readonly perMonth: number | null;
  /** Påfyllning per automat och vecka (inklusive resa). null = mätt eller 45 min. */
  readonly refillMinutesPerMachineWeek: number | null;
  readonly people: number;
  readonly hoursPerPersonWeek: number;
}

export interface GrowthPlanInput {
  readonly machinesNow: number;
  readonly machines: readonly GrowthMachine[];
  readonly settings: GrowthPlanSettings;
  /** Första månaden nya automater kan köpas (oftast nästa månad). */
  readonly startMonth: IsoMonth;
  /** Förval när inget är sparat. */
  readonly fallbacks: {
    /** Snittinvesteringen per automat, eller null. */
    readonly machinePriceOre: number | null;
    /** Mätt påfyllningstid per automat och vecka, eller null. */
    readonly refillMinutesPerMachineWeek: number | null;
  };
  readonly minActiveDays?: number;
}

/** Ett värde och varifrån det kommer. */
export type Source = "saved" | "data" | "default";

export interface GrowthPlanMonth {
  readonly month: IsoMonth;
  /** Automater i slutet av månaden. */
  readonly machines: number;
  /** Köpta denna månad. */
  readonly added: number;
  /** Vinst denna månad (automater som fanns vid månadens början). */
  readonly profitOre: number;
  /** Kassa i slutet av månaden: Σ vinst − Σ köp sedan start. */
  readonly cashOre: number;
  /** Påfyllning per person och vecka vid månadens slut. */
  readonly minutesPerPersonWeek: number;
  /** Mer tid än personerna har. */
  readonly needsHelp: boolean;
}

export interface GrowthPlan {
  readonly status: "ok" | "no-data";
  readonly machinesNow: number;
  readonly target: number;
  readonly toAdd: number;
  /** Automater i underlaget. */
  readonly basis: { readonly machineIds: string[]; readonly names: string[] };
  /** Vinst per ny automat och månad: median, lägsta, högsta. null utan underlag. */
  readonly profitPerMonthOre: {
    readonly median: number;
    readonly low: number;
    readonly high: number;
  } | null;
  readonly packsPerMonth: number | null;
  readonly purchasePerMonthOre: number | null;
  readonly machinePriceOre: number | null;
  readonly machinePriceSource: Source;
  readonly startStockOre: number | null;
  readonly startStockSource: Source;
  /** Automatpris + startlager. null utan automatpris. */
  readonly capitalPerMachineOre: number | null;
  /** Återbetalning i tiondels månader (median, lägsta och högsta vinsten). */
  readonly paybackTenths: {
    readonly median: number | null;
    readonly fastest: number | null;
    readonly slowest: number | null;
  };
  readonly perMonth: number;
  readonly perMonthSource: Source;
  readonly refillMinutesPerMachineWeek: number;
  readonly refillSource: Source;
  /**
   * Ett värde för påfyllningen som inte användes för att det är orimligt högt (över
   * MAX_REFILL_MINUTES_PER_MACHINE_WEEK): det sparade valet eller mätningen. null = inget.
   */
  readonly refillIgnored: { readonly minutes: number; readonly source: "saved" | "data" } | null;
  readonly people: number;
  readonly hoursPerPersonWeek: number;
  /** Vid målet. */
  readonly atTarget: {
    readonly machines: number;
    readonly profitPerMonthOre: number | null;
    readonly packsPerMonth: number | null;
    readonly purchasePerMonthOre: number | null;
    readonly capitalOre: number | null;
    readonly minutesPerWeek: number;
    readonly minutesPerPersonWeek: number;
    /** Personer som behövs med `hoursPerPersonWeek` var. */
    readonly peopleNeeded: number;
  };
  /** Första antalet automater där personerna inte hinner. null = hinner hela vägen. */
  readonly helpFrom: number | null;
  /** Månaden då hjälp behövs enligt tidslinjen. */
  readonly helpMonth: IsoMonth | null;
  readonly timeline: GrowthPlanMonth[];
  /** Månaden målet nås. null = redan nått eller går inte. */
  readonly targetMonth: IsoMonth | null;
  /** Största minus i kassan (≥ 0) och när. */
  readonly peakFundingOre: number;
  readonly peakFundingMonth: IsoMonth | null;
  /** Första månaden efter största minus då kassan är ≥ 0 igen. */
  readonly cashPositiveMonth: IsoMonth | null;
  /** Med vinsten (utan lån): månaden målet nås, null om aldrig inom 10 år. */
  readonly selfFundedTargetMonth: IsoMonth | null;
}

function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid]! : roundHalfUp(v[mid - 1]! + v[mid]!, 2);
}

/** Per aktiv dag → per snittmånad. */
function perMonthOf(total: number, days: number): number {
  return roundHalfUp(total * MONTH_DAYS_NUM, days * MONTH_DAYS_DEN);
}

/** Kapital / vinst per månad i tiondels månader. null när vinsten ≤ 0. */
export function paybackTenthsOf(capitalOre: number, profitPerMonthOre: number): number | null {
  if (profitPerMonthOre <= 0) return null;
  return roundHalfUp(capitalOre * 10, profitPerMonthOre);
}

/** Takten som når målet på `months` månader: ⌈kvar / months⌉, minst 1. */
export function defaultPerMonth(toAdd: number, months: number): number {
  if (toAdd <= 0) return 1;
  return Math.max(1, Math.ceil(toAdd / months));
}

/** Första antalet automater där tiden inte räcker. null = räcker upp till `upTo`. */
export function helpFromCount(
  refillMinutes: number,
  people: number,
  hoursPerPerson: number,
  upTo: number,
): number | null {
  if (refillMinutes <= 0) return null;
  const capacity = people * hoursPerPerson * 60;
  // Största N med N × minuter ≤ kapacitet; hjälp från N + 1.
  const n = Math.floor(capacity / refillMinutes) + 1;
  return n <= upTo ? Math.max(1, n) : null;
}

export function growthPlan(input: GrowthPlanInput): GrowthPlan {
  const s = input.settings;
  const minDays = input.minActiveDays ?? GROWTH_PLAN_DEFAULTS.minActiveDays;
  const active = input.machines.filter((m) => m.activeDays > 0 && m.profitPerMonthOre !== null);
  const settled = active.filter((m) => m.activeDays >= minDays);
  const basis = (settled.length > 0 ? settled : active)
    .slice()
    .sort((a, b) => (a.machineId < b.machineId ? -1 : 1));

  const profits = basis.map((m) => m.profitPerMonthOre!);
  const profit =
    profits.length === 0
      ? null
      : { median: median(profits), low: Math.min(...profits), high: Math.max(...profits) };
  const packs =
    basis.length === 0 ? null : median(basis.map((m) => perMonthOf(m.orders, m.activeDays)));
  const purchase =
    basis.length === 0 ? null : median(basis.map((m) => perMonthOf(m.costOre, m.activeDays)));

  const machinePriceSource: Source =
    s.machinePriceOre !== null
      ? "saved"
      : input.fallbacks.machinePriceOre !== null
        ? "data"
        : "default";
  const machinePrice = s.machinePriceOre ?? input.fallbacks.machinePriceOre;
  const startStockSource: Source =
    s.startStockOre !== null ? "saved" : purchase !== null ? "data" : "default";
  const startStock = s.startStockOre ?? purchase;
  const capital = machinePrice === null ? null : machinePrice + (startStock ?? 0);

  const payback = {
    median: capital !== null && profit ? paybackTenthsOf(capital, profit.median) : null,
    fastest: capital !== null && profit ? paybackTenthsOf(capital, profit.high) : null,
    slowest: capital !== null && profit ? paybackTenthsOf(capital, profit.low) : null,
  };

  const target = Math.max(1, s.targetMachines);
  const now = Math.max(0, input.machinesNow);
  const toAdd = Math.max(0, target - now);
  const perMonthSource: Source = s.perMonth !== null ? "saved" : "default";
  const perMonth = Math.max(
    1,
    s.perMonth ?? defaultPerMonth(toAdd, GROWTH_PLAN_DEFAULTS.monthsToTarget),
  );
  // Rimlighetskontroll: mer än 10 h per automat och vecka är nästan alltid ett felinmatat
  // värde (t.ex. minuter i stället för timmar). Det används inte; planen säger till.
  const plausible = (v: number | null) =>
    v !== null && v > 0 && v <= MAX_REFILL_MINUTES_PER_MACHINE_WEEK ? v : null;
  const savedRefill = plausible(s.refillMinutesPerMachineWeek);
  const dataRefill = plausible(input.fallbacks.refillMinutesPerMachineWeek);
  const refillIgnored: GrowthPlan["refillIgnored"] =
    s.refillMinutesPerMachineWeek !== null && savedRefill === null
      ? { minutes: s.refillMinutesPerMachineWeek, source: "saved" }
      : savedRefill === null &&
          input.fallbacks.refillMinutesPerMachineWeek !== null &&
          dataRefill === null
        ? { minutes: input.fallbacks.refillMinutesPerMachineWeek, source: "data" }
        : null;
  const refillSource: Source =
    savedRefill !== null ? "saved" : dataRefill !== null ? "data" : "default";
  const refill = savedRefill ?? dataRefill ?? GROWTH_PLAN_DEFAULTS.refillMinutesPerMachineWeek;
  const people = Math.max(1, s.people);
  const hours = Math.max(1, s.hoursPerPersonWeek);
  const capacity = people * hours * 60;
  const perPerson = (n: number) => roundHalfUp(n * refill, people);
  const goal = Math.max(target, now);

  // Tidslinjen med vald takt.
  const timeline: GrowthPlanMonth[] = [];
  let machines = now;
  let cash = 0;
  let peak = 0;
  let peakMonth: IsoMonth | null = null;
  let targetMonth: IsoMonth | null = null;
  let helpMonth: IsoMonth | null = null;
  if (toAdd > 0) {
    for (let i = 0; i < GROWTH_PLAN_MAX_MONTHS && machines < target; i++) {
      const month = addMonths(input.startMonth, i);
      const earned = profit ? machines * profit.median : 0;
      const added = Math.min(perMonth, target - machines);
      machines += added;
      cash += earned - added * (capital ?? 0);
      if (-cash > peak) {
        peak = -cash;
        peakMonth = month;
      }
      const minutes = perPerson(machines);
      const needsHelp = machines * refill > capacity;
      if (needsHelp && helpMonth === null) helpMonth = month;
      timeline.push({
        month,
        machines,
        added,
        profitOre: earned,
        cashOre: cash,
        minutesPerPersonWeek: minutes,
        needsHelp,
      });
      if (machines >= target) targetMonth = month;
    }
  }

  // När kassan är plus igen efter största minus (alla automater på plats).
  let cashPositiveMonth: IsoMonth | null = null;
  if (peak > 0 && profit && profit.median > 0 && targetMonth !== null) {
    const after = timeline.findIndex((t) => t.month === peakMonth);
    cashPositiveMonth = timeline.slice(after + 1).find((t) => t.cashOre >= 0)?.month ?? null;
    let c = cash;
    let month = targetMonth;
    for (let i = 0; cashPositiveMonth === null && i < GROWTH_PLAN_MAX_MONTHS; i++) {
      month = addMonths(month, 1);
      c += machines * profit.median;
      if (c >= 0) cashPositiveMonth = month;
    }
  }

  // Med vinsten: köp när kassan räcker.
  let selfFundedTargetMonth: IsoMonth | null = null;
  if (toAdd > 0 && capital !== null && profit && profit.median > 0 && now > 0) {
    let m = now;
    let c = 0;
    for (let i = 0; i < GROWTH_PLAN_MAX_MONTHS; i++) {
      c += m * profit.median;
      const buy = capital === 0 ? target - m : Math.min(target - m, Math.floor(c / capital));
      m += buy;
      c -= buy * capital;
      if (m >= target) {
        selfFundedTargetMonth = addMonths(input.startMonth, i);
        break;
      }
    }
  }

  const status = profit === null ? "no-data" : "ok";
  return {
    status,
    machinesNow: now,
    target,
    toAdd,
    basis: { machineIds: basis.map((m) => m.machineId), names: basis.map((m) => m.name) },
    profitPerMonthOre: profit,
    packsPerMonth: packs,
    purchasePerMonthOre: purchase,
    machinePriceOre: machinePrice,
    machinePriceSource,
    startStockOre: startStock,
    startStockSource,
    capitalPerMachineOre: capital,
    paybackTenths: payback,
    perMonth,
    perMonthSource,
    refillMinutesPerMachineWeek: refill,
    refillSource,
    refillIgnored,
    people,
    hoursPerPersonWeek: hours,
    atTarget: {
      machines: goal,
      profitPerMonthOre: profit ? goal * profit.median : null,
      packsPerMonth: packs === null ? null : goal * packs,
      purchasePerMonthOre: purchase === null ? null : goal * purchase,
      capitalOre: capital === null ? null : toAdd * capital,
      minutesPerWeek: goal * refill,
      minutesPerPersonWeek: perPerson(goal),
      peopleNeeded: Math.max(1, Math.ceil((goal * refill) / (hours * 60))),
    },
    helpFrom: helpFromCount(refill, people, hours, goal),
    helpMonth,
    timeline,
    targetMonth,
    peakFundingOre: peak,
    peakFundingMonth: peakMonth,
    cashPositiveMonth,
    selfFundedTargetMonth,
  };
}

/**
 * Påfyllning per automat och vecka från ett mätvärde "tid för påfyllning per månad"
 * (minuter, hela organisationen) och antalet automater då: minuter × 12 / 52 / automater.
 */
export function refillMinutesFromMonthly(monthlyMinutes: number, machines: number): number | null {
  if (machines <= 0 || monthlyMinutes <= 0) return null;
  return Math.max(1, roundHalfUp(monthlyMinutes * 12, 52 * machines));
}
