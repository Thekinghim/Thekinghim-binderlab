"use server";

/**
 * Server actions för Fyll på.
 *
 * - refreshFill: Uppdatera-knappen. Läser automaternas fack i Awish nu (bara facken,
 *   spärrat per organisation, kort tidsgräns) för ägare, admin och påfyllare. Sidan hämtar
 *   sedan om datan (router.refresh i webbläsaren).
 */

import { unstable_rethrow } from "next/navigation";

import { AuthorizationError } from "@/server/access";
import { refreshFillStockFor, type FillRefreshResult } from "@/server/awish/fill-read";
import { requireContextRole, revalidateAppData } from "@/server/data/core";
import { FIELD_REFILL_ROLES } from "@/server/data/field-refills";
import { safeErrorForLog } from "@/server/errors";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

export async function refreshFill(): Promise<
  { ok: true; data: FillRefreshResult } | { ok: false; error: string }
> {
  await requireContextRole(FIELD_REFILL_ROLES);
  try {
    const data = await refreshFillStockFor(await currentViewer());
    // Nya antal i automaterna syns överallt (Lager, Drift, Att göra), inte bara här.
    if (data.status === "read" || data.status === "partial") revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) throw error;
    console.error("[fyll-pa] uppdatera", safeErrorForLog(error));
    return { ok: false, error: "Kunde inte nå Awish." };
  }
}
