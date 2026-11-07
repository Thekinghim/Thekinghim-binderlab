/**
 * Daglig kontroll för den inloggade: senaste körningen (Inställningar → Kontroll och raden
 * på Hem) och "Kör kontrollen nu". Bara ägare och admin: rollen kontrolleras mot
 * databasen, läsningen sker under RLS (self_check_runs syns bara för ägare och admin).
 * Själva körningen skriver resultatet som systemrollen (./run.ts), med organisationen ur
 * den kontrollerade sessionen, aldrig ur indata.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { parseChecks, type CheckResult, type RunStatus } from "@/analytics/self-check";
import { getServiceDb, type Db } from "@/db/client";
import type { SelfCheckTrigger } from "@/db/schema";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import { runSelfCheck, type SelfCheckRunResult } from "./run";

/** "Kör kontrollen nu" högst så här ofta per organisation. */
export const MANUAL_RUN_INTERVAL_MS = 60_000;

export interface SelfCheckRunView {
  readonly id: string;
  readonly ranAt: string;
  readonly trigger: SelfCheckTrigger;
  readonly status: RunStatus;
  readonly failed: number;
  readonly warnings: number;
  readonly durationMs: number;
  readonly error: string | null;
  /** Vem som körde den (namn eller e-post), null = schemalagd. */
  readonly ranBy: string | null;
  readonly checks: CheckResult[];
}

export interface SelfCheckPage {
  readonly latest: SelfCheckRunView | null;
  /** De senaste körningarna, nyast först (utan kontrollerna). */
  readonly history: Omit<SelfCheckRunView, "checks">[];
}

type RunRow = {
  id: string;
  ran_at: Date | string;
  trigger: string;
  status: string;
  failed: number;
  warnings: number;
  duration_ms: number;
  error: string | null;
  ran_by: string | null;
  checks?: unknown;
};

const STATUSES: readonly RunStatus[] = ["ok", "warning", "failed", "error"];

function toView(r: RunRow): Omit<SelfCheckRunView, "checks"> {
  return {
    id: r.id,
    ranAt: new Date(r.ran_at).toISOString(),
    trigger: r.trigger === "manual" ? "manual" : "schedule",
    status: STATUSES.includes(r.status as RunStatus) ? (r.status as RunStatus) : "error",
    failed: Number(r.failed),
    warnings: Number(r.warnings),
    durationMs: Number(r.duration_ms),
    error: r.error,
    ranBy: r.ran_by,
  };
}

/** Senaste körningen med kontrollerna och historiken. Ägare och admin. */
export async function loadSelfCheckFor(viewer: Viewer, limit = 14): Promise<SelfCheckPage> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const list = (await withUserDbFor(viewer.user, async (tx) =>
    Array.from(
      await tx.execute(
        sql`select r.id, r.ran_at, r.trigger, r.status, r.failed, r.warnings, r.duration_ms,
                   r.error, nullif(p.display_name, '') as ran_by,
                   case when row_number() over (order by r.ran_at desc) = 1 then r.checks end as checks
            from public.self_check_runs r
            left join public.profiles p
              on p.organization_id = r.organization_id and p.user_id = r.created_by
             and p.anonymized_at is null
            where r.organization_id = ${orgId}::uuid
            order by r.ran_at desc
            limit ${Math.min(50, Math.max(1, limit))}`,
      ),
    ),
  )) as unknown as RunRow[];
  const [first] = list;
  return {
    latest: first ? { ...toView(first), checks: parseChecks(first.checks) } : null,
    history: list.map(toView),
  };
}

/**
 * Raden på Hem: senaste körningen (status och antal fel), eller null. Under RLS: läsaren
 * och påfyllaren ser ingen körning (null), utan att något kastas.
 */
export async function latestSelfCheckFor(
  viewer: Viewer,
): Promise<{ id: string; ranAt: string; status: RunStatus; failed: number } | null> {
  const orgId = viewer.organization.id;
  const [row] = (await withUserDbFor(viewer.user, async (tx) =>
    Array.from(
      await tx.execute(
        sql`select id, ran_at, status, failed from public.self_check_runs
            where organization_id = ${orgId}::uuid
            order by ran_at desc limit 1`,
      ),
    ),
  )) as unknown as { id: string; ran_at: Date | string; status: string; failed: number }[];
  if (!row) return null;
  return {
    id: row.id,
    ranAt: new Date(row.ran_at).toISOString(),
    status: STATUSES.includes(row.status as RunStatus) ? (row.status as RunStatus) : "error",
    failed: Number(row.failed),
  };
}

export class SelfCheckBusyError extends Error {
  constructor() {
    super("Kontrollen kördes nyss. Vänta en minut och försök igen.");
    this.name = "SelfCheckBusyError";
  }
}

/**
 * "Kör kontrollen nu": ägare och admin, högst en gång i minuten per organisation. Läser
 * sidorna som den som tryckte. Kastar AuthorizationError för andra roller och
 * SelfCheckBusyError inom spärren.
 */
export async function runSelfCheckNowFor(
  viewer: Viewer,
  deps: { readonly db?: Db; readonly now?: Date } = {},
): Promise<SelfCheckRunResult> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  if (!(OPERATOR_ROLES as readonly string[]).includes(role)) {
    throw new AuthorizationError("forbidden");
  }
  const db = deps.db ?? getServiceDb();
  const now = deps.now ?? new Date();
  const [recent] = Array.from(
    await db.execute(
      sql`select 1 as x from public.self_check_runs
          where organization_id = ${orgId}::uuid and trigger = 'manual'
            and ran_at > ${new Date(now.getTime() - MANUAL_RUN_INTERVAL_MS).toISOString()}::timestamptz
          limit 1`,
    ),
  );
  if (recent) throw new SelfCheckBusyError();
  return runSelfCheck(
    { db, now },
    {
      organizationId: orgId,
      trigger: "manual",
      viewer: { ...viewer, organization: { ...viewer.organization, role } },
    },
  );
}
