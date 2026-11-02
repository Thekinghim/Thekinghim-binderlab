/**
 * Avstämning: leverantörens utbetalningar mot vår försäljning.
 *
 * Regel per utbetalning (perioden räknas i affärsdagar, svensk tid):
 *
 *   väntad utbetalning = försäljning − avgifter − återbetalningar
 *   skillnad           = utbetalt − väntad utbetalning
 *
 * - Försäljning = betalt belopp (inkl. moms) för våra order med affärsdatum i perioden. En dag
 *   som redan täcks av en tidigare utbetalning räknas bara där, så att varje order väntas en gång.
 * - Avgifter = Σ round(belopp × avgift_bp / 10 000) + fast avgift per order (domänens
 *   `cardFees`, avgiften är i dag 0).
 * - Återbetalningar = våra kända återbetalningar med datum i perioden.
 *
 * Skillnaden delas upp i avvikelser som tillsammans (plus en eventuell avrundning inom
 * toleransen) summerar exakt till skillnaden:
 *
 *   skillnad = (leverantörens försäljning − vår försäljning)
 *            − (leverantörens avgifter − väntade avgifter)
 *            − (leverantörens återbetalningar − våra återbetalningar)
 *
 * där leverantörens försäljning = utbetalt + avgifter + återbetalningar. Försäljningsgapet
 * förklaras i ordning: dubbletter i vår import, (med specifikation) order för order: dubbel
 * utbetalning, beloppsavvikelse, tidszon, annan period, saknade order; (utan specifikation)
 * tidszon för order nära midnatt (bara om den minskar skillnaden, märkt 'inferred'),
 * överlappande perioder och till sist saknade order om resten är exakt ett antal order à ett
 * vanligt pris. Avgiftsavvikelse och rest som tillsammans ligger inom toleransen räknas som
 * avrundning. Det som återstår är oförklarat.
 */

import {
  addDays,
  cardFees,
  DomainError,
  eachDay,
  inPeriod,
  isIsoDate,
  monthOf,
  type IsoDate,
  type IsoMonth,
  type Period,
  type Settings,
} from "@/domain";
import { DEFAULT_TIME_ZONE, businessDateAt, clockTimeAt, tryParseInstant } from "../todos/time";
import { formatInt, MINUS, NBSP } from "@/lib/format";

import { day, kr, krExact, periodText, plural } from "../todos/text";
import type { AnalyticsOrder } from "../todos/types";
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
} from "./common";
import type {
  Deviation,
  DeviationConfidence,
  DeviationKind,
  DeviationResolution,
  Payout,
  PayoutLine,
  PayoutReconciliation,
  PayoutStatus,
  ReconciliationInput,
  ReconciliationResult,
  Refund,
} from "./types";

/** Ordningen som avvikelserna visas i. */
export const DEVIATION_ORDER: readonly DeviationKind[] = [
  "missing-in-payout",
  "missing-in-sales",
  "duplicate-payout",
  "duplicate-order",
  "amount-mismatch",
  "fee",
  "refund",
  "period-shift",
  "timezone-shift",
  "missing-payout",
  "unexplained",
];

/** Standardvärden för inställningarna. */
export const RECONCILIATION_DEFAULTS = {
  toleranceOre: 0,
  fixedFeePerOrderOre: 0,
  maxInferredOrders: 20,
} as const;

/** Högst så många ordernummer räknas upp i en text; resten finns i underlaget. */
const MAX_LISTED = 5;

/**
 * Avgiftsinställningen i löptext, i procent och inte i baspunkter: 175 bp → "1,75 % av
 * försäljningen", 0 bp med fast avgift → "2,00 kr per order", ingenting → "ingen avgift".
 */
export function feeBasisText(feeBp: number, fixedFeeOre: number): string {
  // Heltalsräkning (inga flyttal): 175 → "1,75", 150 → "1,5", 200 → "2".
  const rest = feeBp % 100;
  const decimals =
    rest === 0 ? "" : rest % 10 === 0 ? `,${rest / 10}` : `,${String(rest).padStart(2, "0")}`;
  const share =
    feeBp > 0 ? `${formatInt(Math.trunc(feeBp / 100))}${decimals}${NBSP}% av försäljningen` : null;
  const fixed = fixedFeeOre > 0 ? `${krExact(fixedFeeOre)} per order` : null;
  if (share && fixed) return `${share} plus ${fixed}`;
  return share ?? fixed ?? "ingen avgift";
}

/**
 * Belopp i avstämningens sammanfattning (`result.summary`, i rubriken på Ekonomi). En summa i
 * en rubrik skrivs i hela kronor (design.md): "Utbetalt 73 912 kr mot väntat 74 625 kr
 * (−713 kr)". Är skillnaden under en krona skrivs alla tre beloppen med ören, så att
 * avrundningen inte motsäger skillnaden ("375 kr mot 374 kr (+0,63 kr)").
 */
export function summaryAmounts(
  actualOre: number,
  expectedOre: number,
): { actual: string; expected: string; difference: string } {
  const difference = actualOre - expectedOre;
  const exact = difference !== 0 && Math.abs(difference) < 100;
  const amount = exact ? krExact : kr;
  return {
    actual: amount(actualOre),
    expected: amount(expectedOre),
    difference: exact
      ? signedKrExact(difference)
      : difference === 0
        ? `±${kr(0)}`
        : difference > 0
          ? `+${kr(difference)}`
          : `${MINUS}${kr(-difference)}`,
  };
}

/** Belopp med tecken och ören: +49,00 kr, −49,00 kr, ±0,00 kr. */
export function signedKrExact(ore: number): string {
  if (ore === 0) return `±${krExact(0)}`;
  return ore > 0 ? `+${krExact(ore)}` : krExact(ore);
}

function compareOrders(a: AnalyticsOrder, b: AnalyticsOrder): number {
  if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? -1 : 1;
  return compareStrings(a.id, b.id);
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  return ids.length > MAX_LISTED ? `${shown} m.fl.` : shown;
}

function ordersText(n: number): string {
  return plural(n, "order", "order");
}

// ---------------------------------------------------------------------------
// Indata
// ---------------------------------------------------------------------------

interface NormalizedPayout {
  readonly raw: Payout;
  readonly reference: string;
  readonly period: Period;
  readonly paidOn: IsoDate;
}

function normalizePayout(p: Payout): NormalizedPayout {
  const reference = assertId(p?.reference, "Utbetalningens referens");
  const period = toPeriod(p.period, `Perioden för utbetalning ${reference}`);
  assertOre(p.amountOre, `Utbetalt belopp för ${reference}`, true);
  assertOre(p.feesOre, `Avgifterna för ${reference}`, true);
  if (p.refundsOre !== undefined) assertOre(p.refundsOre, `Återbetalningarna för ${reference}`);
  let paidOn = period.end;
  if (p.paidOn !== undefined && p.paidOn !== null) {
    if (!isIsoDate(p.paidOn)) {
      throw new DomainError(
        "invalid_date",
        `Utbetalningsdagen för ${reference} är ogiltig: ${JSON.stringify(p.paidOn)}.`,
      );
    }
    paidOn = p.paidOn;
  }
  if (p.lines !== undefined) {
    for (const line of p.lines) {
      assertId(line?.externalId, `Ordernummer i specifikationen för ${reference}`);
      assertOre(line.amountOre, `Beloppet för order ${line.externalId} i ${reference}`, true);
    }
  }
  return { raw: p, reference, period, paidOn };
}

function comparePayouts(a: NormalizedPayout, b: NormalizedPayout): number {
  if (a.period.start !== b.period.start) return a.period.start < b.period.start ? -1 : 1;
  if (a.period.end !== b.period.end) return a.period.end < b.period.end ? -1 : 1;
  const r = compareStrings(a.reference, b.reference);
  if (r !== 0) return r;
  if (a.raw.amountOre !== b.raw.amountOre) return a.raw.amountOre - b.raw.amountOre;
  return a.raw.feesOre - b.raw.feesOre;
}

function validateOrders(orders: readonly AnalyticsOrder[]): AnalyticsOrder[] {
  const seen = new Set<string>();
  for (const o of orders) {
    assertId(o?.id, "Orderns id");
    if (seen.has(o.id)) {
      throw new DomainError("duplicate_order", `Order ${o.externalId} (${o.id}) finns två gånger.`);
    }
    seen.add(o.id);
    assertId(o.externalId, `Ordernumret för order ${o.id}`);
    if (!isIsoDate(o.businessDate)) {
      throw new DomainError(
        "invalid_date",
        `Affärsdatum för order ${o.externalId} är ogiltigt: ${JSON.stringify(o.businessDate)}.`,
      );
    }
    assertOre(o.amountOre, `Beloppet för order ${o.externalId}`);
  }
  return [...orders].sort(compareOrders);
}

function validateRefunds(refunds: readonly Refund[]): Refund[] {
  for (const r of refunds) {
    assertId(r?.id, "Återbetalningens id");
    if (!isIsoDate(r.date)) {
      throw new DomainError(
        "invalid_date",
        `Datum för återbetalning ${r.id} är ogiltigt: ${JSON.stringify(r.date)}.`,
      );
    }
    assertOre(r.amountOre, `Beloppet för återbetalning ${r.id}`);
  }
  return [...refunds].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareStrings(a.id, b.id),
  );
}

function validateFeeBp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new DomainError(
      "invalid_rate",
      `Avgiften måste vara ett heltal i baspunkter mellan 0 och 10 000, fick ${String(value)}.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Avvikelser
// ---------------------------------------------------------------------------

/** En avvikelse under uppbyggnad. */
interface Collector {
  kind: DeviationKind;
  confidence: DeviationConfidence;
  impactOre: number;
  orders: AnalyticsOrder[];
  /** Ordernummer utan order hos oss (saknas i importen). */
  externalIds: string[];
  /** För tidszon: order som leverantören räknar hit (+) respektive bort (−). */
  inOrders: AnalyticsOrder[];
  outOrders: AnalyticsOrder[];
  dates: IsoDate[];
  orderCount: number;
  title: string;
  explanation: string;
  figures: ReturnType<typeof oreFigure>[];
}

function newCollector(kind: DeviationKind, confidence: DeviationConfidence): Collector {
  return {
    kind,
    confidence,
    impactOre: 0,
    orders: [],
    externalIds: [],
    inOrders: [],
    outOrders: [],
    dates: [],
    orderCount: 0,
    title: "",
    explanation: "",
    figures: [],
  };
}

function sumAmounts(orders: readonly { amountOre: number }[]): number {
  let s = 0;
  for (const o of orders) s = addOre(s, o.amountOre);
  return s;
}

function finishDeviation(
  c: Collector,
  payoutKey: string | null,
  key: string,
  period: Period,
  payoutReferences: readonly string[],
  rule: string,
  resolutions: Map<string, DeviationResolution>,
  used: Set<DeviationResolution>,
): Deviation {
  const allOrders = [...c.orders, ...c.inOrders, ...c.outOrders];
  const orderCount = c.orderCount || allOrders.length + c.externalIds.length;
  const fingerprint = `${c.impactOre}|${orderCount}`;
  const res = resolutions.get(key) ?? null;
  let resolution: DeviationResolution | null = null;
  if (res && (res.fingerprint === undefined || res.fingerprint === fingerprint)) {
    resolution = res;
    used.add(res);
  }
  const evidence: FinanceEvidence = financeEvidence({
    rule,
    period,
    orderIds: allOrders.map((o) => o.id),
    dates: [...c.dates, ...allOrders.map((o) => o.businessDate)],
    titleIds: allOrders.map((o) => o.titleId),
    machineIds: allOrders.flatMap((o) => (o.machineId === null ? [] : [o.machineId])),
    payoutReferences,
    externalOrderIds: [...c.externalIds, ...allOrders.map((o) => o.externalId)],
    figures: [
      oreFigure("impactOre", "Påverkan på skillnaden", c.impactOre),
      countFigure("orders", "Antal order", orderCount),
      ...c.figures,
    ],
  });
  return {
    key,
    fingerprint,
    payoutKey,
    kind: c.kind,
    confidence: c.confidence,
    impactOre: c.impactOre,
    orderCount,
    requiresAction: c.kind !== "timezone-shift",
    title: c.title,
    explanation: c.explanation,
    status: resolution ? "investigated" : "open",
    resolution,
    evidence,
  };
}

const RULES: Record<DeviationKind, string> = {
  fee: "Väntade avgifter = Σ round(belopp × avgift / 10 000) + fast avgift per order, för våra order i perioden.",
  refund: "Leverantörens återbetalningar jämförs med de återbetalningar vi känner till i perioden.",
  "missing-in-sales":
    "Order som leverantören betalat ut men som saknas bland våra order (ordernumret finns inte, eller skillnaden är exakt ett antal order à ett vanligt pris).",
  "missing-in-payout":
    "Order som finns bland våra order i perioden men inte i leverantörens utbetalning.",
  "duplicate-order": "Samma ordernummer förekommer på flera order i vår import.",
  "duplicate-payout":
    "Samma utbetalning, order eller dag betalas mer än en gång (samma referens, samma ordernummer eller överlappande perioder).",
  "amount-mismatch": "Ordern finns på båda sidor men leverantörens belopp skiljer sig från vårt.",
  "timezone-shift":
    "Leverantören räknar perioden i sin tidszon. En order nära midnatt kan då höra till en annan kalenderdag, och därmed en annan period, än hos oss.",
  "period-shift":
    "Ordern finns hos oss men med ett affärsdatum utanför perioden, och tidszonen förklarar det inte.",
  "missing-payout": "Försäljning på dagar som ingen utbetalning täcker.",
  unexplained: "Det som återstår av skillnaden när alla kända orsaker är avräknade.",
};

// ---------------------------------------------------------------------------
// Huvudfunktion
// ---------------------------------------------------------------------------

/**
 * Stämmer av leverantörens utbetalningar mot vår försäljning och förklarar avvikelserna.
 *
 * Varje utbetalning får väntat belopp (försäljning − avgifter − återbetalningar), skillnad,
 * avvikelser med förklaring och underlag (order, dagar, belopp) och en status:
 * 'matched' (stämmer), 'explained' (bara tidszon, jämnas ut), 'deviation' (något att utreda)
 * eller 'investigated' (alla avvikelser utredda). En utredning (`resolutions`) gäller så länge
 * avvikelsens fingerprint (belopp och antal order) är oförändrat.
 *
 * Utbetalningarna gås igenom i periodordning (start, slut, referens), så resultatet beror inte
 * på ordningen i indata. Kastar `DomainError` vid ogiltig indata.
 */
export function reconcilePayouts(input: ReconciliationInput): ReconciliationResult {
  const options = input.options ?? {};
  const settings: Settings = input.settings;
  const feeBp = validateFeeBp(options.feeBp ?? settings?.cardFeeBp);
  const fixedFee = assertOre(
    options.fixedFeePerOrderOre ?? RECONCILIATION_DEFAULTS.fixedFeePerOrderOre,
    "Fast avgift per order",
  );
  const tolerance = assertOre(
    options.toleranceOre ?? RECONCILIATION_DEFAULTS.toleranceOre,
    "Toleransen",
  );
  const maxInferred = assertCount(
    options.maxInferredOrders ?? RECONCILIATION_DEFAULTS.maxInferredOrders,
    "Högsta antal härledda order",
  );
  const providerTz = options.providerTimeZone ?? null;
  const orgTz = options.timeZone ?? DEFAULT_TIME_ZONE;
  const feeSettings: Settings = { vatRateBp: settings.vatRateBp, cardFeeBp: feeBp };

  const orders = validateOrders(input.orders);
  const refunds = validateRefunds(input.refunds ?? []);
  const payouts = input.payouts.map(normalizePayout).sort(comparePayouts);

  const ordersByDate = new Map<IsoDate, AnalyticsOrder[]>();
  const ordersByExt = new Map<string, AnalyticsOrder[]>();
  for (const o of orders) {
    const d = ordersByDate.get(o.businessDate);
    if (d) d.push(o);
    else ordersByDate.set(o.businessDate, [o]);
    const e = ordersByExt.get(o.externalId);
    if (e) e.push(o);
    else ordersByExt.set(o.externalId, [o]);
  }
  /** Den första ordern (datum, id) med ordernumret är "rätt"; övriga är dubbletter. */
  const isExtra = (o: AnalyticsOrder): boolean => ordersByExt.get(o.externalId)?.[0] !== o;
  const refundsByDate = new Map<IsoDate, Refund[]>();
  for (const r of refunds) {
    const list = refundsByDate.get(r.date);
    if (list) list.push(r);
    else refundsByDate.set(r.date, [r]);
  }

  const providerDateCache = new Map<string, IsoDate | null>();
  /** Orderns kalenderdag i leverantörens tidszon, `null` om den inte kan räknas. */
  const providerDate = (o: AnalyticsOrder): IsoDate | null => {
    if (providerTz === null || o.orderedAt === undefined) return null;
    const cached = providerDateCache.get(o.id);
    if (cached !== undefined) return cached;
    const ms = tryParseInstant(o.orderedAt);
    const value = ms === null ? null : businessDateAt(ms, providerTz);
    providerDateCache.set(o.id, value);
    return value;
  };

  const resolutionByKey = new Map<string, DeviationResolution>();
  for (const r of input.resolutions ?? []) {
    assertId(r?.key, "Utredningens nyckel");
    resolutionByKey.set(r.key, r);
  }
  const usedResolutions = new Set<DeviationResolution>();

  const feesFor = (list: readonly AnalyticsOrder[]): number =>
    addOre(cardFees(list, feeSettings), fixedFee * list.length);

  /** Dag → nyckeln för utbetalningen som täcker dagen. */
  const covered = new Map<IsoDate, string>();
  /** Ordernummer → utbetalningen som redan betalat ut det (enligt specifikation). */
  const paidExternal = new Map<string, string>();
  const referenceCount = new Map<string, number>();
  const results: PayoutReconciliation[] = [];

  for (const p of payouts) {
    const occurrence = (referenceCount.get(p.reference) ?? 0) + 1;
    referenceCount.set(p.reference, occurrence);
    const key = occurrence === 1 ? p.reference : `${p.reference}#${occurrence}`;
    const finish = (c: Collector, refs: readonly string[]): Deviation =>
      finishDeviation(
        c,
        key,
        `${key}:${c.kind}`,
        p.period,
        refs,
        RULES[c.kind],
        resolutionByKey,
        usedResolutions,
      );

    // --- Samma referens igen: hela utbetalningen är en dubblett. ---
    if (occurrence > 1) {
      const c = newCollector("duplicate-payout", "confirmed");
      c.impactOre = p.raw.amountOre;
      c.title = `Utbetalningen ${p.reference} finns två gånger`;
      c.explanation = `Referensen ${p.reference} förekommer redan. Den här utbetalningen på ${krExact(
        p.raw.amountOre,
      )} (${periodText(p.period)}) räknas som dubblett och väntas vara 0 kr.`;
      const deviation = finish(c, [p.reference]);
      results.push(
        buildPayoutResult(p, key, {
          expected: { orders: 0, salesOre: 0, feesOre: 0, refundsOre: 0, payoutOre: 0 },
          actualRefunds: p.raw.refundsOre ?? 0,
          deviations: [deviation],
          roundingOre: 0,
          overlapsWith: [p.reference],
          orderIds: [],
        }),
      );
      continue;
    }

    // --- Dagar: egna och redan täckta av en tidigare utbetalning. ---
    const ownDays: IsoDate[] = [];
    const overlapDays: IsoDate[] = [];
    const overlapRefs = new Set<string>();
    for (const d of eachDay(p.period.start, p.period.end)) {
      const by = covered.get(d);
      if (by === undefined) ownDays.push(d);
      else {
        overlapDays.push(d);
        overlapRefs.add(by);
      }
    }
    for (const d of ownDays) covered.set(d, key);
    const ownSet = new Set(ownDays);
    const overlapSet = new Set(overlapDays);

    const own: AnalyticsOrder[] = ownDays.flatMap((d) => ordersByDate.get(d) ?? []);
    const ownRefunds = ownDays.flatMap((d) => refundsByDate.get(d) ?? []);
    const salesOre = sumAmounts(own);
    const expectedFees = feesFor(own);
    const ourRefundsOre = sumAmounts(ownRefunds);
    const expectedPayout = salesOre - expectedFees - ourRefundsOre;
    const reportedRefunds = p.raw.refundsOre ?? ourRefundsOre;
    const providerSales = addOre(addOre(p.raw.amountOre, p.raw.feesOre), reportedRefunds);
    const gap = providerSales - salesOre;

    const collectors = new Map<DeviationKind, Collector>();
    const get = (kind: DeviationKind, confidence: DeviationConfidence = "confirmed"): Collector => {
      let c = collectors.get(kind);
      if (!c) {
        c = newCollector(kind, confidence);
        collectors.set(kind, c);
      }
      return c;
    };
    let explainedGap = 0;

    // Avgifter.
    const feeDelta = p.raw.feesOre - expectedFees;
    if (feeDelta !== 0) {
      const c = get("fee");
      c.impactOre = -feeDelta;
      c.title = `Avgifterna är ${krExact(Math.abs(feeDelta))} ${feeDelta > 0 ? "högre" : "lägre"} än väntat`;
      const basis = feeBasisText(feeBp, fixedFee);
      c.explanation = `Leverantören drog ${krExact(p.raw.feesOre)} i avgifter. Inställningarna (${basis}) ger ${krExact(
        expectedFees,
      )} för ${ordersText(own.length)} på totalt ${krExact(salesOre)}. Kontrollera avtalet med leverantören eller avgiftsinställningen.`;
      c.figures.push(
        oreFigure("reportedFeesOre", "Avgifter enligt leverantören", p.raw.feesOre),
        oreFigure("expectedFeesOre", "Väntade avgifter", expectedFees),
      );
    }

    // Återbetalningar.
    if (p.raw.refundsOre !== undefined && p.raw.refundsOre !== ourRefundsOre) {
      const delta = p.raw.refundsOre - ourRefundsOre;
      const c = get("refund");
      c.impactOre = -delta;
      c.orderCount = ownRefunds.length;
      c.title = `Återbetalningarna skiljer ${krExact(Math.abs(delta))}`;
      c.explanation = `Leverantören drog ${krExact(p.raw.refundsOre)} i återbetalningar. Vi känner till ${plural(
        ownRefunds.length,
        "återbetalning",
        "återbetalningar",
      )} på ${krExact(ourRefundsOre)} i perioden.`;
      c.dates.push(...ownRefunds.map((r) => r.date));
      c.figures.push(
        oreFigure("reportedRefundsOre", "Återbetalningar enligt leverantören", p.raw.refundsOre),
        oreFigure("ourRefundsOre", "Kända återbetalningar", ourRefundsOre),
      );
    }

    // Dubbletter i vår import.
    const canonicalOwn: AnalyticsOrder[] = [];
    for (const o of own) {
      if (isExtra(o)) {
        const c = get("duplicate-order");
        c.orders.push(o);
        c.impactOre -= o.amountOre;
        explainedGap -= o.amountOre;
      } else canonicalOwn.push(o);
    }

    const lines = p.raw.lines;
    if (lines !== undefined) {
      // --- Med specifikation: order för order. ---
      const sortedLines: PayoutLine[] = [...lines].sort((a, b) =>
        a.externalId !== b.externalId
          ? compareStrings(a.externalId, b.externalId)
          : a.amountOre - b.amountOre,
      );
      const seenHere = new Set<string>();
      const matched = new Set<string>();
      const alreadyPaidRefs = new Set<string>();
      for (const line of sortedLines) {
        const ext = line.externalId;
        const ours = ordersByExt.get(ext)?.[0];
        if (seenHere.has(ext) || paidExternal.has(ext)) {
          const c = get("duplicate-payout");
          if (ours) c.orders.push(ours);
          else c.externalIds.push(ext);
          c.orderCount += 1;
          c.impactOre += line.amountOre;
          explainedGap += line.amountOre;
          const earlier = paidExternal.get(ext);
          if (earlier !== undefined) alreadyPaidRefs.add(earlier);
          continue;
        }
        seenHere.add(ext);
        if (ours && ownSet.has(ours.businessDate)) {
          matched.add(ours.id);
          const delta = line.amountOre - ours.amountOre;
          if (delta !== 0) {
            const c = get("amount-mismatch");
            c.orders.push(ours);
            c.impactOre += delta;
            explainedGap += delta;
          }
        } else if (ours && overlapSet.has(ours.businessDate)) {
          const c = get("duplicate-payout");
          c.orders.push(ours);
          c.orderCount += 1;
          c.impactOre += line.amountOre;
          explainedGap += line.amountOre;
          const earlier = covered.get(ours.businessDate);
          if (earlier !== undefined) alreadyPaidRefs.add(earlier);
        } else if (ours) {
          const pd = providerDate(ours);
          const c =
            pd !== null && inPeriod(pd, p.period) ? get("timezone-shift") : get("period-shift");
          if (c.kind === "timezone-shift") c.inOrders.push(ours);
          else c.orders.push(ours);
          c.impactOre += line.amountOre;
          explainedGap += line.amountOre;
        } else {
          const c = get("missing-in-sales");
          c.externalIds.push(ext);
          c.impactOre += line.amountOre;
          explainedGap += line.amountOre;
        }
      }
      for (const ext of seenHere) paidExternal.set(ext, key);
      for (const o of canonicalOwn) {
        if (matched.has(o.id)) continue;
        const pd = providerDate(o);
        if (pd !== null && !inPeriod(pd, p.period)) {
          const c = get("timezone-shift");
          c.outOrders.push(o);
          c.impactOre -= o.amountOre;
        } else {
          const c = get("missing-in-payout");
          c.orders.push(o);
          c.impactOre -= o.amountOre;
        }
        explainedGap -= o.amountOre;
      }
      const dup = collectors.get("duplicate-payout");
      if (dup) {
        dup.title = `${ordersText(dup.orderCount)} betalas två gånger`;
        const ids = [...dup.orders.map((o) => o.externalId), ...dup.externalIds];
        const where =
          alreadyPaidRefs.size > 0
            ? `ingår redan i ${[...alreadyPaidRefs].sort(compareStrings).join(", ")}`
            : "förekommer flera gånger i specifikationen";
        dup.explanation = `Ordernummer ${listIds(ids)} (${krExact(dup.impactOre)}) ${where}. Begär att leverantören drar beloppet från nästa utbetalning.`;
        for (const r of alreadyPaidRefs) overlapRefs.add(r);
      }
    } else {
      // --- Utan specifikation: tidszon, överlapp och härledda saknade order. ---
      if (providerTz !== null) {
        const shift = timezoneCandidates(
          p.period,
          canonicalOwn,
          ordersByDate,
          isExtra,
          providerDate,
        );
        const pick = chooseTimezoneShift(gap - explainedGap, shift.inOrders, shift.outOrders);
        if (pick.inOrders.length > 0 || pick.outOrders.length > 0) {
          // Utan specifikation är förskjutningen en tolkning av beloppen, inte belagd per order.
          const c = get("timezone-shift", "inferred");
          c.inOrders.push(...pick.inOrders);
          c.outOrders.push(...pick.outOrders);
          c.impactOre = sumAmounts(pick.inOrders) - sumAmounts(pick.outOrders);
          explainedGap += c.impactOre;
        }
      }
      const overlapOrders = overlapDays.flatMap((d) => ordersByDate.get(d) ?? []);
      const overlapSales = sumAmounts(overlapOrders);
      const remaining = gap - explainedGap;
      if (overlapDays.length > 0 && overlapSales > 0 && remaining > 0) {
        const impact = Math.min(remaining, overlapSales);
        const c = get("duplicate-payout", "inferred");
        c.impactOre = impact;
        c.orders.push(...overlapOrders);
        c.dates.push(...overlapDays);
        explainedGap += impact;
        const refs = [...overlapRefs].sort(compareStrings).join(", ");
        c.title = `Perioden överlappar ${refs}`;
        c.explanation = `${plural(overlapDays.length, "dag", "dagar")} (${periodText({
          start: overlapDays[0]!,
          end: overlapDays[overlapDays.length - 1]!,
        })}) ingår redan i ${refs}. Försäljningen de dagarna, ${krExact(
          overlapSales,
        )}, väntades där; ${krExact(impact)} av skillnaden förklaras av att dagarna betalats två gånger.`;
        c.figures.push(
          oreFigure("overlapSalesOre", "Försäljning på överlappande dagar", overlapSales),
        );
      }
    }

    // --- Rest: härledda saknade order, avrundning eller oförklarat. ---
    const residual = gap - explainedGap;
    const rounding = splitRounding(collectors.get("fee")?.impactOre ?? 0, residual, tolerance);
    if (rounding.feeIsRounding) collectors.delete("fee");
    const roundingOre = rounding.roundingOre;
    if (residual !== 0 && !rounding.residualIsRounding) {
      const inferred =
        lines === undefined ? inferOrderCount(residual, canonicalOwn, orders, maxInferred) : null;
      if (inferred !== null) {
        const kind: DeviationKind = residual > 0 ? "missing-in-sales" : "missing-in-payout";
        const c = get(kind, "inferred");
        c.confidence = "inferred";
        c.impactOre += residual;
        c.orderCount = inferred.count;
        c.figures.push(oreFigure("unitAmountOre", "Vanligt orderbelopp", inferred.amountOre));
        if (kind === "missing-in-sales") {
          const emptyDays = ownDays.filter((d) => (ordersByDate.get(d) ?? []).length === 0);
          c.dates.push(...emptyDays);
          c.figures.push(
            daysFigure("daysWithoutOrders", "Dagar utan importerade order", emptyDays.length),
          );
          c.title = `Troligen ${ordersText(inferred.count)} som saknas i importen`;
          c.explanation = `Leverantören betalade för ${krExact(residual)} mer försäljning än vi har. Det är exakt ${ordersText(
            inferred.count,
          )} à ${krExact(inferred.amountOre)}.${
            emptyDays.length > 0
              ? ` ${plural(emptyDays.length, "dag", "dagar")} i perioden saknar importerade order (${listIds(
                  emptyDays.map(day),
                )}).`
              : ""
          } Importera om perioden eller hämta specifikationen från leverantören.`;
        } else {
          c.title = `Troligen ${ordersText(inferred.count)} som inte betalats ut`;
          c.explanation = `Leverantören betalade för ${krExact(-residual)} mindre försäljning än vi har. Det är exakt ${ordersText(
            inferred.count,
          )} à ${krExact(inferred.amountOre)}. Begär specifikationen från leverantören.`;
        }
      } else {
        const c = get("unexplained");
        c.impactOre = residual;
        c.title = `${signedKrExact(residual)} är oförklarat`;
        c.explanation =
          lines !== undefined
            ? `Specifikationen summerar till ${krExact(
                sumAmounts(lines),
              )}, men utbetalt + avgifter + återbetalningar är ${krExact(providerSales)}. Skillnaden ${signedKrExact(
                residual,
              )} syns inte på någon order.`
            : `Efter kända orsaker återstår ${signedKrExact(
                residual,
              )} som inte motsvarar ett jämnt antal order. Begär leverantörens specifikation för perioden.`;
      }
    }

    // --- Texter för de insamlade orderavvikelserna. ---
    describeCollectors(collectors, p.period, providerTz, orgTz);

    const deviations: Deviation[] = [];
    for (const kind of DEVIATION_ORDER) {
      const c = collectors.get(kind);
      if (!c) continue;
      deviations.push(finish(c, [p.reference]));
    }

    results.push(
      buildPayoutResult(p, key, {
        expected: {
          orders: own.length,
          salesOre,
          feesOre: expectedFees,
          refundsOre: ourRefundsOre,
          payoutOre: expectedPayout,
        },
        actualRefunds: reportedRefunds,
        deviations,
        roundingOre,
        overlapsWith: [...overlapRefs].sort(compareStrings),
        orderIds: own.map((o) => o.id),
      }),
    );
  }

  // --- Försäljning som ingen utbetalning täcker. ---
  const uncovered = uncoveredSales({
    payouts,
    covered,
    ordersByDate,
    refundsByDate,
    feesFor,
    coverage: options.coverage ?? null,
    resolutions: resolutionByKey,
    used: usedResolutions,
  });

  const staleResolutions = [...resolutionByKey.values()].filter((r) => !usedResolutions.has(r));
  return summarize(results, uncovered, staleResolutions);
}

/**
 * Order nära periodgränsen som leverantören (i sin tidszon) räknar till en annan period än vi:
 * `outOrders` = våra order i perioden som hos leverantören har en kalenderdag utanför den,
 * `inOrders` = order högst två dygn utanför perioden som hos leverantören hamnar i den.
 * Dubbletter i vår import tas inte med.
 */
function timezoneCandidates(
  period: Period,
  periodOrders: readonly AnalyticsOrder[],
  ordersByDate: ReadonlyMap<IsoDate, readonly AnalyticsOrder[]>,
  isExtra: (o: AnalyticsOrder) => boolean,
  providerDate: (o: AnalyticsOrder) => IsoDate | null,
): { inOrders: AnalyticsOrder[]; outOrders: AnalyticsOrder[] } {
  const outOrders = periodOrders.filter((o) => {
    const pd = providerDate(o);
    return pd !== null && !inPeriod(pd, period);
  });
  const near = [
    ...eachDay(addDays(period.start, -2), addDays(period.start, -1)),
    ...eachDay(addDays(period.end, 1), addDays(period.end, 2)),
  ];
  const inOrders: AnalyticsOrder[] = [];
  for (const d of near) {
    for (const o of ordersByDate.get(d) ?? []) {
      if (isExtra(o)) continue;
      const pd = providerDate(o);
      if (pd !== null && inPeriod(pd, period)) inOrders.push(o);
    }
  }
  return { inOrders, outOrders };
}

/**
 * Väljer vilken tidszonsförskjutning som ska antas när det inte finns någon specifikation.
 * Regel: förskjutningen antas bara om den minskar skillnaden. Alternativen är ingen, båda
 * riktningarna, bara in och bara ut; det som ger minst kvarvarande skillnad (|rest|) väljs,
 * och vid lika väljs det första i den ordningen. Stämmer utbetalningen redan (rest 0) antas
 * alltså ingen förskjutning, och inget hittas på.
 *
 * @param remaining skillnaden i försäljning som återstår innan tidszonen räknas in (öre)
 */
export function chooseTimezoneShift<T extends { readonly amountOre: number }>(
  remaining: number,
  inOrders: readonly T[],
  outOrders: readonly T[],
): { inOrders: T[]; outOrders: T[] } {
  const inSum = sumAmounts(inOrders);
  const outSum = sumAmounts(outOrders);
  const options: { inOrders: T[]; outOrders: T[]; rest: number }[] = [
    { inOrders: [], outOrders: [], rest: remaining },
    { inOrders: [...inOrders], outOrders: [...outOrders], rest: remaining - inSum + outSum },
    { inOrders: [...inOrders], outOrders: [], rest: remaining - inSum },
    { inOrders: [], outOrders: [...outOrders], rest: remaining + outSum },
  ];
  let best = options[0]!;
  for (const o of options) if (Math.abs(o.rest) < Math.abs(best.rest)) best = o;
  return { inOrders: best.inOrders, outOrders: best.outOrders };
}

/**
 * Toleransen gäller hela skillnaden, inte bara resten: små avvikelser utan order (avgiften
 * och den oförklarade resten) räknas som avrundning så länge deras summa ligger inom
 * toleransen. Typfallet är att leverantören avrundar avgiften på totalen medan vi avrundar
 * per order (1 öre). Regler:
 * - resten räknas som avrundning om |rest| ≤ tolerans;
 * - avgiftsavvikelsen räknas som avrundning om |avgift + (resten om den är avrundning)| ≤ tolerans.
 * Order-avvikelser (saknade order, dubbletter, belopp, tidszon) visas alltid.
 */
export function splitRounding(
  feeImpactOre: number,
  residualOre: number,
  toleranceOre: number,
): { roundingOre: number; feeIsRounding: boolean; residualIsRounding: boolean } {
  const residualIsRounding = residualOre !== 0 && Math.abs(residualOre) <= toleranceOre;
  const residualPart = residualIsRounding ? residualOre : 0;
  const feeIsRounding = feeImpactOre !== 0 && Math.abs(feeImpactOre + residualPart) <= toleranceOre;
  return {
    roundingOre: residualPart + (feeIsRounding ? feeImpactOre : 0),
    feeIsRounding,
    residualIsRounding,
  };
}

/** Antal order à ett vanligt belopp som exakt motsvarar resten, eller `null`. */
function inferOrderCount(
  residual: number,
  periodOrders: readonly AnalyticsOrder[],
  allOrders: readonly AnalyticsOrder[],
  maxCount: number,
): { count: number; amountOre: number } | null {
  const source = periodOrders.length > 0 ? periodOrders : allOrders;
  const freq = new Map<number, number>();
  for (const o of source)
    if (o.amountOre > 0) freq.set(o.amountOre, (freq.get(o.amountOre) ?? 0) + 1);
  const candidates = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const abs = Math.abs(residual);
  for (const [amount] of candidates) {
    if (abs % amount === 0 && abs / amount <= maxCount)
      return { count: abs / amount, amountOre: amount };
  }
  return null;
}

function describeCollectors(
  collectors: Map<DeviationKind, Collector>,
  period: Period,
  providerTz: string | null,
  orgTz: string,
): void {
  const missingSales = collectors.get("missing-in-sales");
  if (missingSales && missingSales.confidence === "confirmed") {
    const n = missingSales.externalIds.length;
    missingSales.title = `${ordersText(n)} saknas i vår import`;
    missingSales.explanation = `Utbetalningen innehåller ${ordersText(n)} (${krExact(
      missingSales.impactOre,
    )}) som inte finns bland våra order: ${listIds(missingSales.externalIds)}. Importera dem eller kontrollera automatkopplingen.`;
  }
  const missingPayout = collectors.get("missing-in-payout");
  if (missingPayout && missingPayout.confidence === "confirmed") {
    const n = missingPayout.orders.length;
    missingPayout.title = `${ordersText(n)} saknas i utbetalningen`;
    missingPayout.explanation = `${ordersText(n)} (${krExact(-missingPayout.impactOre)}) finns hos oss men inte i leverantörens utbetalning: ${listIds(
      missingPayout.orders.map((o) => o.externalId),
    )}. Begär dem av leverantören.`;
  }
  const dupOrder = collectors.get("duplicate-order");
  if (dupOrder) {
    const n = dupOrder.orders.length;
    dupOrder.title = `${ordersText(n)} finns två gånger i importen`;
    dupOrder.explanation = `Ordernummer ${listIds(
      [...new Set(dupOrder.orders.map((o) => o.externalId))].sort(compareStrings),
    )} förekommer på flera order. ${krExact(-dupOrder.impactOre)} räknas dubbelt i vår försäljning; slå ihop eller arkivera dubbletterna.`;
  }
  const mismatch = collectors.get("amount-mismatch");
  if (mismatch) {
    const n = mismatch.orders.length;
    mismatch.title = `${ordersText(n)} har olika belopp`;
    mismatch.explanation = `Leverantörens belopp skiljer sig från vårt för ${listIds(
      mismatch.orders.map((o) => o.externalId),
    )}, totalt ${signedKrExact(mismatch.impactOre)}.`;
  }
  const periodShift = collectors.get("period-shift");
  if (periodShift) {
    const n = periodShift.orders.length;
    const dates = [...new Set(periodShift.orders.map((o) => o.businessDate))].sort();
    periodShift.title = `${ordersText(n)} hör till en annan period hos oss`;
    periodShift.explanation = `Ordernummer ${listIds(periodShift.orders.map((o) => o.externalId))} (${krExact(
      periodShift.impactOre,
    )}) har affärsdatum ${listIds(dates.map(day))}, utanför ${periodText(period)}. Tidszonen förklarar det inte; kontrollera periodgränsen hos leverantören.`;
  }
  const tz = collectors.get("timezone-shift");
  if (tz) {
    const n = tz.inOrders.length + tz.outOrders.length;
    tz.title = `Tidszon: ${ordersText(n)} hamnar i en annan period hos leverantören`;
    const parts: string[] = [];
    const example = (o: AnalyticsOrder): string => {
      const ms = o.orderedAt === undefined ? null : tryParseInstant(o.orderedAt);
      if (ms === null || providerTz === null) return `order ${o.externalId}`;
      return `order ${o.externalId} betalades ${day(businessDateAt(ms, orgTz))} ${clockTimeAt(
        ms,
        orgTz,
      )} svensk tid = ${day(businessDateAt(ms, providerTz))} ${clockTimeAt(ms, providerTz)} i ${providerTz}`;
    };
    if (tz.inOrders.length > 0) {
      parts.push(
        `${ordersText(tz.inOrders.length)} (${krExact(sumAmounts(tz.inOrders))}) räknas hit av leverantören men till en annan period hos oss`,
      );
    }
    if (tz.outOrders.length > 0) {
      parts.push(
        `${ordersText(tz.outOrders.length)} (${krExact(sumAmounts(tz.outOrders))}) räknas av leverantören till en annan period`,
      );
    }
    const first = tz.inOrders[0] ?? tz.outOrders[0];
    tz.explanation = `Leverantören räknar perioden i ${providerTz ?? "sin tidszon"}: ${parts.join(
      "; ",
    )}. Nettoeffekt ${signedKrExact(tz.impactOre)}, som jämnas ut i grannperioden.${
      first ? ` Exempel: ${example(first)}.` : ""
    }`;
    tz.figures.push(
      oreFigure("inOre", "Räknas hit av leverantören", sumAmounts(tz.inOrders)),
      oreFigure("outOre", "Räknas bort av leverantören", sumAmounts(tz.outOrders)),
    );
  }
}

interface PayoutParts {
  readonly expected: PayoutReconciliation["expected"];
  readonly actualRefunds: number;
  readonly deviations: Deviation[];
  readonly roundingOre: number;
  readonly overlapsWith: string[];
  readonly orderIds: string[];
}

/** Status: avvikelser som kräver åtgärd och inte är utredda → 'deviation', osv. */
export function payoutStatus(deviations: readonly Deviation[]): PayoutStatus {
  if (deviations.length === 0) return "matched";
  if (deviations.some((d) => d.requiresAction && d.status === "open")) return "deviation";
  if (deviations.some((d) => d.status === "open")) return "explained";
  return "investigated";
}

function buildPayoutResult(
  p: NormalizedPayout,
  key: string,
  parts: PayoutParts,
): PayoutReconciliation {
  const { expected, deviations } = parts;
  const differenceOre = p.raw.amountOre - expected.payoutOre;
  const sumImpacts = deviations.reduce((s, d) => s + d.impactOre, 0) + parts.roundingOre;
  if (sumImpacts !== differenceOre) {
    // Ska inte kunna hända: avvikelserna är konstruerade så att de summerar till skillnaden.
    throw new DomainError(
      "invalid_input",
      `Avstämningen av ${key} går inte ihop (${sumImpacts} ≠ ${differenceOre}).`,
    );
  }
  const status = payoutStatus(deviations);
  const actual = {
    payoutOre: p.raw.amountOre,
    feesOre: p.raw.feesOre,
    refundsOre: parts.actualRefunds,
    salesOre: p.raw.amountOre + p.raw.feesOre + parts.actualRefunds,
  };
  // Utbetalningens rad har ören: skillnaderna och avrundningen förklaras på öret.
  const head = `${p.reference} (${periodText(p.period)}): utbetalt ${krExact(
    actual.payoutOre,
  )}, väntat ${krExact(expected.payoutOre)}`;
  const open = deviations.filter((d) => d.requiresAction && d.status === "open");
  let tail: string;
  switch (status) {
    case "matched":
      tail =
        parts.roundingOre !== 0
          ? `Stämmer (avrundning ${signedKrExact(parts.roundingOre)}).`
          : "Stämmer.";
      break;
    case "explained":
      tail = `Skillnaden ${signedKrExact(differenceOre)} beror på tidszonen och jämnas ut i grannperioden.`;
      break;
    case "investigated":
      tail = `Skillnaden ${signedKrExact(differenceOre)} är utredd.`;
      break;
    case "deviation":
      tail = `Skillnad ${signedKrExact(differenceOre)}. Att utreda: ${open
        .map(
          (d) =>
            `${d.title.charAt(0).toLocaleLowerCase("sv-SE")}${d.title.slice(1)} (${signedKrExact(d.impactOre)})`,
        )
        .join("; ")}.`;
      break;
  }
  return {
    key,
    reference: p.reference,
    period: p.period,
    paidOn: p.paidOn,
    status,
    expected,
    actual,
    differenceOre,
    roundingOre: parts.roundingOre,
    deviations,
    overlapsWith: parts.overlapsWith,
    summary: `${head}. ${tail}`,
    evidence: financeEvidence({
      rule: "Väntad utbetalning = försäljning − avgifter − återbetalningar för perioden; skillnad = utbetalt − väntat.",
      period: p.period,
      orderIds: parts.orderIds,
      payoutReferences: [p.reference, ...parts.overlapsWith],
      figures: [
        oreFigure("salesOre", "Försäljning", expected.salesOre),
        oreFigure("expectedFeesOre", "Väntade avgifter", expected.feesOre),
        oreFigure("refundsOre", "Återbetalningar", expected.refundsOre),
        oreFigure("expectedPayoutOre", "Väntad utbetalning", expected.payoutOre),
        oreFigure("actualPayoutOre", "Utbetalt", actual.payoutOre),
        oreFigure("actualFeesOre", "Avgifter enligt leverantören", actual.feesOre),
        oreFigure("differenceOre", "Skillnad", differenceOre),
        countFigure("orders", "Antal order", expected.orders),
      ],
    }),
  };
}

function uncoveredSales(args: {
  payouts: readonly NormalizedPayout[];
  covered: Map<IsoDate, string>;
  ordersByDate: Map<IsoDate, AnalyticsOrder[]>;
  refundsByDate: Map<IsoDate, Refund[]>;
  feesFor: (orders: readonly AnalyticsOrder[]) => number;
  coverage: Period | IsoMonth | null;
  resolutions: Map<string, DeviationResolution>;
  used: Set<DeviationResolution>;
}): Deviation[] {
  let range: Period | null = args.coverage === null ? null : toPeriod(args.coverage, "Täckningen");
  if (range === null && args.payouts.length > 0) {
    let start = args.payouts[0]!.period.start;
    let end = args.payouts[0]!.period.end;
    for (const p of args.payouts) {
      if (p.period.start < start) start = p.period.start;
      if (p.period.end > end) end = p.period.end;
    }
    range = { start, end };
  }
  if (range === null) return [];
  const byMonth = new Map<string, IsoDate[]>();
  for (const d of [...args.ordersByDate.keys()].sort()) {
    if (!inPeriod(d, range) || args.covered.has(d)) continue;
    const m = monthOf(d);
    const list = byMonth.get(m);
    if (list) list.push(d);
    else byMonth.set(m, [d]);
  }
  const out: Deviation[] = [];
  for (const [month, dates] of [...byMonth.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const orders = dates.flatMap((d) => args.ordersByDate.get(d) ?? []);
    const refunds = dates.flatMap((d) => args.refundsByDate.get(d) ?? []);
    const sales = sumAmounts(orders);
    const expected = sales - args.feesFor(orders) - sumAmounts(refunds);
    const c = newCollector("missing-payout", "confirmed");
    c.impactOre = -expected;
    c.orders.push(...orders);
    c.dates.push(...dates);
    const span: Period = { start: dates[0]!, end: dates[dates.length - 1]! };
    c.title = `Ingen utbetalning för ${plural(dates.length, "dag", "dagar")} med försäljning (${periodText(span)})`;
    c.explanation = `${ordersText(orders.length)} för ${krExact(sales)} på ${listIds(
      dates.map(day),
    )} täcks inte av någon utbetalning. Väntad utbetalning ${krExact(expected)}. Lägg in utbetalningen eller kontrollera periodgränserna.`;
    c.figures.push(oreFigure("salesOre", "Försäljning utan utbetalning", sales));
    out.push(
      finishDeviation(
        c,
        null,
        `missing-payout:${month}`,
        span,
        [],
        RULES["missing-payout"],
        args.resolutions,
        args.used,
      ),
    );
  }
  return out;
}

function summarize(
  payouts: PayoutReconciliation[],
  uncovered: Deviation[],
  staleResolutions: DeviationResolution[],
): ReconciliationResult {
  const byStatus: Record<PayoutStatus, number> = {
    matched: 0,
    explained: 0,
    deviation: 0,
    investigated: 0,
  };
  let expectedOre = 0;
  let actualOre = 0;
  let open = 0;
  let investigated = 0;
  const all: Deviation[] = [...payouts.flatMap((p) => p.deviations), ...uncovered];
  for (const p of payouts) {
    byStatus[p.status] += 1;
    expectedOre = addOre(expectedOre, p.expected.payoutOre);
    actualOre = addOre(actualOre, p.actual.payoutOre);
  }
  for (const d of all) {
    if (d.status === "investigated") investigated += 1;
    else if (d.requiresAction) open += 1;
  }
  const differenceOre = actualOre - expectedOre;
  const parts: string[] = [];
  if (payouts.length === 0) parts.push("Inga utbetalningar att stämma av");
  else {
    const status: string[] = [];
    if (byStatus.matched > 0) status.push(`${byStatus.matched} stämmer`);
    if (byStatus.explained > 0)
      status.push(`${byStatus.explained} skiljer bara på grund av tidszonen`);
    if (byStatus.deviation > 0) status.push(`${byStatus.deviation} har avvikelser att utreda`);
    if (byStatus.investigated > 0) status.push(`${byStatus.investigated} är utredda`);
    const sum = summaryAmounts(actualOre, expectedOre);
    parts.push(
      `${plural(payouts.length, "utbetalning", "utbetalningar")}: ${status.join(", ")}. Utbetalt ${sum.actual} mot väntat ${sum.expected} (${sum.difference})`,
    );
  }
  const openUncovered = uncovered.filter((d) => d.status === "open");
  if (openUncovered.length > 0) {
    const sales = openUncovered.reduce(
      (s, d) => s + (d.evidence.figures.find((f) => f.key === "salesOre")?.value ?? 0),
      0,
    );
    const days = openUncovered.reduce((s, d) => s + d.evidence.dates.length, 0);
    parts.push(`Försäljning ${kr(sales)} på ${plural(days, "dag", "dagar")} saknar utbetalning`);
  }
  const allRefs = payouts.map((p) => p.reference);
  return {
    payouts,
    uncovered,
    totals: {
      expectedOre,
      actualOre,
      differenceOre,
      openDeviations: open,
      investigatedDeviations: investigated,
      byStatus,
    },
    staleResolutions,
    summary: parts.map((s) => (s.endsWith(".") ? s : `${s}.`)).join(" "),
    evidence: financeEvidence({
      rule: "Summan av alla utbetalningar mot summan av väntade utbetalningar.",
      payoutReferences: allRefs,
      orderIds: all.flatMap((d) => d.evidence.orderIds),
      figures: [
        oreFigure("expectedOre", "Väntat", expectedOre),
        oreFigure("actualOre", "Utbetalt", actualOre),
        oreFigure("differenceOre", "Skillnad", differenceOre),
        countFigure("openDeviations", "Avvikelser att utreda", open),
      ],
    }),
  };
}
