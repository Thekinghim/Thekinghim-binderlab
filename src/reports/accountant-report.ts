/**
 * Bokföringsrapporten: underlag till bokhållaren för en period.
 *
 * Innehåll: försäljning per dag och totalt inkl. och exkl. moms, avgifter, inköp,
 * butiksersättning per butik, sammanställning per automat och avstämning mot källan
 * (ordernummerintervall, antal order och luckor i nummerserien).
 *
 * Allt bygger på samma orderliggare som panelen (`buildLedger`/`summarizeLedger`), så
 * siffrorna är desamma som i lönsamhetsvyerna. Skillnaden är att bokföringen visar ALLA
 * order: försäljning, moms, avgifter och provision gäller även order som saknar
 * inköpspris. Inköp kan bara räknas för order med pris; antalet utan pris redovisas.
 */

import {
  CALC_VERSION,
  assertPeriod,
  buildLedger,
  summarizeLedger,
  type IsoDate,
  type Period,
  type ProfitabilityRow,
} from "@/domain";
import { Catalog, compareExternalIds, evidence, fig } from "./shared";
import { krText, listText, ordersText, pctText, periodText } from "./text";
import type { Conclusion, Evidence, ReportSources } from "./types";

/** Belopp som alla rader har. Öre. */
export interface SalesAmounts {
  readonly orders: number;
  /** Betalt inkl. moms. */
  readonly grossOre: number;
  readonly vatOre: number;
  /** Exkl. moms. */
  readonly netOre: number;
  /** Kortavgifter. */
  readonly feesOre: number;
}

/** Totalen för perioden. */
export interface AccountantTotals extends SalesAmounts {
  /** Inköp för order med inköpspris. */
  readonly costOre: number;
  readonly pricedOrders: number;
  readonly unpricedOrders: number;
  /** Försäljning exkl. moms för order utan inköpspris. */
  readonly unpricedNetOre: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly compensationOre: number;
  readonly evidence: Evidence;
}

/** En dag. */
export interface AccountantDay extends SalesAmounts {
  readonly date: IsoDate;
  readonly evidence: Evidence;
}

/** En butik (eller order från automater utan placering). */
export interface AccountantStoreRow extends SalesAmounts {
  readonly kind: "store" | "no-store";
  readonly storeId: string | null;
  readonly name: string;
  readonly costOre: number;
  readonly unpricedOrders: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly compensationOre: number;
  readonly evidence: Evidence;
}

/** En automat (eller order utan kopplad automat). */
export interface AccountantMachineRow extends SalesAmounts {
  readonly kind: "machine" | "no-machine";
  readonly machineId: string | null;
  readonly name: string;
  /** Butikerna där automaten sålde under perioden. */
  readonly storeNames: readonly string[];
  readonly costOre: number;
  readonly unpricedOrders: number;
  readonly commissionOre: number;
  readonly evidence: Evidence;
}

/** En lucka i nummerserien, båda ändar inräknade. */
export interface OrderNumberGap {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** Ordernummer i perioden. */
export interface OrderNumberRange {
  readonly first: number;
  readonly last: number;
  /** Antal olika ordernummer i perioden. */
  readonly count: number;
  /** last − first + 1 */
  readonly span: number;
  /** Nummer i intervallet som saknas helt i källan. */
  readonly missing: number;
  readonly gaps: readonly OrderNumberGap[];
  /** Nummer i intervallet som finns i källan men har affärsdatum utanför perioden. */
  readonly outsidePeriod: readonly string[];
}

/** En kontrollsumma: två vägar till samma tal. */
export interface ReconciliationCheck {
  readonly label: string;
  readonly expected: number;
  readonly actual: number;
  readonly unit: "ore" | "count";
  readonly ok: boolean;
}

/** Avstämning mot källan. */
export interface Reconciliation {
  readonly orderCount: number;
  /** `null` när inga order i perioden har numeriska ordernummer. */
  readonly numbers: OrderNumberRange | null;
  /** Ordernummer som inte är heltal (kan inte stämmas av mot serien). */
  readonly nonNumericIds: readonly string[];
  /** Ordernummer som förekommer på flera order i perioden. */
  readonly duplicateExternalIds: readonly string[];
  readonly checks: readonly ReconciliationCheck[];
  /** Sant när alla kontroller stämmer och inga luckor eller dubbletter finns. */
  readonly ok: boolean;
  readonly evidence: Evidence;
}

/** Titel som saknar inköpspris (inköpet kan inte bokföras för dess order). */
export interface AccountantUnpricedTitle {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly netOre: number;
  readonly evidence: Evidence;
}

/** Hela bokföringsrapporten. */
export interface AccountantReport {
  readonly kind: "accountant";
  readonly calcVersion: string;
  readonly period: Period;
  readonly vatRateBp: number;
  readonly cardFeeBp: number;
  readonly conclusion: Conclusion;
  readonly totals: AccountantTotals;
  readonly days: readonly AccountantDay[];
  readonly stores: readonly AccountantStoreRow[];
  readonly machines: readonly AccountantMachineRow[];
  readonly unpricedTitles: readonly AccountantUnpricedTitle[];
  readonly reconciliation: Reconciliation;
}

const NUMERIC_ID = /^\d{1,15}$/;

function amounts(row: ProfitabilityRow): SalesAmounts {
  return {
    orders: row.orders,
    grossOre: row.grossOre,
    vatOre: row.vatOre + row.unpricedVatOre,
    netOre: row.revenueOre + row.unpricedRevenueOre,
    feesOre: row.feesOre + row.unpricedFeesOre,
  };
}

function amountFigures(a: SalesAmounts): ReturnType<typeof fig>[] {
  return [
    fig("Antal order", a.orders, "count"),
    fig("Inkl. moms", a.grossOre, "ore"),
    fig("Moms", a.vatOre, "ore"),
    fig("Exkl. moms", a.netOre, "ore"),
    fig("Avgifter", a.feesOre, "ore"),
  ];
}

/**
 * Bygger bokföringsrapporten för perioden (valfri längd, båda ändar inräknade).
 *
 * Regler:
 * - Inkl. moms = betalt belopp; moms = round(belopp × sats / (10 000 + sats)) per order;
 *   exkl. moms = belopp − moms. Avgifter = round(belopp × kortavgift / 10 000) per order.
 *   Gäller alla order, även de utan inköpspris.
 * - Inköp = inköpspriset som gällde orderns dag, för order med pris.
 * - Provision per order enligt avtalet orderns dag; hyra per butik och månad (per dag
 *   vid delmånad). Butik utan order men med hyra kommer också med.
 * - Avstämning: varje summa räknas två vägar (per dag, per butik, per automat mot
 *   totalen; moms + exkl. moms mot inkl. moms; provision + hyra mot ersättningen).
 * - Nummerserien: luckor = heltal mellan periodens lägsta och högsta ordernummer som
 *   inte finns bland ordrarna i `sources.orders`. Nummer som finns men har datum
 *   utanför perioden är inte luckor; de listas separat. En lucka kan vara en obetald
 *   order i källan (bara betalda importeras) och ska kontrolleras där.
 */
export function buildAccountantReport(sources: ReportSources, period: Period): AccountantReport {
  assertPeriod(period);
  const catalog = new Catalog(sources);
  const ledger = buildLedger({ ...sources, period });
  const byDay = summarizeLedger(ledger, "day");
  const byStore = summarizeLedger(ledger, "store");
  const byMachine = summarizeLedger(ledger, "machine");
  const t = byDay.totals;

  const totalAmounts = amounts(t);
  const commissionOre = t.commissionOre + t.unpricedCommissionOre;
  const totals: AccountantTotals = {
    ...totalAmounts,
    costOre: t.costOre,
    pricedOrders: t.pricedOrders,
    unpricedOrders: t.unpricedOrders,
    unpricedNetOre: t.unpricedRevenueOre,
    commissionOre,
    rentOre: t.rentOre,
    compensationOre: commissionOre + t.rentOre,
    evidence: evidence({
      rule: "Summor för alla order i perioden. Inköp bara för order med inköpspris; hyra per butik och månad.",
      scope: { period },
      orderCount: t.orders,
      figures: [
        ...amountFigures(totalAmounts),
        fig("Inköp", t.costOre, "ore"),
        fig("Order utan inköpspris", t.unpricedOrders, "count"),
        fig("Provision", commissionOre, "ore"),
        fig("Hyra", t.rentOre, "ore"),
      ],
    }),
  };

  const days: AccountantDay[] = byDay.rows
    .filter((r) => r.kind === "time")
    .map((r) => {
      const a = amounts(r);
      return {
        date: r.key,
        ...a,
        evidence: evidence({
          rule: "Dagens försäljning = Σ över order med affärsdatum denna dag (svensk tid).",
          scope: { period: { start: r.key, end: r.key } },
          orderCount: a.orders,
          figures: amountFigures(a),
        }),
      };
    });

  const stores: AccountantStoreRow[] = byStore.rows
    .filter((r) => r.kind === "item" || r.kind === "no-store")
    .map((r) => {
      const a = amounts(r);
      const isStore = r.kind === "item";
      const commission = r.commissionOre + r.unpricedCommissionOre;
      const rent = isStore ? r.rentOre : 0;
      return {
        kind: isStore ? ("store" as const) : ("no-store" as const),
        storeId: isStore ? r.key : null,
        name: isStore ? catalog.store(r.key) : "Automat utan butik",
        ...a,
        costOre: r.costOre,
        unpricedOrders: r.unpricedOrders,
        commissionOre: commission,
        rentOre: rent,
        compensationOre: commission + rent,
        evidence: evidence({
          rule: isStore
            ? "Butikens order = order från automater som stod i butiken orderns dag. Ersättning = provision + hyra."
            : "Order från automater som inte var placerade i någon butik den dagen; ingen ersättning.",
          scope: isStore ? { period, storeId: r.key } : { period },
          orderCount: a.orders,
          figures: [
            ...amountFigures(a),
            fig("Inköp", r.costOre, "ore"),
            fig("Provision", commission, "ore"),
            fig("Hyra", rent, "ore"),
          ],
        }),
      };
    })
    .sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "store"
          ? -1
          : 1
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
    );

  const machineStores = new Map<string, Set<string>>();
  for (const e of ledger.entries) {
    if (e.order.machineId === null || e.storeId === null) continue;
    const set = machineStores.get(e.order.machineId) ?? new Set<string>();
    set.add(e.storeId);
    machineStores.set(e.order.machineId, set);
  }
  const machines: AccountantMachineRow[] = byMachine.rows
    .filter((r) => r.kind === "item" || r.kind === "no-machine")
    .map((r) => {
      const a = amounts(r);
      const isMachine = r.kind === "item";
      const commission = r.commissionOre + r.unpricedCommissionOre;
      return {
        kind: isMachine ? ("machine" as const) : ("no-machine" as const),
        machineId: isMachine ? r.key : null,
        name: isMachine ? catalog.machine(r.key) : "Okopplad automat",
        storeNames: [...(machineStores.get(r.key) ?? [])].map((s) => catalog.store(s)).sort(),
        ...a,
        costOre: r.costOre,
        unpricedOrders: r.unpricedOrders,
        commissionOre: commission,
        evidence: evidence({
          rule: isMachine
            ? "Automatens order under perioden, oavsett butik."
            : "Order vars automat i källan ännu inte är kopplad till en automat.",
          scope: isMachine ? { period, machineId: r.key } : { period },
          orderCount: a.orders,
          figures: [
            ...amountFigures(a),
            fig("Inköp", r.costOre, "ore"),
            fig("Provision", commission, "ore"),
          ],
        }),
      };
    })
    .sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "machine"
          ? -1
          : 1
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
    );

  const unpricedTitles: AccountantUnpricedTitle[] = byDay.unpriced.byTitle.map((u) => ({
    titleId: u.titleId,
    name: catalog.title(u.titleId),
    orders: u.orders,
    netOre: u.revenueOre,
    evidence: evidence({
      rule: "Inget inköpspris gällde orderns dag; inköpet kan inte räknas för dessa order.",
      scope: { period, titleId: u.titleId },
      orderCount: u.orders,
      figures: [fig("Exkl. moms", u.revenueOre, "ore"), fig("Antal order", u.orders, "count")],
      dates: [u.firstDate, u.lastDate],
      titleIds: [u.titleId],
    }),
  }));

  const reconciliation = reconcile({
    sources,
    period,
    entriesExternalIds: ledger.entries.map((e) => e.order.externalId),
    totals,
    days,
    stores,
    machines,
  });

  const report: AccountantReport = {
    kind: "accountant",
    calcVersion: CALC_VERSION,
    period,
    vatRateBp: sources.settings.vatRateBp,
    cardFeeBp: sources.settings.cardFeeBp,
    conclusion: accountantConclusion(period, totals, reconciliation, sources.settings.vatRateBp),
    totals,
    days,
    stores,
    machines,
    unpricedTitles,
    reconciliation,
  };
  return report;
}

/** Index för första elementet ≥ x i en sorterad lista. */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Luckor i nummerserien. `inPeriod` och `all` är sorterade unika nummer; `all` innehåller
 * alla order i källan (även utanför perioden).
 */
export function findOrderNumberGaps(
  inPeriod: readonly number[],
  all: readonly number[],
): { gaps: OrderNumberGap[]; outsidePeriod: number[] } {
  const gaps: OrderNumberGap[] = [];
  const outsidePeriod: number[] = [];
  for (let i = 1; i < inPeriod.length; i++) {
    const a = inPeriod[i - 1]!;
    const b = inPeriod[i]!;
    if (b - a <= 1) continue;
    let from = a + 1;
    for (let k = lowerBound(all, a + 1); k < all.length && all[k]! < b; k++) {
      const n = all[k]!;
      outsidePeriod.push(n);
      if (n > from) gaps.push({ from, to: n - 1, count: n - from });
      from = n + 1;
    }
    if (from <= b - 1) gaps.push({ from, to: b - 1, count: b - from });
  }
  return { gaps, outsidePeriod };
}

function reconcile(args: {
  sources: ReportSources;
  period: Period;
  entriesExternalIds: readonly string[];
  totals: AccountantTotals;
  days: readonly AccountantDay[];
  stores: readonly AccountantStoreRow[];
  machines: readonly AccountantMachineRow[];
}): Reconciliation {
  const { sources, period, entriesExternalIds, totals, days, stores, machines } = args;
  const seen = new Map<string, number>();
  for (const id of entriesExternalIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicateExternalIds = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort(compareExternalIds);
  const nonNumericIds = [...seen.keys()]
    .filter((id) => !NUMERIC_ID.test(id))
    .sort(compareExternalIds);
  const nums = [...seen.keys()]
    .filter((id) => NUMERIC_ID.test(id))
    .map(Number)
    .sort((a, b) => a - b);
  const all = [
    ...new Set(
      sources.orders.filter((o) => NUMERIC_ID.test(o.externalId)).map((o) => Number(o.externalId)),
    ),
  ].sort((a, b) => a - b);

  let numbers: OrderNumberRange | null = null;
  if (nums.length > 0) {
    const { gaps, outsidePeriod } = findOrderNumberGaps(nums, all);
    const first = nums[0]!;
    const last = nums[nums.length - 1]!;
    numbers = {
      first,
      last,
      count: nums.length,
      span: last - first + 1,
      missing: gaps.reduce((s, g) => s + g.count, 0),
      gaps,
      outsidePeriod: outsidePeriod.map(String),
    };
  }

  const sum = (rows: readonly { grossOre: number }[]): number =>
    rows.reduce((s, r) => s + r.grossOre, 0);
  const check = (
    label: string,
    expected: number,
    actual: number,
    unit: "ore" | "count" = "ore",
  ): ReconciliationCheck => ({
    label,
    expected,
    actual,
    unit,
    ok: expected === actual,
  });
  const checks: ReconciliationCheck[] = [
    check("Summa per dag = total inkl. moms", totals.grossOre, sum(days)),
    check("Summa per butik = total inkl. moms", totals.grossOre, sum(stores)),
    check("Summa per automat = total inkl. moms", totals.grossOre, sum(machines)),
    check("Moms + exkl. moms = inkl. moms", totals.grossOre, totals.vatOre + totals.netOre),
    check(
      "Ersättning per butik = total ersättning",
      totals.compensationOre,
      stores.reduce((s, r) => s + r.compensationOre, 0),
    ),
    check(
      "Antal order = order i källan med datum i perioden",
      sources.orders.filter((o) => o.businessDate >= period.start && o.businessDate <= period.end)
        .length,
      totals.orders,
      "count",
    ),
  ];

  const ok =
    checks.every((c) => c.ok) &&
    duplicateExternalIds.length === 0 &&
    (numbers === null || numbers.missing === 0);
  const gapNumbers =
    numbers?.gaps.flatMap((g) =>
      g.count <= 20 ? range(g.from, g.to).map(String) : [String(g.from), String(g.to)],
    ) ?? [];
  return {
    orderCount: totals.orders,
    numbers,
    nonNumericIds,
    duplicateExternalIds,
    checks,
    ok,
    evidence: evidence({
      rule: "Luckor = ordernummer mellan periodens lägsta och högsta som saknas i källan. Kontrollsummor räknas två vägar och ska vara lika.",
      scope: { period },
      orderCount: totals.orders,
      figures: [
        fig("Antal order", totals.orders, "count"),
        ...(numbers
          ? [
              fig("Första ordernummer", numbers.first, "count"),
              fig("Sista ordernummer", numbers.last, "count"),
              fig("Saknade nummer", numbers.missing, "count"),
            ]
          : []),
      ],
      externalIds: [...gapNumbers, ...duplicateExternalIds],
    }),
  };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Luckorna som text: "104, 106 och 110–112". */
export function gapsText(gaps: readonly OrderNumberGap[]): string {
  return listText(gaps.map((g) => (g.from === g.to ? String(g.from) : `${g.from}–${g.to}`)));
}

/**
 * Slutsatsen överst i bokföringsrapporten, en mening. Reglerna i ordning:
 * 1. Inga order → "Ingen försäljning under …" (+ butiksersättning att bokföra om > 0).
 * 2. Kontrollsumma som inte stämmer → det felet.
 * 3. Luckor i nummerserien → antal och vilka (högst fem luckor räknas upp).
 * 4. Dubbletter av ordernummer.
 * 5. Order utan inköpspris → antal.
 * 6. Annars: försäljningen och att serien är komplett.
 */
function accountantConclusion(
  period: Period,
  totals: AccountantTotals,
  rec: Reconciliation,
  vatRateBp: number,
): Conclusion {
  const scope = { period };
  const base = [
    fig("Inkl. moms", totals.grossOre, "ore"),
    fig("Exkl. moms", totals.netOre, "ore"),
    fig("Antal order", totals.orders, "count"),
  ];
  const sales =
    vatRateBp === 0
      ? `Försäljningen ${periodText(period)} var ${krText(totals.grossOre)} (ingen moms) på ${ordersText(totals.orders)}`
      : `Försäljningen ${periodText(period)} var ${krText(totals.grossOre)} inkl. moms (${krText(totals.netOre)} exkl. moms, moms ${pctText(vatRateBp)}) på ${ordersText(totals.orders)}`;

  if (totals.orders === 0) {
    const tail =
      totals.compensationOre > 0
        ? `; butiksersättning ${krText(totals.compensationOre)} ska ändå bokföras`
        : "";
    return {
      text: `Ingen försäljning under ${periodText(period)}${tail}.`,
      ruleId: "accountant.no_sales",
      evidence: evidence({
        rule: "Inga order i perioden.",
        scope,
        orderCount: 0,
        figures: [fig("Butiksersättning", totals.compensationOre, "ore")],
      }),
    };
  }
  const failed = rec.checks.find((c) => !c.ok);
  if (failed) {
    return {
      text: `${sales}, men kontrollen "${failed.label}" stämmer inte (${failed.expected} mot ${failed.actual}).`,
      ruleId: "accountant.check_failed",
      evidence: evidence({
        rule: "Kontrollsummorna ska vara lika.",
        scope,
        orderCount: totals.orders,
        figures: [
          ...base,
          fig("Förväntat", failed.expected, failed.unit),
          fig("Faktiskt", failed.actual, failed.unit),
        ],
      }),
    };
  }
  const n = rec.numbers;
  if (n && n.missing > 0) {
    const shown = n.gaps.slice(0, 5);
    const more = n.gaps.length > shown.length ? ` m.fl.` : "";
    const what = n.missing === 1 ? "1 ordernummer saknas" : `${n.missing} ordernummer saknas`;
    return {
      text: `${sales}; ${what} i serien ${n.first}–${n.last} (${gapsText(shown)}${more}) och behöver kontrolleras i källan.`,
      ruleId: "accountant.gaps",
      evidence: rec.evidence,
    };
  }
  if (rec.duplicateExternalIds.length > 0) {
    return {
      text: `${sales}; ordernummer ${listText(rec.duplicateExternalIds.slice(0, 5))} förekommer på flera order och behöver kontrolleras.`,
      ruleId: "accountant.duplicates",
      evidence: rec.evidence,
    };
  }
  const series = n ? `, ordernummer ${n.first}–${n.last} utan luckor` : "";
  if (totals.unpricedOrders > 0) {
    return {
      text: `${sales}${series}, men ${ordersText(totals.unpricedOrders)} saknar inköpspris och inköpet för dem är inte med.`,
      ruleId: "accountant.unpriced",
      evidence: evidence({
        rule: "Order utan inköpspris har inget inköp.",
        scope,
        orderCount: totals.orders,
        figures: [...base, fig("Order utan inköpspris", totals.unpricedOrders, "count")],
      }),
    };
  }
  return {
    text: `${sales}${series}.`,
    ruleId: "accountant.ok",
    evidence: evidence({
      rule: "Alla kontroller stämmer och nummerserien är komplett.",
      scope,
      orderCount: totals.orders,
      figures: base,
    }),
  };
}
