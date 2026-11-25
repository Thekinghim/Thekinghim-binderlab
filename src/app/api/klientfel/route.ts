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
/**
 * Bara från appens egna sidor: en annan webbplats ska inte kunna skriva rader i personens namn.
 * Samma jämförelse som /installningar/export och /assistent/fraga (Origin mot värden som
 * Vercel skickar vidare), inte request.nextUrl.origin, som bakom en proxy kan ha fel värd
 * eller protokoll och då skulle avvisa varje rapport utan att någon märker det. Origin "null"
 * (sandlådad ram, okänt ursprung) godtas inte.
 */
function sameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  try {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return NO_CONTENT();
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
