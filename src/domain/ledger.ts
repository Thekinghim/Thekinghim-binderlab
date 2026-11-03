/**
 * Orderliggaren: ekonomin för varje order i perioden, med hyran fördelad.
 *
 * Alla vyer (per titel, automat, butik, dag, vecka, månad) summerar samma liggare.
 * Därför är totalerna identiska mellan vyerna, och raderna i varje vy summerar
 * exakt till totalen.
 *
 * Fördelning av hyra: för varje butik och kalendermånad fördelas månadens hyra
 * (rent.ts) på butikens order i den månaden inom perioden, i proportion till
 * nettointäkt × den månadshyra som gällde orderns dag, med största-restmetoden så att
 * summan stämmer på öret. En order på en dag utan hyresavtal bär alltså ingen hyra.
 * Orderna sorteras först på datum och id, så att resultatet inte beror på i vilken
 * ordning orderna kom in. Har butiken hyra men inga order på dagar med hyra den
 * månaden blir hyran "ej fördelad".
 *
 * Varje order får sin andel oavsett om den har inköpspris. Andelen på en order utan
 * pris dras ändå från vinsten, som ej fördelad hyra (se profitability.ts).
 *
 * Vinstdelning (avtal 'profit_after_costs'): butikens andel räknas per butik, månad och
 * avtal på orderna MED inköpspris (profit-split.ts) och fördelas på just de orderna i
 * proportion till beloppet inkl. moms, med största-restmetoden. Order utan pris bär ingen
 * andel; `profitSplits` visar hur många de är, och butiksrapporten stoppas då.
 * Återbetalningar (`refunds`) dras från försäljningen i återbetalningens månad.
 *
 * VMB-moms på vår vinst (vmb.ts, samlad per kalendermånad): bara med `settings.vmb` och
 * momssats 0 (annars är momsen redan dragen från intäkten). Per månad i perioden
 *   marginal = Σ belopp inkl. moms (order med inköpspris) − återbetalningar − inköp − underskott
 * med underskottet fört vidare mellan periodens månader (från 0 vid periodens början). Momsen
 * fördelas på månadens order med inköpspris i proportion till max(0, belopp − inköp), med
 * största-restmetoden, så att alla vyer summerar exakt till periodens VMB-moms (`vmb`).
 * En månad som bara delvis ligger i perioden räknas på periodens dagar (`partialMonth`).
 * I en filtrerad vy (butik/automat) ger `vmbByOrder` orderns del av hela organisationens
 * VMB-moms, så att butikens sida visar samma VMB-moms och vinst som butikens rad.
 */

import { assertPeriod, eachMonth, maxDate, minDate, monthEnd, monthStart } from "./dates";
import { DomainError } from "./errors";
import {
  assertOrder,
  computeOrderEconomics,
  createEconomicsContext,
  type EconomicsContext,
} from "./economics";
import { allocateLargestRemainder, allocateLargestRemainderBig } from "./money";
import { isProfitSplit, profitSplit, type ProfitSplitResult } from "./profit-split";
import { rentByStoreMonth, type StoreMonthRent } from "./rent";
import { vmbApplies, vmbVat, type VmbResult } from "./vmb";
import type {
  IsoDate,
  IsoMonth,
  OrderLine,
  Period,
  ProfitabilityInput,
  Settings,
  SourceRefund,
  StoreAgreement,
} from "./types";

/** En order i liggaren. Alla belopp i öre. */
export interface LedgerEntry {
  readonly order: OrderLine;
  readonly storeId: string | null;
  readonly month: IsoMonth;
  /** Sant om ordern har ett inköpspris och därmed räknas in i vinsten. */
  readonly priced: boolean;
  readonly grossOre: number;
  readonly vatOre: number;
  readonly netRevenueOre: number;
  /** Inköp (0 om pris saknas – se `priced`). */
  readonly costOre: number;
  readonly cardFeeOre: number;
  readonly commissionOre: number;
  /** Orderns andel av butikens månadshyra (även för order utan pris). */
  readonly rentOre: number;
  /** Orderns andel av månadens VMB-moms (0 för order utan pris och utan VMB). */
  readonly vmbVatOre: number;
}

/** VMB-momsen för en kalendermånad (den del av månaden som ligger i perioden). */
export interface VmbMonth extends VmbResult {
  readonly month: IsoMonth;
  /** Månadens dagar i perioden. */
  readonly range: Period;
  /** Sant när perioden bara täcker en del av månaden: momsen är då preliminär. */
  readonly partialMonth: boolean;
  /** Återbetalningar i månaden (ingår i `salesInclVatOre`, som är efter återbetalningar). */
  readonly refundsOre: number;
}

/** Vinstdelningen för en butik, en kalendermånad och ett avtal (inom perioden). */
export interface StoreMonthSplit {
  readonly storeId: string;
  readonly month: IsoMonth;
  /** Avtalets startdag (identifierar avtalet). */
  readonly validFrom: IsoDate;
  /** Dagarna i månaden, inom perioden, då avtalet gällde. */
  readonly range: Period;
  /**
   * Sant när perioden bara täcker en del av avtalets dagar i månaden (t.ex. "senaste 30
   * dagarna"). Andelen är då preliminär: förlustgolvet och avrundningen gäller hela
   * månaden, så butiksrapporten för månaden kan visa en annan andel.
   */
  readonly partialMonth: boolean;
  /** Alla butikens order under avtalet i månaden, med och utan inköpspris. */
  readonly orders: number;
  /** Order utan inköpspris: de ingår inte i `result`. */
  readonly unpricedOrders: number;
  /** Titlarna som saknar inköpspris, sorterade. */
  readonly unpricedTitleIds: readonly string[];
  /** Uträkningen på orderna med inköpspris. */
  readonly result: ProfitSplitResult;
}

/** Hyra för en butik-månad som saknade order (på dagar med hyra) att fördelas på. */
export interface UnallocatedRent {
  readonly storeId: string;
  readonly month: IsoMonth;
  readonly rentOre: number;
}

/** Saker som bör åtgärdas för att siffrorna ska bli kompletta (används t.ex. i Att göra). */
export interface LedgerDiagnostics {
  /** Order utanför perioden som filtrerades bort. */
  readonly ordersOutsidePeriod: number;
  /** Order utan kopplad automat (källans automat inte kopplad). */
  readonly ordersWithoutMachine: number;
  /** Order från en automat som inte var placerad i någon butik den dagen. */
  readonly ordersWithoutStore: number;
  /** Order i en butik som saknade avtal den dagen (ingen provision). */
  readonly ordersWithoutAgreement: number;
  readonly machinesWithoutPlacement: string[];
  readonly storesWithoutAgreement: string[];
}

/** Liggaren för en period. */
export interface Ledger {
  readonly period: Period;
  readonly settings: Settings;
  readonly entries: readonly LedgerEntry[];
  /** Hyra per butik och månad (inom perioden), fördelad eller inte. */
  readonly storeMonthRent: readonly StoreMonthRent[];
  readonly unallocatedRent: readonly UnallocatedRent[];
  /** Vinstdelning per butik, månad och avtal (bara avtal med vinstdelning). */
  readonly profitSplits: readonly StoreMonthSplit[];
  /** VMB-moms per månad i perioden, äldst först. Tom utan VMB (`vmbApplies`). */
  readonly vmb: readonly VmbMonth[];
  readonly diagnostics: LedgerDiagnostics;
  /** Uppslagen som användes (priser, placeringar, avtal). */
  readonly context: EconomicsContext;
}

/** Månadshyran som gällde en dag i butik-månaden (0 om inget hyresavtal gällde). */
function rentRateOn(sm: StoreMonthRent, date: IsoDate): number {
  for (const seg of sm.segments)
    if (seg.start <= date && date <= seg.end) return seg.monthlyRentOre;
  return 0;
}

type MutableEntry = { -readonly [K in keyof LedgerEntry]: LedgerEntry[K] };

function compareEntries(a: MutableEntry, b: MutableEntry): number {
  const da = a.order.businessDate;
  const db = b.order.businessDate;
  if (da !== db) return da < db ? -1 : 1;
  const ia = a.order.id;
  const ib = b.order.id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** En byggd liggare och indatan den byggdes av (jämförs på identitet). */
interface CachedLedger {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly count: number;
  readonly prices: ProfitabilityInput["prices"];
  readonly agreements: ProfitabilityInput["agreements"];
  readonly placements: ProfitabilityInput["placements"];
  readonly settings: Settings;
  readonly refunds: ProfitabilityInput["refunds"];
  readonly vmbByOrder: ProfitabilityInput["vmbByOrder"];
  readonly ledger: Ledger;
}

/** Högst så många perioder sparas per orderlista. */
const LEDGER_CACHE_PER_ORDERS = 24;

/**
 * Byggda liggare per orderlista. En sida räknar ofta flera vyer (lönsamhet, nyckeltal,
 * titlar, scenarier) på samma order och period; liggaren byggs då en gång. Nyckeln är
 * orderlistan (WeakMap: posten försvinner med listan, dvs. med förfrågan) och träffen
 * kräver samma period och samma priser, avtal, placeringar och inställningar (samma
 * objekt) och lika många order. Indatan är `readonly` och ändras inte efter anropet.
 */
const ledgerCache = new WeakMap<readonly OrderLine[], CachedLedger[]>();

/**
 * Bygger liggaren för perioden. Kastar `DomainError` vid ogiltig indata. Samma indata
 * (samma objekt) ger samma liggare, som då inte byggs igen.
 */
export function buildLedger(input: ProfitabilityInput): Ledger {
  const cached = ledgerCache.get(input.orders);
  const hit = cached?.find(
    (c) =>
      c.start === input.period.start &&
      c.end === input.period.end &&
      c.count === input.orders.length &&
      c.prices === input.prices &&
      c.agreements === input.agreements &&
      c.placements === input.placements &&
      c.settings === input.settings &&
      c.refunds === input.refunds &&
      c.vmbByOrder === input.vmbByOrder,
  );
  if (hit) return hit.ledger;
  const ledger = computeLedger(input);
  const entry: CachedLedger = {
    start: input.period.start,
    end: input.period.end,
    count: input.orders.length,
    prices: input.prices,
    agreements: input.agreements,
    placements: input.placements,
    settings: input.settings,
    refunds: input.refunds,
    vmbByOrder: input.vmbByOrder,
    ledger,
  };
  if (cached) {
    if (cached.length >= LEDGER_CACHE_PER_ORDERS) cached.shift();
    cached.push(entry);
  } else ledgerCache.set(input.orders, [entry]);
  return ledger;
}

/** Orderlistor som redan är kontrollerade (antal order när de kontrollerades). */
const validatedOrders = new WeakMap<readonly OrderLine[], number>();

/**
 * Kontrollerar varje order (assertOrder) och att inget id finns två gånger, i listans
 * ordning (första felet kastas). En lista som redan är kontrollerad (samma objekt, lika
 * många order) kontrolleras inte igen: samma order räknas ofta för flera perioder.
 */
function validateOrders(orders: readonly OrderLine[]): void {
  if (validatedOrders.get(orders) === orders.length) return;
  const seen = new Set<string>();
  for (const order of orders) {
    assertOrder(order);
    if (seen.has(order.id)) {
      throw new DomainError(
        "duplicate_order",
        `Order ${order.externalId} (${order.id}) finns två gånger.`,
      );
    }
    seen.add(order.id);
  }
  validatedOrders.set(orders, orders.length);
}

function computeLedger(input: ProfitabilityInput): Ledger {
  assertPeriod(input.period);
  const { period } = input;
  const context = createEconomicsContext(input);

  validateOrders(input.orders);
  const entries: MutableEntry[] = [];
  const agreementOf: (StoreAgreement | null)[] = [];
  let outside = 0;
  let withoutMachine = 0;
  let withoutStore = 0;
  let withoutAgreement = 0;
  const unplacedMachines = new Set<string>();
  const storesWithoutAgreement = new Set<string>();

  for (const order of input.orders) {
    const date = order.businessDate;
    if (date < period.start || date > period.end) {
      outside++;
      continue;
    }
    const econ = computeOrderEconomics(order, context);
    if (order.machineId === null) withoutMachine++;
    else if (econ.storeId === null) {
      withoutStore++;
      unplacedMachines.add(order.machineId);
    } else if (econ.agreement === null) {
      withoutAgreement++;
      storesWithoutAgreement.add(econ.storeId);
    }
    entries.push({
      order,
      storeId: econ.storeId,
      month: date.slice(0, 7),
      priced: econ.costOre !== null,
      grossOre: econ.grossOre,
      vatOre: econ.vatOre,
      netRevenueOre: econ.netRevenueOre,
      costOre: econ.costOre ?? 0,
      cardFeeOre: econ.cardFeeOre,
      commissionOre: econ.commissionOre,
      rentOre: 0,
      vmbVatOre: 0,
    });
    agreementOf.push(econ.agreement);
  }

  // Hyra per butik-månad och fördelning på orderna.
  const storeMonthRent = rentByStoreMonth(context.agreements, period);
  const byStoreMonth = new Map<string, MutableEntry[]>();
  for (const e of entries) {
    if (e.storeId === null) continue;
    const key = `${e.storeId}\u0000${e.month}`;
    const list = byStoreMonth.get(key);
    if (list) list.push(e);
    else byStoreMonth.set(key, [e]);
  }
  const unallocatedRent: UnallocatedRent[] = [];
  for (const sm of storeMonthRent) {
    if (sm.rentOre === 0) continue;
    const list = byStoreMonth.get(`${sm.storeId}\u0000${sm.month}`);
    if (!list || list.length === 0) {
      unallocatedRent.push({ storeId: sm.storeId, month: sm.month, rentOre: sm.rentOre });
      continue;
    }
    list.sort(compareEntries);
    // Vikt = nettointäkt × den månadshyra som gällde orderns dag. Order på dagar utan
    // hyresavtal (t.ex. före ett avtalsbyte från bara provision till hyra) bär ingen hyra.
    const rates = list.map((e) => rentRateOn(sm, e.order.businessDate));
    let weights = list.map((e, i) => e.netRevenueOre * rates[i]!);
    if (weights.every((w) => w === 0)) weights = rates; // alla netto 0 → lika per order och hyresdag
    if (weights.every((w) => w === 0)) {
      // Inga order på dagar med hyra: hyran kan inte bäras av någon order.
      unallocatedRent.push({ storeId: sm.storeId, month: sm.month, rentOre: sm.rentOre });
      continue;
    }
    // Vikterna som vanliga tal när produkterna är säkra heltal (samma fördelning, se
    // allocateLargestRemainder); annars som bigint, som förut.
    const shares = weights.every((w) => Number.isSafeInteger(w))
      ? allocateLargestRemainder(sm.rentOre, weights)
      : allocateLargestRemainderBig(
          sm.rentOre,
          list.map((e, i) =>
            weights === rates ? BigInt(rates[i]!) : BigInt(e.netRevenueOre) * BigInt(rates[i]!),
          ),
        );
    for (let i = 0; i < list.length; i++) list[i]!.rentOre = shares[i]!;
  }

  const profitSplits = allocateProfitSplits(
    context,
    period,
    entries,
    agreementOf,
    input.refunds ?? [],
  );

  const vmb = vmbApplies(input.settings)
    ? allocateVmb(period, entries, input.refunds ?? [], input.vmbByOrder)
    : [];

  return {
    period,
    settings: input.settings,
    entries,
    storeMonthRent,
    unallocatedRent,
    profitSplits,
    vmb,
    diagnostics: {
      ordersOutsidePeriod: outside,
      ordersWithoutMachine: withoutMachine,
      ordersWithoutStore: withoutStore,
      ordersWithoutAgreement: withoutAgreement,
      machinesWithoutPlacement: [...unplacedMachines].sort(),
      storesWithoutAgreement: [...storesWithoutAgreement].sort(),
    },
    context,
  };
}

/**
 * Vinstdelningen per butik, månad och avtal, och fördelningen av butikens andel på
 * orderna med inköpspris (vikt = belopp inkl. moms, största-restmetoden).
 */
function allocateProfitSplits(
  context: EconomicsContext,
  period: Period,
  entries: MutableEntry[],
  agreementOf: readonly (StoreAgreement | null)[],
  refunds: readonly SourceRefund[],
): StoreMonthSplit[] {
  const key = (storeId: string, month: IsoMonth, validFrom: IsoDate): string =>
    `${storeId}\u0000${month}\u0000${validFrom}`;
  const groups = new Map<
    string,
    {
      agreement: StoreAgreement;
      month: IsoMonth;
      range: Period;
      partialMonth: boolean;
      list: MutableEntry[];
      refundsOre: number;
    }
  >();
  for (const a of context.agreements.all()) {
    if (!isProfitSplit(a)) continue;
    const start = maxDate(a.validFrom, period.start);
    const end = a.validTo === null ? period.end : minDate(a.validTo, period.end);
    if (end < start) continue;
    for (const month of eachMonth(start, end)) {
      const range = {
        start: maxDate(start, monthStart(month)),
        end: minDate(end, monthEnd(month)),
      };
      // Avtalets dagar i hela månaden (oberoende av perioden).
      const fullStart = maxDate(a.validFrom, monthStart(month));
      const fullEnd = a.validTo === null ? monthEnd(month) : minDate(a.validTo, monthEnd(month));
      groups.set(key(a.storeId, month, a.validFrom), {
        agreement: a,
        month,
        range,
        partialMonth: fullStart < range.start || fullEnd > range.end,
        list: [],
        refundsOre: 0,
      });
    }
  }
  if (groups.size === 0) return [];
  for (let i = 0; i < entries.length; i++) {
    const a = agreementOf[i];
    const e = entries[i]!;
    if (!a || e.storeId === null || !isProfitSplit(a)) continue;
    groups.get(key(e.storeId, e.month, a.validFrom))?.list.push(e);
  }
  // Återbetalningar: på butiken där automaten stod återbetalningsdagen, i avtalets dagar.
  for (const r of refunds) {
    if (r.machineId === null || !(r.amountOre > 0)) continue;
    if (r.refundedOn < period.start || r.refundedOn > period.end) continue;
    const storeId = context.placements.storeOn(r.machineId, r.refundedOn);
    if (storeId === null) continue;
    const a = context.agreements.agreementOn(storeId, r.refundedOn);
    if (!a || !isProfitSplit(a)) continue;
    const g = groups.get(key(storeId, r.refundedOn.slice(0, 7), a.validFrom));
    if (g) g.refundsOre += r.amountOre;
  }
  const out: StoreMonthSplit[] = [];
  for (const g of groups.values()) {
    g.list.sort(compareEntries);
    const priced = g.list.filter((e) => e.priced);
    let sales = 0;
    let purchases = 0;
    let fees = 0;
    for (const e of priced) {
      sales += e.grossOre;
      purchases += e.costOre;
      fees += e.cardFeeOre;
    }
    const result = profitSplit({
      salesInclVatOre: sales,
      refundsOre: g.refundsOre,
      purchasesOre: purchases,
      cardFeesOre: fees,
      shareBp: g.agreement.commissionBp ?? 0,
      lossTreatment: g.agreement.lossTreatment ?? "zero",
      vmbBeforeSplit: g.agreement.vmbBeforeSplit === true,
    });
    if (priced.length > 0 && result.storeShareOre !== 0) {
      const shares = allocateLargestRemainder(
        result.storeShareOre,
        priced.map((e) => e.grossOre),
      );
      for (let i = 0; i < priced.length; i++) priced[i]!.commissionOre = shares[i]!;
    }
    const unpriced = g.list.filter((e) => !e.priced);
    out.push({
      storeId: g.agreement.storeId,
      month: g.month,
      validFrom: g.agreement.validFrom,
      range: g.range,
      partialMonth: g.partialMonth,
      orders: g.list.length,
      unpricedOrders: unpriced.length,
      unpricedTitleIds: [...new Set(unpriced.map((e) => e.order.titleId))].sort(),
      result,
    });
  }
  out.sort((x, y) =>
    x.storeId !== y.storeId
      ? x.storeId < y.storeId
        ? -1
        : 1
      : x.month !== y.month
        ? x.month < y.month
          ? -1
          : 1
        : x.validFrom < y.validFrom
          ? -1
          : x.validFrom > y.validFrom
            ? 1
            : 0,
  );
  return out;
}

/**
 * VMB-momsen per månad i perioden (samlad: alla order med inköpspris och alla
 * återbetalningar i perioden), och fördelningen på orderna (se filhuvudet).
 */
function allocateVmb(
  period: Period,
  entries: MutableEntry[],
  refunds: readonly SourceRefund[],
  orgShares?: ReadonlyMap<string, number>,
): VmbMonth[] {
  const byMonth = new Map<IsoMonth, MutableEntry[]>();
  for (const e of entries) {
    if (!e.priced) continue;
    const list = byMonth.get(e.month);
    if (list) list.push(e);
    else byMonth.set(e.month, [e]);
  }
  const refundsByMonth = new Map<IsoMonth, number>();
  for (const r of refunds) {
    if (!(r.amountOre > 0)) continue;
    if (r.refundedOn < period.start || r.refundedOn > period.end) continue;
    const m = r.refundedOn.slice(0, 7);
    refundsByMonth.set(m, (refundsByMonth.get(m) ?? 0) + r.amountOre);
  }
  const out: VmbMonth[] = [];
  let carry = 0;
  for (const month of eachMonth(period.start, period.end)) {
    const list = byMonth.get(month) ?? [];
    let sales = 0;
    let purchases = 0;
    for (const e of list) {
      sales += e.grossOre;
      purchases += e.costOre;
    }
    const refundsOre = refundsByMonth.get(month) ?? 0;
    const result = vmbVat({
      salesInclVatOre: sales - refundsOre,
      purchasesOre: purchases,
      carryInOre: carry,
    });
    carry = result.carryOutOre;
    let vatOre = result.vatOre;
    if (orgShares) {
      // Filtrerad vy: orderns del av organisationens VMB-moms (samma tal som i den ofiltrerade
      // vyns rad), inte momsen på urvalets egen marginal.
      vatOre = 0;
      for (const e of list) {
        e.vmbVatOre = orgShares.get(e.order.id) ?? 0;
        vatOre += e.vmbVatOre;
      }
    } else if (result.vatOre !== 0) {
      list.sort(compareEntries);
      const weights = list.map((e) => Math.max(0, e.grossOre - e.costOre));
      // En positiv marginal kräver minst en order med belopp över inköpet.
      const shares = allocateLargestRemainder(result.vatOre, weights);
      for (let i = 0; i < list.length; i++) list[i]!.vmbVatOre = shares[i]!;
    }
    const range = {
      start: maxDate(period.start, monthStart(month)),
      end: minDate(period.end, monthEnd(month)),
    };
    out.push({
      ...result,
      vatOre,
      month,
      range,
      partialMonth: range.start !== monthStart(month) || range.end !== monthEnd(month),
      refundsOre,
    });
  }
  return out;
}
