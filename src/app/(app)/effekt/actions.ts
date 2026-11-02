"use server";

/**
 * Server actions för Effekt: utgångsläget (baselines), mätvärden per månad och
 * timkostnaden. Bara ägare och admin; allt skrivs som användaren med RLS.
 */

import type { IsoMonth } from "@/domain";
import {
  loadMasterData,
  OPERATOR_ROLES,
  requireContextRole,
  revalidateAppData,
} from "@/server/data/core";

import { failure, type ActionResult } from "../expansion/_lib/action-result";
import { machinesInScope } from "../expansion/_lib/model";
import {
  assertMetricLimit,
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

/**
 * Stoppar orimliga mätvärden vid fältet (fler slutsålda dagar än månaden har per automat,
 * mer tid än dygnets timmar per automat). Automaterna i omfattningen läses med RLS.
 */
async function checkLimit(v: {
  metric: Parameters<typeof assertMetricLimit>[0];
  value: number;
  month: string | null;
  scope: "organization" | "store" | "machine";
  storeId: string | null;
}) {
  if (v.metric === "profit_per_machine_month") return;
  const master = await loadMasterData();
  const machines = machinesInScope(master, v.scope, v.storeId, v.month as IsoMonth | null);
  assertMetricLimit(v.metric, v.value, v.month, machines);
}

export async function saveBaseline(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = baselineSchema.parse(raw);
    await checkLimit({ ...input, month: null });
    const id = await saveBaselineFor(viewer, input);
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
    const viewer = await operator();
    const input = measurementSchema.parse(raw);
    await checkLimit(input);
    const id = await saveMeasurementFor(viewer, input);
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
