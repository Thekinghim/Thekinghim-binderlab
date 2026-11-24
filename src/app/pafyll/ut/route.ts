/**
 * Utloggning när kontot är avstängt eller inte använts på 90 dagar (requireStaff skickar
 * hit, eftersom en sida inte kan ta bort cookies). Sedan till inloggningen med mobilnummer.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getAuthProvider } from "@/server/auth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  await (await getAuthProvider()).signOut();
  return NextResponse.redirect(new URL("/logga-in/mobil?ute=1", request.url), 303);
}
