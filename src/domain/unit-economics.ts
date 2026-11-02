/**
 * Enhetsekonomi per automat: vinst per månad, investering, linjär avskrivning och
 * återbetalningstid.
 *
 * Vinst per månad:
 *   Automatens vinst i perioden (prissatta order, efter inköp, avgifter, provision och
 *   fördelad hyra; samma siffra som i lönsamhetsvyn per automat) delat med antalet
 *   aktiva månader. Aktiva månader = Σ över kalendermånader (aktiva dagar / dagar i
 *   månaden), där en dag är aktiv om automaten var placerad i en butik. Saknar automaten
 *   placeringar räknas hela perioden. Bråket räknas exakt (gemensam nämnare 377 580 =
 *   MGM av 28, 29, 30 och 31), så en hel kalendermånad är exakt 1.
 *
 * Avskrivning (linjär, per investering):
 *   månadsavskrivning   = round(belopp / avskrivningsmånader)
 *   ackumulerad          = round(belopp × min(hela månader sedan investeringen, avskrivningstid) / avskrivningstid)
 *   bokfört värde        = belopp − ackumulerad
 *
 * Återbetalningstid (månader, en decimal) = investering / vinst per månad.
 * `null` när vinsten per månad är ≤ 0.
 */

import { assertIsoDate, daysInMonth, eachDay, monthsElapsed } from "./dates";
import { DomainError } from "./errors";
import { buildLedger } from "./ledger";
import { assertNonNegativeInteger, checkSafe, roundHalfUp } from "./money";
import type { IsoDate, MachineInvestment, ProfitabilityInput } from "./types";

/** Minsta gemensamma multipel av 28, 29, 30 och 31. */
export const MONTH_LCM = 377_580;

/** Indata: lönsamhetens indata plus investeringar. */
export interface UnitEconomicsInput extends ProfitabilityInput {
  readonly investments: readonly MachineInvestment[];
  /** Dag för bokfört värde och avskrivning. Standard: periodens slut. */
  readonly asOf?: IsoDate;
  /** Automater som ska med även utan försäljning. */
  readonly machineIds?: readonly string[];
}

/** Enhetsekonomi för en automat. Belopp i öre. */
export interface MachineUnitEconomics {
  readonly machineId: string;
  readonly orders: number;
  readonly unpricedOrders: number;
  /** Nettointäkt (prissatta order). */
  readonly revenueOre: number;
  /** Vinst i perioden före avskrivning (täckningsbidrag). */
  readonly profitOre: number;
  readonly activeDays: number;
  /** Aktiva månader (för visning; räkningen görs exakt). */
  readonly activeMonths: number;
  /** Vinst per aktiv månad, före avskrivning. `null` om automaten inte varit aktiv. */
  readonly profitPerMonthOre: number | null;
  /** Investeringar gjorda senast `asOf`. */
  readonly investmentOre: number;
  /** Avskrivning per månad för investeringar som fortfarande skrivs av `asOf`. */
  readonly monthlyDepreciationOre: number;
  readonly accumulatedDepreciationOre: number;
  readonly bookValueOre: number;
  /** Vinst per månad efter avskrivning. */
  readonly profitPerMonthAfterDepreciationOre: number | null;
  /** Investering / vinst per månad, en decimal. 0 utan investering, `null` om vinsten ≤ 0. */
  readonly paybackMonths: number | null;
}

/** Linjär avskrivning för en investering per `asOf`. */
export function depreciation(
  investment: MachineInvestment,
  asOf: IsoDate,
): { monthlyOre: number; accumulatedOre: number; bookValueOre: number; monthsElapsed: number } {
  assertNonNegativeInteger(investment.amountOre, "Investeringens belopp");
  assertIsoDate(investment.date, "Investeringens datum");
  assertIsoDate(asOf);
  const months = investment.depreciationMonths ?? 0;
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new DomainError(
      "invalid_input",
      `Avskrivningstiden måste vara hela månader, fick ${months}.`,
    );
  }
  const elapsed = Math.max(0, monthsElapsed(investment.date, asOf));
  if (months === 0) {
    return {
      monthlyOre: 0,
      accumulatedOre: 0,
      bookValueOre: investment.amountOre,
      monthsElapsed: elapsed,
    };
  }
  const used = Math.min(elapsed, months);
  const accumulated = roundHalfUp(BigInt(investment.amountOre) * BigInt(used), BigInt(months));
  return {
    monthlyOre: used < months ? roundHalfUp(investment.amountOre, months) : 0,
    accumulatedOre: accumulated,
    bookValueOre: investment.amountOre - accumulated,
    monthsElapsed: elapsed,
  };
}

/** Enhetsekonomi per automat, sorterad på automat-id. */
export function unitEconomics(input: UnitEconomicsInput): MachineUnitEconomics[] {
  const ledger = buildLedger(input);
  const asOf = input.asOf ?? input.period.end;
  assertIsoDate(asOf, "Datum för bokfört värde");
  const placements = ledger.context.placements;
  const days = eachDay(input.period.start, input.period.end);

  const ids = new Set<string>(input.machineIds ?? []);
  for (const inv of input.investments) ids.add(inv.machineId);
  for (const e of ledger.entries) if (e.order.machineId !== null) ids.add(e.order.machineId);

  const stats = new Map<
    string,
    { orders: number; unpriced: number; revenue: number; profit: number }
  >();
  for (const e of ledger.entries) {
    const id = e.order.machineId;
    if (id === null) continue;
    let s = stats.get(id);
    if (!s) {
      s = { orders: 0, unpriced: 0, revenue: 0, profit: 0 };
      stats.set(id, s);
    }
    s.orders++;
    if (!e.priced) {
      s.unpriced++;
      continue;
    }
    s.revenue += e.netRevenueOre;
    s.profit += e.netRevenueOre - e.costOre - e.cardFeeOre - e.commissionOre - e.rentOre;
  }

  const out: MachineUnitEconomics[] = [];
  for (const machineId of [...ids].sort()) {
    const s = stats.get(machineId) ?? { orders: 0, unpriced: 0, revenue: 0, profit: 0 };
    const profit = checkSafe(s.profit, "Vinsten");

    // Aktiva dagar och månadsekvivalenter (täljare över MONTH_LCM).
    const hasPlacements = placements.placementsFor(machineId).length > 0;
    let activeDays = 0;
    let monthUnits = 0;
    for (const d of days) {
      if (hasPlacements && placements.storeOn(machineId, d) === null) continue;
      activeDays++;
      monthUnits += MONTH_LCM / daysInMonth(d);
    }

    let investment = 0;
    let monthlyDep = 0;
    let accumulated = 0;
    for (const inv of input.investments) {
      if (inv.machineId !== machineId || inv.date > asOf) continue;
      const dep = depreciation(inv, asOf);
      investment += inv.amountOre;
      monthlyDep += dep.monthlyOre;
      accumulated += dep.accumulatedOre;
    }
    checkSafe(investment, "Investeringen");

    const perMonth =
      monthUnits === 0 ? null : roundHalfUp(BigInt(profit) * BigInt(MONTH_LCM), BigInt(monthUnits));
    let payback: number | null;
    if (investment === 0) payback = 0;
    else if (monthUnits === 0 || profit <= 0) payback = null;
    else {
      // investering / (vinst × LCM / enheter), i tiondels månader.
      const tenths = roundHalfUp(
        BigInt(investment) * 10n * BigInt(monthUnits),
        BigInt(profit) * BigInt(MONTH_LCM),
      );
      payback = tenths / 10;
    }

    out.push({
      machineId,
      orders: s.orders,
      unpricedOrders: s.unpriced,
      revenueOre: checkSafe(s.revenue, "Intäkten"),
      profitOre: profit,
      activeDays,
      activeMonths: Math.round((monthUnits * 100) / MONTH_LCM) / 100,
      profitPerMonthOre: perMonth,
      investmentOre: investment,
      monthlyDepreciationOre: monthlyDep,
      accumulatedDepreciationOre: accumulated,
      bookValueOre: investment - accumulated,
      profitPerMonthAfterDepreciationOre: perMonth === null ? null : perMonth - monthlyDep,
      paybackMonths: payback,
    });
  }
  return out;
}
