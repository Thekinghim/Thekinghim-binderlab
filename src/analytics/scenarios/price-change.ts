/**
 * Scenario "prisändring": vad händer med vinsten om priset på en titel ändras med N kr?
 *
 * Enkel känslighetsanalys på periodens prissatta order av titeln:
 *
 * 1. Varje order räknas om med det nya beloppet (belopp + N) genom domänens
 *    `orderEconomics`: moms, kortavgift och provision följer det nya priset enligt samma
 *    regler som i lönsamheten. Inköpet är oförändrat.
 *    Bidrag per order = nettointäkt − inköp − avgift − provision.
 * 2. Volymen ändras med en antagen priselasticitet e (i hundradelar: −150 = −1,5):
 *      volymfaktor = 1 + e × N / snittpris = (100 × Σ belopp + e × N × antal) / (100 × Σ belopp)
 *    Faktorn blir aldrig negativ. Standard e = 0: lika många pack säljs.
 * 3. Nytt bidrag = Σ nytt bidrag per order × volymfaktor, avrundat en gång.
 *    Hyran är en fast kostnad och ändras inte av priset, så
 *      vinständring = nytt bidrag − nuvarande bidrag.
 * 4. Brytpunkten är den volymändring (och elasticitet) där vinsten blir oförändrad:
 *      faktor* = nuvarande bidrag / nytt bidrag per order summerat.
 *
 * Order utan inköpspris ingår inte (de ingår inte i vinsten). Ett pris som blir negativt
 * kastar `DomainError('invalid_input')`.
 */

import {
  BP_SCALE,
  buildLedger,
  changeBp,
  DomainError,
  orderEconomics,
  roundHalfUp,
  type Period,
  type ProfitabilityInput,
} from "@/domain";
import { kr, krExact, periodText, plural, sentence } from "../todos/text";
import {
  fig,
  hundredths,
  Ratio,
  scenarioEvidence,
  signedPct,
  type ScenarioEvidence,
} from "../expansion/common";

/** Standardtabell: elasticitet 0; −0,5; −1; −1,5; −2 (hundradelar). */
export const DEFAULT_ELASTICITIES: readonly number[] = [0, -50, -100, -150, -200];

/** Indata till `priceChangeScenario`. */
export interface PriceChangeScenarioInput extends ProfitabilityInput {
  readonly titleId: string;
  /** Titelns namn i texterna. Standard: id. */
  readonly titleName?: string;
  /** Prisändring per pack i öre, inklusive eventuell moms (+1 000 = 10 kr dyrare). */
  readonly deltaOre: number;
  /** Antagen priselasticitet i hundradelar. Standard 0 (oförändrad volym). */
  readonly elasticityHundredths?: number;
  /** Elasticiteter i tabellen (hundradelar). Standard `DEFAULT_ELASTICITIES`; den valda läggs alltid till. */
  readonly elasticities?: readonly number[];
}

/** Utfallet för en elasticitet. */
export interface PriceChangeRow {
  readonly elasticityHundredths: number;
  /** Volymändring i bp (−1 500 = 15 % färre pack). */
  readonly volumeChangeBp: number;
  readonly units: number;
  readonly revenueOre: number;
  /** Bidrag efter inköp, avgifter och provision. */
  readonly contributionOre: number;
  /** Bidrag − titelns andel av hyran (oförändrad). */
  readonly profitOre: number;
  readonly profitChangeOre: number;
  /** Vinständring i bp av nuvarande vinst. `null` när nuvarande vinst är 0. */
  readonly profitChangeBp: number | null;
}

/** Nuläget för titeln i perioden (prissatta order). */
export interface PriceChangeBase {
  readonly units: number;
  readonly grossOre: number;
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly commissionOre: number;
  readonly contributionOre: number;
  readonly rentOre: number;
  readonly profitOre: number;
}

/** Resultatet. */
export interface PriceChangeScenario {
  readonly kind: "scenario";
  /** 'no-data' när titeln saknar prissatta order i perioden. */
  readonly status: "ok" | "no-data";
  readonly titleId: string;
  readonly titleName: string;
  readonly period: Period;
  readonly deltaOre: number;
  readonly unpricedOrders: number;
  /** Snittpris per pack (betalt belopp) före och efter. `null` utan order. */
  readonly averagePriceOre: number | null;
  readonly newAveragePriceOre: number | null;
  /** Prisändring i bp av snittpriset. `null` när snittpriset är 0. */
  readonly priceChangeBp: number | null;
  /** Bidrag per pack före och efter (snitt). */
  readonly contributionPerPackOre: number | null;
  readonly newContributionPerPackOre: number | null;
  readonly base: PriceChangeBase;
  /** Utfallet med den valda elasticiteten. */
  readonly selected: PriceChangeRow;
  /** Utfallet för flera elasticiteter, 0 först och sedan fallande. */
  readonly table: PriceChangeRow[];
  /** Volymändring (bp) där vinsten blir oförändrad. `null` när den inte går att räkna ut. */
  readonly breakEvenVolumeChangeBp: number | null;
  readonly breakEvenElasticityHundredths: number | null;
  readonly text: string;
  readonly detail: string;
  readonly evidence: ScenarioEvidence;
}

function moneyText(ore: number): string {
  return Math.abs(ore) % 100 === 0 ? kr(Math.abs(ore)) : krExact(Math.abs(ore));
}

function assertElasticity(e: number): void {
  if (!Number.isSafeInteger(e)) {
    throw new DomainError(
      "invalid_input",
      `Elasticiteten anges i hundradelar som heltal (−150 = −1,5), fick ${e}.`,
    );
  }
}

function effectText(change: number): string {
  if (change > 0) return `ökar vinsten med ${kr(change)}`;
  if (change < 0) return `minskar vinsten med ${kr(-change)}`;
  return "blir vinsten oförändrad";
}

function volumeText(bp: number): string {
  if (bp === 0) return "lika många pack säljs";
  const p = signedPct(bp).replace(/^[+−]/, "");
  return bp < 0 ? `försäljningen minskar med ${p}` : `försäljningen ökar med ${p}`;
}

/**
 * Känslighetsanalys för en prisändring på en titel. Se reglerna överst i filen.
 *
 * priceChangeScenario({ ...källor, period, titleId: 't-a', deltaOre: 1000 })
 * → { selected: { profitChangeOre: 124 000, … }, table: [...], text: "Höjer du priset på …" }
 */
export function priceChangeScenario(input: PriceChangeScenarioInput): PriceChangeScenario {
  const { titleId, deltaOre, period } = input;
  if (!Number.isSafeInteger(deltaOre)) {
    throw new DomainError("invalid_amount", `Prisändringen måste anges i hela öre, fick ${deltaOre}.`);
  }
  const selectedE = input.elasticityHundredths ?? 0;
  assertElasticity(selectedE);
  const es = new Set<number>([...(input.elasticities ?? DEFAULT_ELASTICITIES), selectedE]);
  for (const e of es) assertElasticity(e);
  const elasticities = [...es].sort((a, b) => b - a);
  const titleName = input.titleName?.trim() || titleId;

  const ledger = buildLedger(input);
  let n = 0;
  let unpriced = 0;
  let gross = 0;
  let revenue = 0;
  let cost = 0;
  let fees = 0;
  let commission = 0;
  let rent = 0;
  let newGross = 0;
  let newRevenue = 0;
  let newContribution = 0;
  const orderIds: string[] = [];
  const dates: string[] = [];
  for (const e of ledger.entries) {
    if (e.order.titleId !== titleId) continue;
    if (!e.priced) {
      unpriced++;
      continue;
    }
    const amount = e.order.amountOre + deltaOre;
    if (amount < 0) {
      throw new DomainError(
        "invalid_input",
        `Priset blir negativt för order ${e.order.externalId} (${krExact(e.order.amountOre)} ${deltaOre < 0 ? "−" : "+"} ${krExact(Math.abs(deltaOre))}).`,
      );
    }
    const after = orderEconomics({ ...e.order, amountOre: amount }, ledger.context);
    n++;
    gross += e.grossOre;
    revenue += e.netRevenueOre;
    cost += e.costOre;
    fees += e.cardFeeOre;
    commission += e.commissionOre;
    rent += e.rentOre;
    newGross += after.grossOre;
    newRevenue += after.netRevenueOre;
    newContribution += after.netRevenueOre - e.costOre - after.cardFeeOre - after.commissionOre;
    orderIds.push(e.order.id);
    dates.push(e.order.businessDate);
  }
  const contribution = revenue - cost - fees - commission;
  const base: PriceChangeBase = {
    units: n,
    grossOre: gross,
    revenueOre: revenue,
    costOre: cost,
    feesOre: fees,
    commissionOre: commission,
    contributionOre: contribution,
    rentOre: rent,
    profitOre: contribution - rent,
  };

  // Volymfaktor för elasticitet e (hundradelar). Utan belopp (gratis pack) ändras inte volymen.
  const factor = (e: number): Ratio => {
    if (gross === 0) return new Ratio(1);
    const f = new Ratio(100 * gross + e * deltaOre * n, 100 * gross);
    return f.sign() < 0 ? Ratio.ZERO : f;
  };
  const row = (e: number): PriceChangeRow => {
    const f = factor(e);
    const contrib = f.mul(newContribution).round();
    const profit = contrib - rent;
    return {
      elasticityHundredths: e,
      volumeChangeBp: f.sub(new Ratio(1)).mul(BP_SCALE).round(),
      units: f.mul(n).round(),
      revenueOre: f.mul(newRevenue).round(),
      contributionOre: contrib,
      profitOre: profit,
      profitChangeOre: profit - base.profitOre,
      profitChangeBp: changeBp(profit, base.profitOre),
    };
  };
  const table = elasticities.map(row);
  const selected = table.find((r) => r.elasticityHundredths === selectedE)!;

  let breakEvenVolume: number | null = null;
  let breakEvenE: number | null = null;
  if (n > 0 && deltaOre !== 0 && newContribution > 0 && contribution >= 0) {
    const fStar = new Ratio(contribution, newContribution);
    const change = fStar.sub(new Ratio(1));
    breakEvenVolume = change.mul(BP_SCALE).round();
    if (gross > 0) breakEvenE = change.mul(100 * gross).div(deltaOre * n).round();
  }

  const avg = n === 0 ? null : roundHalfUp(gross, n);
  const newAvg = n === 0 ? null : roundHalfUp(newGross, n);
  const priceChangeBp = avg === null || gross === 0 ? null : roundHalfUp(deltaOre * n * BP_SCALE, gross);
  const perPack = n === 0 ? null : roundHalfUp(contribution, n);
  const newPerPack = n === 0 ? null : roundHalfUp(newContribution, n);

  const rule =
    "Varje prissatt order av titeln räknas om med nytt pris (moms, avgift och provision enligt samma regler som lönsamheten, inköpet oförändrat). Volymfaktor = 1 + elasticitet × prisändring / snittpris. Hyran är fast.";
  const figures = [
    fig("deltaOre", "Prisändring per pack", deltaOre, "ore"),
    fig("units", "Sålda pack i perioden", n, "packs"),
    fig("contributionOre", "Bidrag i dag", contribution, "ore"),
    fig("newContributionOre", "Bidrag med nytt pris, samma volym", newContribution, "ore"),
    fig("rentOre", "Hyra (fast)", rent, "ore"),
    fig("elasticityHundredths", "Antagen elasticitet", selectedE, "hundredths"),
    fig("profitChangeOre", "Vinständring", selected.profitChangeOre, "ore"),
  ];

  if (n === 0) {
    return {
      kind: "scenario",
      status: "no-data",
      titleId,
      titleName,
      period,
      deltaOre,
      unpricedOrders: unpriced,
      averagePriceOre: null,
      newAveragePriceOre: null,
      priceChangeBp: null,
      contributionPerPackOre: null,
      newContributionPerPackOre: null,
      base,
      selected,
      table,
      breakEvenVolumeChangeBp: null,
      breakEvenElasticityHundredths: null,
      text: sentence(`${titleName} har inga sålda pack med inköpspris under ${periodText(period)}`),
      detail:
        unpriced > 0
          ? `${plural(unpriced, "order saknar", "order saknar")} inköpspris; lägg till priset för att räkna på titeln.`
          : "Välj en period där titeln sålts.",
      evidence: scenarioEvidence({ rule, period, titleIds: [titleId], figures }),
    };
  }

  const verb = deltaOre > 0 ? "Höjer" : "Sänker";
  const condition =
    selectedE === 0
      ? `om lika många pack säljs (${plural(n, "pack", "pack")})`
      : `om ${volumeText(selected.volumeChangeBp)} (elasticitet ${hundredths(selectedE)})`;
  const text =
    deltaOre === 0
      ? sentence(`Oförändrat pris på ${titleName}: vinsten är ${kr(base.profitOre)} under ${periodText(period)}`)
      : `${verb} du priset på ${titleName} med ${moneyText(deltaOre)} ${effectText(selected.profitChangeOre)} under ${periodText(period)} ${condition}.`;

  const parts: string[] = [];
  parts.push(
    `Snittpris ${krExact(avg!)} → ${krExact(newAvg!)}${priceChangeBp === null ? "" : ` (${signedPct(priceChangeBp)})`}`,
  );
  parts.push(
    `bidrag per pack efter inköp, avgifter och provision ${krExact(perPack!)} → ${krExact(newPerPack!)}`,
  );
  parts.push(`hyran ${kr(rent)} är fast`);
  let detail = `${parts.join(", ")}.`;
  if (breakEvenVolume !== null && deltaOre > 0 && breakEvenVolume < 0) {
    detail += ` Vinsten är oförändrad om ${volumeText(breakEvenVolume)}${
      breakEvenE === null ? "" : ` (elasticitet ${hundredths(breakEvenE)})`
    }.`;
  } else if (breakEvenVolume !== null && deltaOre < 0 && breakEvenVolume > 0) {
    detail += ` Försäljningen måste öka med ${signedPct(breakEvenVolume).replace(/^\+/, "")} för samma vinst${
      breakEvenE === null ? "" : ` (elasticitet ${hundredths(breakEvenE)})`
    }.`;
  }
  if (unpriced > 0) detail += ` ${plural(unpriced, "order", "order")} utan inköpspris ingår inte.`;

  return {
    kind: "scenario",
    status: "ok",
    titleId,
    titleName,
    period,
    deltaOre,
    unpricedOrders: unpriced,
    averagePriceOre: avg,
    newAveragePriceOre: newAvg,
    priceChangeBp,
    contributionPerPackOre: perPack,
    newContributionPerPackOre: newPerPack,
    base,
    selected,
    table,
    breakEvenVolumeChangeBp: breakEvenVolume,
    breakEvenElasticityHundredths: breakEvenE,
    text,
    detail,
    evidence: scenarioEvidence({ rule, period, orderIds, dates, titleIds: [titleId], figures }),
  };
}
