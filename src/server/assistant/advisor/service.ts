/**
 * AI-rådgivaren: en körning per organisation och dag (cron) eller på knapptryck (ägare
 * och admin, högst 3 per dag). Underlaget läses som organisationens ägare under RLS,
 * förslagen kontrolleras mot underlaget (grounding.ts) och sparas i ai_suggestions.
 * Varje körning sparas i ai_runs med tokens och kostnad; när månadens kostnad (rådgivaren
 * + assistentens frågor) når AI_MONTHLY_BUDGET_SEK görs inga fler anrop.
 *
 * Skrivningar görs av servern (systemrollen); läsning och statusändring av användaren
 * under RLS. Se docs/assistent.md.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import type { AiConfidence, AiSuggestionStatus } from "@/db/schema";
import { addDays } from "@/domain";
import {
  AuthorizationError,
  listOrganizationsFor,
  requireRoleFor,
  withUserDbFor,
} from "@/server/access";
import {
  businessToday,
  loadDomainInputFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";

import { assistantConfigFrom } from "../config";
import { checkSuggestions, revenueSek, type Rejection } from "./grounding";
import { createAnthropicAdvisor, type AdvisorModel } from "./model";
import { budgetFrom, costOre, dayStart, monthStart, type TokenUsage } from "./pricing";
import { ADVISOR_INSTRUCTIONS, advisorUserMessage } from "./prompt";
import { buildSnapshot, snapshotText, type Snapshot } from "./snapshot";

export const MANUAL_RUNS_PER_DAY = 3;
export const DEFAULT_ADVISOR_MODEL = "claude-sonnet-5-5";
const ADVISOR_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"];
const ADVISOR_ROLES = ["owner", "admin"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export type AdvisorConfig =
  | { readonly status: "ready"; readonly apiKey: string; readonly model: string }
  | { readonly status: "off"; readonly message: string };

/** Rådgivaren kräver Claude API (inte den lokala testmodellen). Modell: AI_ADVISOR_MODEL. */
export function advisorConfigFrom(env: Env): AdvisorConfig {
  const base = assistantConfigFrom(env);
  if (base.status !== "ready" || base.provider !== "anthropic") {
    return { status: "off", message: "Förslagen kräver ANTHROPIC_API_KEY." };
  }
  const model = env.AI_ADVISOR_MODEL?.trim() || DEFAULT_ADVISOR_MODEL;
  if (!ADVISOR_MODELS.includes(model)) {
    return {
      status: "off",
      message: `AI_ADVISOR_MODEL måste vara ${ADVISOR_MODELS.join(" eller ")}.`,
    };
  }
  return { status: "ready", apiKey: base.apiKey, model };
}

/**
 * Demoorganisationerna (slug nordljus-demo*) anropar inte Claude i produktion, så att
 * de inte delar månadstaket med den riktiga verksamheten.
 */
export function isDemoBlocked(slug: string | null | undefined, env: Env): boolean {
  return env.NODE_ENV === "production" && (slug ?? "").startsWith("nordljus-demo");
}

// ---------------------------------------------------------------------------
// Kostnad och tak
// ---------------------------------------------------------------------------

/** Månadens kostnad i öre för hela installationen: rådgivaren och assistentens frågor. */
export async function monthCostOre(db: Db, now: Date, usdSek: number): Promise<number> {
  const since = monthStart(now);
  const runs = Array.from(
    await db.execute(
      sql`select coalesce(sum(cost_ore), 0)::bigint as ore from public.ai_runs where created_at >= ${since.toISOString()}::timestamptz`,
    ),
  ) as Array<{ ore: string | number }>;
  const logs = Array.from(
    await db.execute(
      sql`select model,
                 coalesce(sum((usage ->> 'inputTokens')::bigint), 0)::bigint as input,
                 coalesce(sum((usage ->> 'outputTokens')::bigint), 0)::bigint as output,
                 coalesce(sum((usage ->> 'cacheReadTokens')::bigint), 0)::bigint as cache_read,
                 coalesce(sum((usage ->> 'cacheWriteTokens')::bigint), 0)::bigint as cache_write
          from public.assistant_logs
          where created_at >= ${since.toISOString()}::timestamptz and provider = 'anthropic'
          group by model`,
    ),
  ) as Array<{
    model: string;
    input: string;
    output: string;
    cache_read: string;
    cache_write: string;
  }>;
  let total = Number(runs[0]?.ore ?? 0);
  for (const l of logs) {
    total += costOre(
      l.model,
      {
        inputTokens: Number(l.input),
        outputTokens: Number(l.output),
        cacheReadTokens: Number(l.cache_read),
        cacheWriteTokens: Number(l.cache_write),
      },
      usdSek,
    );
  }
  return total;
}

export interface BudgetState {
  readonly spentOre: number;
  readonly budgetOre: number;
  readonly exceeded: boolean;
}

export async function budgetState(
  db: Db = getServiceDb(),
  now: Date = new Date(),
  env: Env = process.env,
): Promise<BudgetState> {
  const { budgetOre, usdSek } = budgetFrom(env);
  const spentOre = await monthCostOre(db, now, usdSek);
  return { spentOre, budgetOre, exceeded: spentOre >= budgetOre };
}

// ---------------------------------------------------------------------------
// Underlaget
// ---------------------------------------------------------------------------

/** Underlaget för organisationen (läst som viewer under RLS). Kräver ägare eller admin. */
export async function loadSnapshotFor(viewer: Viewer, now: Date, vmb = false): Promise<Snapshot> {
  const today = businessToday(now, viewer.organization.timezone);
  const asOf = addDays(today, -1);
  const period = { start: addDays(asOf, -29), end: asOf };
  const compare = { start: addDays(asOf, -59), end: addDays(asOf, -30) };
  const [data, stock] = await Promise.all([
    loadDomainInputFor(viewer, { period, compare, vmb }, now),
    loadStockFor(viewer),
  ]);
  return buildSnapshot({
    organizationName: viewer.organization.name,
    today,
    timeZone: viewer.organization.timezone,
    now,
    sources: data.sources,
    orders: [...data.current.orders, ...(data.previous?.orders ?? [])],
    titles: data.titles,
    machines: data.machines,
    stores: data.stores,
    machineStock: stock.machineStock,
  });
}

// ---------------------------------------------------------------------------
// En körning
// ---------------------------------------------------------------------------

export type RunOutcome =
  | {
      readonly status: "ok" | "empty";
      readonly runId: string;
      readonly accepted: number;
      readonly rejected: Rejection[];
      readonly costOre: number;
    }
  | { readonly status: "budget"; readonly runId: string }
  | { readonly status: "error"; readonly runId: string; readonly message: string }
  | { readonly status: "rate-limited" | "skipped" | "off"; readonly message: string };

export interface RunArgs {
  readonly viewer: Viewer;
  readonly trigger: "cron" | "manual";
  /** Vyknappen "Med VMB" (manuell körning från en sida med ?vmb=1). Standard av. */
  readonly vmb?: boolean;
  readonly now?: Date;
  readonly env?: Env;
  /** För tester: egen modell i stället för Claude API. */
  readonly model?: AdvisorModel;
  readonly db?: Db;
}

function lockKey(orgId: string): bigint {
  // 63 bitar ur uuid:t räcker för ett lås per organisation.
  return BigInt.asIntN(64, BigInt(`0x${orgId.replace(/-/g, "").slice(0, 16)}`));
}

/**
 * Kör rådgivaren för en organisation. Kontrollerar tak och gräns i en transaktion med
 * lås per organisation, så att två knapptryck samtidigt inte blir fyra körningar.
 */
export async function runAdvisor(args: RunArgs): Promise<RunOutcome> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  const db = args.db ?? getServiceDb();
  const orgId = args.viewer.organization.id;
  const started = Date.now();

  // Rollen ur databasen (även för cron: ägaren som underlaget läses som).
  await requireRoleFor(args.viewer.user, orgId, ADVISOR_ROLES);

  let model = args.model;
  if (!model) {
    if (isDemoBlocked(args.viewer.organization.slug, env)) {
      return { status: "off", message: "Förslag på riktigt finns inte i demon." };
    }
    const config = advisorConfigFrom(env);
    if (config.status !== "ready") return { status: "off", message: config.message };
    model = createAnthropicAdvisor({ apiKey: config.apiKey, model: config.model });
  }

  const { budgetOre, usdSek } = budgetFrom(env);
  const userId = args.trigger === "manual" ? args.viewer.user.userId : null;
  const gate = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(orgId)})`);
    const today = dayStart(now, args.viewer.organization.timezone);
    const [counts] = Array.from(
      await tx.execute(
        sql`select count(*) filter (where trigger = 'manual')::int as manual,
                   count(*) filter (where trigger = 'cron' and status in ('ok', 'empty', 'running'))::int as cron
            from public.ai_runs where organization_id = ${orgId} and created_at >= ${today.toISOString()}::timestamptz`,
      ),
    ) as Array<{ manual: number; cron: number }>;
    if (args.trigger === "manual" && counts!.manual >= MANUAL_RUNS_PER_DAY) {
      return { kind: "rate-limited" as const };
    }
    if (args.trigger === "cron" && counts!.cron > 0) return { kind: "skipped" as const };
    const spent = await monthCostOre(db, now, usdSek);
    const status = spent >= budgetOre ? "budget" : "running";
    const [row] = Array.from(
      await tx.execute(
        sql`insert into public.ai_runs (organization_id, trigger, status, model, created_by)
            values (${orgId}, ${args.trigger}, ${status}, ${model.model}, ${userId})
            returning id`,
      ),
    ) as Array<{ id: string }>;
    return status === "budget"
      ? { kind: "budget" as const, runId: row!.id }
      : { kind: "running" as const, runId: row!.id };
  });

  if (gate.kind === "rate-limited") {
    return {
      status: "rate-limited",
      message: `Högst ${MANUAL_RUNS_PER_DAY} nya förslag per dag. Försök i morgon.`,
    };
  }
  if (gate.kind === "skipped") return { status: "skipped", message: "Redan kört i dag." };
  if (gate.kind === "budget") return { status: "budget", runId: gate.runId };
  const runId = gate.runId;

  const finish = async (fields: {
    status: "ok" | "empty" | "error";
    usage?: TokenUsage;
    model?: string;
    accepted?: number;
    rejected?: Rejection[];
    error?: string;
  }) => {
    const usage = fields.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = costOre(fields.model ?? model.model, usage, usdSek);
    await db.execute(
      sql`update public.ai_runs set
            status = ${fields.status},
            model = ${(fields.model ?? model.model).slice(0, 100)},
            input_tokens = ${usage.inputTokens},
            output_tokens = ${usage.outputTokens},
            cache_read_tokens = ${usage.cacheReadTokens},
            cache_write_tokens = ${usage.cacheWriteTokens},
            cost_ore = ${cost},
            accepted = ${fields.accepted ?? 0},
            rejected = ${JSON.stringify(fields.rejected ?? [])}::jsonb,
            error = ${fields.error?.slice(0, 2000) ?? null},
            duration_ms = ${Date.now() - started}
          where organization_id = ${orgId} and id = ${runId}`,
    );
    return cost;
  };

  try {
    const snapshot = await loadSnapshotFor(args.viewer, now, args.vmb === true);
    const previous = Array.from(
      await db.execute(
        sql`select title from public.ai_suggestions
            where organization_id = ${orgId} and created_at >= ${addMs(now, -30 * 86_400_000).toISOString()}::timestamptz
            order by created_at desc limit 30`,
      ),
    ) as Array<{ title: string }>;
    const response = await model.propose({
      instructions: ADVISOR_INSTRUCTIONS,
      snapshot: snapshotText(snapshot),
      message: advisorUserMessage([...new Set(previous.map((p) => p.title))]),
    });
    if (response.toolInput === null) {
      const message =
        response.stopReason === "refusal"
          ? "Modellen avböjde."
          : response.stopReason === "max_tokens"
            ? "Svaret blev för långt."
            : "Modellen anropade inte spara_forslag.";
      await finish({
        status: "error",
        usage: response.usage,
        model: response.model,
        error: message,
      });
      return { status: "error", runId, message };
    }
    const checked = checkSuggestions(response.toolInput, snapshot, {
      maxEffectSek: revenueSek(snapshot.nyckeltal.d30.vinst),
    });
    if (checked.accepted.length > 0) {
      await db.transaction(async (tx) => {
        for (const s of checked.accepted) {
          await tx.execute(
            sql`insert into public.ai_suggestions
                  (organization_id, run_id, rank, title, why, action, effect_sek_month, confidence, created_by)
                values (${orgId}, ${runId}, ${s.rank}, ${s.title}, ${s.why}, ${s.action},
                        ${s.effectSekMonth}, ${s.confidence}, ${userId})`,
          );
        }
      });
    }
    const status = checked.accepted.length > 0 ? "ok" : "empty";
    const cost = await finish({
      status,
      usage: response.usage,
      model: response.model,
      accepted: checked.accepted.length,
      rejected: checked.rejected,
    });
    return {
      status,
      runId,
      accepted: checked.accepted.length,
      rejected: checked.rejected,
      costOre: cost,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Okänt fel.";
    console.error("[rådgivare] körningen misslyckades:", message);
    await finish({ status: "error", error: message }).catch(() => {});
    return { status: "error", runId, message: "Förslagen kunde inte tas fram." };
  }
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

// ---------------------------------------------------------------------------
// Cron: alla organisationer med försäljning senaste 30 dagarna
// ---------------------------------------------------------------------------

export interface CronResult {
  readonly organizations: { id: string; status: string; accepted?: number }[];
}

/** Daglig körning. Demoorganisationerna hoppas över (de får förslag på knapptryck). */
export async function runAdvisorForAll(
  options: { now?: Date; env?: Env; model?: AdvisorModel; db?: Db } = {},
): Promise<CronResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? getServiceDb();
  const orgs = Array.from(
    await db.execute(
      sql`select o.id, owner.user_id, u.email
          from public.organizations o
          cross join lateral (
            select m.user_id from public.memberships m
            where m.organization_id = o.id and m.role = 'owner'
            order by m.created_at, m.user_id limit 1
          ) owner
          join auth.users u on u.id = owner.user_id
          where o.archived_at is null
            and o.slug not like 'nordljus-demo%'
            and exists (
              select 1 from public.orders x
              where x.organization_id = o.id and x.business_date >= (${now.toISOString()}::timestamptz at time zone o.timezone)::date - 30
            )
          order by o.created_at`,
    ),
  ) as Array<{ id: string; user_id: string; email: string | null }>;

  const out: CronResult["organizations"] = [];
  for (const org of orgs) {
    const user = { userId: org.user_id, email: org.email ?? "" };
    try {
      const organization = (await listOrganizationsFor(user)).find((o) => o.id === org.id);
      if (!organization) {
        out.push({ id: org.id, status: "skipped" });
        continue;
      }
      const r = await runAdvisor({
        viewer: { user, organization },
        trigger: "cron",
        now,
        db,
        ...(options.env ? { env: options.env } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      out.push({
        id: org.id,
        status: r.status,
        ...("accepted" in r ? { accepted: r.accepted } : {}),
      });
      if (r.status === "budget" || r.status === "off") break;
    } catch (error) {
      console.error("[rådgivare] organisationen hoppades över:", error);
      out.push({ id: org.id, status: "error" });
    }
  }
  return { organizations: out };
}

// ---------------------------------------------------------------------------
// Läsning och status (som användaren, under RLS)
// ---------------------------------------------------------------------------

export interface SuggestionView {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly why: string;
  readonly action: string;
  readonly effectSekMonth: number;
  readonly confidence: AiConfidence;
  readonly createdAt: string;
}

export interface AdvisorState {
  readonly suggestions: SuggestionView[];
  /** Senaste körningen (vilken som helst), eller null. */
  readonly lastRun: { status: string; createdAt: string } | null;
  readonly manualLeft: number;
}

/** Öppna förslag (status new) från de 14 senaste dagarna, nyast körning först. Ägare och admin. */
export async function loadAdvisorStateFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<AdvisorState | null> {
  const orgId = viewer.organization.id;
  try {
    await requireRoleFor(viewer.user, orgId, ADVISOR_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  const today = dayStart(now, viewer.organization.timezone);
  try {
    return await readAdvisorState(viewer, orgId, now, today);
  } catch (error) {
    // Sidan ska fungera även om ai_*-tabellerna saknas eller frågan fallerar.
    console.error("[rådgivare] förslagen kunde inte läsas:", error);
    return null;
  }
}

function readAdvisorState(
  viewer: Viewer,
  orgId: string,
  now: Date,
  today: Date,
): Promise<AdvisorState> {
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = Array.from(
      await tx.execute(
        sql`select s.id, s.rank, s.title, s.why, s.action, s.effect_sek_month, s.confidence, s.created_at
            from public.ai_suggestions s
            where s.organization_id = ${orgId} and s.status = 'new'
              and s.created_at >= ${addMs(now, -14 * 86_400_000).toISOString()}::timestamptz
            order by s.created_at desc, s.rank
            limit 5`,
      ),
    ) as Array<{
      id: string;
      rank: number;
      title: string;
      why: string;
      action: string;
      effect_sek_month: number;
      confidence: AiConfidence;
      created_at: Date | string;
    }>;
    const [last] = Array.from(
      await tx.execute(
        sql`select status, created_at from public.ai_runs where organization_id = ${orgId}
            order by created_at desc limit 1`,
      ),
    ) as Array<{ status: string; created_at: Date | string }>;
    const [manual] = Array.from(
      await tx.execute(
        sql`select count(*)::int as n from public.ai_runs
            where organization_id = ${orgId} and trigger = 'manual' and created_at >= ${today.toISOString()}::timestamptz`,
      ),
    ) as Array<{ n: number }>;
    const iso = (d: Date | string) =>
      d instanceof Date ? d.toISOString() : new Date(d).toISOString();
    return {
      suggestions: rows.map((r) => ({
        id: r.id,
        rank: Number(r.rank),
        title: r.title,
        why: r.why,
        action: r.action,
        effectSekMonth: Number(r.effect_sek_month),
        confidence: r.confidence,
        createdAt: iso(r.created_at),
      })),
      lastRun: last ? { status: last.status, createdAt: iso(last.created_at) } : null,
      manualLeft: Math.max(0, MANUAL_RUNS_PER_DAY - (manual?.n ?? 0)),
    };
  });
}

/** Markerar ett förslag som klart, avfärdat eller nytt igen. Ägare och admin (RLS). */
export async function setSuggestionStatusFor(
  viewer: Viewer,
  id: string,
  status: AiSuggestionStatus,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  await requireRoleFor(viewer.user, viewer.organization.id, ADVISOR_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const result = Array.from(
      await tx.execute(
        sql`update public.ai_suggestions set status = ${status}
            where organization_id = ${viewer.organization.id} and id = ${id}
            returning id`,
      ),
    );
    return result.length === 1;
  });
}
