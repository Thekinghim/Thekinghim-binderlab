/**
 * GET /sok?q=…                         Kommandopalettens sökning: order (ordernummer,
 *                                      titel), titlar, automater och butiker.
 * GET /sok?lista=pafyllning&automat=…  Titlar för påfyllning i automaten (antal pack).
 * GET /sok?lista=inkopspris            Titlar för nytt inköpspris (de utan pris först).
 *
 * Svaret är JSON och filtrerat på rollen (src/server/search): påfyllaren får inga order
 * och inga belopp. Allt läses som användaren med RLS. 401 utan session, 403 utan
 * behörighet, 400 vid ogiltiga parametrar, 429 vid för många sökningar. Klienten
 * avbryter förfrågningar som hunnit bli inaktuella (AbortController), så svaren cachas
 * aldrig.
 *
 * Gräns: SEARCHES_PER_MINUTE per användare (räknas per serverinstans). Paletten väntar
 * 140 ms mellan tangenttryck och återanvänder svar, så vanlig skrivning ligger långt
 * under; gränsen skyddar databasen mot skript.
 */

import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";

import { isUuid } from "@/server/access";
import { createRateLimiter } from "@/server/rate-limit";
import { pickList, search } from "@/server/search";
import { AuthorizationError, getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" };

/** Sökningar per användare och minut. */
const SEARCHES_PER_MINUTE = 240;
const limiter = createRateLimiter({ limit: SEARCHES_PER_MINUTE, windowMs: 60_000 });

export async function GET(request: NextRequest): Promise<Response> {
  const sp = request.nextUrl.searchParams;
  // /sok öppnad som sida (bokmärke, historik, brödsmula): till Hem i stället för rå JSON.
  if (!sp.has("q") && !sp.has("lista") && request.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(new URL("/", request.url), 307);
  }
  try {
    const user = await getSessionUser();
    if (!user) {
      return Response.json({ error: "Logga in igen." }, { status: 401, headers: HEADERS });
    }
    const decision = limiter.consume([{ key: `sok:${user.userId}` }]);
    if (!decision.allowed) {
      return Response.json(
        { error: "För många sökningar. Vänta en stund." },
        {
          status: 429,
          headers: { ...HEADERS, "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)) },
        },
      );
    }
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
    // Enkel vy (getActiveOrganization): omdirigeringen till startsidan, inte ett fel.
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) {
      const status = error.reason === "unauthenticated" ? 401 : 403;
      return Response.json({ error: error.message }, { status, headers: HEADERS });
    }
    console.error("[sok] sökningen misslyckades", error);
    return Response.json({ error: "Sökningen misslyckades." }, { status: 500, headers: HEADERS });
  }
}
