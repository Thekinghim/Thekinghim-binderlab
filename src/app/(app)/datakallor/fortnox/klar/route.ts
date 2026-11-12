/**
 * GET /datakallor/fortnox/klar?code=…&state=… : hit skickar Fortnox tillbaka ägaren efter
 * godkännandet. Koden byts mot token (sparas i Vault) och ägaren skickas vidare till
 * Datakällor → Fortnox. Kakan med state och PKCE-nyckeln (satt av startFortnoxConnect) måste
 * följa med och höra till samma användare och organisation.
 *
 * Bara ägare och admin, inte Enkel vy (currentViewer spärrar Enkel vy, tjänsten läser rollen
 * ur databasen). Varken koden eller token skrivs i loggen eller i adressen vi skickar vidare till.
 */

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { revalidateAppData } from "@/server/data/core";
import { FORTNOX_CALLBACK_PATH } from "@/server/fortnox/config";
import { finishFortnoxConnectFor, FORTNOX_STATE_COOKIE } from "@/server/fortnox/service";

export const dynamic = "force-dynamic";

function back(request: NextRequest, params: Record<string, string>): Response {
  const url = new URL("/datakallor/fortnox", request.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 303,
    headers: { location: `${url.pathname}${url.search}`, "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const q = request.nextUrl.searchParams;
  const jar = await cookies();
  const cookie = jar.get(FORTNOX_STATE_COOKIE)?.value;
  jar.delete({ name: FORTNOX_STATE_COOKIE, path: FORTNOX_CALLBACK_PATH });
  try {
    const viewer = await currentViewer();
    const result = await finishFortnoxConnectFor(viewer, {
      code: q.get("code"),
      state: q.get("state"),
      error: q.get("error"),
      cookie,
    });
    revalidateAppData();
    return back(request, { kopplad: result.reconnected ? "igen" : "ja" });
  } catch (error) {
    if (error instanceof AccountingError || error instanceof AuthorizationError) {
      return back(request, { fel: error.message.slice(0, 200) });
    }
    console.error(
      "[fortnox] kopplingen misslyckades",
      error instanceof Error ? `${error.name}: ${error.message}` : "fel",
    );
    return back(request, { fel: "Kopplingen gick inte att slutföra. Försök igen." });
  }
}
