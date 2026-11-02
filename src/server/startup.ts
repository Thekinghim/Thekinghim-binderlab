/**
 * Kontroller vid serverstart (anropas från src/instrumentation.ts).
 *
 * - Miljövariablerna valideras. Vid fel skrivs felet ut tydligt (och når
 *   Sentry när det är konfigurerat) men servern startar, så att öppna sidor
 *   som /design fungerar. Sidor som kräver inloggning visar då en sida om
 *   saknad konfiguration (src/server/config-status.ts) i stället för data;
 *   inloggning och dataåtkomst kastar samma fel om de ändå anropas. Systemet
 *   faller alltså aldrig tillbaka till ett osäkert läge.
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
    assertDevAuthAllowed({
      APP_ENV: rawAppEnv,
      DATABASE_URL: source.DATABASE_URL,
      NODE_ENV: source.NODE_ENV,
      VERCEL: source.VERCEL,
      VERCEL_ENV: source.VERCEL_ENV,
      NEXT_PHASE: source.NEXT_PHASE,
    });
  }
  try {
    load();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(`\n${error.message}\n`);
      return;
    }
    throw error;
  }
}
