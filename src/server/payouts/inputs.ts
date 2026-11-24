/**
 * Underlaget för att dela en utbetalning från Nayax (src/domain/payout-split.ts), läst ur
 * databasen. Bara läsning; körs i anroparens transaktion (användaren under RLS, eller
 * systemet i det dagliga jobbet).
 *
 * - Försäljningen per butik, kalendermånad och dag: order (testköp räknas inte) grupperade
 *   i databasen per automat, titel och dag, sedan butiken (placeringen den dagen) och vårt
 *   inköpspris (purchase_prices, samma uppslag som Lönsamhet och liggaren) i appen. Order
 *   utan titel eller pris räknas i försäljningen men saknar inköp (UNPRICED).
 *   Återbetalningar till kunder dras på återbetalningsdagen i butiken automaten stod i.
 *   Betalar ägaren dem själv (organization_settings.refunds_paid_via = 'outside', standard)
 *   ingår de inte i det vi väntar från Nayax och dras från vinsten före delningen.
 * - Butikens andel per butik och månad: hela månaden med en avräkning →
 *   avräkningens grundbelopp; annars avräkningens uträkning för just dagarna
 *   (computeSettlementsTx med period, en laddning per månad för alla butiker). Går
 *   uträkningen inte (t.ex. saknat inköpspris under vinstdelning) blir andelen 0 med
 *   varningen SHARE_UNKNOWN, och raderna kan inte markeras som betalda förrän det är rättat.
 * - Avräkningens grundbelopp = beloppet − rättelser som lagts på den från tidigare månader
 *   ("Lägg på nästa avräkning" under Butiker). Rättelserna är skillnader mellan det butiken
 *   fick och det den skulle ha för en tidigare månad, och de är redan med i den månadens
 *   justering här; med dem två gånger skulle butiken dras eller få dubbelt.
 * - Justering: för en månad som har en avräkning och vars alla dagar täcks av
 *   utbetalningar (den här och tidigare) = grundbeloppet − det som redan fördelats för
 *   butiken och månaden − den här utbetalningens del. Summan för månaden blir då exakt
 *   avräkningens grundbelopp.
 * - Partneravtalen delar dagarna i avsnitt; momsläget (vat-reserve.ts) och underskotten
 *   från förra utbetalningen.
 */

import "server-only";

import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  addDays,
  addMonths,
  AgreementIndex,
  applyBp,
  cardFeeBpOn,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
  PlacementIndex,
  PriceIndex,
  resolveVatReserveMode,
  shareJumpWarnings,
  type IsoDate,
  type IsoMonth,
  type PartnerSegment,
  type Payee,
  type SplitInput,
  type SplitSlice,
  type SplitTotals,
  type StoreComponent,
  type SplitTrueUp,
  type SplitWarning,
  type VatReserveMode,
} from "@/domain";
import {
  queryAgreements,
  queryEffectivePlacements,
  queryPeriodRefunds,
  queryPrices,
  querySettings,
} from "@/server/data/core/queries";
import type { OrgSettings, PlacementRecord } from "@/server/data/core/types";
import { storesPlacedIn } from "@/server/reports/sources";
import { monthSlices, isWholeMonth } from "@/server/settlements/advance";
import { computeSettlementsTx } from "@/server/settlements/live";
import { parseCorrections, parseStatement } from "@/server/settlements/model";

/** En utbetalning som ska delas. */
export interface PayoutRef {
  readonly id: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly amountOre: number;
}

export interface PartnerAgreementRecord {
  readonly id: string;
  readonly partnerName: string;
  readonly reimburseCost: boolean;
  readonly profitShareBp: number;
  readonly validFrom: IsoDate;
}

/** Det som är gemensamt för alla utbetalningar i en omräkning (laddas en gång). */
export interface OrgPayoutContext {
  readonly organizationId: string;
  readonly prices: PriceIndex;
  readonly placements: readonly PlacementRecord[];
  readonly placementIndex: PlacementIndex;
  readonly agreements: AgreementIndex;
  readonly settings: OrgSettings;
  readonly vatMode: VatReserveMode;
  /** Återbetalningar till kunder görs i Nayax (dras från beloppet) eller av ägaren själv. */
  readonly refundsVia: "nayax" | "outside";
  readonly partners: readonly PartnerAgreementRecord[];
  readonly storeOwner: ReadonlyMap<string, string | null>;
  /** Avräkningarna per "butik|ÅÅÅÅ-MM" (amountOre = grundbeloppet, se filhuvudet). */
  readonly settlements: ReadonlyMap<
    string,
    { readonly amountOre: number; readonly salesOre: number | null }
  >;
}

/** Det som tidigare utbetalningar (i ordning) har fördelat. */
export interface PriorState {
  /** Fördelat per "butik|ÅÅÅÅ-MM". */
  readonly allocated: ReadonlyMap<string, number>;
  /** Dagarna tidigare utbetalningar täcker. */
  readonly covered: readonly { readonly from: IsoDate; readonly to: IsoDate }[];
  readonly vatCarryOutOre: number;
  readonly partnerCarryOutOre: number;
  /** Rättelser från låsta utbetalningar som ska läggas på den här (allocate.ts). */
  readonly partnerAdjustOre: number;
  readonly vatAdjustOre: number;
}

export interface AllocationInputs {
  readonly split: SplitInput;
  readonly extraWarnings: readonly SplitWarning[];
  /** Dagar med försäljning i perioden (för luckor mellan utbetalningar). */
  readonly salesDays: readonly IsoDate[];
  readonly hash: string;
}

export const smKey = (storeId: string, month: string) => `${storeId}|${month.slice(0, 7)}`;

/** Laddar det som är gemensamt för organisationen. */
export async function loadOrgPayoutContextTx(tx: Tx, orgId: string): Promise<OrgPayoutContext> {
  const [prices, placements, agreements, settings, extra, partners, stores, settlements] =
    await Promise.all([
      queryPrices(tx, orgId),
      queryEffectivePlacements(tx, orgId),
      queryAgreements(tx, orgId),
      querySettings(tx, orgId),
      tx.execute(sql`
        select coalesce((select vat_reserve_mode from public.organization_settings
                          where organization_id = ${orgId}::uuid), 'auto') as mode,
               coalesce((select refunds_paid_via from public.organization_settings
                          where organization_id = ${orgId}::uuid), 'outside') as refunds_via,
               coalesce((select report_vmb from public.organization_settings
                          where organization_id = ${orgId}::uuid), false) as report_vmb,
               coalesce((select vmb_enabled from public.bookkeeping_settings
                          where organization_id = ${orgId}::uuid), false) as bookkeeping_vmb`),
      tx
        .select({
          id: s.partnerAgreements.id,
          partnerName: s.partnerAgreements.partnerName,
          reimburseCost: s.partnerAgreements.reimburseCost,
          profitShareBp: s.partnerAgreements.profitShareBp,
          validFrom: s.partnerAgreements.validFrom,
        })
        .from(s.partnerAgreements)
        .where(
          and(
            eq(s.partnerAgreements.organizationId, orgId),
            isNull(s.partnerAgreements.archivedAt),
          ),
        ),
      tx
        .select({ id: s.stores.id, ownerId: s.stores.ownerId })
        .from(s.stores)
        .where(eq(s.stores.organizationId, orgId)),
      tx
        .select({
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          amountOre: s.storeSettlements.amountOre,
          statement: s.storeSettlements.statement,
          corrections: s.storeSettlements.corrections,
        })
        .from(s.storeSettlements)
        .where(eq(s.storeSettlements.organizationId, orgId)),
    ]);
  const flags = Array.from(extra)[0] as
    | { mode: string; refunds_via: string; report_vmb: boolean; bookkeeping_vmb: boolean }
    | undefined;
  return {
    organizationId: orgId,
    prices: new PriceIndex(prices),
    placements,
    placementIndex: new PlacementIndex(
      placements.map((p) => ({
        machineId: p.machineId,
        storeId: p.storeId,
        from: p.from,
        to: p.to,
      })),
    ),
    agreements: new AgreementIndex(agreements),
    settings,
    vatMode: resolveVatReserveMode(flags?.mode, {
      bookkeepingVmb: flags?.bookkeeping_vmb === true,
      reportVmb: flags?.report_vmb === true,
    }),
    refundsVia: flags?.refunds_via === "nayax" ? "nayax" : "outside",
    partners: partners.sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1)),
    storeOwner: new Map(stores.map((r) => [r.id, r.ownerId])),
    settlements: new Map(
      settlements.map((r) => [
        smKey(r.storeId, r.month),
        {
          amountOre:
            r.amountOre - parseCorrections(r.corrections).reduce((a, c) => a + c.amountOre, 0),
          salesOre: parseStatement(r.statement)?.salesInclVatOre ?? null,
        },
      ]),
    ),
  };
}

export function payeeOf(ctx: OrgPayoutContext, storeId: string): Payee {
  const owner = ctx.storeOwner.get(storeId) ?? null;
  return owner ? { kind: "store_owner", id: owner } : { kind: "store", id: storeId };
}

export interface DayGroup {
  storeId: string | null;
  date: IsoDate;
  orders: number;
  grossOre: number;
  /** Försäljningen för order med inköpspris (VMB-marginalen, som liggaren). */
  pricedGrossOre: number;
  refundsOre: number;
  costOre: number;
  unpriced: number;
  priced: number;
  feeOre: number;
}

/** Försäljningen per butik och dag i perioden (se filhuvudet). */
export async function loadDayTotalsTx(
  tx: Tx,
  ctx: OrgPayoutContext,
  from: IsoDate,
  to: IsoDate,
): Promise<DayGroup[]> {
  const orgId = ctx.organizationId;
  const [rows, refunds] = await Promise.all([
    tx.execute(sql`
      select o.machine_id, o.title_id, o.business_date::text as d,
             count(*)::int as n, sum(o.amount_ore)::bigint as gross
      from public.orders o
      where o.organization_id = ${orgId}::uuid
        and o.business_date >= ${from}::date and o.business_date <= ${to}::date
        and o.test_purchase_at is null
      group by 1, 2, 3`),
    queryPeriodRefunds(tx, orgId, { start: from, end: to }),
  ]);
  const groups = new Map<string, DayGroup>();
  const groupOf = (storeId: string | null, date: IsoDate) => {
    const key = `${storeId ?? ""}|${date}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        storeId,
        date,
        orders: 0,
        grossOre: 0,
        pricedGrossOre: 0,
        refundsOre: 0,
        costOre: 0,
        unpriced: 0,
        priced: 0,
        feeOre: 0,
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of Array.from(rows) as {
    machine_id: string | null;
    title_id: string | null;
    d: string;
    n: number;
    gross: string | number;
  }[]) {
    const storeId = r.machine_id ? ctx.placementIndex.storeOn(r.machine_id, r.d) : null;
    const g = groupOf(storeId, r.d);
    const gross = Number(r.gross);
    g.orders += r.n;
    g.grossOre += gross;
    const bp = cardFeeBpOn(ctx.settings, r.d);
    g.feeOre += bp === 0 ? 0 : applyBp(gross, bp);
    const price = r.title_id ? ctx.prices.priceOn(r.title_id, r.d) : null;
    if (price) {
      g.costOre += price.unitCostOre * r.n;
      g.priced += r.n;
      g.pricedGrossOre += gross;
    } else {
      g.unpriced += r.n;
    }
  }
  for (const f of refunds) {
    const storeId = f.machineId ? ctx.placementIndex.storeOn(f.machineId, f.refundedOn) : null;
    groupOf(storeId, f.refundedOn).refundsOre += f.amountOre;
  }
  return [...groups.values()];
}

/**
 * Väntat netto från Nayax per dag: försäljning − beräknad avgift, och − återbetalningar när
 * de görs i Nayax (`refundsVia`, se filhuvudet).
 */
export function expectedByDay(
  groups: readonly DayGroup[],
  refundsVia: "nayax" | "outside" = "nayax",
): Map<IsoDate, number> {
  const out = new Map<IsoDate, number>();
  for (const g of groups) {
    const refunds = refundsVia === "nayax" ? g.refundsOre : 0;
    out.set(g.date, (out.get(g.date) ?? 0) + g.grossOre - refunds - g.feeOre);
  }
  return out;
}

function fullyCovered(month: IsoMonth, ranges: readonly { from: IsoDate; to: IsoDate }[]): boolean {
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : 1));
  let next = monthStart(month);
  const end = monthEnd(month);
  for (const r of sorted) {
    if (r.to < next) continue;
    if (r.from > next) return false;
    next = addDays(r.to, 1);
    if (next > end) return true;
  }
  return next > end;
}

function partnerSegments(
  ctx: OrgPayoutContext,
  from: IsoDate,
  to: IsoDate,
  groups: readonly DayGroup[],
): PartnerSegment[] | null {
  if (ctx.partners.length === 0) return null;
  // Avsnittens gränser: avtalens startdagar inom perioden.
  const bounds: { from: IsoDate; agreement: PartnerAgreementRecord | null }[] = [];
  const activeAt = (d: IsoDate) =>
    [...ctx.partners].reverse().find((p) => p.validFrom <= d) ?? null;
  bounds.push({ from, agreement: activeAt(from) });
  for (const p of ctx.partners) {
    if (p.validFrom > from && p.validFrom <= to) bounds.push({ from: p.validFrom, agreement: p });
  }
  return bounds.map((b, i) => {
    const segTo = i + 1 < bounds.length ? addDays(bounds[i + 1]!.from, -1) : to;
    let cost = 0;
    let packs = 0;
    let weight = 0;
    for (const g of groups) {
      if (g.date < b.from || g.date > segTo) continue;
      cost += g.costOre;
      packs += g.priced;
      weight += g.grossOre - g.refundsOre - g.costOre;
    }
    return {
      agreementId: b.agreement?.id ?? null,
      reimburse: b.agreement?.reimburseCost ?? false,
      bp: b.agreement?.profitShareBp ?? 0,
      from: b.from,
      to: segTo,
      costOre: cost,
      packs,
      weightOre: weight,
    };
  });
}

/** Underlaget för en utbetalning (se filhuvudet). */
export async function loadAllocationInputsTx(
  tx: Tx,
  ctx: OrgPayoutContext,
  payout: PayoutRef,
  prior: PriorState,
  now: Date,
): Promise<AllocationInputs> {
  const from = payout.periodStart;
  const to = payout.periodEnd;
  const groups = await loadDayTotalsTx(tx, ctx, from, to);
  const slices: SplitSlice[] = [];
  const shareUnknown: SplitWarning[] = [];
  const own = new Map<string, number>();
  const shareHistory: {
    storeId: string;
    shareOre: number;
    grossOre: number;
    historyBp: number[];
  }[] = [];
  for (const m of monthSlices({ start: from, end: to })) {
    const inMonth = groups.filter((g) => g.date >= m.start && g.date <= m.end);
    const placed = storesPlacedIn(ctx.placements, { start: m.start, end: m.end });
    const storeIds = [
      ...new Set([...placed, ...inMonth.flatMap((g) => (g.storeId ? [g.storeId] : []))]),
    ];
    const whole = isWholeMonth(m);
    const needLive = storeIds.filter((id) => !(whole && ctx.settlements.has(smKey(id, m.month))));
    const live =
      needLive.length > 0
        ? await computeSettlementsTx(tx, {
            organizationId: ctx.organizationId,
            month: m.month,
            storeIds: needLive,
            now,
            ...(whole ? {} : { period: { start: m.start, end: m.end } }),
          })
        : new Map();
    for (const storeId of [...storeIds, null]) {
      const mine = inMonth.filter((g) => g.storeId === storeId);
      if (storeId === null && mine.length === 0) continue;
      const sum = (f: (g: DayGroup) => number) => mine.reduce((a, g) => a + f(g), 0);
      let share = 0;
      let source: SplitSlice["shareSource"] = "none";
      if (storeId !== null) {
        const settled = whole ? ctx.settlements.get(smKey(storeId, m.month)) : undefined;
        if (settled) {
          share = settled.amountOre;
          source = "settlement";
        } else {
          const l = live.get(storeId);
          if (l?.ok) {
            share = l.computed.amountOre;
            source = "live";
          } else if (l && !l.ok) {
            shareUnknown.push({ code: "SHARE_UNKNOWN", storeId, message: l.message.slice(0, 300) });
          }
        }
      }
      const gross = sum((g) => g.grossOre);
      if (storeId !== null && gross === 0 && share === 0 && sum((g) => g.refundsOre) === 0) {
        continue;
      }
      const hasAgreement =
        storeId !== null &&
        ctx.agreements
          .agreementsFor(storeId)
          .some((a) => a.validFrom <= m.end && (a.validTo === null || a.validTo >= m.start));
      slices.push({
        storeId,
        payee: storeId ? payeeOf(ctx, storeId) : null,
        month: m.month,
        from: maxDate(m.start, from),
        to: minDate(m.end, to),
        orders: sum((g) => g.orders),
        grossOre: gross,
        pricedGrossOre: sum((g) => g.pricedGrossOre),
        refundsOre: sum((g) => g.refundsOre),
        costOre: sum((g) => g.costOre),
        unpricedOrders: sum((g) => g.unpriced),
        storeShareOre: share,
        shareSource: source,
        hasAgreement,
      });
      if (storeId !== null) {
        own.set(smKey(storeId, m.month), (own.get(smKey(storeId, m.month)) ?? 0) + share);
        const history: number[] = [];
        for (let k = 1; k <= 3; k++) {
          const st = ctx.settlements.get(smKey(storeId, addMonths(m.month, -k)));
          if (st && st.salesOre && st.salesOre > 0) {
            history.push(Math.round((st.amountOre * 10_000) / st.salesOre));
          }
        }
        shareHistory.push({ storeId, shareOre: share, grossOre: gross, historyBp: history });
      }
    }
  }

  // Justeringar mot månadsavräkningarna (se filhuvudet).
  const trueUps: SplitTrueUp[] = [];
  const covered = [...prior.covered, { from, to }];
  const months = new Set<string>();
  for (const key of [...prior.allocated.keys(), ...own.keys()]) months.add(key);
  for (const key of [...months].sort()) {
    const settled = ctx.settlements.get(key);
    if (!settled) continue;
    const [storeId, month] = key.split("|") as [string, IsoMonth];
    if (!fullyCovered(month, covered)) continue;
    const delta = settled.amountOre - (prior.allocated.get(key) ?? 0) - (own.get(key) ?? 0);
    if (delta !== 0)
      trueUps.push({ storeId, payee: payeeOf(ctx, storeId), month, deltaOre: delta });
  }

  const expected = expectedByDay(groups, ctx.refundsVia);
  const expectedNetOre = [...expected.values()].reduce((a, v) => a + v, 0);
  const segments = partnerSegments(ctx, from, to, groups);
  const split: SplitInput = {
    amountOre: payout.amountOre,
    slices,
    trueUps,
    vat: {
      mode: ctx.vatMode,
      carryInOre: ctx.vatMode === "vmb" ? prior.vatCarryOutOre : 0,
      vatRateBp: ctx.settings.vatRateBp,
      adjustOre: prior.vatAdjustOre,
    },
    partner: segments
      ? { segments, carryInOre: prior.partnerCarryOutOre, adjustOre: prior.partnerAdjustOre }
      : null,
    expectedNetOre,
    refundsOutsideOre:
      ctx.refundsVia === "outside" ? groups.reduce((a, g) => a + g.refundsOre, 0) : 0,
  };
  const salesDays = [...new Set(groups.filter((g) => g.orders > 0).map((g) => g.date))].sort();
  const hash = createHash("sha256")
    .update(JSON.stringify({ split, ownStoreOwners: [...ctx.storeOwner.entries()].sort() }))
    .digest("hex");
  return {
    split,
    extraWarnings: [...shareUnknown, ...shareJumpWarnings(shareHistory)],
    salesDays,
    hash,
  };
}

/** Ett avsnitt med partnerns avtal som det sparades i en uträkning. */
export interface StoredPartnerSegment {
  readonly agreementId: string | null;
  readonly bp: number;
  readonly reimburse: boolean;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/**
 * Underlaget för att räkna en LÅST utbetalning igen med dagens inköpspriser (rättelserna,
 * allocate.ts). Butikernas delar är de låsta (som justeringar, så att raden blir exakt
 * densamma), avtalen med partnern är de låsta (andel och om inköpet betalas tillbaka), och
 * underskotten och rättelserna in är de låsta: bara inköpet, vinstdelen och momsen kan
 * skilja. `groups` = försäljningen per butik och dag (bara utbetalningens dagar används).
 */
export function lockedRecheckInput(
  ctx: OrgPayoutContext,
  payout: PayoutRef,
  groups: readonly DayGroup[],
  locked: {
    readonly stores: readonly StoreComponent[];
    readonly partnerSegments: readonly StoredPartnerSegment[] | null;
    readonly totals: Partial<SplitTotals>;
    readonly vatMode: VatReserveMode;
  },
): SplitInput {
  const mine = groups.filter((g) => g.date >= payout.periodStart && g.date <= payout.periodEnd);
  const byKey = new Map<string, SplitSlice>();
  for (const g of mine) {
    const month = g.date.slice(0, 7) as IsoMonth;
    const key = `${g.storeId ?? ""}|${month}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      storeId: g.storeId,
      payee: null,
      month,
      from: prev ? minDate(prev.from, g.date) : g.date,
      to: prev ? maxDate(prev.to, g.date) : g.date,
      orders: (prev?.orders ?? 0) + g.orders,
      grossOre: (prev?.grossOre ?? 0) + g.grossOre,
      pricedGrossOre: (prev?.pricedGrossOre ?? 0) + g.pricedGrossOre,
      refundsOre: (prev?.refundsOre ?? 0) + g.refundsOre,
      costOre: (prev?.costOre ?? 0) + g.costOre,
      unpricedOrders: (prev?.unpricedOrders ?? 0) + g.unpriced,
      storeShareOre: 0,
      shareSource: "none",
      hasAgreement: true,
    });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
  const segments: PartnerSegment[] | null = locked.partnerSegments
    ? locked.partnerSegments.map((seg) => {
        let cost = 0;
        let packs = 0;
        let weight = 0;
        for (const g of mine) {
          if (g.date < seg.from || g.date > seg.to) continue;
          cost += g.costOre;
          packs += g.priced;
          weight += g.grossOre - g.refundsOre - g.costOre;
        }
        return { ...seg, costOre: cost, packs, weightOre: weight };
      })
    : null;
  return {
    amountOre: payout.amountOre,
    slices: [...byKey.values()],
    trueUps: locked.stores.map((c) => ({
      storeId: c.storeId,
      payee: payeeOf(ctx, c.storeId),
      month: c.month,
      deltaOre: c.shareOre,
    })),
    vat: {
      mode: locked.vatMode,
      carryInOre: num(locked.totals.vatCarryInOre),
      vatRateBp: ctx.settings.vatRateBp,
      adjustOre: num(locked.totals.vatAdjustOre),
    },
    partner: segments
      ? {
          segments,
          carryInOre: num(locked.totals.partnerCarryInOre),
          adjustOre: num(locked.totals.partnerAdjustOre),
        }
      : null,
    expectedNetOre: 0,
    refundsOutsideOre: num(locked.totals.refundsOutsideOre),
  };
}
