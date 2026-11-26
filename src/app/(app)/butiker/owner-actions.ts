"use server";

/**
 * Server actions för butiksägare (bolaget som äger butikerna). Tunna omslag som
 * ./actions: organisationen är den aktiva, rollen kontrolleras här och igen i
 * ./_lib/owner-service (ägare och admin), allt körs under RLS och triggarna loggar
 * ändringarna. Butikens ägare styr ägarfiltret i statistiken, så hela appen räknas om.
 */

import { unstable_rethrow } from "next/navigation";

import type { ActionResult } from "@/server/auth/flows";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import {
  createOwnerFor,
  setOwnerArchivedFor,
  setStoreOwnerFor,
  updateOwnerFor,
} from "./_lib/owner-service";
import { OWNER_MESSAGES } from "./_lib/owner-validation";
import type { Viewer } from "./_lib/service";
import { currentViewer } from "./_lib/session";

async function run<R extends { ok: boolean }>(
  fn: (viewer: Viewer) => Promise<R>,
): Promise<R | { ok: false; error: string }> {
  let viewer: Viewer;
  try {
    await requireContextRole(OPERATOR_ROLES);
    viewer = await currentViewer();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) return { ok: false, error: OWNER_MESSAGES.forbidden };
    throw error;
  }
  const result = await fn(viewer);
  if (result.ok) await revalidateAppData();
  return result;
}

/** Bolagets uppgifter som formuläret skickar dem (tolkas och kontrolleras i tjänsten). */
export interface OwnerFields {
  legalName: string;
  orgNumber: string;
  vatNumber?: string;
  fTax?: boolean;
  streetAddress?: string;
  postalCode?: string;
  city?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  invoiceEmail?: string;
  bankgiro?: string;
  note?: string;
}

/** Ny butiksägare. Med `storeId` blir den också butikens ägare. */
export async function createOwner(
  input: OwnerFields & { storeId?: string },
): Promise<ActionResult<{ id: string }>> {
  return run((v) => createOwnerFor(v, input));
}

/** Ändrar en butiksägares uppgifter. */
export async function updateOwner(input: OwnerFields & { ownerId: string }): Promise<ActionResult> {
  return run((v) => updateOwnerFor(v, input));
}

/** Arkiverar eller återställer en butiksägare. */
export async function setOwnerArchived(input: {
  ownerId: string;
  archived: boolean;
}): Promise<ActionResult> {
  return run((v) => setOwnerArchivedFor(v, input));
}

/** Väljer butikens ägare ("" = ingen). */
export async function setStoreOwner(input: {
  storeId: string;
  ownerId: string;
}): Promise<ActionResult> {
  return run((v) => setStoreOwnerFor(v, input));
}
