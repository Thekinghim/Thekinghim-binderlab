/**
 * Uträkningarna för utbetalningarna från Nayax (payout_allocations och deras rader).
 *
 * recomputeAllocationsTx går igenom organisationens utbetalningar i ordning (äldst först)
 * och räknar varje utkast igen med underlaget som det är nu (./inputs.ts →
 * src/domain/payout-split.ts). Ett utkast med samma underlag (inputs_hash) får ingen ny
 * version. En låst uträkning (något är betalt från den) räknas aldrig om: det den fördelade
 * räknas med, och skillnader blir justeringar på nästa utbetalning. Siffror ändras alltså
 * aldrig bakåt efter en betalning.
 *
 * Körs i anroparens transaktion: som användaren (ägare och admin, RLS) när sidan öppnas
 * eller en utbetalning sparas, och som systemet i det dagliga jobbet. Ett lås per
 * organisation gör att två omräkningar aldrig går samtidigt.
 */

import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  PAYOUT_RULE_VERSION,
  splitPayout,
  type IsoDate,
  type SplitLine,
  type SplitResult,
  type SplitTotals,
  type SplitWarning,
  type StoreComponent,
} from "@/domain";

import {
  loadAllocationInputsTx,
  loadOrgPayoutContextTx,
  smKey,
  type OrgPayoutContext,
  type PriorState,
} from "./inputs";

export interface RecomputeResult {
  readonly computed: number;
  readonly unchanged: number;
  readonly locked: number;
  /** Utbetalningar som inte gick att räkna, med orsak. */
  readonly errors: readonly { readonly payoutId: string; readonly message: string }[];
}

interface CurrentAllocation {
  id: string;
  payoutId: string;
  status: "draft" | "locked";
  version: number;
  inputsHash: string;
  totals: Record<string, unknown>;
}

function storeComponentsOf(components: unknown): StoreComponent[] {
  const stores = (components as { stores?: unknown } | null)?.stores;
  return Array.isArray(stores) ? (stores as StoreComponent[]) : [];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : 0;
}

/** Raden som den sparas (payout_allocation_lines). */
export function lineRow(line: SplitLine): {
  recipientKind: "store_owner" | "store" | "partner" | "vat_reserve" | "owner";
  storeOwnerId: string | null;
  storeId: string | null;
  partnerAgreementId: string | null;
  amountOre: number;
  components: Record<string, unknown>;
} {
  switch (line.kind) {
    case "store_owner":
      return {
        recipientKind: "store_owner",
        storeOwnerId: line.payeeId,
        storeId: null,
        partnerAgreementId: null,
        amountOre: line.amountOre,
        components: { stores: line.stores },
      };
    case "store":
      return {
        recipientKind: "store",
        storeOwnerId: null,
        storeId: line.payeeId,
        partnerAgreementId: null,
        amountOre: line.amountOre,
        components: { stores: line.stores },
      };
    case "partner":
      return {
        recipientKind: "partner",
        storeOwnerId: null,
        storeId: null,
        partnerAgreementId: line.agreementId,
        amountOre: line.amountOre,
        components: { partner: line.partner },
      };
    case "vat_reserve":
      return {
        recipientKind: "vat_reserve",
        storeOwnerId: null,
        storeId: null,
        partnerAgreementId: null,
        amountOre: line.amountOre,
        components: { vat: line.vat },
      };
    case "owner":
      return {
        recipientKind: "owner",
        storeOwnerId: null,
        storeId: null,
        partnerAgreementId: null,
        amountOre: line.amountOre,
        components: { profitOre: line.profitOre, partnerShareOre: line.partnerShareOre },
      };
  }
}

async function currentAllocations(tx: Tx, orgId: string): Promise<Map<string, CurrentAllocation>> {
  const rows = await tx
    .select({
      id: s.payoutAllocations.id,
      payoutId: s.payoutAllocations.payoutId,
      status: s.payoutAllocations.status,
      version: s.payoutAllocations.version,
      inputsHash: s.payoutAllocations.inputsHash,
      totals: s.payoutAllocations.totals,
    })
    .from(s.payoutAllocations)
    .where(
      and(eq(s.payoutAllocations.organizationId, orgId), isNull(s.payoutAllocations.supersededAt)),
    );
  return new Map(rows.map((r) => [r.payoutId, r]));
}

async function storeComponentsFor(
  tx: Tx,
  orgId: string,
  allocationIds: readonly string[],
): Promise<Map<string, StoreComponent[]>> {
  const out = new Map<string, StoreComponent[]>();
  if (allocationIds.length === 0) return out;
  const rows = await tx
    .select({
      allocationId: s.payoutAllocationLines.allocationId,
      components: s.payoutAllocationLines.components,
    })
    .from(s.payoutAllocationLines)
    .where(
      and(
        eq(s.payoutAllocationLines.organizationId, orgId),
        inArray(s.payoutAllocationLines.allocationId, [...allocationIds]),
        inArray(s.payoutAllocationLines.recipientKind, ["store", "store_owner"]),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.allocationId) ?? [];
    list.push(...storeComponentsOf(r.components));
    out.set(r.allocationId, list);
  }
  return out;
}

async function saveAllocationTx(
  tx: Tx,
  orgId: string,
  payoutId: string,
  previous: CurrentAllocation | undefined,
  hash: string,
  result: SplitResult,
  warnings: readonly SplitWarning[],
  now: Date,
): Promise<string> {
  if (previous) {
    await tx
      .update(s.payoutAllocations)
      .set({ supersededAt: now })
      .where(
        and(
          eq(s.payoutAllocations.organizationId, orgId),
          eq(s.payoutAllocations.id, previous.id),
          eq(s.payoutAllocations.status, "draft"),
          isNull(s.payoutAllocations.supersededAt),
        ),
      );
  }
  const [row] = await tx
    .insert(s.payoutAllocations)
    .values({
      organizationId: orgId,
      payoutId,
      version: (previous?.version ?? 0) + 1,
      ruleVersion: PAYOUT_RULE_VERSION,
      inputsHash: hash,
      amountOre: result.totals.amountOre,
      totals: result.totals as unknown as Record<string, unknown>,
      warnings: warnings as unknown as unknown[],
      computedAt: now,
    })
    .returning({ id: s.payoutAllocations.id });
  const allocationId = row!.id;
  await tx.insert(s.payoutAllocationLines).values(
    result.lines.map((l) => ({
      organizationId: orgId,
      allocationId,
      payoutId,
      ...lineRow(l),
    })),
  );
  return allocationId;
}

/**
 * Räknar om utkasten för organisationen (se filhuvudet). `onlyIfMissing`: räkna bara
 * utbetalningar som saknar uträkning (snabbt, när sidan bara visar).
 */
export async function recomputeAllocationsTx(
  tx: Tx,
  orgId: string,
  now: Date,
  options: { readonly onlyIfMissing?: boolean; readonly context?: OrgPayoutContext } = {},
): Promise<RecomputeResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payout-alloc:${orgId}`}))`);
  const payouts = await tx
    .select({
      id: s.payouts.id,
      periodStart: s.payouts.periodStart,
      periodEnd: s.payouts.periodEnd,
      amountOre: s.payouts.amountOre,
    })
    .from(s.payouts)
    .where(and(eq(s.payouts.organizationId, orgId), isNull(s.payouts.archivedAt)))
    .orderBy(asc(s.payouts.periodStart), asc(s.payouts.periodEnd), asc(s.payouts.createdAt));
  const current = await currentAllocations(tx, orgId);
  const comps = await storeComponentsFor(
    tx,
    orgId,
    [...current.values()].map((a) => a.id),
  );
  let ctx = options.context ?? null;
  const allocated = new Map<string, number>();
  const covered: { from: IsoDate; to: IsoDate }[] = [];
  let vatCarry = 0;
  let partnerCarry = 0;
  let computed = 0;
  let unchanged = 0;
  let locked = 0;
  const errors: { payoutId: string; message: string }[] = [];

  const absorb = (allocationId: string | null, totals: Partial<SplitTotals>) => {
    for (const c of allocationId ? (comps.get(allocationId) ?? []) : []) {
      allocated.set(
        smKey(c.storeId, c.month),
        (allocated.get(smKey(c.storeId, c.month)) ?? 0) + c.shareOre,
      );
    }
    vatCarry = num(totals.vatCarryOutOre);
    partnerCarry = num(totals.partnerCarryOutOre);
  };

  for (const p of payouts) {
    const existing = current.get(p.id);
    if (existing && (existing.status === "locked" || options.onlyIfMissing)) {
      if (existing.status === "locked") locked += 1;
      else unchanged += 1;
      absorb(existing.id, existing.totals as Partial<SplitTotals>);
      covered.push({ from: p.periodStart, to: p.periodEnd });
      continue;
    }
    ctx ??= await loadOrgPayoutContextTx(tx, orgId);
    const prior: PriorState = {
      allocated: new Map(allocated),
      covered: [...covered],
      vatCarryOutOre: vatCarry,
      partnerCarryOutOre: partnerCarry,
    };
    try {
      const inputs = await loadAllocationInputsTx(tx, ctx, p, prior, now);
      const result = splitPayout(inputs.split);
      const warnings = [...result.warnings, ...inputs.extraWarnings];
      let allocationId: string;
      if (existing && existing.inputsHash === inputs.hash) {
        unchanged += 1;
        allocationId = existing.id;
      } else {
        allocationId = await saveAllocationTx(
          tx,
          orgId,
          p.id,
          existing,
          inputs.hash,
          result,
          warnings,
          now,
        );
        computed += 1;
      }
      // Det den här uträkningen fördelar räknas in för nästa utbetalning.
      const mine: StoreComponent[] = result.lines.flatMap((l) =>
        l.kind === "store" || l.kind === "store_owner" ? [...l.stores] : [],
      );
      comps.set(allocationId, mine);
      absorb(allocationId, result.totals);
    } catch (error) {
      errors.push({
        payoutId: p.id,
        message: error instanceof Error ? error.message : String(error),
      });
      absorb(existing?.id ?? null, (existing?.totals ?? {}) as Partial<SplitTotals>);
    }
    covered.push({ from: p.periodStart, to: p.periodEnd });
  }
  return { computed, unchanged, locked, errors };
}
