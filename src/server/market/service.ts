/**
 * Marknad på servern: laddaren och alla ändringar, bundna till en verifierad användare
 * och organisation (Viewer). Server actions i src/app/(app)/marknad anropar dem med
 * sessionens användare; testerna (test/db/marknad-*.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (läsning: ägare, admin och
 * läsare; ändring: ägare och admin) och läser och skriver sedan som användaren med RLS.
 * Förslag som sparas (fastställt släppförslag, genomförd sortimentsändring, startat
 * pristest) räknas om här från databasen, aldrig från det klienten skickar.
 */

import "server-only";

import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

import { withUserDbFor, requireRoleFor } from "@/server/access";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate, type Period } from "@/domain";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import {
  queryAgreements,
  queryFirstOrderDate,
  queryMachines,
  queryOrders,
  queryPlacements,
  queryPrices,
  querySettings,
  queryStock,
  queryStores,
  queryTitles,
} from "@/server/data/core/queries";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";

import {
  assortmentRecommendations,
  priceTestProposals,
  releaseSuggestionFor,
  suggestionDay,
} from "./model";
import {
  queryAllocations,
  queryAssortmentChanges,
  queryExperiments,
  queryPurchaseLines,
  queryQuotes,
  queryReleases,
  querySlots,
  querySupplierItems,
  querySuppliers,
} from "./queries";
import type {
  CreateQuoteInput,
  CreateReleaseInput,
  ImplementAssortmentInput,
  SaveSlotsInput,
  StartExperimentInput,
  UpdateReleaseInput,
} from "./schemas";
import type { MarketData } from "./types";

export type { Viewer };

/** Så långt bakåt orderhistoriken läses (prisändringar, släppkurvor, uppföljning). */
export const HISTORY_DAYS = 400;

/** Fel som visas för användaren som det är (svensk text). */
export class MarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketError";
  }
}

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, fn);
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

/**
 * Allt /marknad räknar på: stamdata, order de senaste HISTORY_DAYS dagarna, priser,
 * avtal, placeringar, inställningar, centrallagret, leverantörer, inköpsorderrader och
 * marknadstabellerna. Bara ägare, admin och läsare (AuthorizationError annars).
 */
export async function loadMarketDataFor(viewer: Viewer, now: Date = new Date()): Promise<MarketData> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const historyStart = addDays(today, -(HISTORY_DAYS - 1));
  return withUserDbFor(viewer.user, async (tx) => {
    const [titles, placements, stores] = await Promise.all([
      queryTitles(tx, orgId),
      queryPlacements(tx, orgId),
      queryStores(tx, orgId),
    ]);
    const machines = await queryMachines(tx, orgId, placements, today);
    const [
      prices,
      agreements,
      settings,
      orderResult,
      dataStart,
      stock,
      suppliers,
      supplierItems,
      purchaseLines,
      releases,
      allocations,
      quotes,
      slots,
      assortmentChanges,
      experiments,
    ] = await Promise.all([
      queryPrices(tx, orgId),
      queryAgreements(tx, orgId),
      querySettings(tx, orgId),
      queryOrders(tx, orgId, { start: historyStart, end: today }, { storeId: null, machineId: null }),
      queryFirstOrderDate(tx, orgId),
      queryStock(tx, orgId),
      querySuppliers(tx, orgId),
      querySupplierItems(tx, orgId),
      queryPurchaseLines(tx, orgId, timeZone),
      queryReleases(tx, orgId),
      queryAllocations(tx, orgId),
      queryQuotes(tx, orgId),
      querySlots(tx, orgId),
      queryAssortmentChanges(tx, orgId),
      queryExperiments(tx, orgId),
    ]);
    const warehouseUnits = new Map<string, number>();
    for (const r of stock) {
      if (r.isCentral) warehouseUnits.set(r.titleId, (warehouseUnits.get(r.titleId) ?? 0) + r.onHand);
    }
    return {
      organizationId: orgId,
      timeZone,
      role,
      canEdit: (OPERATOR_ROLES as readonly string[]).includes(role),
      today,
      dataStart,
      historyStart,
      titles,
      machines,
      stores,
      placements,
      orders: orderResult.orders,
      sources: { prices, agreements, placements, settings },
      settings,
      warehouseUnits,
      suppliers,
      supplierItems,
      purchaseLines,
      releases,
      allocations,
      quotes,
      slots,
      assortmentChanges,
      experiments,
    };
  });
}

// ---------------------------------------------------------------------------
// Releaser
// ---------------------------------------------------------------------------

function releaseValues(input: CreateReleaseInput) {
  return {
    name: input.name,
    series: input.series ?? null,
    releaseDate: input.releaseDate,
    titleId: input.titleId,
    supplierId: input.supplierId,
    scaleBp: input.scalePercent,
    horizonDays: input.horizonDays,
    boxSize: input.boxSize,
    minOrderQty: input.minOrderQty,
    note: input.note ?? null,
  };
}

export async function createReleaseFor(viewer: Viewer, input: CreateReleaseInput): Promise<string> {
  return asOperator(viewer, async (tx) => {
    const [row] = await tx
      .insert(s.releases)
      .values({ organizationId: viewer.organization.id, source: "manual", ...releaseValues(input) })
      .returning({ id: s.releases.id });
    return row!.id;
  });
}

async function releaseRow(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(s.releases)
    .where(and(eq(s.releases.organizationId, orgId), eq(s.releases.id, id)));
  if (!row || row.archivedAt) throw new MarketError("Släppet finns inte.");
  return row;
}

export async function updateReleaseFor(viewer: Viewer, input: UpdateReleaseInput): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    const current = await releaseRow(tx, orgId, input.id);
    const next = releaseValues(input);
    if (current.planLockedAt) {
      const planChanged =
        current.releaseDate !== next.releaseDate ||
        current.scaleBp !== next.scaleBp ||
        current.horizonDays !== next.horizonDays ||
        current.boxSize !== next.boxSize ||
        current.minOrderQty !== next.minOrderQty;
      if (planChanged) {
        throw new MarketError(
          "Förslaget är fastställt. Lås upp det innan släppdag, storlek, horisont eller förpackning ändras.",
        );
      }
    }
    await tx
      .update(s.releases)
      .set(next)
      .where(and(eq(s.releases.organizationId, orgId), eq(s.releases.id, input.id)));
  });
}

export async function deleteReleaseFor(viewer: Viewer, id: string): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    await releaseRow(tx, orgId, id);
    await tx
      .delete(s.releaseAllocations)
      .where(and(eq(s.releaseAllocations.organizationId, orgId), eq(s.releaseAllocations.releaseId, id)));
    await tx.delete(s.releases).where(and(eq(s.releases.organizationId, orgId), eq(s.releases.id, id)));
  });
}

/**
 * Fastställer förslaget: räknar om det från databasen (samma dag som sidan visar) och
 * sparar inköpsmängd, släppkurva, text och fördelning per automat. Utfallet mäts sedan
 * mot det sparade förslaget.
 */
export async function lockReleasePlanFor(
  viewer: Viewer,
  releaseId: string,
  now: Date = new Date(),
): Promise<{ purchaseUnits: number; machines: number }> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const data = await loadMarketDataFor(viewer, now);
  const row = data.releases.find((r) => r.id === releaseId);
  if (!row) throw new MarketError("Släppet finns inte.");
  if (row.planLockedAt) throw new MarketError("Förslaget är redan fastställt.");
  const suggestion = releaseSuggestionFor(data, row, suggestionDay(row, data.today));
  if (suggestion.status !== "ok") {
    throw new MarketError("Det finns inget förslag att fastställa (inga tidigare släpp att räkna från).");
  }
  const snapshot = {
    text: suggestion.text,
    asOf: suggestionDay(row, data.today),
    basis: suggestion.basis,
    comparableTitleIds: suggestion.comparableTitleIds,
    machineUnits: suggestion.machineUnits,
    onHandUnits: suggestion.onHandUnits,
    boxes: suggestion.boxes,
    weeklyUnits: suggestion.weeklyUnits,
    rule: suggestion.evidence.rule,
    figures: suggestion.evidence.figures,
  };
  await withUserDbFor(viewer.user, async (tx) => {
    const orgId = viewer.organization.id;
    const updated = await tx
      .update(s.releases)
      .set({
        planLockedAt: now,
        planPurchaseUnits: suggestion.purchaseUnits,
        planCurveBp: suggestion.curve ? [...suggestion.curve.cumulativeBp] : null,
        planSnapshot: snapshot,
      })
      .where(
        and(
          eq(s.releases.organizationId, orgId),
          eq(s.releases.id, releaseId),
          isNull(s.releases.planLockedAt),
        ),
      )
      .returning({ id: s.releases.id });
    if (updated.length === 0) throw new MarketError("Förslaget är redan fastställt.");
    if (suggestion.allocations.length > 0) {
      await tx.insert(s.releaseAllocations).values(
        suggestion.allocations.map((a) => ({
          organizationId: orgId,
          releaseId,
          machineId: a.machineId,
          units: a.units,
          suggestedUnits: a.units,
        })),
      );
    }
  });
  return { purchaseUnits: suggestion.purchaseUnits, machines: suggestion.allocations.length };
}

/** Låser upp ett fastställt förslag: fördelningen tas bort och förslaget räknas igen. */
export async function unlockReleasePlanFor(viewer: Viewer, releaseId: string): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    const row = await releaseRow(tx, orgId, releaseId);
    if (!row.planLockedAt) throw new MarketError("Förslaget är inte fastställt.");
    await tx
      .delete(s.releaseAllocations)
      .where(
        and(
          eq(s.releaseAllocations.organizationId, orgId),
          eq(s.releaseAllocations.releaseId, releaseId),
        ),
      );
    await tx
      .update(s.releases)
      .set({ planLockedAt: null, planPurchaseUnits: null, planCurveBp: null, planSnapshot: null })
      .where(and(eq(s.releases.organizationId, orgId), eq(s.releases.id, releaseId)));
  });
}

// ---------------------------------------------------------------------------
// Leverantörspriser
// ---------------------------------------------------------------------------

export async function createQuoteFor(viewer: Viewer, input: CreateQuoteInput): Promise<string> {
  return asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    let supplierId = input.supplierId;
    if (!supplierId) {
      const name = input.newSupplierName!.trim();
      const [existing] = await tx
        .select({ id: s.suppliers.id })
        .from(s.suppliers)
        .where(
          and(
            eq(s.suppliers.organizationId, orgId),
            sql`lower(btrim(${s.suppliers.name})) = lower(${name})`,
          ),
        );
      if (existing) supplierId = existing.id;
      else {
        const [created] = await tx
          .insert(s.suppliers)
          .values({ organizationId: orgId, name })
          .returning({ id: s.suppliers.id });
        supplierId = created!.id;
      }
    }
    const [row] = await tx
      .insert(s.supplierPriceQuotes)
      .values({
        organizationId: orgId,
        supplierId,
        titleId: input.titleId,
        quotedOn: input.quotedOn,
        validUntil: input.validUntil,
        unitCostOre: input.unitCost,
        quantity: input.quantity,
        kind: input.kind,
        source: "manual",
        note: input.note ?? null,
      })
      .returning({ id: s.supplierPriceQuotes.id });
    return row!.id;
  });
}

export async function deleteQuoteFor(viewer: Viewer, id: string): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const deleted = await tx
      .delete(s.supplierPriceQuotes)
      .where(
        and(
          eq(s.supplierPriceQuotes.organizationId, viewer.organization.id),
          eq(s.supplierPriceQuotes.id, id),
        ),
      )
      .returning({ id: s.supplierPriceQuotes.id });
    if (deleted.length === 0) throw new MarketError("Priset finns inte.");
  });
}

// ---------------------------------------------------------------------------
// Fackfördelning och sortiment
// ---------------------------------------------------------------------------

/**
 * Ny fackfördelning för en automat från och med `validFrom`: perioder som gäller
 * dagen före avslutas dagen före, perioder som börjar samma dag eller senare ersätts.
 */
async function replaceSlots(
  tx: Tx,
  orgId: string,
  machineId: string,
  validFrom: IsoDate,
  lines: readonly { titleId: string; slots: number }[],
): Promise<void> {
  const where = and(eq(s.machineSlots.organizationId, orgId), eq(s.machineSlots.machineId, machineId));
  await tx.delete(s.machineSlots).where(and(where, gte(s.machineSlots.validFrom, validFrom)));
  await tx
    .update(s.machineSlots)
    .set({ validTo: addDays(validFrom, -1) })
    .where(
      and(
        where,
        lt(s.machineSlots.validFrom, validFrom),
        or(isNull(s.machineSlots.validTo), gte(s.machineSlots.validTo, validFrom)),
      ),
    );
  if (lines.length > 0) {
    await tx.insert(s.machineSlots).values(
      lines.map((l) => ({
        organizationId: orgId,
        machineId,
        titleId: l.titleId,
        slots: l.slots,
        validFrom,
      })),
    );
  }
}

export async function saveSlotsFor(viewer: Viewer, input: SaveSlotsInput): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    const [machine] = await tx
      .select({ id: s.machines.id })
      .from(s.machines)
      .where(and(eq(s.machines.organizationId, orgId), eq(s.machines.id, input.machineId)));
    if (!machine) throw new MarketError("Automaten finns inte.");
    await replaceSlots(tx, orgId, input.machineId, input.validFrom, input.lines);
  });
}

/**
 * Markerar rekommendationen som genomförd: räknar om den för samma period, kontrollerar
 * att den är densamma som användaren såg (fingerprint), sparar ändringen och den väntade
 * effekten, och sätter den nya fackfördelningen från och med genomförandedagen.
 */
export async function implementAssortmentFor(
  viewer: Viewer,
  input: ImplementAssortmentInput,
  now: Date = new Date(),
): Promise<{ id: string; effectPerWeekOre: number }> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const data = await loadMarketDataFor(viewer, now);
  if (input.implementedOn > addDays(data.today, 30)) {
    throw new MarketError("Genomförandedagen kan ligga högst 30 dagar fram.");
  }
  const period: Period = { start: input.periodStart, end: input.periodEnd };
  const rec = assortmentRecommendations(data, period).find((r) => r.machineId === input.machineId);
  if (!rec || rec.fingerprint !== input.fingerprint) {
    throw new MarketError("Rekommendationen har ändrats sedan sidan laddades. Ladda om och försök igen.");
  }
  if (rec.action !== "change") {
    throw new MarketError("Rekommendationen är att behålla sortimentet; det finns inget att genomföra.");
  }
  const snapshot = {
    text: rec.text,
    period,
    changes: rec.changes,
    lines: rec.lines.map((l) => ({
      titleId: l.titleId,
      currentSlots: l.currentSlots,
      recommendedSlots: l.recommendedSlots,
    })),
    rule: rec.evidence.rule,
    figures: rec.evidence.figures,
  };
  const id = await withUserDbFor(viewer.user, async (tx) => {
    const orgId = viewer.organization.id;
    const [row] = await tx
      .insert(s.assortmentChanges)
      .values({
        organizationId: orgId,
        machineId: input.machineId,
        implementedOn: input.implementedOn,
        recommendationKey: rec.key,
        fingerprint: rec.fingerprint,
        expectedEffectPerWeekOre: rec.effectPerWeekOre,
        changedTitleIds: [...new Set(rec.changes.map((c) => c.titleId))].sort(),
        snapshot,
      })
      .returning({ id: s.assortmentChanges.id });
    await replaceSlots(
      tx,
      orgId,
      input.machineId,
      input.implementedOn,
      rec.lines
        .filter((l) => l.recommendedSlots > 0)
        .map((l) => ({ titleId: l.titleId, slots: l.recommendedSlots })),
    );
    return row!.id;
  });
  return { id, effectPerWeekOre: rec.effectPerWeekOre };
}

// ---------------------------------------------------------------------------
// Pristester
// ---------------------------------------------------------------------------

/** Startar ett föreslaget pristest (förslaget räknas om per i dag). */
export async function startExperimentFor(
  viewer: Viewer,
  input: StartExperimentInput,
  now: Date = new Date(),
): Promise<{ id: string; startedOn: IsoDate }> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const data = await loadMarketDataFor(viewer, now);
  const proposal = priceTestProposals(data).find((p) => p.key === input.proposalKey);
  if (!proposal) {
    throw new MarketError("Förslaget gäller inte längre. Ladda om sidan och välj ett aktuellt förslag.");
  }
  const id = await withUserDbFor(viewer.user, async (tx) => {
    const [row] = await tx
      .insert(s.priceExperiments)
      .values({
        organizationId: viewer.organization.id,
        titleId: proposal.titleId,
        proposalKey: proposal.key,
        direction: proposal.direction,
        fromOre: proposal.fromOre,
        toOre: proposal.toOre,
        startedOn: proposal.period.start,
        testDays: proposal.evaluation.windowDays,
        testMachineIds: [...proposal.testMachineIds],
        controlMachineIds: [...proposal.controlMachineIds],
        snapshot: {
          text: proposal.text,
          breakEvenVolumeChangeBp: proposal.breakEvenVolumeChangeBp,
          weeklyContributionOre: proposal.weeklyContributionOre,
          rule: proposal.evidence.rule,
          figures: proposal.evidence.figures,
        },
      })
      .returning({ id: s.priceExperiments.id });
    return row!.id;
  });
  return { id, startedOn: proposal.period.start };
}

/**
 * Stoppar ett pristest. Ett test som inte har börjat tas bort; ett pågående får sista dag
 * i dag (utvärderingen räknas till och med den).
 */
export async function stopExperimentFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<"deleted" | "stopped"> {
  return asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    const today = businessToday(now, viewer.organization.timezone);
    const [row] = await tx
      .select()
      .from(s.priceExperiments)
      .where(and(eq(s.priceExperiments.organizationId, orgId), eq(s.priceExperiments.id, id)));
    if (!row) throw new MarketError("Pristestet finns inte.");
    if (row.stoppedOn) throw new MarketError("Pristestet är redan stoppat.");
    if (row.startedOn > today) {
      await tx
        .delete(s.priceExperiments)
        .where(and(eq(s.priceExperiments.organizationId, orgId), eq(s.priceExperiments.id, id)));
      return "deleted";
    }
    await tx
      .update(s.priceExperiments)
      .set({ stoppedOn: today })
      .where(and(eq(s.priceExperiments.organizationId, orgId), eq(s.priceExperiments.id, id)));
    return "stopped";
  });
}
