"use server";

/**
 * Server actions för Vårt lager: antal (inventering) per lager, inköp, flytt mellan lager
 * (med Ångra) och lagren själva (nytt, byt namn, ta bort med Ångra). Tunna omslag kring
 * ./_lib/register: indata valideras med zod, rollen kontrolleras här och i tjänsten mot
 * databasen (ägare, admin), och allt skrivs som användaren med RLS. Efter en lyckad
 * registrering räknas sidorna om (revalidateAppData).
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

import type { PriceDoubtResult } from "../inkopspriser/_lib/price-check";
import { LagerError, type RegisterResult } from "../lager/_lib/register";
import { currentViewer } from "../lager/_lib/session";
import { EDIT_ROLES } from "./_lib/data";
import {
  archivePlaceFor,
  archivePlaceSchema,
  createPlaceFor,
  createPlaceSchema,
  homeCountSchema,
  moveSchema,
  moveStockFor,
  receiptSchema,
  registerReceiptWithPriceFor,
  renamePlaceFor,
  renamePlaceSchema,
  setHomeCountFor,
  setRefillSourceFor,
  undoMoveFor,
  undoMoveSchema,
  type MoveResult,
  type ReceiptResult,
} from "./_lib/register";

export type ActionResult<T> =
  { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined };

export type VartLagerActionResult = ActionResult<RegisterResult>;

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

/** Antal i ett lager för en titel. */
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

/**
 * Inköp: pack som kom till ett lager, och (om det skickas med) vad ett pack kostade. Ett
 * annat pris än dagens sparas som nytt inköpspris från i dag. Ser priset konstigt ut sparas
 * ingenting förrän användaren bekräftat (svaret har då `doubt`).
 */
export async function addReceipt(
  raw: unknown,
): Promise<ActionResult<ReceiptResult> | PriceDoubtResult> {
  try {
    await requireContextRole(EDIT_ROLES);
    const viewer = await currentViewer();
    const data = await registerReceiptWithPriceFor(viewer, receiptSchema.parse(raw));
    if ("doubt" in data) return data;
    // Ett nytt pris ändrar vinsten: samma omräkning som Inköpspriser gör.
    if (data.price.status === "saved") await revalidateSettlementData();
    else revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireContextRole(EDIT_ROLES);
    const data = await fn();
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Flytta pack mellan två egna lager. */
export async function moveStock(raw: unknown): Promise<ActionResult<MoveResult>> {
  return run(async () => moveStockFor(await currentViewer(), moveSchema.parse(raw)));
}

/** Ångra en flytt. */
export async function undoMove(raw: unknown): Promise<ActionResult<MoveResult>> {
  return run(async () => undoMoveFor(await currentViewer(), undoMoveSchema.parse(raw)));
}

/** Nytt eget lager. */
export async function createPlace(
  raw: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return run(async () => createPlaceFor(await currentViewer(), createPlaceSchema.parse(raw)));
}

/** Byt namn på ett eget lager. */
export async function renamePlace(
  raw: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return run(async () => renamePlaceFor(await currentViewer(), renamePlaceSchema.parse(raw)));
}

/** Ta bort (arkivera) ett tomt lager, eller ta tillbaka det (Ångra). */
export async function archivePlace(
  raw: unknown,
): Promise<ActionResult<{ id: string; name: string; archived: boolean }>> {
  return run(async () => archivePlaceFor(await currentViewer(), archivePlaceSchema.parse(raw)));
}

/** Automatens "Fylls på från" (null = standardlagret). Visas på automatens sida. */
export async function setRefillSource(raw: {
  machineId: string;
  placeId: string | null;
}): Promise<ActionResult<{ placeId: string | null; name: string | null }>> {
  return run(async () => setRefillSourceFor(await currentViewer(), raw));
}
