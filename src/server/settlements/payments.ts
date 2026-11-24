/**
 * "Registrera betalning" på Butiker → Utbetalning: en betalning till en butik för en egen
 * period (t.ex. 14 okt.–14 nov.), uppdelad per kalendermånad med regeln i ./advance.ts.
 *
 * - Förhandsvisningen (previewPaymentFor) visar delarna innan något sparas; registreringen
 *   räknar dem igen i samma transaktion och sparar bara om de är desamma som ägaren såg.
 * - Täcker betalningen en obetald avräkning blir den betald med betalningarna, och är det
 *   månadens sista stängs månaden (som när ägaren trycker "Markera som betald").
 * - "Ta bort" tar bort en felaktig betalning. Avräkningar som var betalda med den blir
 *   obetalda igen. Ligger en sådan i en stängd månad tas inget bort: ägaren öppnar månaden
 *   först (samma regel som allt annat som ändrar en stängd månad).
 *
 * Ägare och admin ändrar, läsaren läser. Allt körs som användaren under RLS.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, daysBetween, DomainError, type IsoDate, type IsoMonth } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";
import { monthLong } from "@/server/periods/model";
import { closeMonthIfDoneTx, queryClosedMonthKeys } from "@/server/periods/service";

import {
  advancesFor,
  advanceTotal,
  advancePartsOf,
  isWholeMonth,
  monthSlices,
  parseParts,
  partEffectText,
  splitPayment,
  type MonthInfo,
  type PaymentPart,
  type StorePaymentRecord,
} from "./advance";
import { queryStorePayments, settleCoveredTx } from "./advances-db";
import { computeSettlementsTx, liveFor } from "./live";
import { SettlementError } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Längsta period för en betalning (dagar). */
export const MAX_PAYMENT_DAYS = 370;

export interface PaymentInput {
  readonly storeId: string;
  readonly paidOn: string;
  readonly amountOre: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly note?: string | null;
}

export interface CleanInput {
  readonly storeId: string;
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly note: string | null;
}

function validDate(v: string): v is IsoDate {
  return (
    ISO_DATE.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
  );
}

/** Kontrollerar fälten; kastar SettlementError med en mening på svenska. */
export function cleanPaymentInput(input: PaymentInput, today: IsoDate): CleanInput {
  if (!UUID.test(input.storeId)) throw new SettlementError("Välj en butik.");
  if (!validDate(input.paidOn)) throw new SettlementError("Välj dagen du betalade.");
  if (input.paidOn > addDays(today, 1)) {
    throw new SettlementError("Betaldagen kan inte vara i framtiden.");
  }
  if (!Number.isSafeInteger(input.amountOre) || input.amountOre <= 0) {
    throw new SettlementError("Skriv ett belopp över 0 kr.");
  }
  if (input.amountOre > 10_000_000_000) throw new SettlementError("Beloppet är för stort.");
  if (!validDate(input.periodStart) || !validDate(input.periodEnd)) {
    throw new SettlementError("Välj perioden betalningen gäller.");
  }
  if (input.periodEnd < input.periodStart) {
    throw new SettlementError("Perioden slutar före den börjar.");
  }
  if (daysBetween(input.periodStart, input.periodEnd) > MAX_PAYMENT_DAYS) {
    throw new SettlementError("Perioden kan vara högst ett år.");
  }
  const note = (input.note ?? "").trim();
  if (note.length > 500) throw new SettlementError("Anteckningen kan vara högst 500 tecken.");
  return {
    storeId: input.storeId.toLowerCase(),
    paidOn: input.paidOn,
    amountOre: input.amountOre,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    note: note.length > 0 ? note : null,
  };
}

export function paymentDbError(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg && ["BL080", "BL081", "BL082", "22023"].includes(pg.code) && pg.message) {
    throw new SettlementError(pg.message);
  }
  if (pg && pg.code === "23503") throw new SettlementError("Butiken finns inte.");
  throw error;
}

interface SettlementState {
  readonly id: string;
  readonly storeId: string;
  readonly month: IsoMonth;
  readonly amountOre: number;
  readonly paidOn: string | null;
  readonly paidOre: number;
  readonly fromPayments: boolean;
}

async function settlementsOfStore(tx: Tx, orgId: string, storeId: string, lock: boolean) {
  const q = tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
      paidOn: s.storeSettlements.paidOn,
      paidAmountOre: s.storeSettlements.paidAmountOre,
      fromPayments: s.storeSettlements.paidFromPayments,
    })
    .from(s.storeSettlements)
    .where(
      and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.storeId, storeId)),
    );
  const rows = lock ? await q.for("update") : await q;
  return rows.map((r): SettlementState => ({
    id: r.id,
    storeId: r.storeId,
    month: r.month.slice(0, 7) as IsoMonth,
    amountOre: r.amountOre,
    paidOn: r.paidOn,
    paidOre: r.paidAmountOre ?? r.amountOre,
    fromPayments: r.fromPayments,
  }));
}

/** Det appen vet om varje månad i perioden (./advance.ts MonthInfo), i ordning. */
async function monthInfos(
  tx: Tx,
  orgId: string,
  input: CleanInput,
  today: IsoDate,
  now: Date,
  settlements: readonly SettlementState[],
  others: readonly StorePaymentRecord[],
): Promise<MonthInfo[]> {
  const slices = monthSlices({ start: input.periodStart, end: input.periodEnd });
  const otherParts = advancePartsOf(others);
  const out: MonthInfo[] = [];
  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i]!;
    const last = i === slices.length - 1;
    const st = settlements.find((x) => x.month === slice.month) ?? null;
    const otherOre = advanceTotal(advancesFor(otherParts, input.storeId, slice.month));
    let settlement: MonthInfo["settlement"] = null;
    let why: string | undefined;
    if (st && st.paidOn) settlement = { paid: true, openOre: st.paidOre - otherOre };
    else if (st) {
      const live = (await liveFor(tx, orgId, [st], now)).get(st.id);
      if (live?.ok) settlement = { paid: false, openOre: live.computed.amountOre - otherOre };
      else why = live && !live.ok ? live.message : undefined;
    }
    // Den sista månaden får resten: inget behöver räknas för den.
    let rangeOre: number | null = null;
    let monthOre: number | null = null;
    const future = slice.end >= today;
    if (!last && !(settlement && isWholeMonth(slice)) && !future) {
      const [range, whole] = await Promise.all([
        computeSettlementsTx(tx, {
          organizationId: orgId,
          month: slice.month,
          storeIds: [input.storeId],
          now,
          period: { start: slice.start, end: slice.end },
        }),
        computeSettlementsTx(tx, {
          organizationId: orgId,
          month: slice.month,
          storeIds: [input.storeId],
          now,
        }),
      ]);
      const r = range.get(input.storeId);
      const w = whole.get(input.storeId);
      if (r?.ok) rangeOre = r.computed.amountOre;
      else why = r && !r.ok ? r.message : why;
      if (w?.ok) monthOre = w.computed.amountOre;
    }
    out.push({
      ...slice,
      settlement,
      rangeOre,
      monthOre,
      future,
      ...(why ? { why } : {}),
    });
  }
  return out;
}

/** En del av betalningen med vad den gör (för förhandsvisningen och listan). */
export interface PaymentPartView extends PaymentPart {
  /** "Dras av när avräkningen för november skapas" o.s.v. */
  readonly effect: string;
}

function partViews(
  parts: readonly PaymentPart[],
  settlements: readonly SettlementState[],
): PaymentPartView[] {
  return parts.map((p) => {
    const st = settlements.find((x) => x.month === p.month);
    return {
      ...p,
      effect: partEffectText(
        p,
        st ? { paid: st.paidOn !== null, fromPayments: st.fromPayments } : null,
      ),
    };
  });
}

async function storeName(tx: Tx, orgId: string, storeId: string): Promise<string> {
  const [row] = await tx
    .select({ name: s.stores.name })
    .from(s.stores)
    .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)));
  if (!row) throw new SettlementError("Butiken finns inte.");
  return row.name;
}

async function splitTx(
  tx: Tx,
  orgId: string,
  input: CleanInput,
  today: IsoDate,
  now: Date,
  lock: boolean,
) {
  const name = await storeName(tx, orgId, input.storeId);
  const settlements = await settlementsOfStore(tx, orgId, input.storeId, lock);
  const others = await queryStorePayments(tx, orgId, input.storeId);
  const infos = await monthInfos(tx, orgId, input, today, now, settlements, others);
  let split;
  try {
    split = splitPayment(input.amountOre, infos);
  } catch (error) {
    if (error instanceof DomainError) throw new SettlementError(error.message);
    throw error;
  }
  if (!split.ok) throw new SettlementError(split.message);
  return { name, settlements, parts: split.parts };
}

/** Förhandsvisningen: hur betalningen delas upp, utan att något sparas. */
export async function previewPaymentFor(
  viewer: Viewer,
  raw: PaymentInput,
  now: Date = new Date(),
): Promise<{ storeName: string; parts: PaymentPartView[] }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const input = cleanPaymentInput(raw, today);
  return withUserDbFor(viewer.user, async (tx) => {
    const { name, settlements, parts } = await splitTx(tx, orgId, input, today, now, false);
    return { storeName: name, parts: partViews(parts, settlements) };
  });
}

/**
 * Registrerar betalningen. `expectedParts` är delarnas belopp i förhandsvisningen: blir
 * uppdelningen en annan nu (en avräkning har räknats om, en annan betalning registrerats)
 * sparas inget och ägaren får se den nya.
 */
export async function registerPaymentFor(
  viewer: Viewer,
  raw: PaymentInput,
  expectedParts: readonly number[] | null = null,
  now: Date = new Date(),
): Promise<{
  id: string;
  storeName: string;
  parts: PaymentPartView[];
  /** Avräkningar som blev betalda med betalningen. */
  settledMonths: IsoMonth[];
  /** Månader som stängdes när deras sista avräkning blev betald. */
  closedMonths: IsoMonth[];
}> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const input = cleanPaymentInput(raw, today);
  try {
    return await withUserDbFor(viewer.user, (tx) =>
      registerPaymentTx(tx, orgId, input, { today, now, expectedParts }),
    );
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    paymentDbError(error);
  }
}

/**
 * Registreringen i en given transaktion (som användaren, RLS): samma regel och kontroll som
 * registerPaymentFor. `payoutLineId` = raden i en Nayax-utbetalning betalningen görs från
 * (Pengar → Utbetalningar); utelämnad för en vanlig betalning.
 */
export async function registerPaymentTx(
  tx: Tx,
  orgId: string,
  input: CleanInput,
  options: {
    readonly today: IsoDate;
    readonly now: Date;
    readonly expectedParts?: readonly number[] | null;
    readonly payoutLineId?: string | null;
  },
): Promise<{
  id: string;
  storeName: string;
  parts: PaymentPartView[];
  settledMonths: IsoMonth[];
  closedMonths: IsoMonth[];
}> {
  const { today, now } = options;
  const expectedParts = options.expectedParts ?? null;
  // En registrering i taget per butik: delarna räknas på de andra betalningarna.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`store-payment:${orgId}:${input.storeId}`}))`,
  );
  const { name, parts } = await splitTx(tx, orgId, input, today, now, true);
  if (
    expectedParts !== null &&
    (expectedParts.length !== parts.length ||
      parts.some((p, i) => p.amountOre !== expectedParts[i]))
  ) {
    throw new SettlementError("Uppdelningen har ändrats. Kontrollera och försök igen.");
  }
  const [row] = await tx
    .insert(s.storePayments)
    .values({
      organizationId: orgId,
      storeId: input.storeId,
      paidOn: input.paidOn,
      amountOre: input.amountOre,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      note: input.note,
      parts: parts as unknown as unknown[],
      payoutAllocationLineId: options.payoutLineId ?? null,
    })
    .returning({ id: s.storePayments.id });
  const settlements = await settlementsOfStore(tx, orgId, input.storeId, false);
  const touched = settlements
    .filter((x) => x.paidOn === null && parts.some((p) => p.month === x.month && p.amountOre > 0))
    .map((x) => x.id);
  const settled = await settleCoveredTx(tx, orgId, touched, now);
  const closedMonths: IsoMonth[] = [];
  for (const m of [...new Set(settled.map((x) => x.month))].sort()) {
    if (
      await closeMonthIfDoneTx(tx, {
        organizationId: orgId,
        month: m,
        trigger: "settlement_paid",
        today,
      })
    ) {
      closedMonths.push(m);
    }
  }
  const after = await settlementsOfStore(tx, orgId, input.storeId, false);
  return {
    id: row!.id,
    storeName: name,
    parts: partViews(parts, after),
    settledMonths: settled.map((x) => x.month),
    closedMonths,
  };
}

/**
 * Tar bort en felaktig betalning. En avräkning som var betald med betalningarna blir
 * obetald igen (och betald på nytt om andra betalningar fortfarande täcker den). Ligger en
 * sådan avräkning i en stängd månad, eller ligger en rättelse från den på en senare
 * avräkning, tas inget bort.
 */
export async function deletePaymentFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<{ storeName: string; amountOre: number; reopened: IsoMonth[] }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  if (!UUID.test(id)) throw new SettlementError("Betalningen finns inte.");
  const paymentId = id.toLowerCase();
  try {
    return await withUserDbFor(viewer.user, (tx) => deletePaymentTx(tx, orgId, paymentId, now));
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    paymentDbError(error);
  }
}

/** Borttagningen i en given transaktion (som användaren, RLS), samma regler som deletePaymentFor. */
export async function deletePaymentTx(
  tx: Tx,
  orgId: string,
  paymentId: string,
  now: Date,
): Promise<{ storeName: string; amountOre: number; reopened: IsoMonth[] }> {
  const [payment] = await tx
    .select({
      storeId: s.storePayments.storeId,
      amountOre: s.storePayments.amountOre,
      parts: s.storePayments.parts,
    })
    .from(s.storePayments)
    .where(and(eq(s.storePayments.organizationId, orgId), eq(s.storePayments.id, paymentId)));
  if (!payment) throw new SettlementError("Betalningen finns inte.");
  // Samma lås som registreringen (tabellen har ingen uppdateringsrätt, så inget radlås).
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`store-payment:${orgId}:${payment.storeId}`}))`,
  );
  // Togs den bort medan vi väntade på låset (två flikar)?
  const still = await tx
    .select({ id: s.storePayments.id })
    .from(s.storePayments)
    .where(and(eq(s.storePayments.organizationId, orgId), eq(s.storePayments.id, paymentId)));
  if (still.length === 0) throw new SettlementError("Betalningen finns inte.");
  const name = await storeName(tx, orgId, payment.storeId);
  const settlements = await settlementsOfStore(tx, orgId, payment.storeId, true);
  const months = new Set(
    parseParts(payment.parts)
      .filter((p) => p.amountOre > 0)
      .map((p) => p.month),
  );
  const affected = settlements.filter((x) => months.has(x.month) && x.fromPayments);
  const closed = new Set(await queryClosedMonthKeys(tx, orgId));
  const closedHit = affected.find((x) => closed.has(x.month));
  if (closedHit) {
    const m = monthLong(closedHit.month);
    throw new SettlementError(
      `${m.charAt(0).toUpperCase()}${m.slice(1)} är stängd och avräkningen där är betald med den här betalningen. Ägaren öppnar månaden igen under Butiker → Utbetalning först.`,
    );
  }
  for (const x of affected) {
    await tx
      .update(s.storeSettlements)
      .set({ paidOn: null })
      .where(and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, x.id)));
  }
  await tx
    .delete(s.storePayments)
    .where(and(eq(s.storePayments.organizationId, orgId), eq(s.storePayments.id, paymentId)));
  // Täcker andra betalningar fortfarande avräkningen blir den betald med dem.
  const again = await settleCoveredTx(
    tx,
    orgId,
    affected.map((x) => x.id),
    now,
  );
  const stillPaid = new Set(again.map((x) => x.id));
  return {
    storeName: name,
    amountOre: payment.amountOre,
    reopened: affected.filter((x) => !stillPaid.has(x.id)).map((x) => x.month),
  };
}

/** En betalning i listan på Utbetalning. */
export interface PaymentListItem {
  readonly id: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly note: string | null;
  readonly parts: readonly PaymentPartView[];
  /** Varför betalningen inte kan tas bort nu (stängd månad), annars null. */
  readonly deleteBlocked: string | null;
}

/** Betalningarna för listan "Betalningar" på Utbetalning, senaste först. */
export async function queryPaymentList(tx: Tx, orgId: string): Promise<PaymentListItem[]> {
  const [payments, names, settlementRows, closed] = await Promise.all([
    queryStorePayments(tx, orgId),
    tx
      .select({ id: s.stores.id, name: s.stores.name })
      .from(s.stores)
      .where(eq(s.stores.organizationId, orgId)),
    tx
      .select({
        id: s.storeSettlements.id,
        storeId: s.storeSettlements.storeId,
        month: s.storeSettlements.month,
        amountOre: s.storeSettlements.amountOre,
        paidOn: s.storeSettlements.paidOn,
        paidAmountOre: s.storeSettlements.paidAmountOre,
        fromPayments: s.storeSettlements.paidFromPayments,
      })
      .from(s.storeSettlements)
      .where(eq(s.storeSettlements.organizationId, orgId)),
    queryClosedMonthKeys(tx, orgId),
  ]);
  const name = new Map(names.map((n) => [n.id, n.name]));
  const closedSet = new Set(closed);
  const settlements: SettlementState[] = settlementRows.map((r) => ({
    id: r.id,
    storeId: r.storeId,
    month: r.month.slice(0, 7) as IsoMonth,
    amountOre: r.amountOre,
    paidOn: r.paidOn,
    paidOre: r.paidAmountOre ?? r.amountOre,
    fromPayments: r.fromPayments,
  }));
  return payments
    .map((p): PaymentListItem => {
      const own = settlements.filter((x) => x.storeId === p.storeId);
      const blockedMonth = p.parts.find(
        (part) =>
          part.amountOre > 0 &&
          closedSet.has(part.month) &&
          own.some((x) => x.month === part.month && x.fromPayments),
      );
      return {
        id: p.id,
        storeId: p.storeId,
        storeName: name.get(p.storeId) ?? "Okänd butik",
        paidOn: p.paidOn,
        amountOre: p.amountOre,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        note: p.note,
        parts: partViews(p.parts, own),
        deleteBlocked: blockedMonth
          ? `${capitalize(monthLong(blockedMonth.month))} är stängd. Öppna månaden först.`
          : null,
      };
    })
    .sort((a, b) =>
      a.paidOn !== b.paidOn
        ? a.paidOn < b.paidOn
          ? 1
          : -1
        : a.periodStart < b.periodStart
          ? 1
          : -1,
    );
}

/** Betalningarna (läsaren läser också). */
export async function loadPaymentListFor(viewer: Viewer): Promise<PaymentListItem[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, (tx) => queryPaymentList(tx, orgId));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
