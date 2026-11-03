"use server";

/**
 * Server actions för Kampanjer och Gratis-pack. Tunna omslag: indata valideras med zod,
 * rollen kontrolleras här (requireContextRole) och i tjänsten mot databasen. Varje
 * skrivning till Awish kommer från en knapp som användaren har bekräftat i en dialog.
 */

import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { AwishApiError } from "@/server/awish/grpc-client";
import { AwishNotConnectedError } from "@/server/awish/marketing";
import {
  CAMPAIGN_IMAGE_MAX_BYTES,
  CampaignError,
  campaignInputSchema,
} from "@/server/campaigns/model";
import {
  createCampaignFor,
  retryCampaignFor,
  stopCampaignFor,
  type CreatedCampaign,
} from "@/server/campaigns/service";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateAppData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import { FreePackError, freePackInputSchema } from "@/server/free-packs/model";
import {
  createFreePacksFor,
  freePackChoicesFor,
  type CreatedFreePacks,
  type FreePackChoice,
} from "@/server/free-packs/service";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof CampaignError ||
    error instanceof FreePackError ||
    error instanceof AwishApiError ||
    error instanceof AwishNotConnectedError ||
    error instanceof AuthorizationError
  ) {
    return { ok: false, error: error.message };
  }
  console.error("[kampanjer]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

const idSchema = z.string().uuid("Okänd kampanj.");

/**
 * Ny kampanj: FormData med `input` (JSON, campaignInputSchema) och `image` (fil), eller
 * `input.reuseImageFrom` för en bild som redan använts.
 */
export async function createCampaign(form: FormData): Promise<ActionResult<CreatedCampaign>> {
  try {
    const viewer = await operator();
    const raw = form.get("input");
    const input = campaignInputSchema.parse(JSON.parse(typeof raw === "string" ? raw : "{}"));
    let bytes: Uint8Array | null = null;
    if (!input.reuseImageFrom) {
      const file = form.get("image");
      if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Välj en bild." };
      if (file.size > CAMPAIGN_IMAGE_MAX_BYTES) {
        return { ok: false, error: "Bilden är för stor (högst 3 MB)." };
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    }
    const data = await createCampaignFor(viewer, input, bytes);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, error: "Ogiltiga uppgifter." };
    return failure(error);
  }
}

export async function stopCampaign(
  id: unknown,
): Promise<ActionResult<{ stopped: number; failed: number }>> {
  try {
    const viewer = await operator();
    const data = await stopCampaignFor(viewer, idSchema.parse(id));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function retryCampaign(
  id: unknown,
): Promise<ActionResult<{ shown: number; failed: number }>> {
  try {
    const viewer = await operator();
    const data = await retryCampaignFor(viewer, idSchema.parse(id));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Automatens titlar (läses i Awish nu). Ingen skrivning. */
export async function loadFreePackChoices(
  machineId: unknown,
): Promise<ActionResult<FreePackChoice[]>> {
  try {
    const viewer = await operator();
    const id = z.string().uuid("Välj automat.").parse(machineId);
    return { ok: true, data: await freePackChoicesFor(viewer, id) };
  } catch (error) {
    return failure(error);
  }
}

export async function createFreePacks(raw: unknown): Promise<ActionResult<CreatedFreePacks>> {
  try {
    const viewer = await operator();
    const input = freePackInputSchema.parse(raw);
    const data = await createFreePacksFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    // Ett misslyckat försök finns i listan: räkna om sidan även då.
    if (error instanceof FreePackError) revalidateAppData();
    return failure(error);
  }
}
