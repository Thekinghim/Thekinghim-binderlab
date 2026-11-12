"use server";

/**
 * Server actions för Fortnox (Datakällor → Fortnox och Ekonomi → Bokföring). Tunna omslag
 * kring src/server/fortnox/service.ts: rollen kontrolleras här (requireContextRole) och i
 * tjänsten mot databasen (ägare/admin, inte Enkel vy). Svarar { ok, data } eller
 * { ok: false, error } på svenska. Fel från Fortnox loggas aldrig med token.
 */

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import { FORTNOX_CALLBACK_PATH } from "@/server/fortnox/config";
import {
  disconnectFortnoxFor,
  FORTNOX_STATE_COOKIE,
  requestFortnoxReversalFor,
  runFortnoxNowFor,
  saveFortnoxSettingsFor,
  setFortnoxLiveFor,
  startFortnoxConnectFor,
  type FortnoxSettingsInput,
} from "@/server/fortnox/service";

export type FortnoxResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AccountingError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  // Bara felets namn och text: aldrig hela felet (det kan bära en fråga eller ett svar).
  console.error("[fortnox]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

/** Startar kopplingen: svarar med adressen hos Fortnox som webbläsaren ska gå till. */
export async function startFortnoxConnect(): Promise<FortnoxResult<{ url: string }>> {
  try {
    const viewer = await operator();
    const start = await startFortnoxConnectFor(viewer);
    (await cookies()).set(FORTNOX_STATE_COOKIE, start.cookie, {
      httpOnly: true,
      // Lax: kakan följer med när Fortnox skickar tillbaka webbläsaren (en vanlig länk).
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: FORTNOX_CALLBACK_PATH,
      maxAge: start.maxAgeSeconds,
    });
    return { ok: true, data: { url: start.url } };
  } catch (error) {
    return failure(error);
  }
}

export async function saveFortnoxSettings(raw: FortnoxSettingsInput): Promise<FortnoxResult> {
  try {
    await saveFortnoxSettingsFor(await operator(), raw);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function setFortnoxLive(raw: { live: boolean }): Promise<FortnoxResult> {
  try {
    const { live } = z.object({ live: z.boolean() }).parse(raw);
    await setFortnoxLiveFor(await operator(), live);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function runFortnoxNow(): Promise<FortnoxResult<{ message: string }>> {
  try {
    const r = await runFortnoxNowFor(await operator());
    revalidateAppData();
    const n = (count: number) => (count === 1 ? "1 verifikat" : `${count} verifikat`);
    const message =
      r.status === "dry_run"
        ? `Torrkörning: ${n(r.wouldSend)} skulle skickas. Inget skickades.`
        : r.status === "busy"
          ? "En körning pågår redan. Titta igen om en stund."
          : r.status === "needs_reconnect"
            ? "Fortnox behöver kopplas igen."
            : r.error
              ? r.error
              : r.blocked > 0
                ? `${n(r.sent + r.recovered)} bokförda. ${n(r.blocked)} stoppade, se listan.`
                : `${n(r.sent + r.recovered)} bokförda i Fortnox.`;
    return { ok: true, data: { message } };
  } catch (error) {
    return failure(error);
  }
}

export async function requestFortnoxReversal(raw: { id: string }): Promise<FortnoxResult> {
  try {
    const { id } = z.object({ id: z.uuid() }).parse(raw);
    await requestFortnoxReversalFor(await operator(), id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function disconnectFortnox(): Promise<FortnoxResult> {
  try {
    await disconnectFortnoxFor(await operator());
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
