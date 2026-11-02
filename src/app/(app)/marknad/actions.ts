"use server";

/**
 * Server actions för Marknad. Tunna omslag kring src/server/market/service: indata
 * valideras här (zod), rollen kontrolleras både här (requireContextRole) och i tjänsten
 * mot databasen, och allt läses och skrivs som användaren med RLS.
 *
 * Alla returnerar { ok, data } eller { ok: false, error } med ett svenskt meddelande.
 * Ändringar räknar om alla sidor (revalidateAppData) sist.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { DomainError } from "@/domain";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";
import { currentMarketViewer } from "@/server/market";
import {
  createReleaseSchema,
  createQuoteSchema,
  idSchema,
  implementAssortmentSchema,
  releaseIdSchema,
  saveSlotsSchema,
  startExperimentSchema,
  updateReleaseSchema,
} from "@/server/market/schemas";
import {
  createQuoteFor,
  createReleaseFor,
  deleteQuoteFor,
  deleteReleaseFor,
  implementAssortmentFor,
  lockReleasePlanFor,
  MarketError,
  saveSlotsFor,
  startExperimentFor,
  stopExperimentFor,
  unlockReleasePlanFor,
  updateReleaseFor,
} from "@/server/market/service";

import type { ActionResult } from "./_lib/types";

function failure(error: unknown): { ok: false; error: string } {
  // redirect() (utloggad) och andra Next-signaler ska inte bli felmeddelanden.
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof MarketError ||
    error instanceof AuthorizationError ||
    error instanceof DomainError
  ) {
    return { ok: false, error: error.message };
  }
  console.error("[marknad]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentMarketViewer();
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function createRelease(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const viewer = await operator();
    const id = await createReleaseFor(viewer, createReleaseSchema.parse(raw));
    return { id };
  });
}

export async function updateRelease(raw: unknown): Promise<ActionResult> {
  return run(async () => {
    const viewer = await operator();
    await updateReleaseFor(viewer, updateReleaseSchema.parse(raw));
  });
}

export async function deleteRelease(raw: unknown): Promise<ActionResult> {
  return run(async () => {
    const viewer = await operator();
    await deleteReleaseFor(viewer, idSchema.parse(raw).id);
  });
}

export async function lockReleasePlan(
  raw: unknown,
): Promise<ActionResult<{ purchaseUnits: number; machines: number }>> {
  return run(async () => {
    const viewer = await operator();
    return lockReleasePlanFor(viewer, releaseIdSchema.parse(raw).releaseId);
  });
}

export async function unlockReleasePlan(raw: unknown): Promise<ActionResult> {
  return run(async () => {
    const viewer = await operator();
    await unlockReleasePlanFor(viewer, releaseIdSchema.parse(raw).releaseId);
  });
}

export async function createQuote(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const viewer = await operator();
    const id = await createQuoteFor(viewer, createQuoteSchema.parse(raw));
    return { id };
  });
}

export async function deleteQuote(raw: unknown): Promise<ActionResult> {
  return run(async () => {
    const viewer = await operator();
    await deleteQuoteFor(viewer, idSchema.parse(raw).id);
  });
}

export async function saveSlots(raw: unknown): Promise<ActionResult> {
  return run(async () => {
    const viewer = await operator();
    await saveSlotsFor(viewer, saveSlotsSchema.parse(raw));
  });
}

export async function implementAssortment(
  raw: unknown,
): Promise<ActionResult<{ id: string; effectPerWeekOre: number }>> {
  return run(async () => {
    const viewer = await operator();
    return implementAssortmentFor(viewer, implementAssortmentSchema.parse(raw));
  });
}

export async function startExperiment(
  raw: unknown,
): Promise<ActionResult<{ id: string; startedOn: string }>> {
  return run(async () => {
    const viewer = await operator();
    return startExperimentFor(viewer, startExperimentSchema.parse(raw));
  });
}

export async function stopExperiment(raw: unknown): Promise<ActionResult<"deleted" | "stopped">> {
  return run(async () => {
    const viewer = await operator();
    return stopExperimentFor(viewer, idSchema.parse(raw).id);
  });
}
