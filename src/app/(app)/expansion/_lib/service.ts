/**
 * Expansion, enhetsekonomi och effekt på servern: laddare och ändringar, bundna till en
 * verifierad användare och organisation (Viewer). Server actions och sidorna anropar dem
 * med sessionens användare; testerna (test/db/expansion-service.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (läsa: ägare, admin och läsare;
 * ändra: ägare och admin) och läser och skriver sedan som användaren med RLS
 * (withUserDbFor). Påfyllaren kommer aldrig åt något här.
 */

import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { requireRoleFor, withUserDbFor, AuthorizationError } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import type { MemberRole } from "@/db/schema";

import type { LeadRecord, LeadStageKey } from "./model";
import type {
  BaselineInput,
  EffectSettingsInput,
  GoalInput,
  InvestmentInput,
  LeadInput,
  MeasurementInput,
  StoreProfileInput,
} from "./schemas";

export type { Viewer };

/** Fel som visas för användaren som det är (svenskt meddelande). */
export class ExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpansionError";
  }
}

async function asViewer<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx, orgId: string) => Promise<T>,
): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, roles);
  return withUserDbFor(viewer.user, (tx) => fn(tx, viewer.organization.id));
}

const read = <T>(viewer: Viewer, fn: (tx: Tx, orgId: string) => Promise<T>) =>
  asViewer(viewer, ECONOMY_ROLES, fn);
const write = <T>(viewer: Viewer, fn: (tx: Tx, orgId: string) => Promise<T>) =>
  asViewer(viewer, OPERATOR_ROLES, fn);

function notFound(what: string): never {
  throw new ExpansionError(`${what} finns inte längre. Ladda om sidan.`);
}

// ---------------------------------------------------------------------------
// Platsattribut
// ---------------------------------------------------------------------------

export interface StoreProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly storeType: string | null;
  readonly city: string | null;
  readonly openHoursPerWeek: number | null;
  readonly areaSqm: number | null;
  readonly archived: boolean;
}

export function loadStoreProfilesFor(viewer: Viewer): Promise<StoreProfileRecord[]> {
  return read(viewer, async (tx, orgId) => {
    const rows = await tx
      .select({
        id: s.stores.id,
        name: s.stores.name,
        storeType: s.stores.storeType,
        city: s.stores.city,
        openHoursPerWeek: s.stores.openHoursPerWeek,
        areaSqm: s.stores.areaSqm,
        archivedAt: s.stores.archivedAt,
      })
      .from(s.stores)
      .where(eq(s.stores.organizationId, orgId))
      .orderBy(asc(s.stores.name), asc(s.stores.id));
    return rows.map(({ archivedAt, ...r }) => ({ ...r, archived: archivedAt !== null }));
  });
}

export function saveStoreProfileFor(viewer: Viewer, input: StoreProfileInput): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .update(s.stores)
      .set({
        storeType: input.storeType,
        city: input.city,
        openHoursPerWeek: input.openHoursPerWeek,
        areaSqm: input.areaSqm,
      })
      .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, input.storeId)))
      .returning({ id: s.stores.id });
    if (done.length === 0) notFound("Butiken");
  });
}

// ---------------------------------------------------------------------------
// Investeringar
// ---------------------------------------------------------------------------

export interface InvestmentRecord {
  readonly id: string;
  readonly machineId: string;
  readonly kind: "purchase" | "installation" | "other";
  readonly amountOre: number;
  readonly investedOn: string;
  readonly depreciationMonths: number | null;
  readonly note: string | null;
}

export function loadInvestmentsFor(viewer: Viewer): Promise<InvestmentRecord[]> {
  return read(viewer, (tx, orgId) =>
    tx
      .select({
        id: s.machineInvestments.id,
        machineId: s.machineInvestments.machineId,
        kind: s.machineInvestments.kind,
        amountOre: s.machineInvestments.amountOre,
        investedOn: s.machineInvestments.investedOn,
        depreciationMonths: s.machineInvestments.depreciationMonths,
        note: s.machineInvestments.note,
      })
      .from(s.machineInvestments)
      .where(eq(s.machineInvestments.organizationId, orgId))
      .orderBy(asc(s.machineInvestments.investedOn), asc(s.machineInvestments.id)),
  );
}

/** Ny investering, eller ändring av en befintlig (`id`). Investeringar raderas aldrig. */
export function saveInvestmentFor(viewer: Viewer, input: InvestmentInput): Promise<string> {
  return write(viewer, async (tx, orgId) => {
    const values = {
      machineId: input.machineId,
      kind: input.kind,
      amountOre: input.amountOre,
      investedOn: input.investedOn,
      depreciationMonths: input.depreciationMonths,
      note: input.note,
    };
    if (input.id) {
      const done = await tx
        .update(s.machineInvestments)
        .set(values)
        .where(
          and(
            eq(s.machineInvestments.organizationId, orgId),
            eq(s.machineInvestments.id, input.id),
          ),
        )
        .returning({ id: s.machineInvestments.id });
      if (done.length === 0) notFound("Investeringen");
      return input.id;
    }
    const [row] = await tx
      .insert(s.machineInvestments)
      .values({ ...values, organizationId: orgId })
      .returning({ id: s.machineInvestments.id });
    return row!.id;
  });
}

// ---------------------------------------------------------------------------
// Mål
// ---------------------------------------------------------------------------

export interface GoalRecord {
  readonly id: string;
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  readonly metric: "revenue" | "profit" | "active_machines";
  readonly scope: "organization" | "store" | "machine";
  readonly storeId: string | null;
  readonly machineId: string | null;
  readonly target: number;
}

export function loadGoalsFor(viewer: Viewer): Promise<GoalRecord[]> {
  return read(viewer, async (tx, orgId) => {
    const rows = await tx
      .select({
        id: s.goals.id,
        month: s.goals.month,
        metric: s.goals.metric,
        scope: s.goals.scope,
        storeId: s.goals.storeId,
        machineId: s.goals.machineId,
        target: s.goals.target,
      })
      .from(s.goals)
      .where(eq(s.goals.organizationId, orgId))
      .orderBy(asc(s.goals.month), asc(s.goals.metric), asc(s.goals.id));
    return rows.map((r) => ({ ...r, month: r.month.slice(0, 7) }));
  });
}

export function saveGoalFor(viewer: Viewer, input: GoalInput): Promise<string> {
  return write(viewer, async (tx, orgId) => {
    const values = {
      month: `${input.month}-01`,
      metric: input.metric,
      scope: input.scope,
      storeId: input.storeId,
      machineId: input.machineId,
      target: input.target,
    };
    if (input.id) {
      const done = await tx
        .update(s.goals)
        .set(values)
        .where(and(eq(s.goals.organizationId, orgId), eq(s.goals.id, input.id)))
        .returning({ id: s.goals.id });
      if (done.length === 0) notFound("Målet");
      return input.id;
    }
    const [row] = await tx
      .insert(s.goals)
      .values({ ...values, organizationId: orgId })
      .returning({ id: s.goals.id });
    return row!.id;
  });
}

export function deleteGoalFor(viewer: Viewer, id: string): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .delete(s.goals)
      .where(and(eq(s.goals.organizationId, orgId), eq(s.goals.id, id)))
      .returning({ id: s.goals.id });
    if (done.length === 0) notFound("Målet");
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function loadLeadsFor(viewer: Viewer): Promise<LeadRecord[]> {
  return read(viewer, async (tx, orgId) => {
    const rows = await tx
      .select()
      .from(s.expansionLeads)
      .where(eq(s.expansionLeads.organizationId, orgId))
      .orderBy(asc(s.expansionLeads.name), asc(s.expansionLeads.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage,
      stageChangedAt: r.stageChangedAt.toISOString(),
      storeType: r.storeType,
      city: r.city,
      openHoursPerWeek: r.openHoursPerWeek,
      areaSqm: r.areaSqm,
      address: r.address,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      notes: r.notes,
      nextStep: r.nextStep,
      nextStepOn: r.nextStepOn,
      commissionBp: r.commissionBp,
      monthlyRentOre: r.monthlyRentOre,
      purchaseOre: r.purchaseOre,
      installationOre: r.installationOre,
      storeId: r.storeId,
      archived: r.archivedAt !== null,
    }));
  });
}

export function saveLeadFor(viewer: Viewer, input: LeadInput): Promise<string> {
  return write(viewer, async (tx, orgId) => {
    const { id, ...values } = input;
    if (id) {
      const done = await tx
        .update(s.expansionLeads)
        .set(values)
        .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, id)))
        .returning({ id: s.expansionLeads.id });
      if (done.length === 0) notFound("Platsen");
      return id;
    }
    const [row] = await tx
      .insert(s.expansionLeads)
      .values({ ...values, organizationId: orgId })
      .returning({ id: s.expansionLeads.id });
    return row!.id;
  });
}

export function setLeadStageFor(
  viewer: Viewer,
  input: { id: string; stage: LeadStageKey },
): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .update(s.expansionLeads)
      .set({ stage: input.stage })
      .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, input.id)))
      .returning({ id: s.expansionLeads.id });
    if (done.length === 0) notFound("Platsen");
  });
}

export function deleteLeadFor(viewer: Viewer, id: string): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .delete(s.expansionLeads)
      .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, id)))
      .returning({ id: s.expansionLeads.id });
    if (done.length === 0) notFound("Platsen");
  });
}

// ---------------------------------------------------------------------------
// Effekt: utgångsläge, mätvärden och inställningar
// ---------------------------------------------------------------------------

export interface BaselineRecord {
  readonly id: string;
  readonly metric: BaselineInput["metric"];
  readonly scope: "organization" | "store" | "machine";
  readonly storeId: string | null;
  readonly machineId: string | null;
  readonly value: number;
  readonly unit: "ore" | "days" | "minutes" | "count";
  readonly measuredFrom: string | null;
  readonly measuredTo: string | null;
  readonly source: string | null;
}

export function loadBaselinesFor(viewer: Viewer): Promise<BaselineRecord[]> {
  return read(viewer, (tx, orgId) =>
    tx
      .select({
        id: s.baselines.id,
        metric: s.baselines.metric,
        scope: s.baselines.scope,
        storeId: s.baselines.storeId,
        machineId: s.baselines.machineId,
        value: s.baselines.value,
        unit: s.baselines.unit,
        measuredFrom: s.baselines.measuredFrom,
        measuredTo: s.baselines.measuredTo,
        source: s.baselines.source,
      })
      .from(s.baselines)
      .where(eq(s.baselines.organizationId, orgId))
      .orderBy(asc(s.baselines.metric), asc(s.baselines.scope), asc(s.baselines.id)),
  );
}

export function saveBaselineFor(viewer: Viewer, input: BaselineInput): Promise<string> {
  return write(viewer, async (tx, orgId) => {
    const values = {
      metric: input.metric,
      scope: input.scope,
      storeId: input.storeId,
      machineId: input.machineId,
      value: input.value,
      unit: input.unit,
      measuredFrom: input.measuredFrom,
      measuredTo: input.measuredTo,
      source: input.source,
    };
    if (input.id) {
      const done = await tx
        .update(s.baselines)
        .set(values)
        .where(and(eq(s.baselines.organizationId, orgId), eq(s.baselines.id, input.id)))
        .returning({ id: s.baselines.id });
      if (done.length === 0) notFound("Utgångsläget");
      return input.id;
    }
    const [row] = await tx
      .insert(s.baselines)
      .values({ ...values, organizationId: orgId })
      .returning({ id: s.baselines.id });
    return row!.id;
  });
}

export function deleteBaselineFor(viewer: Viewer, id: string): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .delete(s.baselines)
      .where(and(eq(s.baselines.organizationId, orgId), eq(s.baselines.id, id)))
      .returning({ id: s.baselines.id });
    if (done.length === 0) notFound("Utgångsläget");
  });
}

export interface MeasurementRecord {
  readonly id: string;
  readonly metric: MeasurementInput["metric"];
  readonly scope: "organization" | "store" | "machine";
  readonly storeId: string | null;
  readonly machineId: string | null;
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  readonly value: number;
  readonly note: string | null;
}

export function loadMeasurementsFor(viewer: Viewer): Promise<MeasurementRecord[]> {
  return read(viewer, async (tx, orgId) => {
    const rows = await tx
      .select({
        id: s.effectMeasurements.id,
        metric: s.effectMeasurements.metric,
        scope: s.effectMeasurements.scope,
        storeId: s.effectMeasurements.storeId,
        machineId: s.effectMeasurements.machineId,
        month: s.effectMeasurements.month,
        value: s.effectMeasurements.value,
        note: s.effectMeasurements.note,
      })
      .from(s.effectMeasurements)
      .where(eq(s.effectMeasurements.organizationId, orgId))
      .orderBy(asc(s.effectMeasurements.month), asc(s.effectMeasurements.metric));
    return rows
      .filter(
        (r): r is typeof r & { metric: MeasurementInput["metric"] } =>
          r.metric !== "profit_per_machine_month",
      )
      .map((r) => ({ ...r, month: r.month.slice(0, 7) }));
  });
}

export function saveMeasurementFor(viewer: Viewer, input: MeasurementInput): Promise<string> {
  return write(viewer, async (tx, orgId) => {
    const values = {
      metric: input.metric,
      scope: input.scope,
      storeId: input.storeId,
      machineId: input.machineId,
      month: `${input.month}-01`,
      value: input.value,
      note: input.note,
    };
    if (input.id) {
      const done = await tx
        .update(s.effectMeasurements)
        .set(values)
        .where(
          and(
            eq(s.effectMeasurements.organizationId, orgId),
            eq(s.effectMeasurements.id, input.id),
          ),
        )
        .returning({ id: s.effectMeasurements.id });
      if (done.length === 0) notFound("Mätvärdet");
      return input.id;
    }
    const [row] = await tx
      .insert(s.effectMeasurements)
      .values({ ...values, organizationId: orgId })
      .returning({ id: s.effectMeasurements.id });
    return row!.id;
  });
}

export function deleteMeasurementFor(viewer: Viewer, id: string): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    const done = await tx
      .delete(s.effectMeasurements)
      .where(and(eq(s.effectMeasurements.organizationId, orgId), eq(s.effectMeasurements.id, id)))
      .returning({ id: s.effectMeasurements.id });
    if (done.length === 0) notFound("Mätvärdet");
  });
}

export interface EffectSettingsRecord {
  readonly hourlyCostOre: number | null;
  readonly stockoutDayValueOre: number | null;
}

export function loadEffectSettingsFor(viewer: Viewer): Promise<EffectSettingsRecord> {
  return read(viewer, async (tx, orgId) => {
    const [row] = await tx
      .select({
        hourlyCostOre: s.effectSettings.hourlyCostOre,
        stockoutDayValueOre: s.effectSettings.stockoutDayValueOre,
      })
      .from(s.effectSettings)
      .where(eq(s.effectSettings.organizationId, orgId));
    return row ?? { hourlyCostOre: null, stockoutDayValueOre: null };
  });
}

export function saveEffectSettingsFor(viewer: Viewer, input: EffectSettingsInput): Promise<void> {
  return write(viewer, async (tx, orgId) => {
    await tx
      .insert(s.effectSettings)
      .values({ organizationId: orgId, ...input })
      .onConflictDoUpdate({ target: s.effectSettings.organizationId, set: { ...input } });
  });
}

export { AuthorizationError };
