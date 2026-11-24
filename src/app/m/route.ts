/**
 * Kort länk till inloggningen med mobilnummer (QR-koden på automaten). Inte en hemlighet:
 * mobilnummer och PIN-kod är det som loggar in.
 */

import { NextResponse, type NextRequest } from "next/server";

export function GET(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/logga-in/mobil", request.url), 307);
}
