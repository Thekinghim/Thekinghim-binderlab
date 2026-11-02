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

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

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

import { dayText } from "./display";
import {
  analysisPeriod,
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

/** Registrerat pris får ligga högst så många dagar fram (en offert för kommande leverans). */
export const QUOTE_MAX_DAYS_AHEAD = 90;
/** ...och högst så många dagar bakåt. */
export const QUOTE_MAX_DAYS_BACK = 3650;
/** Fackfördelning får börja högst så många dagar fram. */
export const SLOTS_MAX_DAYS_AHEAD = 90;
/** Genomförandedag för en sortimentsändring: högst så många dagar bakåt och fram. */
export const IMPLEMENT_MAX_DAYS_BACK = 7;
export const IMPLEMENT_MAX_DAYS_AHEAD = 30;

/**
 * Databasens begränsningar som användaren kan råka ut för, med svenska meddelanden.
 * Kontrollerna i tjänsten fångar de flesta före skrivningen; det här gäller samtidiga
 * anrop och manipulerade id:n som ändå når databasen.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  releases_title_unique: "Titeln har redan ett släpp i kalendern.",
  releases_organization_id_title_id_fkey: "Titeln finns inte.",
  releases_organization_id_supplier_id_fkey: "Leverantören finns inte.",
  supplier_price_quotes_organization_id_title_id_fkey: "Titeln finns inte.",
  supplier_price_quotes_organization_id_supplier_id_fkey: "Leverantören finns inte.",
  machine_slots_organization_id_title_id_fkey: "Titeln finns inte.",
  machine_slots_organization_id_machine_id_fkey: "Automaten finns inte.",
  machine_slots_no_overlap: "Fackperioderna överlappar. Ladda om sidan och försök igen.",
  price_experiments_proposal_unique: "Pristestet är redan startat.",
  assortment_changes_fingerprint_unique: "Rekommendationen är redan markerad som genomförd.",
};

/** Namnet på begränsningen bakom ett fel från postgres.js, om det finns. */
export function constraintOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "constraint_name" in current) {
      const name = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof name === "string") return name;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

async function explained<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const name = constraintOf(error);
    const message = name ? CONSTRAINT_MESSAGES[name] : undefined;
    if (message) throw new MarketError(message);
    throw error;
  }
}

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return explained(() => withUserDbFor(viewer.user, fn));
}

/** Titeln finns i organisationen och är inte sammanslagen (MarketError annars). */
async function assertTitles(tx: Tx, orgId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await tx
    .select({ id: s.titles.id })
    .from(s.titles)
    .where(
      and(
        eq(s.titles.organizationId, orgId),
        inArray(s.titles.id, unique),
        isNull(s.titles.mergedIntoId),
      ),
    );
  if (rows.length !== unique.length) throw new MarketError("Titeln finns inte.");
}

async function assertSupplier(tx: Tx, orgId: string, id: string | null): Promise<void> {
  if (!id) return;
  const [row] = await tx
    .select({ id: s.suppliers.id })
    .from(s.suppliers)
    .where(and(eq(s.suppliers.organizationId, orgId), eq(s.suppliers.id, id)));
  if (!row) throw new MarketError("Leverantören finns inte.");
}

async function assertNoOtherRelease(
  tx: Tx,
  orgId: string,
  titleId: string | null,
  exceptId: string | null,
): Promise<void> {
  if (!titleId) return;
  const rows = await tx
    .select({ id: s.releases.id, name: s.releases.name })
    .from(s.releases)
    .where(and(eq(s.releases.organizationId, orgId), eq(s.releases.titleId, titleId)));
  const other = rows.find((r) => r.id !== exceptId);
  if (other) throw new MarketError(`Titeln har redan ett släpp i kalendern (${other.name}).`);
}

/** Transaktionslås för en nyckel (släpps när transaktionen slutar). */
async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Senaste genomförda sortimentsändringens dag för en automat, eller null. */
async function lastImplementedOn(tx: Tx, orgId: string, machineId: string) {
  const [row] = await tx
    .select({ implementedOn: s.assortmentChanges.implementedOn })
    .from(s.assortmentChanges)
    .where(
      and(
        eq(s.assortmentChanges.organizationId, orgId),
        eq(s.assortmentChanges.machineId, machineId),
      ),
    )
    .orderBy(desc(s.assortmentChanges.implementedOn))
    .limit(1);
  return row?.implementedOn ?? null;
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

/**
 * Allt /marknad räknar på: stamdata, order de senaste HISTORY_DAYS dagarna, priser,
 * avtal, placeringar, inställningar, centrallagret, leverantörer, inköpsorderrader och
 * marknadstabellerna. Bara ägare, admin och läsare (AuthorizationError annars).
 */
export async function loadMarketDataFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<MarketData> {
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
      queryOrders(
        tx,
        orgId,
        { start: historyStart, end: today },
        { storeId: null, machineId: null },
      ),
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
      if (r.isCentral)
        warehouseUnits.set(r.titleId, (warehouseUnits.get(r.titleId) ?? 0) + r.onHand);
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
    const orgId = viewer.organization.id;
    if (input.titleId) await assertTitles(tx, orgId, [input.titleId]);
    await assertSupplier(tx, orgId, input.supplierId);
    await assertNoOtherRelease(tx, orgId, input.titleId, null);
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
    if (next.titleId && next.titleId !== current.titleId) {
      await assertTitles(tx, orgId, [next.titleId]);
      await assertNoOtherRelease(tx, orgId, next.titleId, current.id);
    }
    if (next.supplierId !== current.supplierId) await assertSupplier(tx, orgId, next.supplierId);
    if (current.planLockedAt) {
      // En titel får kopplas till ett fastställt förslag (när den dyker upp i orderna),
      // men inte bytas: utfallet mäts då mot en annan titel än planen.
      if (current.titleId !== null && next.titleId !== current.titleId) {
        throw new MarketError(
          "Förslaget är fastställt för en annan titel. Lås upp det innan titeln byts.",
        );
      }
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
      .where(
        and(eq(s.releaseAllocations.organizationId, orgId), eq(s.releaseAllocations.releaseId, id)),
      );
    await tx
      .delete(s.releases)
      .where(and(eq(s.releases.organizationId, orgId), eq(s.releases.id, id)));
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
    throw new MarketError(
      "Det finns inget förslag att fastställa (inga tidigare släpp att räkna från).",
    );
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
  const today = businessToday(new Date(), viewer.organization.timezone);
  if (input.quotedOn > addDays(today, QUOTE_MAX_DAYS_AHEAD)) {
    throw new MarketError(
      `Datumet kan ligga högst ${QUOTE_MAX_DAYS_AHEAD} dagar fram (${dayText(addDays(today, QUOTE_MAX_DAYS_AHEAD), today)}).`,
    );
  }
  if (input.quotedOn < addDays(today, -QUOTE_MAX_DAYS_BACK)) {
    throw new MarketError("Datumet kan ligga högst tio år bakåt.");
  }
  if (input.unitCost === 0 && !input.note) {
    throw new MarketError("Ett pris på 0 kr kräver en anteckning (t.ex. gratisexemplar).");
  }
  return asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    await assertTitles(tx, orgId, [input.titleId]);
    await assertSupplier(tx, orgId, input.supplierId);
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
  const where = and(
    eq(s.machineSlots.organizationId, orgId),
    eq(s.machineSlots.machineId, machineId),
  );
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

/**
 * Sparar en ny fackfördelning från och med `validFrom`. Fackfördelningen från en
 * genomförd sortimentsändring skrivs aldrig över (uppföljningen mäts mot den), så
 * `validFrom` måste ligga efter den senaste genomförda ändringen i automaten.
 */
export async function saveSlotsFor(
  viewer: Viewer,
  input: SaveSlotsInput,
  now: Date = new Date(),
): Promise<void> {
  const today = businessToday(now, viewer.organization.timezone);
  if (input.validFrom > addDays(today, SLOTS_MAX_DAYS_AHEAD)) {
    throw new MarketError(`Fackfördelningen kan börja högst ${SLOTS_MAX_DAYS_AHEAD} dagar fram.`);
  }
  await asOperator(viewer, async (tx) => {
    const orgId = viewer.organization.id;
    const [machine] = await tx
      .select({ id: s.machines.id })
      .from(s.machines)
      .where(and(eq(s.machines.organizationId, orgId), eq(s.machines.id, input.machineId)));
    if (!machine) throw new MarketError("Automaten finns inte.");
    await assertTitles(
      tx,
      orgId,
      input.lines.map((l) => l.titleId),
    );
    await lockKey(tx, `marknad:slots:${orgId}:${input.machineId}`);
    const locked = await lastImplementedOn(tx, orgId, input.machineId);
    if (locked && input.validFrom <= locked) {
      throw new MarketError(
        `Fackfördelningen från den genomförda sortimentsändringen ${dayText(locked, today)} följs upp och kan inte skrivas över. Välj en dag efter ${dayText(locked, today)}.`,
      );
    }
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
  if (input.implementedOn > addDays(data.today, IMPLEMENT_MAX_DAYS_AHEAD)) {
    throw new MarketError(
      `Genomförandedagen kan ligga högst ${IMPLEMENT_MAX_DAYS_AHEAD} dagar fram.`,
    );
  }
  if (input.implementedOn < addDays(data.today, -IMPLEMENT_MAX_DAYS_BACK)) {
    throw new MarketError(
      `Genomförandedagen kan ligga högst ${IMPLEMENT_MAX_DAYS_BACK} dagar bakåt. Registrera äldre ändringar som fackfördelning.`,
    );
  }
  // Samma analysperiod som sidan (dagar med data, högst till och med i går).
  const period: Period = analysisPeriod(data, { start: input.periodStart, end: input.periodEnd });
  if (input.implementedOn <= period.end) {
    throw new MarketError(
      `Genomförandedagen måste ligga efter rekommendationens mätperiod (efter ${dayText(period.end, data.today)}).`,
    );
  }
  const rec = assortmentRecommendations(data, period).find((r) => r.machineId === input.machineId);
  if (!rec || rec.fingerprint !== input.fingerprint) {
    throw new MarketError(
      "Rekommendationen har ändrats sedan sidan laddades. Ladda om och försök igen.",
    );
  }
  if (rec.action !== "change") {
    throw new MarketError(
      "Rekommendationen är att behålla sortimentet; det finns inget att genomföra.",
    );
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
  const id = await explained(() =>
    withUserDbFor(viewer.user, async (tx) => {
    const orgId = viewer.organization.id;
    // Ett anrop i taget per automat; kontrollerna nedan görs under låset.
    await lockKey(tx, `marknad:slots:${orgId}:${input.machineId}`);
    const [already] = await tx
      .select({ id: s.assortmentChanges.id })
      .from(s.assortmentChanges)
      .where(
        and(
          eq(s.assortmentChanges.organizationId, orgId),
          eq(s.assortmentChanges.machineId, input.machineId),
          eq(s.assortmentChanges.fingerprint, rec.fingerprint),
        ),
      );
    if (already) throw new MarketError("Rekommendationen är redan markerad som genomförd.");
    const locked = await lastImplementedOn(tx, orgId, input.machineId);
    if (locked && input.implementedOn <= locked) {
      throw new MarketError(
        `Automaten har en genomförd sortimentsändring ${dayText(locked, data.today)}. Välj en dag efter den.`,
      );
    }
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
    }),
  );
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
    throw new MarketError(
      "Förslaget gäller inte längre. Ladda om sidan och välj ett aktuellt förslag.",
    );
  }
  const id = await explained(() =>
    withUserDbFor(viewer.user, async (tx) => {
    const orgId = viewer.organization.id;
    // Ett anrop i taget per titel; kontrollen görs under låset (dubbelklick, flera flikar).
    await lockKey(tx, `marknad:experiment:${orgId}:${proposal.titleId}`);
    const running = await tx
      .select({ id: s.priceExperiments.id })
      .from(s.priceExperiments)
      .where(
        and(
          eq(s.priceExperiments.organizationId, orgId),
          eq(s.priceExperiments.titleId, proposal.titleId),
          isNull(s.priceExperiments.stoppedOn),
          sql`${s.priceExperiments.startedOn} + ${s.priceExperiments.testDays} - 1 >= ${data.today}::date`,
        ),
      );
    if (running.length > 0) throw new MarketError("Titeln har redan ett pristest som pågår.");
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
        snapshot: {
          text: proposal.text,
          breakEvenVolumeChangeBp: proposal.breakEvenVolumeChangeBp,
          weeklyContributionOre: proposal.weeklyContributionOre,
          rule: proposal.evidence.rule,
          figures: proposal.evidence.figures,
        },
      })
      .returning({ id: s.priceExperiments.id });
    await tx.insert(s.priceExperimentMachines).values([
      ...proposal.testMachineIds.map((machineId) => ({
        organizationId: viewer.organization.id,
        experimentId: row!.id,
        machineId,
        arm: "test" as const,
      })),
      ...proposal.controlMachineIds.map((machineId) => ({
        organizationId: viewer.organization.id,
        experimentId: row!.id,
        machineId,
        arm: "control" as const,
      })),
    ]);
    return row!.id;
    }),
  );
  return { id, startedOn: proposal.period.start };
}

/**
 * Stoppar ett pristest. Ett test som inte har mätts en hel dag (börjar i dag eller senare)
 * tas bort; ett pågående får sista dag i dag (utvärderingen räknas till och med i går, sista
 * hela dagen).
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
    // Ett test som inte mätts en hel dag (börjar i dag eller senare) tas bort.
    if (row.startedOn >= today) {
      await tx
        .delete(s.priceExperimentMachines)
        .where(
          and(
            eq(s.priceExperimentMachines.organizationId, orgId),
            eq(s.priceExperimentMachines.experimentId, id),
          ),
        );
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
