"use server";

/**
 * Server actions för Lager: registrera påfyllning och inventering. Tunna omslag kring
 * ./_lib/register: indata valideras här (zod), rollen kontrolleras både här
 * (requireContextRole) och i tjänsten mot databasen, och allt skrivs som användaren
 * med RLS. Efter en lyckad registrering räknas alla sidor om (Hem, Att göra, Lager,
 * Lönsamhet …) med revalidateAppData, sist.
 *
 * Svaret innehåller bara antal (saldo före och efter), aldrig belopp.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";

import { REGISTER_ROLES } from "./_lib/data";
import { currentViewer } from "./_lib/session";
import {
  LagerError,
  registerCountFor,
  registerRefillFor,
  type RegisterResult,
} from "./_lib/register";
import { countSchema, refillSchema } from "./_lib/schemas";

export type LagerActionResult =
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
  console.error("[lager]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function registrar() {
  await requireContextRole(REGISTER_ROLES);
  return currentViewer();
}

/** Påfyllning i en automat. Drar samma antal ur centrallagret om fromWarehouse. */
export async function registerRefill(raw: unknown): Promise<LagerActionResult> {
  try {
    const viewer = await registrar();
    const input = refillSchema.parse(raw);
    const data = await registerRefillFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Inventering i en automat eller i centrallagret. */
export async function registerCount(raw: unknown): Promise<LagerActionResult> {
  try {
    const viewer = await registrar();
    const input = countSchema.parse(raw);
    const data = await registerCountFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
