"use server";

/**
 * Server actions för Vårt lager: antal hemma (inventering) och inköp. Tunna omslag kring
 * ./_lib/register: indata valideras med zod, rollen kontrolleras här och i tjänsten mot
 * databasen (ägare, admin), och allt skrivs som användaren med RLS. Efter en lyckad
 * registrering räknas sidorna om (revalidateAppData).
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";

import { LagerError, type RegisterResult } from "../lager/_lib/register";
import { currentViewer } from "../lager/_lib/session";
import { EDIT_ROLES } from "./_lib/data";
import {
  homeCountSchema,
  receiptSchema,
  registerReceiptFor,
  setHomeCountFor,
} from "./_lib/register";

export type VartLagerActionResult =
  | { ok: true; data: RegisterResult; error?: undefined }
  | { ok: false; error: string; data?: undefined };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof LagerError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[vart-lager]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

/** Antal hemma för en titel. */
export async function setHomeCount(raw: unknown): Promise<VartLagerActionResult> {
  try {
    await requireContextRole(EDIT_ROLES);
    const viewer = await currentViewer();
    const data = await setHomeCountFor(viewer, homeCountSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Inköp: pack som kom hem. */
export async function addReceipt(raw: unknown): Promise<VartLagerActionResult> {
  try {
    await requireContextRole(EDIT_ROLES);
    const viewer = await currentViewer();
    const data = await registerReceiptFor(viewer, receiptSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
