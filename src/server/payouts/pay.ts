/**
 * "Markera som betald" och "Ångra" för raderna i utbetalningarna från Nayax.
 *
 * - Butik eller bolag: en vanlig betalning till butiken (store_payments) per butik och
 *   månad på raden, äldsta först, med raden som koppling (registerPaymentTx). Butikens
 *   månadsavräkning dras av och blir betald med betalningarna som förut, och butiken ser
 *   betalningen i portalen. Ett delbelopp fyller de äldsta delarna först.
 * - Partnern, momsen och ägaren: recipient_payments.
 * - Första betalningen låser uträkningen (databasen).
 * - Ångra: butikens betalningar tas bort (deletePaymentTx, samma regler som på Butiker),
 *   de andra arkiveras.
 *
 * Ägare och admin. Allt i en transaktion som användaren under RLS.
 */

import "server-only";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { DomainError, monthEnd, monthStart, type IsoDate } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import {
  cleanPaymentInput,
  deletePaymentTx,
  paymentDbError,
  registerPaymentTx,
} from "@/server/settlements/payments";
import { SettlementError } from "@/server/settlements/service";
import { pgErrorOf } from "@/server/errors";

import { loadPayOverviewTx, type LineView } from "./balances";

export class PayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function rethrow(error: unknown): never {
  if (error instanceof PayoutError) throw error;
  if (error instanceof SettlementError) throw new PayoutError(error.message);
  if (error instanceof DomainError) throw new PayoutError(error.message);
  const pg = pgErrorOf(error);
  if (pg && ["BL090", "BL091", "22023"].includes(pg.code) && pg.message) {
    throw new PayoutError(pg.message);
  }
  try {
    paymentDbError(error);
  } catch (e) {
    if (e instanceof SettlementError) throw new PayoutError(e.message);
    throw e;
  }
}

export interface MarkPaidResult {
  readonly paidOre: number;
  readonly refs: readonly string[];
  readonly names: readonly string[];
}

async function payLineTx(
  tx: Tx,
  orgId: string,
  line: LineView,
  amountOre: number,
  paidOn: IsoDate,
  today: IsoDate,
  now: Date,
  reference: string,
): Promise<string[]> {
  const refs: string[] = [];
  if (line.kind === "store" || line.kind === "store_owner") {
    let left = amountOre;
    for (const c of line.stores) {
      if (left <= 0) break;
      if (c.leftOre <= 0) continue;
      const take = Math.min(left, c.leftOre);
      const input = cleanPaymentInput(
        {
          storeId: c.storeId,
          paidOn,
          amountOre: take,
          periodStart: c.from ?? monthStart(c.month),
          periodEnd: c.to ?? monthEnd(c.month),
          note: `Från Nayax-utbetalningen ${reference}`.slice(0, 500),
        },
        today,
      );
      const r = await registerPaymentTx(tx, orgId, input, {
        today,
        now,
        payoutLineId: line.id,
      });
      refs.push(`s:${r.id}`);
      left -= take;
    }
    return refs;
  }
  const kind = line.kind;
  const [row] = await tx
    .insert(s.recipientPayments)
    .values({
      organizationId: orgId,
      payoutId: line.payoutId,
      lineId: line.id,
      recipientKind: kind,
      paidOn,
      amountOre,
    })
    .returning({ id: s.recipientPayments.id });
  refs.push(`r:${row!.id}`);
  return refs;
}

/**
 * Markerar raderna som betalda med `amountOre` (utelämnat = allt som är kvar), fördelat på
 * raderna i ordning (äldsta utbetalningen först).
 */
export async function markPaidFor(
  viewer: Viewer,
  input: {
    readonly lineIds: readonly string[];
    readonly paidOn: string;
    readonly amountOre?: number | null;
  },
  now: Date = new Date(),
): Promise<MarkPaidResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  if (input.lineIds.length === 0 || input.lineIds.some((id) => !UUID.test(id))) {
    throw new PayoutError("Raden finns inte.");
  }
  if (!ISO.test(input.paidOn)) throw new PayoutError("Välj dagen du betalade.");
  if (input.paidOn > today) throw new PayoutError("Betaldagen kan inte vara i framtiden.");
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const overview = await loadPayOverviewTx(tx, orgId);
      const all = new Map(
        overview.payouts.flatMap((p) => p.lines.map((l) => [l.id, { l, p }] as const)),
      );
      const chosen = input.lineIds.map((id) => all.get(id.toLowerCase()));
      if (chosen.some((c) => !c)) {
        throw new PayoutError(
          "Uträkningen har ändrats sedan sidan laddades. Ladda om och försök igen.",
        );
      }
      const items = chosen.map((c) => c!);
      // En butiks andel som inte gick att räkna (SHARE_UNKNOWN) skulle låsa fel belopp.
      const unknown = items
        .flatMap((i) => i.p.allocation?.warnings ?? [])
        .find((w) => w.code === "SHARE_UNKNOWN");
      if (unknown && unknown.code === "SHARE_UNKNOWN") {
        throw new PayoutError(
          `En butiks andel går inte att räkna än (${unknown.message}). Rätta det först, sedan kan du markera som betalt.`.slice(
            0,
            400,
          ),
        );
      }
      if (items.some((i) => i.l.kind === "owner" && i.l.leftOre <= 0)) {
        throw new PayoutError("Det finns inget kvar att ta ut.");
      }
      const left = items.reduce((a, i) => a + Math.max(0, i.l.leftOre), 0);
      if (left <= 0) throw new PayoutError("Det är redan betalt.");
      const amount = input.amountOre ?? left;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new PayoutError("Skriv ett belopp över 0 kr.");
      }
      if (amount > left) {
        throw new PayoutError("Beloppet är mer än det som är kvar att betala.");
      }
      let rest = amount;
      const refs: string[] = [];
      for (const { l, p } of [...items].sort((a, b) =>
        a.p.periodStart < b.p.periodStart ? -1 : 1,
      )) {
        if (rest <= 0) break;
        const take = Math.min(rest, Math.max(0, l.leftOre));
        if (take <= 0) continue;
        refs.push(
          ...(await payLineTx(
            tx,
            orgId,
            l,
            take,
            input.paidOn as IsoDate,
            today,
            now,
            p.reference,
          )),
        );
        rest -= take;
      }
      return {
        paidOre: amount,
        refs,
        names: [...new Set(items.map((i) => i.l.name))],
      };
    });
  } catch (error) {
    rethrow(error);
  }
}

/** Ångrar betalningarna (referenserna från markPaidFor: "s:<id>" butik, "r:<id>" övriga). */
export async function undoPaidFor(
  viewer: Viewer,
  refs: readonly string[],
  now: Date = new Date(),
): Promise<{ undone: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const store = refs.filter((r) => r.startsWith("s:")).map((r) => r.slice(2));
  const other = refs.filter((r) => r.startsWith("r:")).map((r) => r.slice(2));
  if ([...store, ...other].some((id) => !UUID.test(id)) || store.length + other.length === 0) {
    throw new PayoutError("Betalningen finns inte.");
  }
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      // Bara betalningar som gjorts härifrån (kopplade till en rad) ångras här.
      const linked = store.length
        ? await tx
            .select({ id: s.storePayments.id })
            .from(s.storePayments)
            .where(
              and(
                eq(s.storePayments.organizationId, orgId),
                inArray(s.storePayments.id, store),
                isNotNull(s.storePayments.payoutAllocationLineId),
              ),
            )
        : [];
      if (linked.length !== store.length) throw new PayoutError("Betalningen finns inte.");
      for (const id of [...store].reverse()) await deletePaymentTx(tx, orgId, id, now);
      if (other.length) {
        await tx
          .update(s.recipientPayments)
          .set({ archivedAt: now })
          .where(
            and(
              eq(s.recipientPayments.organizationId, orgId),
              inArray(s.recipientPayments.id, other),
              isNull(s.recipientPayments.archivedAt),
            ),
          );
      }
      return { undone: store.length + other.length };
    });
  } catch (error) {
    rethrow(error);
  }
}
