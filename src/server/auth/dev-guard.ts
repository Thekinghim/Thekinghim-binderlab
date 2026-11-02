/**
 * Hård spärr för dev-inloggningen. Den får bara köras lokalt: APP_ENV måste
 * vara development, NODE_ENV får inte vara production, servern får inte köra
 * på Vercel och DATABASE_URL måste peka på localhost/127.0.0.1 (även enligt
 * postgres.js tolkning, se isLocalDatabaseUrl).
 * Kontrolleras när providern skapas och vid serverstart (instrumentation).
 */

import { isLocalDatabaseUrl } from "@/lib/env";

export class DevAuthForbiddenError extends Error {
  constructor(reason: string) {
    super(`Dev-inloggningen är spärrad: ${reason}`);
    this.name = "DevAuthForbiddenError";
  }
}

export interface DevAuthGuardEnv {
  APP_ENV: string | undefined;
  DATABASE_URL: string | undefined;
  /** Saknas de används processens värden (process.env). */
  NODE_ENV?: string | undefined;
  VERCEL?: string | undefined;
  VERCEL_ENV?: string | undefined;
  /** Next sätter "phase-production-build" under `next build`. */
  NEXT_PHASE?: string | undefined;
}

function runtimeValue(
  env: DevAuthGuardEnv,
  key: "NODE_ENV" | "VERCEL" | "VERCEL_ENV" | "NEXT_PHASE",
) {
  const value = key in env ? env[key] : undefined;
  return value ?? (typeof process === "undefined" ? undefined : process.env[key]);
}

export function assertDevAuthAllowed(env: DevAuthGuardEnv): void {
  if (env.APP_ENV !== "development") {
    throw new DevAuthForbiddenError(
      `APP_ENV är ${env.APP_ENV ?? "inte satt"}, men måste vara development.`,
    );
  }
  // Härdning: ett produktionsbygge (`next start`) eller en körning på Vercel
  // är aldrig lokal utveckling, oavsett vad APP_ENV säger.
  // Undantag: själva bygget (`next build`) lokalt, där inga förfrågningar
  // hanteras. `next start` av samma bygge stoppas.
  if (
    runtimeValue(env, "NODE_ENV") === "production" &&
    runtimeValue(env, "NEXT_PHASE") !== "phase-production-build"
  ) {
    throw new DevAuthForbiddenError("NODE_ENV är production (produktionsbygge).");
  }
  if (runtimeValue(env, "VERCEL") || runtimeValue(env, "VERCEL_ENV")) {
    throw new DevAuthForbiddenError("servern körs på Vercel (VERCEL/VERCEL_ENV är satt).");
  }
  if (!env.DATABASE_URL || !isLocalDatabaseUrl(env.DATABASE_URL)) {
    throw new DevAuthForbiddenError(
      "DATABASE_URL pekar inte på en lokal databas (localhost eller 127.0.0.1).",
    );
  }
}
