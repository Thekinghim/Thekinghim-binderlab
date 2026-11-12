/**
 * Vad som ska vara bokfört i Fortnox just nu: alla verifikat från startmånaden till och med
 * i går, räknade ur samma underlag som Ekonomi → Bokföring. Samma funktion används av det
 * schemalagda jobbet (systemrollen) och av sidan (ägare/admin under RLS), så torrkörningen
 * visar exakt det jobbet skulle skicka.
 *
 * - Månadsverifikat (försäljning, butikernas andel, inköpsvärde, fasta kostnader) tas fram
 *   för avslutade månader från och med startmånaden.
 * - En utbetalning bokförs när dagen pengarna kom in har varit (och ligger i eller efter
 *   startmånaden). Arkiverade utbetalningar finns inte med.
 * - En avräkning till en butik bokförs när den är markerad som betald.
 * - Utbetalningar och avräkningar som gäller månader FÖRE startmånaden bokförs inte: de hör
 *   till det som redan bokförts för hand.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { accrueFixedCosts } from "@/analytics/cashflow/fixed-costs";
import type { Db, Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addMonths, eachMonth, monthPeriod, type IsoDate } from "@/domain";
import { queryFixedCosts, queryPayouts } from "@/server/accounting/queries";
import { monthReportsIn } from "@/server/accounting/service";
import { parseAccountPlan, type AccountPlan } from "@/server/bokforing/plan";
import { packageSource, type OrgRef } from "@/server/bokforing/service";
import { querySettings } from "@/server/data/core/queries";

import {
  FORTNOX_KINDS,
  parseMapping,
  type FortnoxMapping,
  type FortnoxVoucherKind,
} from "./mapping";
import {
  cogsVoucher,
  fixedCostsVoucher,
  payoutVoucher,
  salesVoucher,
  settlementPaidVoucher,
  storeShareVoucher,
  type DesiredVoucher,
} from "./vouchers";

export interface FortnoxConnection {
  readonly organizationId: string;
  readonly status: "connected" | "needs_reconnect";
  readonly live: boolean;
  /** 'ÅÅÅÅ-MM' eller null (inte vald än). */
  readonly startMonth: string | null;
  readonly series: string;
  readonly mapping: FortnoxMapping;
  readonly connectedAt: string;
}

/** Kopplingen för organisationen, eller null. */
export async function readConnection(
  tx: Db | Tx,
  orgId: string,
): Promise<FortnoxConnection | null> {
  const rows = Array.from(
    await tx.execute<{
      status: "connected" | "needs_reconnect";
      live: boolean;
      start_month: string | null;
      voucher_series: string;
      mapping: unknown;
      connected_at: string;
    }>(sql`
      select status, live, start_month::text as start_month, voucher_series, mapping,
             connected_at::text as connected_at
      from public.fortnox_connections where organization_id = ${orgId}::uuid`),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: orgId,
    status: row.status,
    live: row.live,
    startMonth: row.start_month ? row.start_month.slice(0, 7) : null,
    series: row.voucher_series,
    mapping: parseMapping(row.mapping),
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

export interface DesiredPlan {
  /** Alla verifikat som ska finnas, äldst först. Även sorter som är avstängda (se `enabled`). */
  readonly vouchers: readonly DesiredVoucher[];
  readonly enabled: Readonly<Record<FortnoxVoucherKind, boolean>>;
  readonly plan: AccountPlan;
  /** Sista avslutade månaden som räknades, eller null om ingen månad är avslutad sedan starten. */
  readonly throughMonth: string | null;
}

/** Dagar efter månadsskiftet innan förra månadens verifikat tas fram. */
export const SETTLE_DAYS = 2;

const KIND_ORDER = new Map(FORTNOX_KINDS.map((k, i) => [k, i]));

/** VMB-momsen per månad (bara när momssatsen är 0 och VMB används någon månad). */
async function vmbByMonth(
  tx: Tx,
  org: OrgRef,
  months: readonly string[],
  today: IsoDate,
): Promise<Map<string, { enabled: boolean; vatOre: number }>> {
  const out = new Map<string, { enabled: boolean; vatOre: number }>();
  const [setting] = await tx
    .select({ vmb: s.bookkeepingSettings.vmbEnabled })
    .from(s.bookkeepingSettings)
    .where(eq(s.bookkeepingSettings.organizationId, org.id));
  const sent = await tx
    .select({ month: s.bookkeepingMonths.month, snapshot: s.bookkeepingMonths.snapshot })
    .from(s.bookkeepingMonths)
    .where(
      and(
        eq(s.bookkeepingMonths.organizationId, org.id),
        sql`${s.bookkeepingMonths.sentAt} is not null`,
      ),
    );
  // En skickad månad behåller sitt val (saknas = på), se src/server/bokforing/service.ts.
  const sentWithVmb = sent.some(
    (r) => (r.snapshot as { vmbEnabled?: unknown } | null)?.vmbEnabled !== false,
  );
  if (!setting?.vmb && !sentWithVmb) return out;
  for (const month of months) {
    const src = await packageSource(tx, org, month, today);
    if (src) out.set(month, { enabled: src.book.vmbEnabled, vatOre: src.book.vmb.vatOre });
  }
  return out;
}

/**
 * Verifikaten som ska finnas i Fortnox (se filhuvudet). `tx` är användarens transaktion
 * (RLS) eller systemrollens.
 */
export async function computeDesired(
  tx: Tx,
  org: OrgRef,
  today: IsoDate,
  connection: Pick<FortnoxConnection, "startMonth" | "mapping">,
): Promise<DesiredPlan> {
  const mapping = connection.mapping;
  const [planRow] = await tx
    .select({ plan: s.bookkeepingSettings.accountPlan, vmb: s.bookkeepingSettings.vmbEnabled })
    .from(s.bookkeepingSettings)
    .where(eq(s.bookkeepingSettings.organizationId, org.id));
  const plan = parseAccountPlan(planRow?.plan ?? {});
  const start = connection.startMonth;
  if (!start) return { vouchers: [], enabled: mapping.kinds, plan, throughMonth: null };

  const startDate = `${start}-01`;
  // En månad räknas som avslutad först den 3:e i nästa månad: sena order och återbetalningar
  // från månadens sista dagar hinner komma in innan verifikatet skickas.
  const settled = new Date(`${today}T00:00:00Z`);
  settled.setUTCDate(settled.getUTCDate() - SETTLE_DAYS);
  const lastEnded = addMonths(settled.toISOString().slice(0, 7), -1);
  const months = start <= lastEnded ? eachMonth(startDate, `${lastEnded}-01`) : [];
  const settings = await querySettings(tx, org.id);
  const out: DesiredVoucher[] = [];
  const push = (v: DesiredVoucher | null) => {
    if (v) out.push(v);
  };

  if (months.length > 0) {
    const [reports, fixed] = await Promise.all([
      monthReportsIn(tx, org.id, months),
      queryFixedCosts(tx, org.id),
    ]);
    const vmb =
      settings.vatRateBp === 0
        ? await vmbByMonth(tx, org, months, today)
        : new Map<string, { enabled: boolean; vatOre: number }>();
    const activeCosts = fixed
      .filter((c) => !c.archived)
      .map((c) => ({
        id: c.id,
        name: c.name,
        amountOre: c.amountOre,
        interval: c.interval,
        start: c.startsOn,
        end: c.endsOn,
        machineId: c.machineId,
      }));
    for (const month of months) {
      const r = reports.get(month);
      if (!r) continue;
      push(
        salesVoucher(
          {
            month,
            report: r.report,
            refundsOre: r.refundsOre,
            vmb:
              settings.vatRateBp === 0
                ? (vmb.get(month) ?? { enabled: false, vatOre: 0 })
                : { enabled: planRow?.vmb === true, vatOre: 0 },
          },
          plan,
          mapping,
        ),
      );
      push(storeShareVoucher(month, r.report, plan, mapping));
      push(cogsVoucher(month, r.report, plan, mapping));
      const accrual = accrueFixedCosts(activeCosts, monthPeriod(month));
      const names = new Map(activeCosts.map((c) => [c.id, c.name]));
      push(
        fixedCostsVoucher(
          month,
          accrual.byCost.map((c) => ({
            name: names.get(c.costId) ?? "Fast kostnad",
            amountOre: c.accruedOre,
          })),
          plan,
          mapping,
        ),
      );
    }
  }

  const payouts = await queryPayouts(tx, org.id, null);
  for (const p of payouts) {
    const paidOn = p.paidOn ?? p.periodEnd;
    // Bara utbetalningar för försäljning från och med startmånaden. En utbetalning för en
    // tidigare månad hör till det som bokförts för hand (där står redan försäljningen och
    // den uppskattade kortavgiften): den bokförs också för hand, annars blir avgiften dubbel.
    if (p.periodStart < startDate || paidOn > today) continue;
    const st = p.statement;
    const sideFees = st
      ? st.deductions
          .filter((d) => d.kind === "bank_fee" || d.kind === "other_fee")
          .reduce((sum, d) => sum + d.amountOre, 0)
      : 0;
    push(
      payoutVoucher(
        {
          id: p.id,
          reference: p.reference,
          period: { start: p.periodStart, end: p.periodEnd },
          paidOn,
          amountOre: p.amountOre,
          // Nayax-rapporten: kortavgiften för sig, övriga avdrag som egna rader.
          cardFeeOre: st ? (st.cardFeeOre ?? p.feesOre - sideFees) : p.feesOre,
          deductions: st ? st.deductions : [],
          manual: p.manual,
        },
        plan,
        mapping,
      ),
    );
  }

  const settlements = Array.from(
    await tx.execute<{
      id: string;
      store_name: string;
      month: string;
      amount_ore: string | number;
      paid_on: string;
    }>(sql`
      select ss.id::text as id, st.name as store_name, to_char(ss.month, 'YYYY-MM') as month,
             ss.amount_ore, ss.paid_on::text as paid_on
      from public.store_settlements ss
      join public.stores st on st.organization_id = ss.organization_id and st.id = ss.store_id
      where ss.organization_id = ${org.id}::uuid
        and ss.paid_on is not null
        and ss.month >= ${startDate}::date
        and ss.paid_on <= ${today}::date
        and ss.amount_ore > 0`),
  );
  for (const row of settlements) {
    push(
      settlementPaidVoucher(
        {
          id: row.id,
          storeName: row.store_name,
          month: row.month,
          amountOre: Number(row.amount_ore),
          paidOn: row.paid_on,
        },
        plan,
        mapping,
      ),
    );
  }

  out.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
      (a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0),
  );
  return {
    vouchers: out,
    enabled: mapping.kinds,
    plan,
    throughMonth: months.at(-1) ?? null,
  };
}
