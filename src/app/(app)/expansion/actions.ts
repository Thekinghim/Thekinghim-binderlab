"use server";

/**
 * Server actions för Expansion: platsattribut, pipeline och mål. Indata kontrolleras här
 * (zod), rollen både här (requireContextRole) och i tjänsten mot databasen, och allt
 * skrivs som användaren med RLS. Ändringar räknar om sidorna (revalidateAppData) sist.
 */

import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";

import { failure, type ActionResult } from "./_lib/action-result";
import {
  goalSchema,
  growthPlanSchema,
  idSchema,
  leadArchiveSchema,
  leadSchema,
  leadStageSchema,
  storeProfileSchema,
} from "./_lib/schemas";
import {
  deleteGoalFor,
  deleteLeadFor,
  saveGoalFor,
  saveGrowthPlanFor,
  saveLeadFor,
  saveStoreProfileFor,
  setLeadArchivedFor,
  setLeadStageFor,
} from "./_lib/service";
import { currentViewer } from "./_lib/session";

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

export async function saveStoreProfile(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await saveStoreProfileFor(viewer, storeProfileSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function saveLead(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const id = await saveLeadFor(viewer, leadSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function setLeadStage(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await setLeadStageFor(viewer, leadStageSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function setLeadArchived(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await setLeadArchivedFor(viewer, leadArchiveSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function deleteLead(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await deleteLeadFor(viewer, idSchema.parse(raw).id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function saveGoal(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const id = await saveGoalFor(viewer, goalSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "expansion");
  }
}

export async function deleteGoal(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await deleteGoalFor(viewer, idSchema.parse(raw).id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}

/** Planen för fler automater: målet och förvalen (tomt fält = standard). */
export async function saveGrowthPlan(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    await saveGrowthPlanFor(viewer, growthPlanSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "expansion");
  }
}
