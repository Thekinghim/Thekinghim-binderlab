/**
 * Uträkningarna för utbetalningarna från Nayax (payout_allocations och deras rader).
 *
 * recomputeAllocationsTx går igenom organisationens utbetalningar i ordning (äldst först)
 * och räknar varje utkast igen med underlaget som det är nu (./inputs.ts →
 * src/domain/payout-split.ts). Ett utkast med samma underlag (inputs_hash) får ingen ny
 * version. En låst uträkning (något är betalt från den), och allt före den, räknas aldrig
 * om: det den fördelade räknas med, och skillnader blir justeringar (butikerna) och
 * rättelser (partnern och momsen) på nästa utkast. Siffror ändras alltså aldrig bakåt
 * efter en betalning.
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
  type PartnerComponents,
  type VatComponents,
  type VatReserveMode,
  type SplitLine,
  type SplitResult,
  type SplitTotals,
  type SplitWarning,
  type StoreComponent,
} from "@/domain";

import {
  loadAllocationInputsTx,
  loadDayTotalsTx,
  loadOrgPayoutContextTx,
  lockedRecheckInput,
  smKey,
  type OrgPayoutContext,
  type PayoutRef,
  type PriorState,
  type StoredPartnerSegment,
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

interface FrozenDetails {
  stores: StoreComponent[];
  partnerSegments: StoredPartnerSegment[] | null;
  vatMode: VatReserveMode | null;
}

/** Butikernas delar, partnerns avsnitt och momsläget per uträkning (raderna). */
async function detailsFor(
  tx: Tx,
  orgId: string,
  allocationIds: readonly string[],
): Promise<Map<string, FrozenDetails>> {
  const out = new Map<string, FrozenDetails>();
  if (allocationIds.length === 0) return out;
  const rows = await tx
    .select({
      allocationId: s.payoutAllocationLines.allocationId,
      kind: s.payoutAllocationLines.recipientKind,
      components: s.payoutAllocationLines.components,
    })
    .from(s.payoutAllocationLines)
    .where(
      and(
        eq(s.payoutAllocationLines.organizationId, orgId),
        inArray(s.payoutAllocationLines.allocationId, [...allocationIds]),
        inArray(s.payoutAllocationLines.recipientKind, [
          "store",
          "store_owner",
          "partner",
          "vat_reserve",
        ]),
      ),
    );
  for (const r of rows) {
    const d = out.get(r.allocationId) ?? { stores: [], partnerSegments: null, vatMode: null };
    if (r.kind === "store" || r.kind === "store_owner") {
      d.stores.push(...storeComponentsOf(r.components));
    } else if (r.kind === "partner") {
      const segs = (r.components as { partner?: PartnerComponents }).partner?.segments ?? [];
      d.partnerSegments = segs.map((g) => ({
        agreementId: g.agreementId,
        bp: g.bp,
        reimburse: g.reimburse ?? g.reimbOre > 0,
        from: g.from,
        to: g.to,
      }));
    } else {
      const mode = (r.components as { vat?: VatComponents }).vat?.mode;
      d.vatMode = mode === "vmb" || mode === "standard" || mode === "none" ? mode : null;
    }
    out.set(r.allocationId, d);
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
 * Rättelserna från de fasta uträkningarna (se recomputeAllocationsTx): varje fast
 * utbetalning räknas igen med dagens inköpspriser men med sina låsta butiksdelar, avtal och
 * underskott. Skillnaden för partnern (inköp + vinstdel) och momsen, minus det som redan
 * lagts på senare utbetalningar, läggs på nästa utkast.
 */
async function lockedAdjustmentsTx(
  tx: Tx,
  ctx: OrgPayoutContext,
  frozen: readonly { payout: PayoutRef; allocationId: string; totals: Partial<SplitTotals> }[],
  details: ReadonlyMap<string, FrozenDetails>,
): Promise<{ partnerOre: number; vatOre: number }> {
  if (frozen.length === 0) return { partnerOre: 0, vatOre: 0 };
  const from = frozen.reduce(
    (a, f) => (f.payout.periodStart < a ? f.payout.periodStart : a),
    "9999-12-31",
  );
  const to = frozen.reduce(
    (a, f) => (f.payout.periodEnd > a ? f.payout.periodEnd : a),
    "0000-01-01",
  );
  const groups = await loadDayTotalsTx(tx, ctx, from as IsoDate, to as IsoDate);
  let partnerOre = 0;
  let vatOre = 0;
  for (const f of frozen) {
    const d = details.get(f.allocationId);
    const t = f.totals;
    partnerOre -= num(t.partnerAdjustOre);
    vatOre -= num(t.vatAdjustOre);
    try {
      const v = splitPayout(
        lockedRecheckInput(ctx, f.payout, groups, {
          stores: d?.stores ?? [],
          partnerSegments: d?.partnerSegments ?? null,
          totals: t,
          vatMode: t.vatMode ?? d?.vatMode ?? ctx.vatMode,
        }),
      ).totals;
      // Bara när uträkningen hade partnern (ett borttaget avtal ändrar inget bakåt).
      if (d?.partnerSegments) {
        partnerOre +=
          v.partnerReimbOre + v.partnerProfitOre - num(t.partnerReimbOre) - num(t.partnerProfitOre);
      }
      vatOre += v.vatOre - num(t.vatOre);
    } catch {
      // Går den inte att räkna igen blir det ingen rättelse för den.
    }
  }
  return { partnerOre, vatOre };
}

/** Utbetalningens dag för "Utbetalningar från och med": dagen pengarna kom, annars sparad. */
function payoutDay(p: { paidOn: IsoDate | null; createdAt: Date }): IsoDate {
  return p.paidOn ?? (p.createdAt.toISOString().slice(0, 10) as IsoDate);
}

export const BEFORE_LOCKED_MESSAGE =
  "Utbetalningen ligger före en utbetalning som redan är betald, så den räknas inte. Ångra betalningarna på den senare först, eller arkivera den här.";

/**
 * Räknar om utkasten för organisationen. Utbetalningarna gås igenom äldst först:
 *
 * - Bara utbetalningar från och med organization_settings.payouts_from (dagen pengarna
 *   kom). Äldre (t.ex. importerade på Ekonomi innan Utbetalningar fanns) får ingen
 *   uträkning och syns inte här.
 * - FASTA: en låst uträkning, och varje uträkning före den senaste låsta (även ett utkast),
 *   räknas aldrig om; det de fördelade och deras underskott förs vidare som de är. En
 *   utbetalning före den senaste låsta som saknar uträkning (t.ex. importerad i efterhand)
 *   räknas inte alls (BEFORE_LOCKED_MESSAGE): annars skulle underskotten användas två gånger.
 * - Ändrade inköpspris eller moms för en fast utbetalning blir en rättelse för partnern och
 *   momsen på första utkastet efter dem (lockedAdjustmentsTx); butikerna rättas mot
 *   månadsavräkningen (inputs.ts).
 * - `onlyIfMissing`: räkna bara utbetalningar som saknar uträkning (snabbt).
 */
export async function recomputeAllocationsTx(
  tx: Tx,
  orgId: string,
  now: Date,
  options: { readonly onlyIfMissing?: boolean; readonly context?: OrgPayoutContext } = {},
): Promise<RecomputeResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payout-alloc:${orgId}`}))`);
  const [opt] = await tx
    .select({ from: s.organizationSettings.payoutsFrom })
    .from(s.organizationSettings)
    .where(eq(s.organizationSettings.organizationId, orgId));
  const payoutsFrom = opt?.from ?? null;
  const all = await tx
    .select({
      id: s.payouts.id,
      periodStart: s.payouts.periodStart,
      periodEnd: s.payouts.periodEnd,
      amountOre: s.payouts.amountOre,
      paidOn: s.payouts.paidOn,
      createdAt: s.payouts.createdAt,
    })
    .from(s.payouts)
    .where(and(eq(s.payouts.organizationId, orgId), isNull(s.payouts.archivedAt)))
    .orderBy(asc(s.payouts.periodStart), asc(s.payouts.periodEnd), asc(s.payouts.createdAt));
  const payouts = all.filter((p) => payoutsFrom === null || payoutDay(p) >= payoutsFrom);
  const current = await currentAllocations(tx, orgId);
  const details = await detailsFor(
    tx,
    orgId,
    [...current.values()].map((a) => a.id),
  );
  const comps = new Map([...details.entries()].map(([id, d]) => [id, d.stores]));
  let lastLocked = -1;
  payouts.forEach((p, i) => {
    if (current.get(p.id)?.status === "locked") lastLocked = i;
  });
  let ctx = options.context ?? null;
  const allocated = new Map<string, number>();
  const covered: { from: IsoDate; to: IsoDate }[] = [];
  const frozen: { payout: PayoutRef; allocationId: string; totals: Partial<SplitTotals> }[] = [];
  let vatCarry = 0;
  let partnerCarry = 0;
  // Rättelser som redan lagts på utkast som inte räknas om (onlyIfMissing).
  let consumedPartner = 0;
  let consumedVat = 0;
  let adjustments: { partnerOre: number; vatOre: number } | null = null;
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

  for (const [i, p] of payouts.entries()) {
    const existing = current.get(p.id);
    if (i <= lastLocked) {
      if (!existing) {
        errors.push({ payoutId: p.id, message: BEFORE_LOCKED_MESSAGE });
        continue;
      }
      if (existing.status === "locked") locked += 1;
      else unchanged += 1;
      const totals = existing.totals as Partial<SplitTotals>;
      absorb(existing.id, totals);
      covered.push({ from: p.periodStart, to: p.periodEnd });
      frozen.push({ payout: p, allocationId: existing.id, totals });
      continue;
    }
    if (existing && options.onlyIfMissing) {
      unchanged += 1;
      const totals = existing.totals as Partial<SplitTotals>;
      consumedPartner += num(totals.partnerAdjustOre);
      consumedVat += num(totals.vatAdjustOre);
      absorb(existing.id, totals);
      covered.push({ from: p.periodStart, to: p.periodEnd });
      continue;
    }
    ctx ??= await loadOrgPayoutContextTx(tx, orgId);
    adjustments ??= await lockedAdjustmentsTx(tx, ctx, frozen, details);
    const prior: PriorState = {
      allocated: new Map(allocated),
      covered: [...covered],
      vatCarryOutOre: vatCarry,
      partnerCarryOutOre: partnerCarry,
      partnerAdjustOre: adjustments.partnerOre - consumedPartner,
      vatAdjustOre: adjustments.vatOre - consumedVat,
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
      consumedPartner += num(result.totals.partnerAdjustOre);
      consumedVat += num(result.totals.vatAdjustOre);
      absorb(allocationId, result.totals);
    } catch (error) {
      errors.push({
        payoutId: p.id,
        message: error instanceof Error ? error.message : String(error),
      });
      const totals = (existing?.totals ?? {}) as Partial<SplitTotals>;
      consumedPartner += num(totals.partnerAdjustOre);
      consumedVat += num(totals.vatAdjustOre);
      absorb(existing?.id ?? null, totals);
    }
    covered.push({ from: p.periodStart, to: p.periodEnd });
  }
  return { computed, unchanged, locked, errors };
}
