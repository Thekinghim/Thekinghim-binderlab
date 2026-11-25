import { NextResponse, type NextRequest } from "next/server";

import { ACTIVE_ORG_COOKIE } from "@/server/auth/flows";
import { saveClientErrorFor } from "@/server/client-errors/report";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** Större kroppar läses inte (meddelande och stack ryms med god marginal). */
const MAX_BODY = 16_000;

const NO_CONTENT = () =>
  new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/klientfel: telefonen eller webbläsaren rapporterar ett fel som den själv kastade
 * (felrutan, ohanterade fel). Sparas i private.client_errors för den inloggade personen.
 *
 * En route och inte en server action: efter en ny driftsättning har en telefon med gamla
 * skript gamla action-id:n som servern inte känner igen, och det är just då felen behöver
 * komma fram. Svarar alltid 204 (utom fel ursprung), så att felrutan aldrig får ett nytt fel.
 * Utloggad: proxyn skickar till inloggningen och inget sparas.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Bara från appens egna sidor: en annan webbplats ska inte kunna skriva rader i personens namn.
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (
    (site && site !== "same-origin") ||
    (origin && origin !== request.nextUrl.origin && origin !== "null")
  ) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    const user = await getSessionUser();
    if (!user) return NO_CONTENT();
    const text = await request.text();
    if (text.length > MAX_BODY) return NO_CONTENT();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NO_CONTENT();
    }
    await saveClientErrorFor(user, request.cookies.get(ACTIVE_ORG_COOKIE)?.value, body);
  } catch (error) {
    console.error("[klientfel] Rapporten kunde inte tas emot:", error);
  }
  return NO_CONTENT();
}
