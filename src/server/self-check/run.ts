/**
 * Daglig kontroll för en organisation: kör de sju kontrollerna, sparar resultatet
 * (public.self_check_runs) och synkar larmen (./alerts.ts).
 *
 * Kontrollerna läser bara: sidornas laddare under RLS som en ägare eller admin
 * (kontroll 1 och 5, så att talen är exakt de hen ser) och select-frågor som systemrollen
 * med organisationens id (./queries.ts). Det enda som skrivs är resultatraden och larmen.
 * Ett fel i en kontroll stoppar inte de andra: kontrollen blir "kunde inte köras" (fel).
 * Kontroll 1 läses om en gång när den hittar en skillnad (se runChecks).
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  awishStockCheck,
  crashed,
  hygieneCheck,
  profitConsistency,
  refillPushCheck,
  settingsCheck,
  settlementCheck,
  summarize,
  syncFreshnessCheck,
  type CheckResult,
  type RunStatus,
  type SelfCheckId,
  type PaidSettlementRow,
  type SettlementRow,
} from "@/analytics/self-check";
import { monthName } from "@/analytics/todos/text";
import { getServiceDb, type Db } from "@/db/client";
import type { SelfCheckTrigger } from "@/db/schema";
import { addDays, addMonths, monthOf, monthStart, type IsoMonth } from "@/domain";
import { withUserDbFor, type OrganizationMembership } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { recordJobOutcome } from "@/server/monitoring/failures";
import { errorText } from "@/server/monitoring/system-alerts";
import { liveFor } from "@/server/settlements/live";

import { syncSelfCheckAlerts, type AlertOutcome } from "./alerts";
import { gatherProfit, monthStoreShares, unpricedTitlesFor, type UnpricedTitle } from "./profit";
import {
  queryAgreementGaps,
  queryAwishReads,
  queryHygiene,
  queryRefillPushes,
  querySettingsFacts,
  querySyncSources,
  queryPaidSince,
  queryUnpaidClosed,
} from "./queries";

export interface SelfCheckRunResult {
  readonly id: string | null;
  readonly organizationId: string;
  readonly status: RunStatus;
  readonly failed: number;
  readonly warnings: number;
  readonly durationMs: number;
  readonly checks: CheckResult[];
  readonly alerts: AlertOutcome | null;
  readonly error?: string;
}

/** En kontroll som inte är klar efter så här länge blir "kunde inte köras". */
export const CHECK_TIMEOUT_MS = 60_000;
/**
 * Hela körningen för en organisation. Går tiden ut sparas körningen som ett fel: en
 * kontroll som hänger ska synas som "kunde inte köras", inte försvinna när funktionen
 * dödas (300 s) utan att något har sparats.
 */
export const RUN_TIMEOUT_MS = 150_000;

export interface SelfCheckDeps {
  /** Systemrollens databas. Standard: getServiceDb(). */
  readonly db?: Db;
  readonly now?: Date;
  /** Tidsgränser (tester). */
  readonly checkTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  /** Själva kontrollerna (tester). Standard: runChecks. */
  readonly checks?: (
    db: Db,
    viewer: Viewer,
    now: Date,
    options?: { readonly checkTimeoutMs?: number },
  ) => Promise<CheckResult[]>;
}

/** `promise`, eller ett fel med `message` när tiden går ut. Väntar inte på det som hänger. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // Det som hänger får inte bli ett ohanterat fel om det till slut kastar.
  promise.catch(() => {});
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} sekunder`;
}

interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly is_demo: boolean;
}

async function orgOf(db: Db, orgId: string): Promise<OrgRow | null> {
  const [row] = Array.from(
    await db.execute(
      sql`select id, name, slug, timezone, is_demo from public.organizations
          where id = ${orgId}::uuid and archived_at is null`,
    ),
  ) as unknown as OrgRow[];
  return row ?? null;
}

/**
 * Ägaren (annars en admin) som kontrollen läser sidorna som i det schemalagda jobbet:
 * samma tal som hen ser. null om organisationen saknar ägare och admin.
 */
export async function checkViewerFor(db: Db, orgId: string): Promise<Viewer | null> {
  const [row] = Array.from(
    await db.execute(
      sql`select m.user_id::text as user_id, u.email::text as email, m.role::text as role,
                 o.name, o.slug, o.timezone
          from public.memberships m
          join auth.users u on u.id = m.user_id
          join public.organizations o on o.id = m.organization_id
          where m.organization_id = ${orgId}::uuid and m.role in ('owner', 'admin')
            and o.archived_at is null and u.email is not null
          order by (m.role = 'owner') desc, m.created_at asc
          limit 1`,
    ),
  ) as unknown as {
    user_id: string;
    email: string;
    role: string;
    name: string;
    slug: string;
    timezone: string;
  }[];
  if (!row) return null;
  const organization: OrganizationMembership = {
    id: orgId,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    role: row.role as OrganizationMembership["role"],
  };
  return { user: { userId: row.user_id, email: row.email }, organization };
}

async function timed(
  id: SelfCheckId,
  fn: () => Promise<CheckResult>,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  const start = Date.now();
  let result: CheckResult;
  try {
    result = await withTimeout(fn(), timeoutMs, `Blev inte klar på ${seconds(timeoutMs)}.`);
  } catch (error) {
    console.error(`[self-check] ${id}`, error instanceof Error ? error.message : error);
    result = crashed(id, errorText(error, 200));
  }
  return { ...result, durationMs: Date.now() - start };
}

function monthLabel(month: string): string {
  return `${monthName(month.slice(0, 7) as IsoMonth)} ${month.slice(0, 4)}`;
}

/** De sju kontrollerna för organisationen. Läser bara. */
export async function runChecks(
  db: Db,
  viewer: Viewer,
  now: Date,
  options: { readonly checkTimeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const limit = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const check = (id: SelfCheckId, fn: () => Promise<CheckResult>) => timed(id, fn, limit);
  const orgId = viewer.organization.id;
  const tz = viewer.organization.timezone;
  const today = businessToday(now, tz);
  const from30 = addDays(today, -29);
  const thisMonthStart = monthStart(monthOf(today));

  const profitP = gatherProfit(viewer, now);
  profitP.catch(() => {});
  const unpricedP: Promise<UnpricedTitle[]> = profitP
    .then((p) => p.unpricedTitles)
    .catch(() => unpricedTitlesFor(viewer, from30, today, now));

  const results = await Promise.all([
    check("samma_vinst", async () => {
      const first = profitConsistency((await profitP).periods);
      if (first.status !== "fail") return first;
      // Sidorna läses i flera transaktioner: en order som synkas (var femte minut) mellan
      // två läsningar ger en skillnad som inte finns på sidorna. Ett riktigt fel räknas
      // likadant varje gång, så det läses en gång till och bara det som består är fel.
      return profitConsistency((await gatherProfit(viewer, now)).periods);
    }),
    check("awish_appen", async () =>
      awishStockCheck({ machines: await queryAwishReads(db, orgId), now }),
    ),
    check("pafyllning_awish", async () => {
      const data = await queryRefillPushes(db, orgId, now);
      return refillPushCheck({ ...data, now });
    }),
    check("synk", async () =>
      syncFreshnessCheck({ sources: await querySyncSources(db, orgId, tz, now), now }),
    ),
    check("avrakningar", async () => {
      const [unpaid, paid] = await Promise.all([
        queryUnpaidClosed(db, orgId, thisMonthStart),
        // Betalda de senaste tolv månaderna: betalt mot dagens uträkning.
        queryPaidSince(db, orgId, `${addMonths(thisMonthStart.slice(0, 7) as IsoMonth, -12)}-01`),
      ]);
      if (unpaid.length === 0 && paid.length === 0) return settlementCheck([]);
      const live = await withUserDbFor(viewer.user, (tx) =>
        liveFor(tx, orgId, [...unpaid, ...paid], now),
      );
      const paidRows: PaidSettlementRow[] = paid.map((p) => {
        const l = live.get(p.id);
        return {
          storeName: p.storeName,
          monthLabel: monthLabel(p.month),
          paidOre: p.paidOre,
          liveOre: l?.ok ? l.computed.amountOre : null,
          correctedOre: p.correctedOre,
        };
      });
      const months = [...new Set(unpaid.map((u) => u.month.slice(0, 7) as IsoMonth))];
      const shares = new Map<string, Map<string, number>>();
      for (const m of months) shares.set(m, await monthStoreShares(viewer, m, now));
      const rows: SettlementRow[] = unpaid.map((u) => {
        const l = live.get(u.id);
        return {
          storeName: u.storeName,
          monthLabel: monthLabel(u.month),
          storedOre: u.amountOre,
          live: !l
            ? { ok: false, message: "Avräkningen kunde inte räknas." }
            : l.ok
              ? { ok: true, amountOre: l.computed.amountOre }
              : { ok: false, message: l.message },
          pageShareOre: shares.get(u.month.slice(0, 7))?.get(u.storeId) ?? 0,
          correctionsOre: l?.ok ? l.computed.correctionsOre : 0,
        };
      });
      return settlementCheck(rows, paidRows);
    }),
    check("datahygien", async () => {
      const [base, unpricedTitles, agreementGaps] = await Promise.all([
        queryHygiene(db, orgId, from30),
        unpricedP,
        // Butiker med automat men utan avtal (räknas som 0 %), senaste 30 dagarna.
        queryAgreementGaps(db, orgId, { start: from30, end: today }),
      ]);
      return hygieneCheck({ ...base, unpricedTitles, agreementGaps });
    }),
    // Bara varningar: kortavgift 0 % trots kortköp, moms 0 % nära momsgränsen.
    check("installningar", async () => settingsCheck(await querySettingsFacts(db, orgId, today))),
  ]);
  return results;
}

/**
 * Kör kontrollen för organisationen och sparar resultatet. `viewer` = den som tryckte
 * "Kör kontrollen nu" (rollen redan kontrollerad); annars läses sidorna som ägaren.
 */
export async function runSelfCheck(
  deps: SelfCheckDeps,
  input: {
    readonly organizationId: string;
    readonly trigger: SelfCheckTrigger;
    readonly viewer?: Viewer;
  },
): Promise<SelfCheckRunResult> {
  const db = deps.db ?? getServiceDb();
  const now = deps.now ?? new Date();
  const start = Date.now();
  const orgId = input.organizationId;
  const org = await orgOf(db, orgId);
  if (!org) throw new Error("Organisationen finns inte eller är arkiverad.");

  let checks: CheckResult[] = [];
  let error: string | undefined;
  try {
    const viewer = input.viewer ?? (await checkViewerFor(db, orgId));
    if (!viewer) throw new Error("Organisationen saknar ägare och admin.");
    const runLimit = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    checks = await withTimeout(
      (deps.checks ?? runChecks)(db, viewer, now, { checkTimeoutMs: deps.checkTimeoutMs }),
      runLimit,
      `Kontrollen blev inte klar på ${seconds(runLimit)}.`,
    );
  } catch (e) {
    error = errorText(e, 500);
  }
  const summary = summarize(checks);
  const status: RunStatus = error ? "error" : summary.status;
  const durationMs = Math.min(3_600_000, Date.now() - start);
  const [row] = Array.from(
    await db.execute(
      sql`insert into public.self_check_runs
            (organization_id, ran_at, trigger, status, failed, warnings, duration_ms, checks,
             error, created_by)
          values (${orgId}::uuid, ${now.toISOString()}::timestamptz, ${input.trigger}, ${status},
                  ${summary.failed}, ${summary.warnings}, ${durationMs},
                  ${JSON.stringify(checks)}::jsonb, ${error ?? null},
                  ${input.trigger === "manual" ? (input.viewer?.user.userId ?? null) : null}::uuid)
          returning id`,
    ),
  ) as { id: string }[];

  // Larmen: ett per kontroll som inte gick igenom; inget utskick från en demo.
  const alerts = error
    ? null
    : await syncSelfCheckAlerts(db, orgId, checks, { now, notify: !org.is_demo });
  // En schemalagd körning som inte gick att köra ska höras (job:kontroll); en körning som
  // gick stänger larmet. "Kör kontrollen nu" visar sitt fel direkt för den som tryckte.
  if (!org.is_demo && (input.trigger === "schedule" || !error)) {
    await recordJobOutcome(
      { db, now },
      { organizationId: orgId, job: "kontroll", error: error ? new Error(error) : null },
    );
  }

  return {
    id: row?.id ?? null,
    organizationId: orgId,
    status,
    failed: summary.failed,
    warnings: summary.warnings,
    durationMs,
    checks,
    alerts,
    ...(error ? { error } : {}),
  };
}
