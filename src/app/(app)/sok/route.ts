/**
 * GET /sok?q=…                         Kommandopalettens sökning: order (ordernummer,
 *                                      titel), titlar, automater och butiker.
 * GET /sok?lista=pafyllning&automat=…  Titlar för påfyllning i automaten (antal pack).
 * GET /sok?lista=inkopspris            Titlar för nytt inköpspris (de utan pris först).
 *
 * Svaret är JSON och filtrerat på rollen (src/server/search): påfyllaren får inga order
 * och inga belopp. Allt läses som användaren med RLS. 401 utan session, 403 utan
 * behörighet, 400 vid ogiltiga parametrar. Klienten avbryter förfrågningar som hunnit
 * bli inaktuella (AbortController), så svaren cachas aldrig.
 */

import type { NextRequest } from "next/server";

import { isUuid } from "@/server/access";
import { pickList, search } from "@/server/search";
import { AuthorizationError } from "@/server/session";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" };

export async function GET(request: NextRequest): Promise<Response> {
  const sp = request.nextUrl.searchParams;
  try {
    const list = sp.get("lista");
    if (list !== null) {
      if (list === "inkopspris")
        return Response.json(await pickList(list, null), { headers: HEADERS });
      const machine = sp.get("automat");
      if (list === "pafyllning" && isUuid(machine)) {
        return Response.json(await pickList(list, machine.toLowerCase()), { headers: HEADERS });
      }
      return Response.json({ error: "Okänd lista." }, { status: 400, headers: HEADERS });
    }
    return Response.json(await search(sp.get("q") ?? ""), { headers: HEADERS });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      const status = error.reason === "unauthenticated" ? 401 : 403;
      return Response.json({ error: error.message }, { status, headers: HEADERS });
    }
    console.error("[sok] sökningen misslyckades", error);
    return Response.json({ error: "Sökningen misslyckades." }, { status: 500, headers: HEADERS });
  }
}
