/**
 * Kassaflöde per månad eller vecka: faktiskt (datum ≤ i dag) och prognos (datum > i dag).
 *
 * In: utbetalningar från leverantören.
 * Ut: inköp, butiksersättningar (provision + hyra) och fasta kostnader.
 *
 * Regler:
 * - Faktiska utbetalningar räknas på utbetalningsdagen (`paidOn`, annars periodens sista dag).
 * - Väntade utbetalningar: perioderna efter den sista registrerade utbetalningen, i samma rytm
 *   (månad, vecka eller antal dagar) och med samma fördröjning som den senaste utbetalningen.
 *   Belopp = känd försäljning (dagar före i dag) + prognos (snittet i fönstret × dagar kvar)
 *   − avgifter. Snittet: försäljning i fönstret × dagar / fönstrets dagar, avrundat en gång
 *   per period. Har utbetalningsdagen redan passerat utan registrerad utbetalning läggs
 *   beloppet som försenat på dagen efter i dag.
 * - Butiksersättning för månad M = provision på månadens order (domänens `storeCompensation`)
 *   + månadens hyra enligt avtal (domänens `rentByStoreMonth`), betald månad M + fördröjning
 *   (standard 1) på vald dag (standard månadens sista). Provision för dagar från i dag
 *   prognostiseras som snittprovisionen i fönstret × dagar. Anges faktiska butiksbetalningar
 *   ersätter varje betalning den beräknade ersättningen för sin butik och månad (`month`, annars
 *   månaden vars ersättning förfaller samma kalendermånad), även när den betalas i förväg.
 *   En förfallen ersättning utan betalning är obetald och läggs som försenad i morgon.
 * - Inköp: betalda inköp på sitt datum; planerade inköp som prognos (passerat datum →
 *   dagen efter i dag, markerat försenat).
 * - Fasta kostnader på sina betalningsdagar (`fixedCostOccurrences`). Före i dag räknas de
 *   som betalda enligt plan.
 */

import {
  addDays,
  applyBp,
  assertIsoDate,
  assertPeriod,
  cardFees,
  dailyUnits,
  daysBetween,
  daysInMonth,
  DomainError,
  eachDay,
  eachMonth,
  isIsoDate,
  maxDate,
  minDate,
  monthEnd,
  monthPeriod,
  monthStart,
  addMonths,
  parseIsoMonth,
  periodDays,
  rentByStoreMonth,
  roundHalfUp,
  salesVelocity,
  storeCompensation,
  weekOf,
  type IsoDate,
  type IsoMonth,
  type OrderLine,
  type Period,
  type Settings,
} from "@/domain";
import { day, kr, monthName, periodText, plural } from "../todos/text";
import {
  addOre,
  assertCount,
  assertId,
  assertOre,
  compareStrings,
  countFigure,
  daysFigure,
  financeEvidence,
  oreFigure,
  toPeriod,
  type FinanceEvidence,
} from "../reconciliation/common";
import { fixedCostLabel, fixedCostOccurrences } from "./fixed-costs";
import type {
  CashBucket,
  CashFlowKind,
  CashflowInput,
  CashflowResult,
  CashForecastBasis,
  CashItem,
  CashLines,
  CashPhase,
  PayoutCycle,
  StorePayment,
} from "./types";

/** Standardvärden. */
export const CASHFLOW_DEFAULTS = {
  forecastWindowDays: 28,
  storeCompensationLagMonths: 1,
} as const;

/** Tomma rader (alla belopp 0). */
export const EMPTY_CASH_LINES: CashLines = {
  payoutsOre: 0,
  purchasesOre: 0,
  storeCompensationOre: 0,
  fixedCostsOre: 0,
  inOre: 0,
  outOre: 0,
  netOre: 0,
};

/** Summerar flöden till rader per typ. */
export function sumCashItems(items: readonly CashItem[]): CashLines {
  let payouts = 0;
  let purchases = 0;
  let store = 0;
  let fixed = 0;
  for (const i of items) {
    switch (i.kind) {
      case "payout":
        payouts = addOre(payouts, i.amountOre);
        break;
      case "purchase":
        purchases = addOre(purchases, i.amountOre);
        break;
      case "store-compensation":
        store = addOre(store, i.amountOre);
        break;
      case "fixed-cost":
        fixed = addOre(fixed, i.amountOre);
        break;
    }
  }
  const out = addOre(addOre(purchases, store), fixed);
  return {
    payoutsOre: payouts,
    purchasesOre: purchases,
    storeCompensationOre: store,
    fixedCostsOre: fixed,
    inOre: payouts,
    outOre: out,
    netOre: payouts - out,
  };
}

function cycleText(cycle: PayoutCycle): string {
  if (cycle === "month") return "månadsvis";
  if (cycle === "week") return "veckovis";
  return `var ${cycle.days}:e dag`;
}

/** Nästa avräkningsperiod som börjar `start` i given rytm. */
function settlementPeriod(start: IsoDate, cycle: PayoutCycle): Period {
  if (cycle === "month") return { start, end: monthEnd(start.slice(0, 7)) };
  if (cycle === "week") return { start, end: weekOf(start).end };
  return { start, end: addDays(start, cycle.days - 1) };
}

/**
 * Månaden som en butiksbetalning avser: `month` om den anges, annars den månad vars
 * ersättning förfaller samma kalendermånad som betalningen (betalningens månad − fördröjningen).
 * Med fördröjning 1: betalt 10 nov. → oktober. En sen betalning (t.ex. oktober betald i
 * december) behöver därför `month`.
 */
export function storePaymentMonth(payment: StorePayment, lagMonths: number): IsoMonth {
  if (payment.month !== undefined && payment.month !== null) {
    try {
      parseIsoMonth(payment.month);
    } catch {
      throw new DomainError(
        "invalid_date",
        `Månaden för butiksbetalning ${payment.id} måste vara ÅÅÅÅ-MM, fick ${JSON.stringify(payment.month)}.`,
      );
    }
    return payment.month;
  }
  return addMonths(payment.paidOn.slice(0, 7), -lagMonths);
}

/** Rytmen för en period: hel kalendermånad → månad, måndag–söndag → vecka, annars antal dagar. */
export function inferPayoutCycle(period: Period): PayoutCycle {
  const month = period.start.slice(0, 7);
  if (period.start === monthStart(month) && period.end === monthEnd(month)) return "month";
  const w = weekOf(period.start);
  if (period.start === w.start && period.end === w.end) return "week";
  return { days: periodDays(period) };
}

function validateCycle(cycle: PayoutCycle): PayoutCycle {
  if (cycle === "month" || cycle === "week") return cycle;
  if (cycle && typeof cycle === "object" && Number.isSafeInteger(cycle.days) && cycle.days >= 1) {
    return { days: cycle.days };
  }
  throw new DomainError(
    "invalid_input",
    `Utbetalningsrytmen måste vara 'month', 'week' eller { days ≥ 1 }, fick ${JSON.stringify(cycle)}.`,
  );
}

/**
 * Kassaflöde per månad eller vecka i `range`, faktiskt t.o.m. `asOf` och prognos därefter.
 * Varje bucket har faktiskt, prognos och totalt per typ (utbetalningar in; inköp,
 * butiksersättning och fasta kostnader ut), saldo om ingående saldo angavs, en mening och
 * underlag. Kastar `DomainError` vid ogiltig indata.
 */
export function cashflow(input: CashflowInput): CashflowResult {
  assertPeriod(input.range);
  assertIsoDate(input.asOf, "I dag");
  const { range, asOf } = input;
  if (input.granularity !== "month" && input.granularity !== "week") {
    throw new DomainError(
      "invalid_input",
      `Indelningen måste vara 'month' eller 'week', fick ${JSON.stringify(input.granularity)}.`,
    );
  }
  const options = input.options ?? {};
  const windowLength = assertCount(
    options.forecastWindowDays ?? CASHFLOW_DEFAULTS.forecastWindowDays,
    "Prognosfönstret",
  );
  if (windowLength < 1) {
    throw new DomainError("invalid_input", "Prognosfönstret måste vara minst 1 dag.");
  }
  const settings: Settings = input.settings;
  const feeBp = options.feeBp ?? settings.cardFeeBp;
  const fixedFee = assertOre(options.fixedFeePerOrderOre ?? 0, "Fast avgift per order");
  const feeSettings: Settings = { vatRateBp: settings.vatRateBp, cardFeeBp: feeBp };
  const compLag = assertCount(
    options.storeCompensationLagMonths ?? CASHFLOW_DEFAULTS.storeCompensationLagMonths,
    "Fördröjningen för butiksersättning",
  );
  const dueDay = options.storeCompensationDueDay ?? null;
  if (dueDay !== null && (!Number.isSafeInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
    throw new DomainError("invalid_input", `Betaldagen måste vara 1–31, fick ${dueDay}.`);
  }
  const opening =
    options.openingBalanceOre === undefined || options.openingBalanceOre === null
      ? null
      : assertOre(options.openingBalanceOre, "Ingående saldo", true);

  const orders = [...input.orders].sort((a, b) =>
    a.businessDate !== b.businessDate
      ? a.businessDate < b.businessDate
        ? -1
        : 1
      : compareStrings(a.id, b.id),
  );
  const ordersByDate = new Map<IsoDate, OrderLine[]>();
  for (const o of orders) {
    if (!isIsoDate(o.businessDate)) {
      throw new DomainError("invalid_date", `Affärsdatum för order ${o.externalId} är ogiltigt.`);
    }
    const list = ordersByDate.get(o.businessDate);
    if (list) list.push(o);
    else ordersByDate.set(o.businessDate, [o]);
  }
  const ordersIn = (p: Period): OrderLine[] =>
    p.end < p.start ? [] : eachDay(p.start, p.end).flatMap((d) => ordersByDate.get(d) ?? []);
  const sales = (list: readonly OrderLine[]): number =>
    list.reduce((s, o) => addOre(s, o.amountOre), 0);
  const fees = (list: readonly OrderLine[]): number =>
    addOre(cardFees(list, feeSettings), fixedFee * list.length);
  const phaseOf = (date: IsoDate): CashPhase => (date <= asOf ? "actual" : "forecast");
  const tomorrow = addDays(asOf, 1);
  const yesterday = addDays(asOf, -1);
  const econ = {
    prices: input.prices,
    agreements: input.agreements,
    placements: input.placements,
    settings: input.settings,
  };

  // --- Prognosunderlag: snittet i fönstret som slutar i går. ---
  const firstOrder = orders[0]?.businessDate;
  const velocity = salesVelocity(dailyUnits(orders), {
    asOf: yesterday,
    days: windowLength,
    ...(firstOrder !== undefined ? { activeFrom: firstOrder } : {}),
  });
  // Utan någon order alls finns inget att bygga prognosen på.
  const window: Period | null =
    velocity.days > 0 && firstOrder !== undefined
      ? { start: velocity.start, end: velocity.end }
      : null;
  const windowDays = window === null ? 0 : velocity.days;
  const windowOrders = window ? ordersIn(window) : [];
  const windowSales = sales(windowOrders);
  const windowComp = window
    ? storeCompensation({ ...econ, orders: windowOrders, period: window })
    : null;
  const windowCommission = windowComp?.commissionOre ?? 0;
  const windowStores = windowComp?.stores ?? [];
  /** Prognos för `days` dagar: round(fönstrets värde × days / fönstrets dagar). */
  const project = (windowValue: number, days: number): number =>
    days <= 0 || windowDays === 0 ? 0 : roundHalfUp(BigInt(windowValue) * BigInt(days), windowDays);

  const items: CashItem[] = [];
  const inRange = (d: IsoDate): boolean => d >= range.start && d <= range.end;
  const push = (item: Omit<CashItem, "phase"> & { phase?: CashPhase }): void => {
    if (!inRange(item.date)) return;
    items.push({ ...item, phase: item.phase ?? phaseOf(item.date) });
  };

  // --- Faktiska och aviserade utbetalningar. ---
  const payouts = input.payouts.map((p) => {
    const reference = assertId(p?.reference, "Utbetalningens referens");
    const period = toPeriod(p.period, `Perioden för ${reference}`);
    assertOre(p.amountOre, `Utbetalt belopp för ${reference}`, true);
    const paidOn = p.paidOn ?? period.end;
    assertIsoDate(paidOn, `Utbetalningsdag för ${reference}`);
    return { reference, period, paidOn, amountOre: p.amountOre };
  });
  payouts.sort((a, b) =>
    a.period.end !== b.period.end
      ? a.period.end < b.period.end
        ? -1
        : 1
      : compareStrings(a.reference, b.reference),
  );
  for (const p of payouts) {
    push({
      key: `payout:${p.reference}:${p.period.start}`,
      kind: "payout",
      direction: "in",
      date: p.paidOn,
      amountOre: p.amountOre,
      overdue: false,
      label: `Utbetalning ${p.reference} för ${periodText(p.period)}`,
      evidence: financeEvidence({
        rule: "Registrerad utbetalning på utbetalningsdagen.",
        period: p.period,
        payoutReferences: [p.reference],
        dates: [p.paidOn],
        figures: [oreFigure("amountOre", "Utbetalt", p.amountOre)],
      }),
    });
  }

  // --- Väntade utbetalningar. ---
  const latest = payouts[payouts.length - 1];
  const cycle = validateCycle(
    options.payoutCycle ?? (latest ? inferPayoutCycle(latest.period) : "month"),
  );
  const lag = assertCount(
    options.payoutLagDays ??
      (latest ? Math.max(0, daysBetween(latest.period.end, latest.paidOn)) : 0),
    "Fördröjningen för utbetalningar",
  );
  let cursor: IsoDate | null = latest
    ? addDays(latest.period.end, 1)
    : firstOrder !== undefined
      ? minDate(firstOrder, range.start)
      : range.start;
  for (let guard = 0; cursor !== null && guard < 10_000; guard++) {
    const s = settlementPeriod(cursor, cycle);
    const payDate = addDays(s.end, lag);
    if (payDate > range.end) break;
    cursor = addDays(s.end, 1);
    const knownOrders = ordersIn({ start: s.start, end: minDate(s.end, yesterday) });
    const forecastDays = s.end < asOf ? 0 : daysBetween(maxDate(s.start, asOf), s.end) + 1;
    const knownSales = sales(knownOrders);
    const knownFees = fees(knownOrders);
    const forecastSales = project(windowSales, forecastDays);
    const forecastOrders = project(windowOrders.length, forecastDays);
    const forecastFees = addOre(
      feeBp === 0 ? 0 : applyBp(forecastSales, feeBp),
      fixedFee * forecastOrders,
    );
    const amount = knownSales - knownFees + forecastSales - forecastFees;
    if (amount === 0) continue;
    const overdue = payDate <= asOf;
    // Utan källa för utbetalningar är en passerad utbetalning okänd, inte försenad.
    if (overdue && options.payoutsTracked === false) continue;
    push({
      key: `payout-forecast:${s.start}`,
      kind: "payout",
      direction: "in",
      date: overdue ? tomorrow : payDate,
      phase: "forecast",
      amountOre: amount,
      overdue,
      ...(overdue ? { dueDate: payDate } : {}),
      label: overdue
        ? `Utbetalning för ${periodText(s)} väntades ${day(payDate)} men saknas`
        : `Väntad utbetalning för ${periodText(s)}`,
      evidence: financeEvidence({
        rule: "Väntad utbetalning = känd försäljning − avgifter + snittförsäljningen i fönstret × dagar kvar − avgifter.",
        period: s,
        orderIds: knownOrders.map((o) => o.id),
        dates: [payDate],
        figures: [
          oreFigure("knownSalesOre", "Känd försäljning", knownSales),
          oreFigure("forecastSalesOre", "Prognos för resten av perioden", forecastSales),
          oreFigure("feesOre", "Avgifter", knownFees + forecastFees),
          daysFigure("forecastDays", "Dagar med prognos", forecastDays),
        ],
      }),
    });
  }

  // --- Butiksersättning. ---
  const dueDateOf = (month: IsoMonth): IsoDate => {
    const payMonth = addMonths(month, compLag);
    const d = dueDay === null ? daysInMonth(payMonth) : Math.min(dueDay, daysInMonth(payMonth));
    return `${payMonth}-${d < 10 ? "0" : ""}${d}`;
  };
  const storePayments = input.storePayments;
  /** Butik och månad ('<butik>|<månad>') som har en registrerad betalning t.o.m. i dag. */
  const settled = new Set<string>();
  if (storePayments !== undefined) {
    const sortedPayments = [...storePayments].sort(
      (a, b) =>
        compareStrings(a?.paidOn ?? "", b?.paidOn ?? "") ||
        compareStrings(a?.id ?? "", b?.id ?? ""),
    );
    for (const sp of sortedPayments) {
      assertId(sp?.id, "Butiksbetalningens id");
      assertId(sp.storeId, `Butik för butiksbetalning ${sp.id}`);
      assertIsoDate(sp.paidOn, `Betaldag för butiksbetalning ${sp.id}`);
      assertOre(sp.amountOre, `Beloppet för butiksbetalning ${sp.id}`);
      if (sp.paidOn > asOf) continue;
      const month = storePaymentMonth(sp, compLag);
      settled.add(`${sp.storeId}|${month}`);
      push({
        key: `store-payment:${sp.id}`,
        kind: "store-compensation",
        direction: "out",
        date: sp.paidOn,
        amountOre: sp.amountOre,
        overdue: false,
        label: `Betalning till butik för ${monthName(month)}`,
        evidence: financeEvidence({
          rule: "Registrerad betalning till butiken. Den ersätter den beräknade ersättningen för butiken och månaden.",
          period: monthPeriod(month),
          storeIds: [sp.storeId],
          dates: [sp.paidOn, dueDateOf(month)],
          figures: [oreFigure("amountOre", "Betalt", sp.amountOre)],
        }),
      });
    }
  }
  const windowCommissionByStore = new Map<string, number>(
    windowStores.map((s) => [s.storeId, s.commissionOre]),
  );
  for (const month of eachMonth(
    monthStart(addMonths(range.start.slice(0, 7), -compLag - 1)),
    range.end,
  )) {
    const due = dueDateOf(month);
    if (!inRange(due)) continue;
    const mp = monthPeriod(month);
    const knownPeriod: Period = { start: mp.start, end: minDate(mp.end, yesterday) };
    const known =
      knownPeriod.end >= knownPeriod.start
        ? storeCompensation({ ...econ, orders: ordersIn(knownPeriod), period: knownPeriod })
        : null;
    const rents = rentByStoreMonth(input.agreements, mp);
    const rent = rents.reduce((s, r) => addOre(s, r.rentOre), 0);
    const forecastDays = mp.end < asOf ? 0 : daysBetween(maxDate(mp.start, asOf), mp.end) + 1;
    const forecastCommission = project(windowCommission, forecastDays);
    const commission = addOre(known?.commissionOre ?? 0, forecastCommission);
    const fullTotal = addOre(commission, rent);
    if (fullTotal === 0) continue;

    // Varje butiks del: känd provision + hyra + prognostiserad provision.
    const share = new Map<string, number>();
    const addShare = (storeId: string, value: number): void => {
      share.set(storeId, addOre(share.get(storeId) ?? 0, value));
    };
    for (const s of known?.stores ?? []) addShare(s.storeId, s.commissionOre);
    for (const r of rents) addShare(r.storeId, r.rentOre);
    if (forecastDays > 0) {
      for (const [storeId, c] of windowCommissionByStore)
        addShare(storeId, project(c, forecastDays));
    }
    const owed = [...share.entries()].filter(([, v]) => v !== 0).map(([id]) => id);
    const paidStores = owed.filter((id) => settled.has(`${id}|${month}`));
    const openStores = owed.filter((id) => !settled.has(`${id}|${month}`));
    // Betalda butikers del dras bort; betalar alla butiker försvinner beräkningen helt.
    if (owed.length > 0 && openStores.length === 0) continue;
    const paidShare = paidStores.reduce((s, id) => addOre(s, share.get(id) ?? 0), 0);
    const total = Math.max(0, fullTotal - paidShare);
    if (total === 0) continue;

    // Med registrerade butiksbetalningar är en förfallen ersättning utan betalning obetald:
    // den läggs som försenad i morgon (som uteblivna utbetalningar och planerade inköp).
    const overdue = storePayments !== undefined && due <= asOf;
    const storeIds = openStores.length > 0 ? openStores : rents.map((r) => r.storeId);
    push({
      key: `store-compensation:${month}`,
      kind: "store-compensation",
      direction: "out",
      date: overdue ? tomorrow : due,
      ...(overdue ? { phase: "forecast" as const } : {}),
      amountOre: total,
      overdue,
      ...(overdue ? { dueDate: due } : {}),
      label: overdue
        ? `Butiksersättning för ${monthName(month)} förföll ${day(due)} men är inte betald (${kr(total)})`
        : rent !== 0
          ? `Butiksersättning för ${monthName(month)} (provision ${kr(commission)}, hyra ${kr(rent)})`
          : `Butiksersättning för ${monthName(month)} (${kr(commission)})`,
      evidence: financeEvidence({
        rule: overdue
          ? `Butiksersättning = provision på månadens order${rent !== 0 ? " + månadens hyra enligt avtal" : ""}. Förfallodagen har passerat utan registrerad betalning till butiken, så beloppet väntas i morgon.`
          : `Butiksersättning = provision på månadens order${rent !== 0 ? " + månadens hyra enligt avtal" : ""}; provision för dagar från i dag enligt snittet i fönstret.`,
        period: mp,
        storeIds,
        dates: [due],
        figures: [
          oreFigure("commissionOre", "Provision", commission),
          oreFigure("forecastCommissionOre", "Varav prognos", forecastCommission),
          ...(rent !== 0 ? [oreFigure("rentOre", "Hyra", rent)] : []),
          ...(paidShare > 0 ? [oreFigure("paidOre", "Redan betalt till butiker", paidShare)] : []),
        ],
      }),
    });
  }

  // --- Inköp. ---
  const purchaseIds = new Set<string>();
  for (const p of input.purchases) {
    const id = assertId(p?.id, "Inköpets id");
    if (purchaseIds.has(id)) {
      throw new DomainError("invalid_input", `Inköpet ${id} finns två gånger.`);
    }
    purchaseIds.add(id);
    assertIsoDate(p.date, `Datum för inköp ${id}`);
    assertOre(p.amountOre, `Beloppet för inköp ${id}`);
    if (p.status !== "paid" && p.status !== "planned") {
      throw new DomainError(
        "invalid_input",
        `Status för inköp ${id} måste vara paid eller planned.`,
      );
    }
    const planned = p.status === "planned";
    const overdue = planned && p.date <= asOf;
    const date = overdue ? tomorrow : p.date;
    push({
      key: `purchase:${id}`,
      kind: "purchase",
      direction: "out",
      date,
      phase: planned ? "forecast" : phaseOf(date),
      amountOre: p.amountOre,
      overdue,
      ...(overdue ? { dueDate: p.date } : {}),
      label: `${planned ? "Planerat inköp" : "Inköp"}${p.label ? ` ${p.label}` : ""}`,
      evidence: financeEvidence({
        rule: planned ? "Planerat inköp på planerad betaldag." : "Betalt inköp på betaldagen.",
        purchaseIds: [id],
        dates: [p.date],
        figures: [oreFigure("amountOre", "Belopp", p.amountOre)],
      }),
    });
  }

  // --- Fasta kostnader. ---
  const costIds = new Set<string>();
  for (const cost of input.fixedCosts) {
    if (costIds.has(cost?.id)) {
      throw new DomainError("invalid_input", `Den fasta kostnaden ${cost.id} finns två gånger.`);
    }
    costIds.add(cost?.id);
    for (const occ of fixedCostOccurrences(cost, range.end)) {
      push({
        key: `fixed:${cost.id}:${occ.date}`,
        kind: "fixed-cost",
        direction: "out",
        date: occ.date,
        amountOre: occ.amountOre,
        overdue: false,
        label: fixedCostLabel(cost),
        evidence: financeEvidence({
          rule: "Fast kostnad på sin betalningsdag; före i dag räknas den som betald enligt plan.",
          period: occ.coverage,
          fixedCostIds: [cost.id],
          machineIds: cost.machineId ? [cost.machineId] : [],
          dates: [occ.date],
          figures: [oreFigure("amountOre", "Belopp", occ.amountOre)],
        }),
      });
    }
  }

  items.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareStrings(a.key, b.key),
  );

  // --- Buckets. ---
  const buckets: CashBucket[] = [];
  let balance = opening;
  let lowest: { bucketKey: string; balanceOre: number } | null = null;
  for (const b of bucketRanges(range, input.granularity)) {
    const inBucket = items.filter((i) => i.date >= b.range.start && i.date <= b.range.end);
    const actual = sumCashItems(inBucket.filter((i) => i.phase === "actual"));
    const forecast = sumCashItems(inBucket.filter((i) => i.phase === "forecast"));
    const total = sumCashItems(inBucket);
    const phase =
      b.range.end <= asOf ? "actual" : b.range.start > asOf ? "forecast" : ("mixed" as const);
    const openingBalance = balance;
    const closing = balance === null ? null : balance + total.netOre;
    balance = closing;
    if (closing !== null && (lowest === null || closing < lowest.balanceOre)) {
      lowest = { bucketKey: b.key, balanceOre: closing };
    }
    const label = bucketLabel(b.key, b.range, input.granularity);
    const prognosis =
      phase === "forecast"
        ? " (prognos)"
        : phase === "mixed"
          ? ` (prognos från ${day(tomorrow)})`
          : "";
    buckets.push({
      key: b.key,
      range: b.range,
      partial: b.partial,
      phase,
      actual,
      forecast,
      total,
      openingBalanceOre: openingBalance,
      closingBalanceOre: closing,
      itemKeys: inBucket.map((i) => i.key),
      summary: `${label}${prognosis}: in ${kr(total.inOre)}, ut ${kr(total.outOre)}, netto ${signedKr(total.netOre)}${
        closing === null ? "" : `, saldo ${kr(closing)}`
      }.`,
      evidence: mergeEvidence(
        inBucket.map((i) => i.evidence),
        b.range,
        [
          oreFigure("inOre", "In", total.inOre),
          oreFigure("outOre", "Ut", total.outOre),
          oreFigure("netOre", "Netto", total.netOre),
          countFigure("items", "Antal flöden", inBucket.length),
        ],
      ),
    });
  }

  const actual = sumCashItems(items.filter((i) => i.phase === "actual"));
  const forecast = sumCashItems(items.filter((i) => i.phase === "forecast"));
  const total = sumCashItems(items);
  const basis: CashForecastBasis = {
    window,
    windowDays,
    windowOrders: windowOrders.length,
    windowSalesOre: windowSales,
    windowCommissionOre: windowCommission,
    payoutCycle: cycle,
    payoutLagDays: lag,
  };
  const perDay = windowDays === 0 ? 0 : roundHalfUp(windowSales, windowDays);
  const assumptions = [
    window === null
      ? "Det finns ingen försäljning att bygga prognosen på; väntade utbetalningar räknas bara på känd försäljning."
      : `Prognosen bygger på försäljningen ${periodText(window)} (${plural(windowDays, "dag", "dagar")}): ${kr(
          windowSales,
        )}, i snitt ${kr(perDay)} per dag.`,
    `Utbetalningar kommer ${cycleText(cycle)}, ${plural(lag, "dag", "dagar")} efter periodens slut${
      latest ? ` (som ${latest.reference})` : ""
    }.`,
    `Butiksersättningen för en månad betalas ${
      compLag === 0 ? "samma månad" : compLag === 1 ? "månaden efter" : `${compLag} månader senare`
    }, ${dueDay === null ? "sista dagen" : `den ${dueDay}:e`}.`,
    // Bara när det finns fasta kostnader (annars är inköpet den enda kostnaden).
    ...(input.fixedCosts.length > 0
      ? ["Fasta kostnader före i dag räknas som betalda enligt plan."]
      : []),
  ];
  const overdueItems = items.filter((i) => i.overdue);
  const parts = [
    `${periodText(range)}: in ${kr(total.inOre)}, ut ${kr(total.outOre)}, netto ${signedKr(total.netOre)}.`,
  ];
  if (forecast.inOre !== 0 || forecast.outOre !== 0) {
    parts.push(`Varav prognos från ${day(tomorrow)}: netto ${signedKr(forecast.netOre)}.`);
  }
  if (lowest !== null && lowest.balanceOre < 0) {
    const b = buckets.find((x) => x.key === lowest!.bucketKey)!;
    parts.push(
      `Saldot blir negativt i ${bucketLabel(b.key, b.range, input.granularity, false)}: ${kr(lowest.balanceOre)}.`,
    );
  }
  if (overdueItems.length > 0) {
    parts.push(
      `${plural(overdueItems.length, "post", "poster")} ${
        overdueItems.length === 1 ? "är försenad" : "är försenade"
      } (${overdueItems.map((i) => i.label).join("; ")}).`,
    );
  }

  return {
    range,
    asOf,
    granularity: input.granularity,
    buckets,
    items,
    totals: { actual, forecast, total },
    basis,
    assumptions,
    lowestBalance: lowest,
    summary: parts.join(" "),
    evidence: mergeEvidence(
      items.map((i) => i.evidence),
      range,
      [
        oreFigure("inOre", "In", total.inOre),
        oreFigure("outOre", "Ut", total.outOre),
        oreFigure("netOre", "Netto", total.netOre),
        oreFigure("forecastNetOre", "Varav prognos", forecast.netOre),
      ],
    ),
  };
}

function signedKr(ore: number): string {
  return ore > 0 ? `+${kr(ore)}` : kr(ore);
}

function bucketRanges(
  range: Period,
  granularity: "month" | "week",
): Array<{ key: string; range: Period; partial: boolean }> {
  const out: Array<{ key: string; range: Period; partial: boolean }> = [];
  if (granularity === "month") {
    for (const m of eachMonth(range.start, range.end)) {
      const full = monthPeriod(m);
      const r = { start: maxDate(full.start, range.start), end: minDate(full.end, range.end) };
      out.push({ key: m, range: r, partial: r.start !== full.start || r.end !== full.end });
    }
    return out;
  }
  let d = range.start;
  while (d <= range.end) {
    const w = weekOf(d);
    const r = { start: maxDate(w.start, range.start), end: minDate(w.end, range.end) };
    out.push({ key: w.key, range: r, partial: r.start !== w.start || r.end !== w.end });
    d = addDays(w.end, 1);
  }
  return out;
}

/** "November 2026" / "Vecka 45 (2–8 nov.)"; med `capital = false` "november 2026" / "vecka 45 (…)". */
function bucketLabel(
  key: string,
  range: Period,
  granularity: "month" | "week",
  capital = true,
): string {
  const text =
    granularity === "month"
      ? `${monthName(key)} ${key.slice(0, 4)}`
      : `vecka ${Number(key.slice(6))} (${periodText(range)})`;
  return capital ? `${text.charAt(0).toLocaleUpperCase("sv-SE")}${text.slice(1)}` : text;
}

function mergeEvidence(
  list: readonly FinanceEvidence[],
  period: Period,
  figures: FinanceEvidence["figures"],
): FinanceEvidence {
  return financeEvidence({
    rule: "Summan av flödena i perioden: in = utbetalningar, ut = inköp + butiksersättning + fasta kostnader.",
    period,
    orderIds: list.flatMap((e) => e.orderIds),
    dates: list.flatMap((e) => e.dates),
    machineIds: list.flatMap((e) => e.machineIds),
    storeIds: list.flatMap((e) => e.storeIds),
    payoutReferences: list.flatMap((e) => e.payoutReferences),
    fixedCostIds: list.flatMap((e) => e.fixedCostIds),
    purchaseIds: list.flatMap((e) => e.purchaseIds),
    figures,
  });
}

/** Typerna i den ordning de visas. */
export const CASH_FLOW_KINDS: readonly CashFlowKind[] = [
  "payout",
  "purchase",
  "store-compensation",
  "fixed-cost",
];
