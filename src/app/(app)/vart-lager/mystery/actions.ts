"use server";

/**
 * Server actions för Mystery packs: spara innehållet, packa, ångra, "Sätt inköpspris" och
 * "Uppdatera priset från i dag" / "Rätta priset" efter kalkylen.
 * Tunna omslag kring ./_lib/service: indata valideras med zod, rollen kontrolleras här och
 * i tjänsten mot databasen, och allt skrivs som användaren genom RPC:erna. Efter en lyckad
 * ändring räknas sidorna om (revalidateAppData).
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import {
  requireContextRole,
  revalidateAppData,
  revalidateSettlementData,
} from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";

import { currentViewer } from "../../lager/_lib/session";
import { PACK_ROLES, RECIPE_ROLES } from "./_lib/data";
import {
  MysteryError,
  packFor,
  packSchema,
  recipeSchema,
  saveRecipeFor,
  setCostSchema,
  setMysteryCostFor,
  undoPackFor,
  undoPackSchema,
  updateCostSchema,
  updateMysteryCostFor,
  type PackResult,
  type UpdateCostResult,
} from "./_lib/service";

export type MysteryActionResult<T> =
  { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof MysteryError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[mystery]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

/** Spara innehållet (ägare, admin): en ny version från i dag. */
export async function saveMysteryRecipe(
  raw: unknown,
): Promise<MysteryActionResult<{ recipeId: string }>> {
  try {
    await requireContextRole(RECIPE_ROLES);
    const data = await saveRecipeFor(await currentViewer(), recipeSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Packa N omgångar (ägare, admin, påfyllare). */
export async function packMystery(raw: unknown): Promise<MysteryActionResult<PackResult>> {
  try {
    await requireContextRole(PACK_ROLES);
    const data = await packFor(await currentViewer(), packSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Ångra en packning inom 30 minuter. */
export async function undoMysteryPack(
  raw: unknown,
): Promise<MysteryActionResult<{ packingId: string }>> {
  try {
    await requireContextRole(PACK_ROLES);
    const data = await undoPackFor(await currentViewer(), undoPackSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** "Sätt inköpspris till X kr" (ägare, admin): ett inköpspris från i dag. */
export async function setMysteryCost(
  raw: unknown,
): Promise<MysteryActionResult<{ unitCostOre: number; validFrom: string }>> {
  try {
    await requireContextRole(RECIPE_ROLES);
    const data = await setMysteryCostFor(await currentViewer(), setCostSchema.parse(raw));
    await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/**
 * "Uppdatera priset från i dag" eller "Rätta priset" (ägare, admin): mystery-packets
 * inköpspris blir kalkylen, räknad på servern. Sålda pack behåller sitt pris om inte
 * "Rätta priset" väljs.
 */
export async function updateMysteryCost(
  raw: unknown,
): Promise<MysteryActionResult<UpdateCostResult>> {
  try {
    await requireContextRole(RECIPE_ROLES);
    const data = await updateMysteryCostFor(await currentViewer(), updateCostSchema.parse(raw));
    await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
