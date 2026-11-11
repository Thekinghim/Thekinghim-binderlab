"use server";

/**
 * Server action för inventeringen: spara alla räknade antal i ett eget lager i en
 * transaktion. Tunt omslag kring ./_lib/service: indata valideras med zod, rollen
 * kontrolleras här och i tjänsten mot databasen (ägare, admin), och allt skrivs som
 * användaren genom public.save_stock_count. Efteråt räknas sidorna om.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";

import { LagerError } from "../../lager/_lib/register";
import { currentViewer } from "../../lager/_lib/session";
import { EDIT_ROLES } from "../_lib/data";
import { saveStockCountFor, stockCountSchema, type StockCountResult } from "./_lib/service";

export type StockCountActionResult =
  | { ok: true; data: StockCountResult; error?: undefined }
  | { ok: false; error: string; data?: undefined };

/** Spara inventeringen (ägare, admin). */
export async function saveStockCount(raw: unknown): Promise<StockCountActionResult> {
  try {
    await requireContextRole(EDIT_ROLES);
    const data = await saveStockCountFor(await currentViewer(), stockCountSchema.parse(raw));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ZodError) {
      return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
    }
    if (error instanceof LagerError || error instanceof AuthorizationError) {
      return { ok: false, error: error.message };
    }
    console.error("[inventering]", error);
    return { ok: false, error: dbErrorMessage(error) };
  }
}
