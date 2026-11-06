/**
 * Förslag på pristester, alltid märkta som experiment.
 *
 * Ett pristest ändrar priset för en titel i hälften av automaterna (test) och behåller det i
 * resten (kontroll) under `testDays` dagar. Efteråt mäts effekten med `priceChangeEffect`
 * med test- och kontrollautomaterna (difference-in-differences), se `evaluation`.
 *
 * Regler:
 * 1. Underlag: titelns order de senaste `lookbackDays` dagarna till och med `asOf`.
 * 2. Titeln kommer i fråga när
 *    - den sålts i minst 2 automater,
 *    - bidraget per pack (nettointäkt − inköp − kortavgift − provision) är känt och > 0,
 *    - väntat antal pack per grupp under testet, pack × testDays / lookbackDays / 2, är minst
 *      `minUnitsPerArm` (annars går effekten inte att skilja från slumpen),
 *    - priset inte ändrats de senaste `quietDays` dagarna (`detectPriceChanges`).
 * 3. Riktning: titlar som säljer minst lika mycket som medianen bland kandidaterna testas
 *    med höjt pris (efterfrågan tål det troligen). Övriga testas med sänkt pris om bidraget per
 *    pack är minst 2 × steget, annars med höjt pris.
 * 4. Nytt bidrag per pack räknas om med domänens regler (`orderEconomics`) för varje order med
 *    beloppet ± steget: moms, kortavgift och provision följer det nya priset.
 *    Brytpunkt: volymfaktor = Σ bidrag nu / Σ nytt bidrag. Höjning lönar sig om försäljningen
 *    minskar mindre än (1 − faktor); sänkning om den ökar mer än (faktor − 1).
 * 5. Fördelning: automaterna sorteras på sålda pack (flest först, sedan id) och delas
 *    test, kontroll, kontroll, test, … (ABBA), så att grupperna blir ungefär lika stora.
 * 6. Ordning: bidrag per vecka som berörs (Σ bidrag × 7 / lookbackDays), störst först.
 */

import {
  addDays,
  assertIsoDate,
  createEconomicsContext,
  storeShareDeducted,
  orderEconomics,
  type EconomicsSources,
  type OrderLine,
  type Period,
} from "@/domain";
import { fig, Ratio } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { krExact, periodText, plural } from "../todos/text";
import {
  bpOf,
  compareStrings,
  listText,
  marketEvidence,
  modalAmount,
  pctAbs,
  tenthsOf,
  tenthsText,
  type MarketEvidence,
  intOption,
} from "./common";
import type { NamedRef } from "./market";
import { median } from "./robust";
import { detectPriceChanges } from "./price-changes";

/** Indata till `proposePriceTests`. */
export interface PriceTestInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  /** Sista dag med data. Testet börjar dagen efter. */
  readonly asOf: string;
  readonly titles?: readonly NamedRef[];
  readonly machines?: readonly NamedRef[];
  /** Underlagets längd i dagar. Standard 28. */
  readonly lookbackDays?: number;
  /** Prissteg i öre (inkl. moms). Standard 500 (5 kr). */
  readonly stepOre?: number;
  /** Testets längd i dagar. Standard 28. */
  readonly testDays?: number;
  /** Minsta väntade antal pack per grupp. Standard 30. */
  readonly minUnitsPerArm?: number;
  /** Dagar utan prisändring före testet. Standard 90. */
  readonly quietDays?: number;
  /** Högst så många förslag. Standard 3. */
  readonly maxTests?: number;
}

/** Hur ett test utvärderas: indata till `priceChangeEffect`. */
export interface PriceTestEvaluation {
  readonly titleId: string;
  readonly changeDate: string;
  readonly windowDays: number;
  readonly testMachineIds: readonly string[];
  readonly controlMachineIds: readonly string[];
}

/** Ett förslag på pristest. */
export interface PriceTestProposal {
  /** Stabil nyckel 'price-test:<titel>:<riktning>:<startdag>'. */
  readonly key: string;
  /** Alltid sant: ett förslag på experiment, inte en rekommendation att ändra priset. */
  readonly experiment: true;
  readonly label: "Experiment";
  readonly titleId: string;
  readonly direction: "up" | "down";
  readonly fromOre: number;
  readonly toOre: number;
  readonly testMachineIds: readonly string[];
  readonly controlMachineIds: readonly string[];
  readonly period: Period;
  /** Sålda pack per vecka i underlaget, i tiondelar. */
  readonly unitsPerWeekTenths: number;
  readonly contributionPerPackOre: number;
  readonly newContributionPerPackOre: number;
  /**
   * Volymändring där bidraget blir oförändrat, i bp. Negativ vid höjning (största tillåtna
   * minskning), positiv vid sänkning (minsta nödvändiga ökning).
   */
  readonly breakEvenVolumeChangeBp: number;
  /** Väntade pack i testgruppen respektive kontrollgruppen under testet. */
  readonly expectedTestUnits: number;
  readonly expectedControlUnits: number;
  /** Bidrag per vecka som berörs, i öre. */
  readonly weeklyContributionOre: number;
  readonly evaluation: PriceTestEvaluation;
  readonly text: string;
  readonly evidence: MarketEvidence;
}

interface Candidate {
  titleId: string;
  orders: OrderLine[];
  units: number;
  byMachine: Map<string, number>;
  price: number;
  contributionSum: bigint;
  pricedCount: number;
}

/** Förslag på pristester enligt modulens regler. Tom lista när ingen titel uppfyller villkoren. */
export function proposePriceTests(input: PriceTestInput): PriceTestProposal[] {
  assertIsoDate(input.asOf, "Sista dag med data");
  const lookbackDays = intOption(input.lookbackDays, 28, "Underlagets längd", 1);
  const stepOre = intOption(input.stepOre, 500, "Prissteget", 1);
  const testDays = intOption(input.testDays, 28, "Testets längd", 1);
  const minUnitsPerArm = intOption(input.minUnitsPerArm, 30, "Minsta antal pack per grupp", 0);
  const quietDays = intOption(input.quietDays, 90, "Dagar utan prisändring", 0);
  const maxTests = intOption(input.maxTests, 3, "Antal förslag", 0);
  const titleName = nameLookup(input.titles ?? []);
  const machineName = nameLookup(input.machines ?? []);
  const ctx = createEconomicsContext(input);
  // Provisionen dras bara när vyn drar butikernas andel (@/domain storeShareDeducted).
  const share = (commissionOre: number) => (storeShareDeducted(input.settings) ? commissionOre : 0);

  const window: Period = { start: addDays(input.asOf, -(lookbackDays - 1)), end: input.asOf };
  const recentChange = new Set(
    detectPriceChanges(input.orders.filter((o) => o.businessDate <= input.asOf))
      .filter((c) => c.date > addDays(input.asOf, -quietDays))
      .map((c) => c.titleId),
  );

  const byTitle = new Map<string, OrderLine[]>();
  for (const o of input.orders) {
    if (o.machineId === null || o.businessDate < window.start || o.businessDate > window.end)
      continue;
    const list = byTitle.get(o.titleId);
    if (list) list.push(o);
    else byTitle.set(o.titleId, [o]);
  }

  const candidates: Candidate[] = [];
  for (const titleId of [...byTitle.keys()].sort(compareStrings)) {
    if (recentChange.has(titleId)) continue;
    const orders = byTitle.get(titleId)!;
    const byMachine = new Map<string, number>();
    let contributionSum = 0n;
    let pricedCount = 0;
    for (const o of orders) {
      byMachine.set(o.machineId!, (byMachine.get(o.machineId!) ?? 0) + 1);
      const e = orderEconomics(o, ctx);
      if (e.costOre === null) continue;
      contributionSum += BigInt(
        e.netRevenueOre - e.costOre - e.cardFeeOre - share(e.commissionOre),
      );
      pricedCount++;
    }
    if (byMachine.size < 2 || pricedCount === 0 || contributionSum <= 0n) continue;
    const perArm = new Ratio(orders.length * testDays, lookbackDays * 2);
    if (perArm.compare(new Ratio(minUnitsPerArm)) < 0) continue;
    candidates.push({
      titleId,
      orders,
      units: orders.length,
      byMachine,
      price: modalAmount(orders)!,
      contributionSum,
      pricedCount,
    });
  }
  if (candidates.length === 0) return [];
  const medianUnits = median(candidates.map((c) => c.units))!;

  const proposals: PriceTestProposal[] = [];
  for (const c of candidates) {
    const avgContribution = new Ratio(c.contributionSum, c.pricedCount);
    let direction: "up" | "down" = "up";
    if (
      new Ratio(c.units).compare(medianUnits) < 0 &&
      avgContribution.compare(new Ratio(2 * stepOre)) >= 0
    ) {
      direction = "down";
    }
    const delta = direction === "up" ? stepOre : -stepOre;
    if (c.price + delta <= 0) continue;
    let newSum = 0n;
    let feasible = true;
    for (const o of c.orders) {
      const amount = o.amountOre + delta;
      if (amount < 0) {
        feasible = false;
        break;
      }
      const e = orderEconomics({ ...o, amountOre: amount }, ctx);
      if (e.costOre === null) continue;
      newSum += BigInt(e.netRevenueOre - e.costOre - e.cardFeeOre - share(e.commissionOre));
    }
    if (!feasible || newSum <= 0n) continue;
    const factor = new Ratio(c.contributionSum, newSum);
    const breakEvenVolumeChangeBp = bpOf(factor.sub(new Ratio(1)));

    const machines = [...c.byMachine.entries()].sort(
      (a, b) => b[1] - a[1] || compareStrings(a[0], b[0]),
    );
    const test: string[] = [];
    const control: string[] = [];
    machines.forEach(([m], i) => (i % 4 === 0 || i % 4 === 3 ? test : control).push(m));
    const unitsIn = (ids: string[]) => ids.reduce((s, m) => s + (c.byMachine.get(m) ?? 0), 0);
    const scale = (u: number) => new Ratio(u * testDays, lookbackDays).round();
    const period: Period = { start: addDays(input.asOf, 1), end: addDays(input.asOf, testDays) };
    const unitsPerWeekTenths = tenthsOf(new Ratio(c.units * 7, lookbackDays));
    const weeklyContributionOre = new Ratio(c.contributionSum * 7n, BigInt(lookbackDays)).round();
    const toOre = c.price + delta;
    const contributionPerPackOre = avgContribution.round();
    const newContributionPerPackOre = new Ratio(newSum, c.pricedCount).round();
    const duration =
      testDays % 7 === 0
        ? plural(testDays / 7, "vecka", "veckor")
        : plural(testDays, "dag", "dagar");
    const name = titleName(c.titleId);
    const verb = direction === "up" ? "höj" : "sänk";
    const breakEvenText =
      direction === "up"
        ? `Höjningen lönar sig om försäljningen minskar mindre än ${pctAbs(breakEvenVolumeChangeBp)}.`
        : `Sänkningen lönar sig om försäljningen ökar mer än ${pctAbs(breakEvenVolumeChangeBp)}.`;
    proposals.push({
      key: `price-test:${c.titleId}:${direction}:${period.start}`,
      experiment: true,
      label: "Experiment",
      titleId: c.titleId,
      direction,
      fromOre: c.price,
      toOre,
      testMachineIds: [...test].sort(compareStrings),
      controlMachineIds: [...control].sort(compareStrings),
      period,
      unitsPerWeekTenths,
      contributionPerPackOre,
      newContributionPerPackOre,
      breakEvenVolumeChangeBp,
      expectedTestUnits: scale(unitsIn(test)),
      expectedControlUnits: scale(unitsIn(control)),
      weeklyContributionOre,
      evaluation: {
        titleId: c.titleId,
        changeDate: period.start,
        windowDays: testDays,
        testMachineIds: [...test].sort(compareStrings),
        controlMachineIds: [...control].sort(compareStrings),
      },
      text: `Experiment: ${verb} ${name} från ${krExact(c.price)} till ${krExact(toOre)} i ${listText(test.map(machineName))} under ${duration} (${periodText(period)}); ${listText(control.map(machineName))} behåller ${krExact(c.price)} som kontroll. ${breakEvenText} Titeln säljer ${tenthsText(unitsPerWeekTenths)} pack/vecka med ${krExact(contributionPerPackOre)} kvar per pack (${krExact(newContributionPerPackOre)} med nytt pris).`,
      evidence: marketEvidence({
        rule: "Pristest: titlar sålda i minst 2 automater med känt bidrag, tillräcklig volym och utan prisändring nyligen. Brytpunkt = Σ bidrag nu / Σ bidrag med nytt pris.",
        period: window,
        orderIds: c.orders.map((o) => o.id),
        titleIds: [c.titleId],
        machineIds: machines.map(([m]) => m),
        figures: [
          fig("units", "Sålda pack i underlaget", c.units, "packs"),
          fig("lookbackDays", "Underlagets längd", lookbackDays, "days"),
          fig("fromOre", "Pris nu", c.price, "ore"),
          fig("toOre", "Testpris", toOre, "ore"),
          fig("contributionPerPackOre", "Bidrag per pack nu", contributionPerPackOre, "ore"),
          fig(
            "newContributionPerPackOre",
            "Bidrag per pack med testpris",
            newContributionPerPackOre,
            "ore",
          ),
          fig("breakEvenVolumeChangeBp", "Brytpunkt för volymen", breakEvenVolumeChangeBp, "bp"),
        ],
      }),
    });
  }
  return proposals
    .sort(
      (a, b) =>
        b.weeklyContributionOre - a.weeklyContributionOre || compareStrings(a.titleId, b.titleId),
    )
    .slice(0, maxTests);
}
