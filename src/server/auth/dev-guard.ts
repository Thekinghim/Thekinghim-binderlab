/**
 * Hård spärr för dev-inloggningen. Den får bara köras lokalt: APP_ENV måste
 * vara development och DATABASE_URL måste peka på localhost/127.0.0.1.
 * Kontrolleras när providern skapas och vid serverstart (instrumentation).
 */

import { isLocalDatabaseUrl } from "@/lib/env";

export class DevAuthForbiddenError extends Error {
  constructor(reason: string) {
    super(`Dev-inloggningen är spärrad: ${reason}`);
    this.name = "DevAuthForbiddenError";
  }
}

export function assertDevAuthAllowed(env: {
  APP_ENV: string | undefined;
  DATABASE_URL: string | undefined;
}): void {
  if (env.APP_ENV !== "development") {
    throw new DevAuthForbiddenError(
      `APP_ENV är ${env.APP_ENV ?? "inte satt"}, men måste vara development.`,
    );
  }
  if (!env.DATABASE_URL || !isLocalDatabaseUrl(env.DATABASE_URL)) {
    throw new DevAuthForbiddenError(
      "DATABASE_URL pekar inte på en lokal databas (localhost eller 127.0.0.1).",
    );
  }
}
