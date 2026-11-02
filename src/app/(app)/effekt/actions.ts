"use server";

/**
 * Server actions för Effekt: utgångsläget (baselines), mätvärden per månad och
 * timkostnaden. Bara ägare och admin; allt skrivs som användaren med RLS.
 */

import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";

import { failure, type ActionResult } from "../expansion/_lib/action-result";
import {
  baselineSchema,
  effectSettingsSchema,
  idSchema,
  measurementSchema,
} from "../expansion/_lib/schemas";
import {
  deleteBaselineFor,
  deleteMeasurementFor,
  saveBaselineFor,
  saveEffectSettingsFor,
  saveMeasurementFor,
} from "../expansion/_lib/service";
import { currentViewer } from "../expansion/_lib/session";

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

export async function saveBaseline(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const id = await saveBaselineFor(await operator(), baselineSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "effekt");
  }
}

export async function deleteBaseline(raw: unknown): Promise<ActionResult> {
  try {
    await deleteBaselineFor(await operator(), idSchema.parse(raw).id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "effekt");
  }
}

export async function saveMeasurement(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const id = await saveMeasurementFor(await operator(), measurementSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "effekt");
  }
}

export async function deleteMeasurement(raw: unknown): Promise<ActionResult> {
  try {
    await deleteMeasurementFor(await operator(), idSchema.parse(raw).id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "effekt");
  }
}

export async function saveEffectSettings(raw: unknown): Promise<ActionResult> {
  try {
    await saveEffectSettingsFor(await operator(), effectSettingsSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "effekt");
  }
}
