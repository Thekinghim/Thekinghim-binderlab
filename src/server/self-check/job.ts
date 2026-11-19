/**
 * Det schemalagda jobbet (/api/cron/kontroll, pg_cron varje timme 03:52–09:52 UTC, och en
 * gång till från larmjobbet som Vercel schemalägger): varje organisation kontrolleras en
 * gång per dag, första tillfället från 05:00 i organisationens tidszon. De övriga
 * tillfällena gör ingenting när kontrollen har kört, och är nya försök när den inte har
 * det. Demos körs också (resultatet syns i appen) men aviserar aldrig utanför den.
 * Systemroll.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { selfCheckDue } from "@/analytics/self-check";
import type { Db } from "@/db/client";
import { errorText } from "@/server/monitoring/system-alerts";

import { runSelfCheck } from "./run";

/**
 * Tiden jobbet får påbörja nya organisationer inom. Med gränsen för en körning
 * (RUN_TIMEOUT_MS, 150 s) blir den längsta körningen 270 s, under routens 300 s.
 */
export const JOB_BUDGET_MS = 120_000;

export interface ScheduledOutcome {
  readonly organizationId: string;
  readonly status: "ok" | "warning" | "failed" | "error" | "skipped";
  /** no_time = körningens tid räckte inte; organisationen tas vid nästa tillfälle. */
  readonly reason?: "not_yet" | "already_ran" | "no_time";
  readonly failed?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

export async function runScheduledSelfChecks(
  db: Db,
  now: Date = new Date(),
  options: {
    readonly only?: readonly string[];
    /** Efter så här lång tid påbörjas ingen ny organisation (routens maxDuration är 300 s). */
    readonly budgetMs?: number;
  } = {},
): Promise<{ ranAt: string; organizations: ScheduledOutcome[] }> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? JOB_BUDGET_MS;
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
    // En organisation som tar lång tid får inte kosta de andra deras körning: de som inte
    // hinns med tas vid nästa tillfälle (kontrollen anropas varje timme på morgonen).
    if (Date.now() - started > budgetMs) {
      out.push({ organizationId: o.id, status: "skipped", reason: "no_time" });
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
