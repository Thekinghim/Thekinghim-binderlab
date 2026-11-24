/**
 * Vad som är betalt och vad som är kvar från utbetalningarna från Nayax, per rad och per
 * mottagare ("Att betala just nu"). Bara läsning, i anroparens transaktion.
 *
 * - En rad till en butik eller ett bolag: varje butik och månad på raden (komponenterna)
 *   är kvar tills betalningar från raden (store_payments.payout_allocation_line_id) täcker
 *   den. Är butikens månadsavräkning redan betald på annat sätt (Butiker → Utbetalning,
 *   "Markera som betald" utan betalningarna) räknas den månaden som betald: inget betalas
 *   två gånger.
 * - Partnern, momsen och ägaren: raden − betalningarna (recipient_payments, ej ångrade).
 * - Ägarens rad är "Kvar till dig" och ingår inte i "Att betala".
 */

import "server-only";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { PayoutRecipientKind } from "@/db/schema";
import {
  coverageRangeText,
  gapWarnings,
  type IsoDate,
  type PartnerComponents,
  type SplitTotals,
  type SplitWarning,
  type StoreComponent,
  type VatComponents,
} from "@/domain";
import { parseParts } from "@/server/settlements/advance";

import { smKey } from "./inputs";

export interface LineView {
  readonly id: string;
  readonly payoutId: string;
  readonly kind: PayoutRecipientKind;
  /** Mottagarens nyckel: "store:<id>", "store_owner:<id>", "partner", "vat_reserve", "owner". */
  readonly recipientKey: string;
  readonly name: string;
  readonly amountOre: number;
  readonly paidOre: number;
  readonly leftOre: number;
  readonly stores: readonly (StoreComponent & {
    readonly storeName: string;
    readonly paidOre: number;
    readonly leftOre: number;
    /** Månadsavräkningen är betald utan betalningarna härifrån. */
    readonly settledElsewhere: boolean;
  })[];
  readonly partner: PartnerComponents | null;
  readonly vat: VatComponents | null;
  readonly owner: { readonly profitOre: number; readonly partnerShareOre: number } | null;
  readonly payments: readonly {
    readonly ref: string;
    readonly paidOn: IsoDate;
    readonly amountOre: number;
  }[];
}

export interface PayoutView {
  readonly id: string;
  readonly reference: string;
  readonly paidOn: IsoDate | null;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly periodText: string;
  readonly amountOre: number;
  readonly feesOre: number;
  readonly basis: "report" | "lines" | "inferred" | "manual";
  readonly inferredNote: string | null;
  readonly summary: string | null;
  readonly allocation: {
    readonly id: string;
    readonly status: "draft" | "locked";
    readonly totals: SplitTotals;
    readonly warnings: readonly SplitWarning[];
    readonly computedAt: string;
  } | null;
  readonly lines: readonly LineView[];
  /** Rader med något kvar att betala (utom ägaren). */
  readonly unpaidLines: number;
}

export interface RecipientRow {
  readonly key: string;
  readonly kind: PayoutRecipientKind;
  readonly name: string;
  readonly orgNumber: string | null;
  readonly bankgiro: string | null;
  readonly leftOre: number;
  readonly paidOre: number;
  /** Raderna med något kvar, äldst först (det "Betala" betalar i ordning). */
  readonly lineIds: readonly string[];
  readonly oldestPaidOn: IsoDate | null;
  /** Utbetalningarnas perioder ("Nayax 3–9 nov."). */
  readonly periodTexts: readonly string[];
  /** Partner: inköp och vinst i det som är kvar (ungefär, i samma proportion). */
  readonly partnerParts: { readonly reimbOre: number; readonly profitOre: number } | null;
}

export interface PayOverview {
  readonly payouts: readonly PayoutView[];
  readonly recipients: readonly RecipientRow[];
  /** Att betala (butiker, partner, moms). */
  readonly toPayOre: number;
  /** Kvar till ägaren (kan vara negativt: du behöver lägga till). */
  readonly ownerLeftOre: number;
  readonly warnings: readonly SplitWarning[];
  readonly partnerName: string | null;
}

function totalsOf(v: unknown): SplitTotals {
  return v as SplitTotals;
}

/** Allt om utbetalningarna (se filhuvudet). `payoutId` = bara den (sidan för en utbetalning). */
export async function loadPayOverviewTx(
  tx: Tx,
  orgId: string,
  options: { readonly payoutId?: string } = {},
): Promise<PayOverview> {
  const payoutConds = [eq(s.payouts.organizationId, orgId), isNull(s.payouts.archivedAt)];
  const payouts = await tx
    .select({
      id: s.payouts.id,
      reference: s.payouts.reference,
      paidOn: s.payouts.paidOn,
      periodStart: s.payouts.periodStart,
      periodEnd: s.payouts.periodEnd,
      amountOre: s.payouts.amountOre,
      feesOre: s.payouts.feesOre,
      basis: s.payouts.periodBasis,
      inferredNote: s.payouts.inferredNote,
      summary: s.payouts.aiSummary,
    })
    .from(s.payouts)
    .where(and(...payoutConds));
  const allocations = await tx
    .select({
      id: s.payoutAllocations.id,
      payoutId: s.payoutAllocations.payoutId,
      status: s.payoutAllocations.status,
      totals: s.payoutAllocations.totals,
      warnings: s.payoutAllocations.warnings,
      computedAt: s.payoutAllocations.computedAt,
    })
    .from(s.payoutAllocations)
    .where(
      and(eq(s.payoutAllocations.organizationId, orgId), isNull(s.payoutAllocations.supersededAt)),
    );
  const allocIds = allocations.map((a) => a.id);
  const [lines, storePays, recipientPays, stores, owners, partners, settlements] =
    await Promise.all([
      allocIds.length
        ? tx
            .select()
            .from(s.payoutAllocationLines)
            .where(
              and(
                eq(s.payoutAllocationLines.organizationId, orgId),
                inArray(s.payoutAllocationLines.allocationId, allocIds),
              ),
            )
        : Promise.resolve([]),
      tx
        .select({
          id: s.storePayments.id,
          lineId: s.storePayments.payoutAllocationLineId,
          storeId: s.storePayments.storeId,
          paidOn: s.storePayments.paidOn,
          amountOre: s.storePayments.amountOre,
          parts: s.storePayments.parts,
        })
        .from(s.storePayments)
        .where(
          and(
            eq(s.storePayments.organizationId, orgId),
            isNotNull(s.storePayments.payoutAllocationLineId),
          ),
        ),
      tx
        .select({
          id: s.recipientPayments.id,
          lineId: s.recipientPayments.lineId,
          paidOn: s.recipientPayments.paidOn,
          amountOre: s.recipientPayments.amountOre,
        })
        .from(s.recipientPayments)
        .where(
          and(
            eq(s.recipientPayments.organizationId, orgId),
            isNull(s.recipientPayments.archivedAt),
          ),
        ),
      tx
        .select({ id: s.stores.id, name: s.stores.name })
        .from(s.stores)
        .where(eq(s.stores.organizationId, orgId)),
      tx
        .select({
          id: s.storeOwners.id,
          legalName: s.storeOwners.legalName,
          orgNumber: s.storeOwners.orgNumber,
          bankgiro: s.storeOwners.bankgiro,
        })
        .from(s.storeOwners)
        .where(eq(s.storeOwners.organizationId, orgId)),
      tx
        .select({
          id: s.partnerAgreements.id,
          name: s.partnerAgreements.partnerName,
          validFrom: s.partnerAgreements.validFrom,
          archivedAt: s.partnerAgreements.archivedAt,
        })
        .from(s.partnerAgreements)
        .where(eq(s.partnerAgreements.organizationId, orgId)),
      tx
        .select({
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          paidOn: s.storeSettlements.paidOn,
          fromPayments: s.storeSettlements.paidFromPayments,
        })
        .from(s.storeSettlements)
        .where(
          and(eq(s.storeSettlements.organizationId, orgId), isNotNull(s.storeSettlements.paidOn)),
        ),
    ]);
  const storeName = new Map(stores.map((r) => [r.id, r.name]));
  const ownerOf = new Map(owners.map((r) => [r.id, r]));
  const partnerById = new Map(partners.map((p) => [p.id, p.name]));
  const currentPartner =
    [...partners]
      .filter((p) => p.archivedAt === null)
      .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]?.name ?? null;
  const paidElsewhere = new Set(
    settlements.filter((x) => !x.fromPayments).map((x) => smKey(x.storeId, x.month)),
  );

  const storePaysByLine = new Map<string, typeof storePays>();
  for (const p of storePays) {
    const list = storePaysByLine.get(p.lineId!) ?? [];
    list.push(p);
    storePaysByLine.set(p.lineId!, list);
  }
  const recPaysByLine = new Map<string, typeof recipientPays>();
  for (const p of recipientPays) {
    const list = recPaysByLine.get(p.lineId) ?? [];
    list.push(p);
    recPaysByLine.set(p.lineId, list);
  }

  const lineViews = new Map<string, LineView[]>();
  for (const l of lines) {
    const comps = l.components as Record<string, unknown>;
    let name = "";
    let key = l.recipientKind as string;
    if (l.recipientKind === "store") {
      name = storeName.get(l.storeId!) ?? "Butik";
      key = `store:${l.storeId}`;
    } else if (l.recipientKind === "store_owner") {
      name = ownerOf.get(l.storeOwnerId!)?.legalName ?? "Bolag";
      key = `store_owner:${l.storeOwnerId}`;
    } else if (l.recipientKind === "partner") {
      name = (l.partnerAgreementId && partnerById.get(l.partnerAgreementId)) || "Partnern";
    } else if (l.recipientKind === "vat_reserve") {
      name = "Moms att spara";
    } else {
      name = "Kvar till dig";
    }
    let paidOre = 0;
    let leftOre = 0;
    const payments: { ref: string; paidOn: IsoDate; amountOre: number }[] = [];
    let storeViews: LineView["stores"] = [];
    if (l.recipientKind === "store" || l.recipientKind === "store_owner") {
      const pays = storePaysByLine.get(l.id) ?? [];
      const paidBy = new Map<string, number>();
      for (const p of pays) {
        paidOre += p.amountOre;
        payments.push({ ref: `s:${p.id}`, paidOn: p.paidOn, amountOre: p.amountOre });
        for (const part of parseParts(p.parts)) {
          const k = smKey(p.storeId, part.month);
          paidBy.set(k, (paidBy.get(k) ?? 0) + part.amountOre);
        }
      }
      const list = Array.isArray(comps.stores) ? (comps.stores as StoreComponent[]) : [];
      // Flera komponenter för samma butik och månad (andel + justering) delar betalningen.
      const groupLeft = new Map<string, number>();
      for (const c of list) {
        const k = smKey(c.storeId, c.month);
        groupLeft.set(k, (groupLeft.get(k) ?? 0) + c.shareOre);
      }
      const used = new Map<string, number>();
      storeViews = list.map((c) => {
        const k = smKey(c.storeId, c.month);
        const elsewhere = paidElsewhere.has(k) && !paidBy.has(k);
        const avail = (paidBy.get(k) ?? 0) - (used.get(k) ?? 0);
        const paid = Math.max(0, Math.min(Math.max(0, c.shareOre), avail));
        used.set(k, (used.get(k) ?? 0) + paid);
        const left = elsewhere ? 0 : Math.max(0, c.shareOre - paid);
        return {
          ...c,
          storeName: storeName.get(c.storeId) ?? "Butik",
          paidOre: paid,
          leftOre: left,
          settledElsewhere: elsewhere,
        };
      });
      const compLeft = storeViews.reduce((a, c) => a + c.leftOre, 0);
      leftOre = Math.max(0, Math.min(compLeft, l.amountOre - paidOre));
    } else {
      for (const p of recPaysByLine.get(l.id) ?? []) {
        paidOre += p.amountOre;
        payments.push({ ref: `r:${p.id}`, paidOn: p.paidOn, amountOre: p.amountOre });
      }
      leftOre =
        l.recipientKind === "owner" ? l.amountOre - paidOre : Math.max(0, l.amountOre - paidOre);
    }
    const view: LineView = {
      id: l.id,
      payoutId: l.payoutId,
      kind: l.recipientKind,
      recipientKey: key,
      name,
      amountOre: l.amountOre,
      paidOre,
      leftOre,
      stores: storeViews,
      partner: (comps.partner as PartnerComponents | undefined) ?? null,
      vat: (comps.vat as VatComponents | undefined) ?? null,
      owner:
        l.recipientKind === "owner"
          ? {
              profitOre: Number(comps.profitOre ?? 0),
              partnerShareOre: Number(comps.partnerShareOre ?? 0),
            }
          : null,
      payments: payments.sort((a, b) => (a.paidOn < b.paidOn ? -1 : 1)),
    };
    const list = lineViews.get(l.payoutId) ?? [];
    list.push(view);
    lineViews.set(l.payoutId, list);
  }

  const order: Record<PayoutRecipientKind, number> = {
    store_owner: 0,
    store: 0,
    partner: 1,
    vat_reserve: 2,
    owner: 3,
  };
  const allocByPayout = new Map(allocations.map((a) => [a.payoutId, a]));
  const views: PayoutView[] = payouts.map((p) => {
    const a = allocByPayout.get(p.id);
    const ls = (lineViews.get(p.id) ?? []).sort((x, y) =>
      order[x.kind] !== order[y.kind] ? order[x.kind] - order[y.kind] : y.amountOre - x.amountOre,
    );
    return {
      id: p.id,
      reference: p.reference,
      paidOn: p.paidOn,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      periodText: coverageRangeText(p.periodStart, p.periodEnd),
      amountOre: p.amountOre,
      feesOre: p.feesOre,
      basis: p.basis,
      inferredNote: p.inferredNote,
      summary: p.summary,
      allocation: a
        ? {
            id: a.id,
            status: a.status,
            totals: totalsOf(a.totals),
            warnings: (a.warnings ?? []) as SplitWarning[],
            computedAt: a.computedAt.toISOString(),
          }
        : null,
      lines: ls,
      unpaidLines: ls.filter((l) => l.kind !== "owner" && l.leftOre > 0).length,
    };
  });
  // Nyast först.
  views.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));

  // Mottagarna, över alla utbetalningar (äldsta raden först).
  const chrono = [...views].reverse();
  const recipients = new Map<string, RecipientRow & { lineIds: string[]; periodTexts: string[] }>();
  let ownerLeftOre = 0;
  for (const v of chrono) {
    for (const l of v.lines) {
      if (l.kind === "owner") {
        ownerLeftOre += l.leftOre;
        continue;
      }
      if (l.leftOre <= 0) continue;
      let r = recipients.get(l.recipientKey);
      if (!r) {
        const owner = l.kind === "store_owner" ? ownerOf.get(l.recipientKey.slice(12)) : null;
        r = {
          key: l.recipientKey,
          kind: l.kind,
          name: l.kind === "partner" ? (currentPartner ?? l.name) : l.name,
          orgNumber: owner?.orgNumber ?? null,
          bankgiro: owner?.bankgiro ?? null,
          leftOre: 0,
          paidOre: 0,
          lineIds: [],
          oldestPaidOn: v.paidOn,
          periodTexts: [],
          partnerParts: l.kind === "partner" ? { reimbOre: 0, profitOre: 0 } : null,
        };
        recipients.set(l.recipientKey, r);
      }
      const next = {
        ...r,
        leftOre: r.leftOre + l.leftOre,
        paidOre: r.paidOre + l.paidOre,
        lineIds: [...r.lineIds, l.id],
        periodTexts: [...r.periodTexts, v.periodText],
        partnerParts:
          r.partnerParts && l.partner
            ? (() => {
                const reimb = Math.min(l.leftOre, Math.max(0, l.partner.reimbOre));
                return {
                  reimbOre: r.partnerParts.reimbOre + reimb,
                  profitOre: r.partnerParts.profitOre + (l.leftOre - reimb),
                };
              })()
            : r.partnerParts,
      };
      recipients.set(l.recipientKey, next);
    }
  }
  const kindOrder = (k: PayoutRecipientKind) => order[k];
  const recipientRows = [...recipients.values()].sort((a, b) =>
    kindOrder(a.kind) !== kindOrder(b.kind)
      ? kindOrder(a.kind) - kindOrder(b.kind)
      : b.leftOre - a.leftOre,
  );

  // Luckor: dagar med försäljning mellan två utbetalningar som ingen täcker.
  const warnings: SplitWarning[] = [];
  const covered = views.map((v) => ({ from: v.periodStart, to: v.periodEnd }));
  if (covered.length > 1) {
    const days = Array.from(
      await tx.execute(sql`
        select distinct o.business_date::text as d from public.orders o
        where o.organization_id = ${orgId}::uuid and o.test_purchase_at is null
          and o.business_date > ${[...covered].sort((a, b) => (a.from < b.from ? -1 : 1))[0]!.to}::date
          and o.business_date < ${[...covered].sort((a, b) => (a.from < b.from ? 1 : -1))[0]!.from}::date
          and not exists (
            select 1 from public.payouts p
            where p.organization_id = o.organization_id and p.archived_at is null
              and o.business_date between p.period_start and p.period_end)`),
    ) as { d: string }[];
    warnings.push(...gapWarnings(covered, new Set(days.map((d) => d.d))));
  }

  const selected = options.payoutId ? views.filter((v) => v.id === options.payoutId) : views;
  return {
    payouts: selected,
    recipients: recipientRows,
    toPayOre: recipientRows.reduce((a, r) => a + r.leftOre, 0),
    ownerLeftOre,
    warnings,
    partnerName: currentPartner,
  };
}

/** Raderna i betallistan för banken (CSV): butiker och bolag med något kvar. */
export function bankRows(overview: PayOverview): {
  name: string;
  orgNumber: string;
  bankgiro: string;
  amountKr: number;
  message: string;
}[] {
  return overview.recipients
    .filter((r) => r.kind === "store" || r.kind === "store_owner" || r.kind === "partner")
    .map((r) => ({
      name: r.name,
      orgNumber: r.orgNumber ?? "",
      bankgiro: r.bankgiro ?? "",
      amountKr: r.leftOre / 100,
      message: `Nayax ${[...new Set(r.periodTexts)].join(", ")}`.slice(0, 50),
    }));
}
