/**
 * GET /dagens-brief  Korten i Dagens brief (rutan som öppnas första gången appen öppnas
 *                    varje dag, src/app/(app)/_hem/brief) som JSON: { day, cards }.
 *
 * Hämtas av klienten efter att sidan laddats, så att den aldrig fördröjer sidan. Rollen
 * avgörs på servern (../_hem/brief/data.ts): påfyllaren får bara påfyllning och rutt, utan
 * kronor. Vid fel eller utan inloggning: { day: null, cards: [] } (rutan visas då inte).
 * Svaret cachas aldrig.
 */

import type { NextRequest } from "next/server";

import { getSessionUser } from "@/server/session";

import { loadBrief } from "../_hem/brief/data";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" };
const NOTHING = { day: null, cards: [] };

export async function GET(request: NextRequest): Promise<Response> {
  // Öppnad som sida (bokmärke, historik): till Hem i stället för rå JSON.
  if (request.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(new URL("/", request.url), 307);
  }
  try {
    const user = await getSessionUser();
    if (!user) return Response.json(NOTHING, { status: 401, headers: HEADERS });
    const brief = await loadBrief();
    return Response.json(brief ?? NOTHING, { headers: HEADERS });
  } catch (error) {
    // Briefen får aldrig stoppa något: inga kort (en omdirigering i enkel vy räknas hit också).
    console.error("[brief] Dagens brief kunde inte läsas:", error);
    return Response.json(NOTHING, { headers: HEADERS });
  }
}
