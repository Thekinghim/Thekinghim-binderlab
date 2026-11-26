/**
 * GET /assistent/tips  Rådgivarens öppna förslag, högst ett per sida, som JSON (tipsraden i
 * AI-panelen, src/components/assistant). Bara läsning. Hämtas av klienten efter första trycket
 * (src/components/assistant/page-tips-client.ts), så att det aldrig fördröjer sidan. En GET i
 * stället för en server action: server actions körs en i taget och köade bakom sidans egna.
 * Vid fel, utan inloggning eller för roller utan förslag: {}. Svaret cachas aldrig.
 */

import type { NextRequest } from "next/server";

import { pageTipsForUser } from "@/server/assistant/page-tips-for-user";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" };

export async function GET(request: NextRequest): Promise<Response> {
  // Öppnad som sida (bokmärke, historik): till Hem i stället för rå JSON.
  if (request.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(new URL("/", request.url), 307);
  }
  const user = await getSessionUser().catch(() => null);
  if (!user) return Response.json({}, { status: 401, headers: HEADERS });
  return Response.json(await pageTipsForUser(), { headers: HEADERS });
}
