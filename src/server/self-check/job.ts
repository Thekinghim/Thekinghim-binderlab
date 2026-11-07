/**
 * Det schemalagda jobbet (/api/cron/kontroll, pg_cron 03:37 och 04:37 UTC): varje
 * organisation kontrolleras en gång per dag, första tillfället från 05:00 i
 * organisationens tidszon (05:37 svensk tid både sommar- och vintertid). Demos körs också
 * (resultatet syns i appen) men aviserar aldrig utanför den. Systemroll.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { selfCheckDue } from "@/analytics/self-check";
import type { Db } from "@/db/client";
import { errorText } from "@/server/monitoring/system-alerts";

import { runSelfCheck } from "./run";

export interface ScheduledOutcome {
  readonly organizationId: string;
  readonly status: "ok" | "warning" | "failed" | "error" | "skipped";
  readonly reason?: "not_yet" | "already_ran";
  readonly failed?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

export async function runScheduledSelfChecks(
  db: Db,
  now: Date = new Date(),
  options: { readonly only?: readonly string[] } = {},
): Promise<{ ranAt: string; organizations: ScheduledOutcome[] }> {
  const only = options.only ? [...options.only] : null;
  const orgs = Array.from(
    await db.execute(
      sql`select o.id, o.timezone,
                 (select max(r.ran_at) from public.self_check_runs r
                   where r.organization_id = o.id and r.trigger = 'schedule') as last_at
          from public.organizations o
          where o.archived_at is null
            and (${only === null} or o.id::text = any(string_to_array(${(only ?? []).join(",")}, ',')))
          order by o.created_at`,
    ),
  ) as { id: string; timezone: string; last_at: Date | string | null }[];
  const out: ScheduledOutcome[] = [];
  for (const o of orgs) {
    const last = o.last_at ? new Date(o.last_at) : null;
    const due = selfCheckDue(now, o.timezone, last);
    if (!due.due) {
      out.push({ organizationId: o.id, status: "skipped", reason: due.reason });
      continue;
    }
    try {
      const r = await runSelfCheck({ db, now }, { organizationId: o.id, trigger: "schedule" });
      out.push({
        organizationId: o.id,
        status: r.status,
        failed: r.failed,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (error) {
      out.push({ organizationId: o.id, status: "error", error: errorText(error) });
    }
  }
  return { ranAt: now.toISOString(), organizations: out };
}
