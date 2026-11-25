import "server-only";

import { sql } from "drizzle-orm";

import { clampClientError } from "@/lib/client-error";
import { isUuid, withUserDbFor, type SessionUser } from "@/server/access";

/**
 * Sparar ett klientfel som den inloggade personen (RLS-rollen authenticated) via
 * public.report_client_error. Organisationen sparas bara om personen är medlem där (det
 * kontrolleras i databasen). Kastar aldrig: true = skickat till databasen (som tyst släpper
 * fler än 30 per person och timme), false = ogiltigt eller fel.
 */
export async function saveClientErrorFor(
  user: SessionUser,
  organizationId: string | null | undefined,
  input: unknown,
): Promise<boolean> {
  try {
    const report = clampClientError(input);
    if (!report) return false;
    const org = isUuid(organizationId) ? organizationId : null;
    await withUserDbFor(user, (tx) =>
      tx.execute(
        sql`select public.report_client_error(
              ${report.path}, ${report.message}, ${report.stack}, ${report.digest},
              ${report.buildId}, ${report.userAgent}, ${JSON.stringify(report.extra)}::jsonb,
              ${org}::uuid
            )`,
      ),
    );
    return true;
  } catch (error) {
    console.error("[klientfel] Kunde inte spara felet:", error);
    return false;
  }
}
