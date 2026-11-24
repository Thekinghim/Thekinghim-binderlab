/**
 * QR-koden på automaten: /m/<nyckel>. Nyckeln sparas i en httpOnly-cookie och personen
 * skickas till inloggningen, där bara PIN-koden behövs. Nyckeln ensam loggar inte in, och
 * ägaren byter den med "Ny QR-kod" (den gamla slutar gälla).
 */

import { NextResponse, type NextRequest } from "next/server";

import { isQrToken } from "@/server/auth/phone";
import { STAFF_QR_COOKIE } from "@/server/auth/phone-qr-cookie";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const response = NextResponse.redirect(new URL("/logga-in/mobil", request.url), 303);
  if (isQrToken(token)) {
    response.cookies.set(STAFF_QR_COOKIE, token, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/logga-in",
      maxAge: 400 * 24 * 60 * 60,
    });
  }
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
