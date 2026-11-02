/**
 * Kontroller vid serverstart (anropas från src/instrumentation.ts).
 *
 * - Miljövariablerna valideras. I preview och production stoppas starten
 *   vid fel. Lokalt (APP_ENV=development) skrivs felet ut tydligt men
 *   servern startar, så att sidor som inte kräver inloggning fortfarande går
 *   att arbeta med; inloggningen kastar samma fel när den används.
 * - Dev-inloggningens spärr gäller alltid: AUTH_PROVIDER=dev utanför
 *   development eller mot en fjärrdatabas stoppar starten.
 */

import { EnvError, getServerEnv, parseServerEnv } from "@/lib/env";

import { assertDevAuthAllowed } from "./auth/dev-guard";

export function verifyServerStartup(
  source: Record<string, string | undefined> = process.env,
  load: () => unknown = () => (source === process.env ? getServerEnv() : parseServerEnv(source)),
): void {
  // Spärren först, oberoende av övriga fel i miljön.
  const rawAppEnv =
    source.APP_ENV?.trim() || (source.NODE_ENV === "production" ? undefined : "development");
  const provider =
    source.AUTH_PROVIDER?.trim() || (rawAppEnv === "development" ? "dev" : "supabase");
  if (provider === "dev") {
    assertDevAuthAllowed({ APP_ENV: rawAppEnv, DATABASE_URL: source.DATABASE_URL });
  }
  try {
    load();
  } catch (error) {
    if (error instanceof EnvError && rawAppEnv === "development") {
      console.error(`\n${error.message}\n`);
      return;
    }
    throw error;
  }
}
