/**
 * Larmjobbet i sin helhet: utvärdera varje organisation och skicka det som är på tur.
 * Anropas av /api/cron/larm (schemalagt, t.ex. var 10:e minut). Systemroll.
 */

import "server-only";

import type { Db } from "@/db/client";

import { deliverDue, type DeliverySummary } from "./deliver";
import { activeOrganizations, evaluateOrganization, type EvaluationSummary } from "./evaluate";

export interface AlertJobResult {
  readonly ranAt: string;
  readonly organizations: EvaluationSummary[];
  readonly deliveries: DeliverySummary;
}

export async function runAlertJob(
  db: Db,
  options: { now?: Date; baseUrl: string },
): Promise<AlertJobResult> {
  const now = options.now ?? new Date();
  const organizations: EvaluationSummary[] = [];
  for (const orgId of await activeOrganizations(db)) {
    organizations.push(await evaluateOrganization(db, orgId, now));
  }
  const deliveries = await deliverDue(db, { now, baseUrl: options.baseUrl });
  return { ranAt: now.toISOString(), organizations, deliveries };
}

export { cronAuthorized } from "./cron-auth";
