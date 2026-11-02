import "server-only";

import { EnvError, parseServerEnv } from "@/lib/env";

export type ConfigStatus = { ok: true } | { ok: false; issues: readonly string[] };

/**
 * Är servermiljön komplett? Används av sidor som kräver inloggning för att
 * visa en tydlig sida om saknad konfiguration i stället för ett serverfel.
 * Returnerar bara variabelnamn och regler, aldrig värden.
 */
export function getConfigStatus(
  source: Record<string, string | undefined> = process.env,
): ConfigStatus {
  try {
    parseServerEnv(source);
    return { ok: true };
  } catch (error) {
    if (error instanceof EnvError) return { ok: false, issues: error.issues };
    throw error;
  }
}
