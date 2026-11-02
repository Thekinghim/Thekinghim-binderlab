/**
 * Enhetsekonomi sida vid sida: intäkt och vinst per dag, vinst per månad,
 * återbetalningstid och avkastning för varje automat.
 *
 * Allt bygger på domänens `unitEconomics` (samma vinst som lönsamhetsvyn per automat,
 * samma aktiva dagar och samma återbetalningstid). Här läggs till:
 *
 * - intäkt per dag = intäkt (prissatta order) / aktiva dagar, avrundat
 * - vinst per dag  = vinst före avskrivning / aktiva dagar, avrundat
 * - avkastning per år = vinst per månad × 12 / investering, bp (`null` utan investering),
 *   med samma funktion (`annualReturnBp`) som uppskattningen för nya platser
 * - underlaget för varje automat pekar ut periodens order och försäljningsdagar
 * - jämförelse mot flottans snitt: snittet är Σ vinst / Σ aktiva dagar (viktat efter
 *   automatdagar), och avvikelsen är round((automatens − snittet) × 10 000 / |snittet|) bp
 * - rang efter vinst per dag (1 = bäst; lika → lägst id). Automater utan aktiva dagar får ingen rang.
 */

import {
  buildLedger,
  changeBp,
  roundHalfUp,
  unitEconomics,
  type MachineUnitEconomics,
  type Period,
  type UnitEconomicsInput,
} from "@/domain";
import { nameLookup } from "../todos/common";
import { kr, tenths } from "../todos/text";
import { fig, orderTrail, Ratio, scenarioEvidence, signedPct, type ScenarioEvidence } from "./common";
import { annualReturnBp } from "./estimate";

/** En automat i jämförelsen. */
export interface UnitEconomicsComparisonRow {
  readonly machineId: string;
  readonly name: string;
  readonly activeDays: number;
  readonly orders: number;
  readonly unpricedOrders: number;
  /** Intäkt och vinst (före avskrivning) i perioden, prissatta order. */
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly revenuePerDayOre: number | null;
  readonly profitPerDayOre: number | null;
  /** Från domänen: vinst per aktiv månad före avskrivning. */
  readonly profitPerMonthOre: number | null;
  readonly profitPerMonthAfterDepreciationOre: number | null;
  readonly investmentOre: number;
  readonly bookValueOre: number;
  /** Återbetalningstid i tiondels månader. `null` utan investering eller när vinsten ≤ 0. */
  readonly paybackTenths: number | null;
  /** Vinst per år / investering, bp. `null` utan investering. */
  readonly annualReturnBp: number | null;
  /** Vinst per dag mot flottans snitt, bp. `null` när snittet är 0 eller automaten saknar dagar. */
  readonly vsAverageBp: number | null;
  /** 1 = mest vinst per dag. `null` utan aktiva dagar. */
  readonly rank: number | null;
  /** T.ex. "Automat 1: 290 kr vinst per dag, återbetald på 7,2 månader". */
  readonly text: string;
  readonly evidence: ScenarioEvidence;
}

/** Hela jämförelsen. */
export interface UnitEconomicsComparison {
  readonly period: Period;
  readonly rows: UnitEconomicsComparisonRow[];
  /** Flottans snitt per automat och dag (viktat efter automatdagar). `null` utan aktiva dagar. */
  readonly averageRevenuePerDayOre: number | null;
  readonly averageProfitPerDayOre: number | null;
  /** Automaten med mest vinst per dag. */
  readonly bestMachineId: string | null;
  readonly text: string;
  readonly evidence: ScenarioEvidence;
}

function perDay(total: number, days: number): number | null {
  return days === 0 ? null : roundHalfUp(total, days);
}

function paybackTenthsOf(u: MachineUnitEconomics): number | null {
  if (u.investmentOre === 0 || u.paybackMonths === null) return null;
  // Domänen ger månader med en decimal (t.ex. 7.2); tillbaka till heltal tiondelar.
  return Math.round(u.paybackMonths * 10);
}

/**
 * Enhetsekonomin för alla automater i perioden, sida vid sida, sorterad efter rang
 * (bäst först; automater utan aktiva dagar sist, i id-ordning).
 */
export function compareUnitEconomics(
  input: UnitEconomicsInput,
  machines: readonly { id: string; name: string }[] = [],
): UnitEconomicsComparison {
  const units = unitEconomics(input);
  const entries = buildLedger(input).entries;
  const nameOf = nameLookup(machines);

  let totalDays = 0;
  let totalProfit = 0;
  let totalRevenue = 0;
  for (const u of units) {
    totalDays += u.activeDays;
    totalProfit += u.profitOre;
    totalRevenue += u.revenueOre;
  }
  const avgProfit = perDay(totalProfit, totalDays);
  const avgRevenue = perDay(totalRevenue, totalDays);

  const ranked = units
    .filter((u) => u.activeDays > 0)
    .map((u) => ({ id: u.machineId, profitPerDay: perDay(u.profitOre, u.activeDays)! }))
    .sort((a, b) =>
      a.profitPerDay !== b.profitPerDay ? b.profitPerDay - a.profitPerDay : a.id < b.id ? -1 : 1,
    );
  const rankOf = new Map(ranked.map((r, i) => [r.id, i + 1]));

  const rows: UnitEconomicsComparisonRow[] = units.map((u) => {
    const name = nameOf(u.machineId);
    const revenuePerDay = perDay(u.revenueOre, u.activeDays);
    const profitPerDay = perDay(u.profitOre, u.activeDays);
    const payback = paybackTenthsOf(u);
    const annual =
      u.profitPerMonthOre === null
        ? null
        : annualReturnBp(u.investmentOre, new Ratio(u.profitPerMonthOre));
    const vsAverage =
      profitPerDay === null || avgProfit === null ? null : changeBp(profitPerDay, avgProfit);

    let text: string;
    if (profitPerDay === null) text = `${name}: inga aktiva dagar i perioden`;
    else {
      const paybackPart =
        u.investmentOre === 0
          ? "ingen investering registrerad"
          : payback === null
            ? "återbetalas inte med nuvarande vinst"
            : `återbetald på ${tenths(payback)} månader`;
      text = `${name}: ${kr(profitPerDay)} vinst per dag, ${paybackPart}`;
    }

    return {
      machineId: u.machineId,
      name,
      activeDays: u.activeDays,
      orders: u.orders,
      unpricedOrders: u.unpricedOrders,
      revenueOre: u.revenueOre,
      profitOre: u.profitOre,
      revenuePerDayOre: revenuePerDay,
      profitPerDayOre: profitPerDay,
      profitPerMonthOre: u.profitPerMonthOre,
      profitPerMonthAfterDepreciationOre: u.profitPerMonthAfterDepreciationOre,
      investmentOre: u.investmentOre,
      bookValueOre: u.bookValueOre,
      paybackTenths: payback,
      annualReturnBp: annual,
      vsAverageBp: vsAverage,
      rank: rankOf.get(u.machineId) ?? null,
      text,
      evidence: scenarioEvidence({
        rule: "Vinst före avskrivning (prissatta order, efter inköp, avgifter, provision och hyra) delat med dagar då automaten var placerad. Återbetalningstid = investering / vinst per månad.",
        period: input.period,
        machineIds: [u.machineId],
        ...orderTrail(entries, { machineId: u.machineId }),
        figures: [
          fig("revenueOre", "Intäkt i perioden", u.revenueOre, "ore"),
          fig("profitOre", "Vinst i perioden", u.profitOre, "ore"),
          fig("activeDays", "Aktiva dagar", u.activeDays, "days"),
          fig("orders", "Order", u.orders, "count"),
          fig("unpricedOrders", "Order utan inköpspris", u.unpricedOrders, "count"),
          fig("investmentOre", "Investering", u.investmentOre, "ore"),
          ...(payback === null
            ? []
            : [fig("paybackTenths", "Återbetalningstid (tiondels månader)", payback, "tenths")]),
        ],
      }),
    };
  });

  rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.machineId < b.machineId ? -1 : 1;
  });

  const best = rows[0]?.rank === 1 ? rows[0] : null;
  let text: string;
  if (!best || best.profitPerDayOre === null || avgProfit === null) {
    text = "Ingen automat var placerad under perioden.";
  } else if (ranked.length === 1) {
    text = `${best.name} ger ${kr(best.profitPerDayOre)} vinst per dag.`;
  } else {
    text = `${best.name} ger mest vinst per dag: ${kr(best.profitPerDayOre)} mot snittet ${kr(avgProfit)}${
      best.vsAverageBp === null ? "" : ` (${signedPct(best.vsAverageBp)})`
    }.`;
  }

  return {
    period: input.period,
    rows,
    averageRevenuePerDayOre: avgRevenue,
    averageProfitPerDayOre: avgProfit,
    bestMachineId: best?.machineId ?? null,
    text,
    evidence: scenarioEvidence({
      rule: "Flottans snitt = Σ vinst / Σ aktiva automatdagar. Rang efter vinst per dag.",
      period: input.period,
      machineIds: units.map((u) => u.machineId),
      ...orderTrail(entries),
      figures: [
        fig("totalProfitOre", "Vinst, alla automater", totalProfit, "ore"),
        fig("machineDays", "Aktiva automatdagar", totalDays, "days"),
        ...(avgProfit === null
          ? []
          : [fig("averageProfitPerDayOre", "Snitt vinst per automat och dag", avgProfit, "ore")]),
      ],
    }),
  };
}
