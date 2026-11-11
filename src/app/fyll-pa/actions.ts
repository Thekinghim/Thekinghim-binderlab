"use server";

/**
 * Server actions för Fyll på.
 *
 * - refreshFill: Uppdatera-knappen. Läser automaternas fack i Awish nu (bara facken,
 *   spärrat per organisation, kort tidsgräns) för ägare, admin och påfyllare. Sidan hämtar
 *   sedan om datan (router.refresh i webbläsaren).
 * - retryAwishPush: "Försök igen" på en automat vars sändning till Awish inte gick fram
 *   (och det automatiska försöket när Fyll på öppnas). Skickar automatens antal en gång
 *   till. Ägare, admin och påfyllare.
 */

import { unstable_rethrow } from "next/navigation";

import { AuthorizationError } from "@/server/access";
import { refreshFillStockFor, type FillRefreshResult } from "@/server/awish/fill-read";
import { retryAwishPushFor, type AwishRetryStatus } from "@/server/awish/push-retry";
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

/**
 * Försök igen: skickar antalen till Awish för automaten (eller alla som väntar när
 * `machineId` utelämnas). Svarar med beskedet och vilka automater som fortfarande väntar.
 */
export async function retryAwishPush(
  raw: unknown,
): Promise<{ ok: true; data: AwishRetryStatus } | { ok: false; error: string }> {
  await requireContextRole(FIELD_REFILL_ROLES);
  try {
    const data = await retryAwishPushFor(await currentViewer(), raw);
    // Raden på automaten (och saldot efter nästa läsning) ändras: hämta om överallt.
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) throw error;
    console.error("[fyll-pa] försök igen", safeErrorForLog(error));
    return { ok: false, error: "Kunde inte skicka till Awish just nu." };
  }
}
