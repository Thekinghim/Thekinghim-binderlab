/**
 * Delägarrapporten: månadens resultat för ägarna.
 *
 * Innehåll: resultat (intäkt, inköp, avgifter, ersättning, vinst, marginal), jämförelse
 * mot förra månaden och samma månad i fjol när historik finns, utveckling 6–12 månader,
 * lönsamhet per automat och titel, lagervärde, viktiga händelser och vinstfördelning
 * enligt ägarandelar exakt på öret.
 *
 * Alla resultatsiffror kommer från beräkningslagrets lönsamhet (`summarizeLedger`), så de
 * är desamma som i panelen: order utan inköpspris ingår inte i vinsten och redovisas
 * separat; hyran dras alltid i sin helhet.
 */

import {
  CALC_VERSION,
  DomainError,
  addDays,
  addMonths,
  allocateToOwners,
  buildLedger,
  changeBp,
  eachMonth,
  isProfitSplit,
  monthPeriod,
  monthStart,
  summarizeLedger,
  titleEconomics,
  type IsoDate,
  type IsoMonth,
  type Period,
  type ProfitabilityRow,
  type StoreAgreement,
} from "@/domain";
import { Catalog, evidence, fig, firstOrderDate, hasHistory, monthScope, safeOre } from "./shared";
import {
  dateText,
  krText,
  listText,
  monthNameText,
  monthText,
  ordersText,
  pctText,
  pointsText,
  signedKrText,
  signedPctText,
} from "./text";
import type { Conclusion, Evidence, ReportSources } from "./types";

/**
 * Månadens resultat. Belopp i öre.
 *
 * `totalRevenueOre` är intäkten för alla order, samma tal som panelens nyckeltal
 * (`keyMetrics().revenueOre`, docs/berakningar.md avsnitt 6). Övriga belopp gäller order med
 * inköpspris, som på sidan Lönsamhet: `revenueOre` är vinstens underlag och
 * `revenueOre + unpricedRevenueOre = totalRevenueOre`.
 */
export interface PartnerResult {
  readonly orders: number;
  readonly pricedOrders: number;
  /** Intäkt exkl. moms för alla order (= panelens Intäkt). Visas som "intäkt" i texterna. */
  readonly totalRevenueOre: number;
  /** Intäkt exkl. moms för order med inköpspris: underlaget för vinst och marginal. */
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly compensationOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly unpricedOrders: number;
  readonly unpricedRevenueOre: number;
  /** Andel av intäkten (alla order) som saknar inköpspris, i bp. */
  readonly unpricedShareBp: number;
  readonly evidence: Evidence;
}

/**
 * Jämförelse mot en annan månad. `totalRevenueOre`/`totalRevenueChangeBp` gäller alla order
 * (panelens Intäkt och Förändring) och används i texten; `revenueOre`/`revenueChangeBp`
 * jämför vinstens underlag (order med inköpspris), som `PartnerResult.revenueOre`.
 */
export interface PartnerComparison {
  readonly month: IsoMonth;
  readonly orders: number;
  /** Intäkt för alla order den månaden (= panelens Intäkt). */
  readonly totalRevenueOre: number;
  /** Förändring i intäkt för alla order, nu mot då, i bp (= panelens Förändring). */
  readonly totalRevenueChangeBp: number | null;
  /** Intäkt för order med inköpspris den månaden (vinstens underlag). */
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  /** Förändring i vinstens underlag (order med inköpspris), nu mot då, i bp. */
  readonly revenueChangeBp: number | null;
  readonly profitChangeBp: number | null;
  /** Skillnad i marginal (nu − då) i bp, `null` om någon marginal saknas. */
  readonly marginDiffBp: number | null;
  readonly text: string;
  readonly evidence: Evidence;
}

/** En månad i utvecklingen. */
export interface PartnerTrendMonth {
  readonly month: IsoMonth;
  /** Falskt för månader före historikens start (värdena är då 0). */
  readonly hasData: boolean;
  readonly orders: number;
  /** Intäkt exkl. moms för alla order (= panelens Intäkt för månaden). */
  readonly revenueOre: number;
  /** Del av intäkten från order med inköpspris (vinstens och marginalens underlag). */
  readonly pricedRevenueOre: number;
  /** Del av intäkten från order utan inköpspris. */
  readonly unpricedRevenueOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly evidence: Evidence;
}

/** En rad i lönsamheten per automat eller titel. */
export interface PartnerRow {
  readonly key: string;
  readonly kind: "item" | "no-machine" | "unallocated";
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly compensationOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly unpricedOrders: number;
  readonly unpricedRevenueOre: number;
  readonly evidence: Evidence;
}

/** Lager vid månadens slut, för en titel. */
export interface InventoryLine {
  readonly titleId: string;
  readonly name: string;
  readonly quantity: number;
  /** Inköpspriset som gällde månadens sista dag, `null` om pris saknas. */
  readonly unitCostOre: number | null;
  readonly valueOre: number | null;
  readonly evidence: Evidence;
}

/** Lagervärde vid månadens slut. */
export interface InventoryValue {
  readonly asOf: IsoDate;
  readonly totalValueOre: number;
  readonly quantity: number;
  /** Pack vars titel saknar inköpspris (ingår inte i värdet). */
  readonly unpricedQuantity: number;
  readonly lines: readonly InventoryLine[];
  readonly evidence: Evidence;
}

export type PartnerEventKind =
  | "price_change"
  | "new_price"
  | "agreement_start"
  | "agreement_change"
  | "agreement_end"
  | "machine_placed"
  | "machine_moved"
  | "machine_removed"
  | "first_sale"
  | "loss_title"
  | "unpriced_orders"
  | "unallocated_rent"
  | "idle_machine"
  | "record_high"
  | "record_low"
  | "manual";

/** En viktig händelse under månaden, framräknad med regler (eller inlagd för hand). */
export interface PartnerEvent {
  readonly kind: PartnerEventKind;
  readonly severity: "info" | "positive" | "warning";
  readonly date: IsoDate;
  readonly text: string;
  readonly evidence: Evidence;
}

/** En ägares del av vinsten. */
export interface OwnerPayout {
  readonly id: string;
  readonly name: string;
  readonly shareBp: number;
  readonly amountOre: number;
}

/** Vinstfördelning enligt ägarandelar. */
export interface ProfitSplit {
  readonly profitOre: number;
  readonly owners: readonly OwnerPayout[];
  readonly text: string;
  readonly evidence: Evidence;
}

/** Hela delägarrapporten. */
export interface PartnerReport {
  readonly kind: "partner";
  readonly calcVersion: string;
  readonly month: IsoMonth;
  readonly period: Period;
  readonly conclusion: Conclusion;
  readonly result: PartnerResult;
  readonly previousMonth: PartnerComparison | null;
  readonly sameMonthLastYear: PartnerComparison | null;
  readonly trend: {
    readonly months: readonly PartnerTrendMonth[];
    readonly limitedHistory: boolean;
  };
  readonly machines: readonly PartnerRow[];
  readonly titles: readonly PartnerRow[];
  readonly inventory: InventoryValue | null;
  readonly events: readonly PartnerEvent[];
  readonly profitSplit: ProfitSplit | null;
}

/** Ägare med andel i bp (andelarna summerar till 10 000). */
export interface PartnerOwner {
  readonly id: string;
  readonly name: string;
  readonly shareBp: number;
}

/** Inställningar för delägarrapporten. */
export interface PartnerReportOptions {
  /** Ägarandelar för vinstfördelningen. Utan ägare blir `profitSplit` `null`. */
  readonly owners?: readonly PartnerOwner[];
  /** Lager (antal pack) vid månadens slut. Utan lager blir `inventory` `null`. */
  readonly stock?: readonly { readonly titleId: string; readonly quantity: number }[];
  /** Antal månader i utvecklingen, 6–12. Standard 12. */
  readonly trendMonths?: number;
  /** Första dagen med data. Standard: första orderns affärsdag. */
  readonly historyStart?: IsoDate | null;
  /** Händelser som lagts in för hand (t.ex. "Automaten servades"). */
  readonly events?: readonly { readonly date: IsoDate; readonly text: string }[];
}

/** Minsta antal månader med data för att utse rekordmånad. */
export const RECORD_MIN_MONTHS = 6;
/** Andel utan inköpspris som nämns i slutsatsen (5 %). */
export const UNPRICED_NOTICE_BP = 500;

/**
 * Bygger delägarrapporten för en kalendermånad.
 *
 * Regler:
 * - Intäkt = Σ belopp exkl. moms för alla order, samma tal som panelen (`keyMetrics`).
 *   Den används i utvecklingen, jämförelsetexterna, rekorden och slutsatsen.
 * - Resultat: vinst = intäkt − inköp − avgifter − butiksersättning för order med
 *   inköpspris; marginal = round(vinst × 10 000 / intäkt med inköpspris) bp (som panelen).
 * - Jämförelse mot förra månaden och samma månad i fjol bara när historik finns
 *   (månaden slutar på eller efter historikens start); annars `null`.
 * - Utveckling: de senaste 6–12 månaderna till och med rapportmånaden; månader före
 *   historikens start markeras `hasData: false`.
 * - Lagervärde = Σ antal × inköpspriset som gällde månadens sista dag.
 * - Vinstfördelning: `allocateToOwners`, avkortat per ägare och resten till den största
 *   andelen, så att summan stämmer exakt på öret.
 */
export function buildPartnerReport(
  sources: ReportSources,
  month: IsoMonth,
  options: PartnerReportOptions = {},
): PartnerReport {
  const period = monthScope(month);
  const catalog = new Catalog(sources);
  const trendLength = options.trendMonths ?? 12;
  if (!Number.isSafeInteger(trendLength) || trendLength < 6 || trendLength > 12) {
    throw new DomainError(
      "invalid_input",
      `Utvecklingen ska vara 6–12 månader, fick ${trendLength}.`,
    );
  }
  const historyStart =
    options.historyStart === undefined ? firstOrderDate(sources.orders) : options.historyStart;

  const ledger = buildLedger({ ...sources, period });
  const byTitle = summarizeLedger(ledger, "title");
  const byMachine = summarizeLedger(ledger, "machine");
  const t = byTitle.totals;

  const lastYear = addMonths(month, -12);
  const longLedger = buildLedger({
    ...sources,
    period: { start: monthStart(lastYear), end: period.end },
  });
  const monthRows = new Map(
    summarizeLedger(longLedger, "month")
      .rows.filter((r) => r.kind === "time")
      .map((r) => [r.key, r]),
  );

  const result: PartnerResult = {
    orders: t.orders,
    pricedOrders: t.pricedOrders,
    totalRevenueOre: totalRevenue(t),
    revenueOre: t.revenueOre,
    costOre: t.costOre,
    feesOre: t.feesOre,
    commissionOre: t.commissionOre,
    rentOre: t.rentOre,
    compensationOre: t.compensationOre,
    profitOre: t.profitOre,
    marginBp: t.marginBp,
    unpricedOrders: t.unpricedOrders,
    unpricedRevenueOre: t.unpricedRevenueOre,
    unpricedShareBp: byTitle.unpriced.shareBp,
    evidence: evidence({
      rule: "Intäkt = Σ belopp exkl. moms för alla order. Vinst = intäkt − inköp − avgifter − butiksersättning för order med inköpspris (all hyra dras). Marginal = round(vinst × 10 000 / intäkt med inköpspris) bp.",
      scope: { period },
      orderCount: t.orders,
      figures: [
        fig("Intäkt", totalRevenue(t), "ore"),
        fig("Intäkt med inköpspris", t.revenueOre, "ore"),
        fig("Inköp", t.costOre, "ore"),
        fig("Avgifter", t.feesOre, "ore"),
        fig("Provision", t.commissionOre, "ore"),
        fig("Hyra", t.rentOre, "ore"),
        fig("Vinst", t.profitOre, "ore"),
        ...(t.marginBp === null ? [] : [fig("Marginal", t.marginBp, "bp")]),
        fig("Order utan inköpspris", t.unpricedOrders, "count"),
        fig("Intäkt utan inköpspris", t.unpricedRevenueOre, "ore"),
      ],
      titleIds: byTitle.unpriced.titleIds,
    }),
  };

  const compare = (other: IsoMonth, label: string): PartnerComparison | null => {
    const otherPeriod = monthPeriod(other);
    if (!hasHistory(otherPeriod, historyStart)) return null;
    const r = monthRows.get(other);
    const orders = r?.orders ?? 0;
    const total = r ? totalRevenue(r) : 0;
    const totalChange = changeBp(result.totalRevenueOre, total);
    const revenue = r?.revenueOre ?? 0;
    const profit = r?.profitOre ?? 0;
    const margin = r?.marginBp ?? null;
    const revenueChange = changeBp(result.revenueOre, revenue);
    const profitChange = changeBp(result.profitOre, profit);
    const marginDiff =
      margin === null || result.marginBp === null ? null : result.marginBp - margin;
    const parts = [
      `vinst ${krText(profit)}${profitChange === null ? "" : ` (nu ${signedPctText(profitChange)})`}`,
      `intäkt ${krText(total)}${totalChange === null ? "" : ` (nu ${signedPctText(totalChange)})`}`,
    ];
    if (marginDiff !== null)
      parts.push(`marginal ${pctText(margin!, 1)} (nu ${pointsText(marginDiff)})`);
    return {
      month: other,
      orders,
      totalRevenueOre: total,
      totalRevenueChangeBp: totalChange,
      revenueOre: revenue,
      profitOre: profit,
      marginBp: margin,
      revenueChangeBp: revenueChange,
      profitChangeBp: profitChange,
      marginDiffBp: marginDiff,
      text: `${label} (${monthText(other)}): ${parts.join(", ")}.`,
      evidence: evidence({
        rule: "Förändring = round((nu − då) × 10 000 / |då|) bp; saknas när då = 0. Intäkten gäller alla order, vinsten order med inköpspris. Marginalskillnad i procentenheter.",
        scope: { period: otherPeriod },
        orderCount: orders,
        figures: [
          fig("Intäkt då", total, "ore"),
          fig("Vinst då", profit, "ore"),
          fig("Intäkt nu", result.totalRevenueOre, "ore"),
          fig("Vinst nu", result.profitOre, "ore"),
        ],
      }),
    };
  };
  const previousMonth = compare(addMonths(month, -1), "Förra månaden");
  const sameMonthLastYear = compare(lastYear, "Samma månad i fjol");

  const trendMonths: PartnerTrendMonth[] = eachMonth(
    monthStart(addMonths(month, -(trendLength - 1))),
    period.end,
  ).map((m) => {
    const r = monthRows.get(m);
    const hasData = hasHistory(monthPeriod(m), historyStart);
    const total = r ? totalRevenue(r) : 0;
    return {
      month: m,
      hasData,
      orders: r?.orders ?? 0,
      revenueOre: total,
      pricedRevenueOre: r?.revenueOre ?? 0,
      unpricedRevenueOre: r?.unpricedRevenueOre ?? 0,
      profitOre: r?.profitOre ?? 0,
      marginBp: r?.marginBp ?? null,
      evidence: evidence({
        rule: "Intäkt för alla order (som panelen); vinst och marginal för order med inköpspris, som i resultatet.",
        scope: { period: monthPeriod(m) },
        orderCount: r?.orders ?? 0,
        figures: [
          fig("Intäkt", total, "ore"),
          fig("Intäkt med inköpspris", r?.revenueOre ?? 0, "ore"),
          fig("Vinst", r?.profitOre ?? 0, "ore"),
        ],
      }),
    };
  });

  const toRow = (r: ProfitabilityRow, dim: "machine" | "title"): PartnerRow => {
    const kind =
      r.kind === "no-machine" ? "no-machine" : r.kind === "unallocated" ? "unallocated" : "item";
    const name =
      kind === "no-machine"
        ? "Okopplad automat"
        : kind === "unallocated"
          ? "Ej fördelad hyra"
          : dim === "machine"
            ? catalog.machine(r.key)
            : catalog.title(r.key);
    const scope =
      kind === "item"
        ? dim === "machine"
          ? { period, machineId: r.key }
          : { period, titleId: r.key }
        : { period };
    return {
      key: r.key,
      kind,
      name,
      orders: r.orders,
      revenueOre: r.revenueOre,
      costOre: r.costOre,
      feesOre: r.feesOre,
      commissionOre: r.commissionOre,
      rentOre: r.rentOre,
      compensationOre: r.compensationOre,
      profitOre: r.profitOre,
      marginBp: r.marginBp,
      unpricedOrders: r.unpricedOrders,
      unpricedRevenueOre: r.unpricedRevenueOre,
      evidence: evidence({
        rule:
          kind === "unallocated"
            ? "Hyra som ingen order med inköpspris bär (butik utan försäljning, eller hyra på order utan pris). Dras från vinsten."
            : "Vinst = intäkt − inköp − avgifter − butiksersättning för radens order med inköpspris.",
        scope,
        orderCount: r.orders,
        figures: [
          fig("Intäkt", r.revenueOre, "ore"),
          fig("Inköp", r.costOre, "ore"),
          fig("Avgifter", r.feesOre, "ore"),
          fig("Butiksersättning", r.compensationOre, "ore"),
          fig("Vinst", r.profitOre, "ore"),
        ],
        ...(kind === "item" && dim === "title" ? { titleIds: [r.key] } : {}),
      }),
    };
  };
  const machines = byMachine.rows.map((r) => toRow(r, "machine"));
  const titles = byTitle.rows.map((r) => toRow(r, "title"));

  const inventory = options.stock
    ? buildInventory(options.stock, period, ledger.context.prices, catalog)
    : null;

  const events = buildEvents({
    sources,
    month,
    period,
    catalog,
    ledger,
    unpriced: byTitle.unpriced,
    machineRows: byMachine.rows,
    trend: trendMonths,
    manual: options.events ?? [],
  });

  const profitSplit = options.owners
    ? buildProfitSplit(result.profitOre, options.owners, period, t.orders)
    : null;

  return {
    kind: "partner",
    calcVersion: CALC_VERSION,
    month,
    period,
    conclusion: partnerConclusion(month, result, previousMonth),
    result,
    previousMonth,
    sameMonthLastYear,
    trend: { months: trendMonths, limitedHistory: trendMonths.some((m) => !m.hasData) },
    machines,
    titles,
    inventory,
    events,
    profitSplit,
  };
}

function buildInventory(
  stock: NonNullable<PartnerReportOptions["stock"]>,
  period: Period,
  prices: ReturnType<typeof buildLedger>["context"]["prices"],
  catalog: Catalog,
): InventoryValue {
  const qty = new Map<string, number>();
  for (const s of stock) {
    if (!Number.isSafeInteger(s.quantity)) {
      throw new DomainError(
        "invalid_input",
        `Lagret för ${s.titleId} måste vara ett heltal, fick ${s.quantity}.`,
      );
    }
    qty.set(s.titleId, safeOre((qty.get(s.titleId) ?? 0) + s.quantity, "Lagret"));
  }
  const asOf = period.end;
  let total = 0;
  let quantity = 0;
  let unpricedQuantity = 0;
  const lines: InventoryLine[] = [...qty.entries()].map(([titleId, q]) => {
    const p = prices.priceOn(titleId, asOf);
    const value = p ? safeOre(p.unitCostOre * q, "Lagervärdet") : null;
    quantity += q;
    if (value === null) unpricedQuantity += q;
    else total = safeOre(total + value, "Lagervärdet");
    return {
      titleId,
      name: catalog.title(titleId),
      quantity: q,
      unitCostOre: p ? p.unitCostOre : null,
      valueOre: value,
      evidence: evidence({
        rule: "Lagervärde = antal pack × inköpspriset som gällde månadens sista dag.",
        scope: { period, titleId },
        orderCount: 0,
        figures: [
          fig("Antal pack", q, "count"),
          ...(p ? [fig("Inköpspris", p.unitCostOre, "ore"), fig("Värde", value!, "ore")] : []),
        ],
        dates: p ? [p.validFrom] : [],
        titleIds: [titleId],
      }),
    };
  });
  lines.sort((a, b) => {
    const va = a.valueOre ?? -1;
    const vb = b.valueOre ?? -1;
    return va !== vb ? vb - va : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return {
    asOf,
    totalValueOre: total,
    quantity,
    unpricedQuantity,
    lines,
    evidence: evidence({
      rule: "Lagervärde = Σ antal pack × inköpspriset som gällde månadens sista dag; pack utan pris ingår inte.",
      scope: { period },
      orderCount: 0,
      figures: [
        fig("Lagervärde", total, "ore"),
        fig("Antal pack", quantity, "count"),
        fig("Pack utan inköpspris", unpricedQuantity, "count"),
      ],
    }),
  };
}

function buildProfitSplit(
  profitOre: number,
  owners: readonly PartnerOwner[],
  period: Period,
  orders: number,
): ProfitSplit {
  const alloc = allocateToOwners(
    profitOre,
    owners.map((o) => ({ id: o.id, shareBp: o.shareBp })),
  );
  const payouts: OwnerPayout[] = alloc.map((a, i) => ({
    id: a.id,
    name: owners[i]!.name,
    shareBp: a.shareBp,
    amountOre: a.amountOre,
  }));
  const parts = payouts.map(
    (p) =>
      `${p.name} ${pctText(p.shareBp, p.shareBp % 100 === 0 ? 0 : 1)} = ${krText(p.amountOre, "always")}`,
  );
  const what = profitOre < 0 ? "Förlusten" : "Vinsten";
  return {
    profitOre,
    owners: payouts,
    text: `${what} ${krText(profitOre, "always")} fördelas: ${listText(parts)}.`,
    evidence: evidence({
      rule: "Varje ägare utom den med störst andel får vinst × andel avkortat till helt öre; den största andelen får resten, så att summan stämmer exakt.",
      scope: { period },
      orderCount: orders,
      figures: [
        fig("Vinst", profitOre, "ore"),
        ...payouts.flatMap((p) => [
          fig(`Andel ${p.name}`, p.shareBp, "bp"),
          fig(`Belopp ${p.name}`, p.amountOre, "ore"),
        ]),
      ],
    }),
  };
}

function termsText(a: StoreAgreement): string {
  const parts: string[] = [];
  const bp = a.commissionBp ?? 0;
  if (isProfitSplit(a))
    parts.push(`${pctText(bp, bp % 100 === 0 ? 0 : 1)} av vinsten efter kostnader`);
  else if (bp > 0) parts.push(`provision ${pctText(bp, bp % 100 === 0 ? 0 : 1)}`);
  if ((a.monthlyRentOre ?? 0) > 0) parts.push(`hyra ${krText(a.monthlyRentOre!)}/mån`);
  return parts.length === 0 ? "ingen ersättning" : listText(parts);
}

const SEVERITY_RANK = { warning: 0, positive: 1, info: 2 } as const;

/**
 * Viktiga händelser under månaden. Reglerna:
 * - Inköpspris med giltig från i månaden: ändrat (med förra priset) eller nytt.
 * - Avtal som börjar i månaden (nytt eller ändrade villkor) och avtal som upphör.
 * - Automat som placeras, flyttas (placering slutar dagen före nästa börjar) eller tas bort.
 * - Titel som säljs för första gången någonsin.
 * - Titel som går med förlust per order med dagens inköpspris (`titleEconomics`).
 * - Order utan inköpspris; hyra som inte kunde fördelas.
 * - Automat som stod placerad hela månaden utan att sälja.
 * - Rekord: högsta/lägsta intäkten bland minst sex månader med data.
 * Sorteras på datum, sedan varningar före övrigt.
 */
function buildEvents(args: {
  sources: ReportSources;
  month: IsoMonth;
  period: Period;
  catalog: Catalog;
  ledger: ReturnType<typeof buildLedger>;
  unpriced: ReturnType<typeof summarizeLedger>["unpriced"];
  machineRows: readonly ProfitabilityRow[];
  trend: readonly PartnerTrendMonth[];
  manual: readonly { readonly date: IsoDate; readonly text: string }[];
}): PartnerEvent[] {
  const { sources, month, period, catalog, ledger, unpriced, machineRows, trend, manual } = args;
  const ctx = ledger.context;
  const inMonth = (d: IsoDate): boolean => d >= period.start && d <= period.end;
  const events: PartnerEvent[] = [];
  const push = (e: PartnerEvent): void => {
    events.push(e);
  };

  // Inköpspriser.
  for (const p of sources.prices) {
    if (!inMonth(p.validFrom)) continue;
    const prev = ctx.prices.priceOn(p.titleId, addDays(p.validFrom, -1));
    const name = catalog.title(p.titleId);
    push({
      kind: prev ? "price_change" : "new_price",
      severity: prev && p.unitCostOre > prev.unitCostOre ? "warning" : "info",
      date: p.validFrom,
      text: prev
        ? `Inköpspriset för ${name} ändrades från ${krText(prev.unitCostOre, "always")} till ${krText(p.unitCostOre, "always")} den ${dateText(p.validFrom)}.`
        : `Inköpspris för ${name} lades in: ${krText(p.unitCostOre, "always")} från ${dateText(p.validFrom)}.`,
      evidence: evidence({
        rule: "Ett inköpspris gäller från och med sitt giltig från-datum.",
        scope: { period: { start: p.validFrom, end: period.end }, titleId: p.titleId },
        orderCount: ledger.entries.filter(
          (e) => e.order.titleId === p.titleId && e.order.businessDate >= p.validFrom,
        ).length,
        figures: [
          ...(prev ? [fig("Tidigare pris", prev.unitCostOre, "ore")] : []),
          fig("Nytt pris", p.unitCostOre, "ore"),
        ],
        dates: [p.validFrom],
        titleIds: [p.titleId],
      }),
    });
  }

  // Avtal.
  for (const a of ctx.agreements.all()) {
    const list = ctx.agreements.agreementsFor(a.storeId);
    const store = catalog.store(a.storeId);
    if (inMonth(a.validFrom)) {
      const prev = list.find((x) => x.validTo === addDays(a.validFrom, -1)) ?? null;
      push({
        kind: prev ? "agreement_change" : "agreement_start",
        severity: "info",
        date: a.validFrom,
        text: prev
          ? `Nya villkor för ${store} från ${dateText(a.validFrom)}: ${termsText(a)} (tidigare ${termsText(prev)}).`
          : `Avtal med ${store} från ${dateText(a.validFrom)}: ${termsText(a)}.`,
        evidence: evidence({
          rule: "Avtalet gäller från och med sitt startdatum; hyran räknas per dag vid delmånad.",
          scope: { period, storeId: a.storeId },
          orderCount: 0,
          figures: [
            fig(isProfitSplit(a) ? "Andel av vinsten" : "Provision", a.commissionBp ?? 0, "bp"),
            fig("Månadshyra", a.monthlyRentOre ?? 0, "ore"),
          ],
          dates: [a.validFrom],
        }),
      });
    }
    if (a.validTo !== null && inMonth(a.validTo)) {
      const next = list.find((x) => x.validFrom === addDays(a.validTo!, 1));
      if (!next) {
        push({
          kind: "agreement_end",
          severity: "warning",
          date: a.validTo,
          text: `Avtalet med ${store} upphörde den ${dateText(a.validTo)}.`,
          evidence: evidence({
            rule: "Avtalet gäller till och med sitt slutdatum.",
            scope: { period, storeId: a.storeId },
            orderCount: 0,
            figures: [],
            dates: [a.validTo],
          }),
        });
      }
    }
  }

  // Placeringar.
  for (const machineId of ctx.placements.machineIds()) {
    const list = ctx.placements.placementsFor(machineId);
    const machine = catalog.machine(machineId);
    for (const p of list) {
      if (inMonth(p.from)) {
        const prev = list.find((x) => x.to === addDays(p.from, -1)) ?? null;
        const moved = prev !== null && prev.storeId !== p.storeId;
        if (prev === null || moved) {
          push({
            kind: moved ? "machine_moved" : "machine_placed",
            severity: "info",
            date: p.from,
            text: moved
              ? `${machine} flyttade från ${catalog.store(prev.storeId)} till ${catalog.store(p.storeId)} den ${dateText(p.from)}.`
              : `${machine} placerades i ${catalog.store(p.storeId)} den ${dateText(p.from)}.`,
            evidence: evidence({
              rule: "Order räknas på den butik där automaten stod orderns dag.",
              scope: { period, machineId },
              orderCount: 0,
              figures: [],
              dates: [p.from],
            }),
          });
        }
      }
      if (p.to !== null && inMonth(p.to) && !list.some((x) => x.from === addDays(p.to!, 1))) {
        push({
          kind: "machine_removed",
          severity: "warning",
          date: p.to,
          text: `${machine} togs bort från ${catalog.store(p.storeId)} den ${dateText(p.to)}.`,
          evidence: evidence({
            rule: "Placeringen gäller till och med sitt slutdatum.",
            scope: { period, machineId },
            orderCount: 0,
            figures: [],
            dates: [p.to],
          }),
        });
      }
    }
  }

  // Första försäljning av en titel.
  const firstSale = new Map<string, IsoDate>();
  for (const o of sources.orders) {
    const d = firstSale.get(o.titleId);
    if (d === undefined || o.businessDate < d) firstSale.set(o.titleId, o.businessDate);
  }
  for (const [titleId, d] of firstSale) {
    if (!inMonth(d)) continue;
    const n = ledger.entries.filter((e) => e.order.titleId === titleId).length;
    push({
      kind: "first_sale",
      severity: "positive",
      date: d,
      text: `${catalog.title(titleId)} såldes för första gången den ${dateText(d)} (${ordersText(n)} under månaden).`,
      evidence: evidence({
        rule: "Första order någonsin för titeln.",
        scope: { period, titleId },
        orderCount: n,
        figures: [fig("Antal order", n, "count")],
        dates: [d],
        titleIds: [titleId],
      }),
    });
  }

  // Titlar som går med förlust per order.
  for (const te of titleEconomics({ ...sources, period })) {
    if (te.orders === 0 || !te.lossWarning || te.leftPerOrderOre === null) continue;
    push({
      kind: "loss_title",
      severity: "warning",
      date: period.end,
      text: `${catalog.title(te.titleId)} går med förlust: ${krText(te.leftPerOrderOre, "always")} kvar per order med dagens inköpspris ${krText(te.currentUnitCostOre ?? 0, "always")}.`,
      evidence: evidence({
        rule: "Kvar per order = round((Σ netto − Σ kortavgift − Σ provision − antal × aktuellt inköpspris) / antal); ≤ 0 ger varning.",
        scope: { period, titleId: te.titleId },
        orderCount: te.orders,
        figures: [
          fig("Kvar per order", te.leftPerOrderOre, "ore"),
          fig("Aktuellt inköpspris", te.currentUnitCostOre ?? 0, "ore"),
          ...(te.averagePriceOre === null ? [] : [fig("Snittpris", te.averagePriceOre, "ore")]),
        ],
        titleIds: [te.titleId],
      }),
    });
  }

  // Order utan inköpspris.
  if (unpriced.orders > 0) {
    push({
      kind: "unpriced_orders",
      severity: "warning",
      date: period.end,
      text: `${ordersText(unpriced.orders)} (${krText(unpriced.revenueOre)}, ${pctText(unpriced.shareBp)} av intäkten) saknar inköpspris och ingår inte i vinsten: ${listText(unpriced.byTitle.map((u) => catalog.title(u.titleId)))}.`,
      evidence: evidence({
        rule: "En order utan inköpspris räknas inte in i vinsten.",
        scope: { period },
        orderCount: unpriced.orders,
        figures: [
          fig("Intäkt utan pris", unpriced.revenueOre, "ore"),
          fig("Andel", unpriced.shareBp, "bp"),
        ],
        titleIds: unpriced.titleIds,
      }),
    });
  }

  // Hyra utan försäljning.
  for (const u of ledger.unallocatedRent) {
    push({
      kind: "unallocated_rent",
      severity: "warning",
      date: period.end,
      text: `${catalog.store(u.storeId)} hade ingen försäljning men hyran ${krText(u.rentOre)} dras ändå.`,
      evidence: evidence({
        rule: "Hyran gäller enligt avtalet även utan försäljning och dras från vinsten.",
        scope: { period, storeId: u.storeId },
        orderCount: 0,
        figures: [fig("Hyra", u.rentOre, "ore")],
      }),
    });
  }

  // Automater som stod hela månaden utan att sälja.
  const sold = new Set(
    machineRows.filter((r) => r.kind === "item" && r.orders > 0).map((r) => r.key),
  );
  for (const machineId of ctx.placements.machineIds()) {
    if (sold.has(machineId)) continue;
    const p = ctx.placements.placementOn(machineId, period.start);
    if (!p || p.from > period.start || (p.to !== null && p.to < period.end)) continue;
    push({
      kind: "idle_machine",
      severity: "warning",
      date: period.end,
      text: `${catalog.machine(machineId)} i ${catalog.store(p.storeId)} sålde inget under ${monthText(month)}.`,
      evidence: evidence({
        rule: "Automaten stod i samma butik hela månaden och har inga order.",
        scope: { period, machineId },
        orderCount: 0,
        figures: [],
      }),
    });
  }

  // Rekord.
  const withData = trend.filter((m) => m.hasData);
  const current = trend[trend.length - 1];
  if (current && current.hasData && withData.length >= RECORD_MIN_MONTHS) {
    const others = withData.slice(0, -1);
    const max = Math.max(...others.map((m) => m.revenueOre));
    const min = Math.min(...others.map((m) => m.revenueOre));
    const ev = (rule: string): Evidence =>
      evidence({
        rule,
        scope: { period: { start: monthStart(withData[0]!.month), end: period.end } },
        orderCount: withData.reduce((s, m) => s + m.orders, 0),
        figures: [
          fig("Intäkt denna månad (alla order)", current.revenueOre, "ore"),
          fig(
            rule.includes("Högsta") ? "Högsta tidigare" : "Lägsta tidigare",
            rule.includes("Högsta") ? max : min,
            "ore",
          ),
        ],
      });
    if (current.revenueOre > max) {
      push({
        kind: "record_high",
        severity: "positive",
        date: period.end,
        text: `Högsta intäkten på ${withData.length} månader: ${krText(current.revenueOre)}.`,
        evidence: ev(
          "Högsta intäkten (alla order, som panelen) bland månaderna med data i utvecklingen.",
        ),
      });
    } else if (current.revenueOre < min) {
      push({
        kind: "record_low",
        severity: "warning",
        date: period.end,
        text: `Lägsta intäkten på ${withData.length} månader: ${krText(current.revenueOre)}.`,
        evidence: ev(
          "Lägsta intäkten (alla order, som panelen) bland månaderna med data i utvecklingen.",
        ),
      });
    }
  }

  for (const m of manual) {
    if (!inMonth(m.date)) continue;
    push({
      kind: "manual",
      severity: "info",
      date: m.date,
      text: m.text,
      evidence: evidence({
        rule: "Inlagd för hand.",
        scope: { period: { start: m.date, end: m.date } },
        orderCount: 0,
        figures: [],
        dates: [m.date],
      }),
    });
  }

  return events.sort((a, b) =>
    a.date !== b.date
      ? a.date < b.date
        ? -1
        : 1
      : SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]
        ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        : a.text < b.text
          ? -1
          : a.text > b.text
            ? 1
            : 0,
  );
}

/**
 * Slutsatsen överst i delägarrapporten, en mening. Reglerna i ordning:
 * 1. Inga order och inga kostnader → "Ingen försäljning i …".
 * 2. Vinst < 0 → "… gick med förlust: X på Y intäkt".
 * 3. Förra månaden finns och hade vinst ≠ 0 → vinst, marginal och förändring i kronor och procent.
 * 4. Annars vinst, intäkt och marginal.
 * Saknar minst 5 % av intäkten inköpspris läggs det till som förbehåll.
 */
function partnerConclusion(
  month: IsoMonth,
  r: PartnerResult,
  prev: PartnerComparison | null,
): Conclusion {
  const scope = { period: monthPeriod(month) };
  const figures = [
    fig("Vinst", r.profitOre, "ore"),
    fig("Intäkt", r.totalRevenueOre, "ore"),
    fig("Intäkt med inköpspris", r.revenueOre, "ore"),
    ...(r.marginBp === null ? [] : [fig("Marginal", r.marginBp, "bp")]),
    fig("Andel utan inköpspris", r.unpricedShareBp, "bp"),
  ];
  const caveat =
    r.unpricedShareBp >= UNPRICED_NOTICE_BP
      ? `, men ${pctText(r.unpricedShareBp)} av intäkten saknar inköpspris och ingår inte`
      : "";
  const ev = (rule: string, extra: ReturnType<typeof fig>[] = []): Evidence =>
    evidence({ rule, scope, orderCount: r.orders, figures: [...figures, ...extra] });

  if (r.orders === 0 && r.compensationOre === 0) {
    return {
      text: `Ingen försäljning i ${monthText(month)}.`,
      ruleId: "partner.no_sales",
      evidence: ev("Inga order och inga kostnader under månaden."),
    };
  }
  if (r.profitOre < 0) {
    return {
      text: `${capitalize(monthText(month))} gick med förlust: ${krText(r.profitOre)} på ${krText(r.totalRevenueOre)} intäkt${caveat}.`,
      ruleId: "partner.loss",
      evidence: ev("Vinsten är negativ."),
    };
  }
  const margin = r.marginBp === null ? "" : ` (marginal ${pctText(r.marginBp, 1)})`;
  if (prev && prev.profitOre !== 0 && prev.profitChangeBp !== null) {
    const diff = r.profitOre - prev.profitOre;
    const prevName =
      prev.month.slice(0, 4) === month.slice(0, 4)
        ? monthNameText(prev.month)
        : monthText(prev.month);
    const direction =
      diff === 0
        ? `samma som i ${prevName}`
        : `${signedKrText(diff)} (${signedPctText(prev.profitChangeBp)}) mot ${prevName}`;
    return {
      text: `Vinsten blev ${krText(r.profitOre)}${margin}, ${direction}${caveat}.`,
      ruleId: diff >= 0 ? "partner.profit_up" : "partner.profit_down",
      evidence: ev(
        "Förändring = round((vinst nu − vinst förra månaden) × 10 000 / |vinst förra månaden|) bp.",
        [
          fig("Vinst förra månaden", prev.profitOre, "ore"),
          fig("Förändring", prev.profitChangeBp, "bp"),
        ],
      ),
    };
  }
  return {
    text: `Vinsten blev ${krText(r.profitOre)} på ${krText(r.totalRevenueOre)} intäkt${margin}${caveat}.`,
    ruleId: "partner.profit",
    evidence: ev("Vinst = intäkt − inköp − avgifter − butiksersättning."),
  };
}

/**
 * Intäkt för alla order = intäkt med inköpspris + intäkt utan inköpspris. Samma regel som
 * panelens `keyMetrics().revenueOre` (docs/berakningar.md avsnitt 6), så delägarrapporten
 * och panelen visar samma intäkt. Används på domänens summeringsrader.
 */
export function totalRevenue(row: {
  readonly revenueOre: number;
  readonly unpricedRevenueOre: number;
}): number {
  return safeOre(row.revenueOre + row.unpricedRevenueOre, "Intäkt");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
