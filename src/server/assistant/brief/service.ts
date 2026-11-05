/**
 * Morgonbriefen på Hem: tre rader per organisation och dag ("I går", "Fel", "Gör i dag").
 *
 * Tas fram en gång per dag, i AI-rådgivarens dagliga körning (runBriefsForAll från
 * /api/cron/ai) eller vid första besöket på Hem samma dag (ensureBrief med trigger
 * "visit"). Underlaget läses som besökaren (eller organisationens ägare i cron) med de
 * vanliga laddarna, så att talen är desamma som på Hem och i Att göra. Den billiga
 * modellen (AI_BRIEF_MODEL, standard claude-sonnet-5-5) skriver raderna; en rad vars tal
 * inte finns i underlaget byts mot den fasta raden. Kostnaden sparas i ai_briefs och
 * räknas in i månadstaket (monthCostOre).
 *
 * Briefen visas bara för ägare och admin, och inte alls när AI saknas (ingen
 * ANTHROPIC_API_KEY) eller i demon. Ett fel stoppar aldrig Hem: då visas ingen brief.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { addDays, type IsoDate } from "@/domain";
import {
  AuthorizationError,
  listOrganizationsFor,
  requireRoleFor,
  withUserDbFor,
} from "@/server/access";
import { businessToday, loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { loadRankedTodoStateFor } from "@/server/data/todos";

import { budgetFrom, costOre, type TokenUsage } from "../advisor/pricing";
import {
  advisorConfigFrom,
  DEFAULT_ADVISOR_MODEL,
  isDemoBlocked,
  monthCostOre,
} from "../advisor/service";

import { BRIEF_INSTRUCTIONS, briefUserMessage, checkBrief, type BriefRejection } from "./check";
import { buildBriefFacts, type BriefFacts, type BriefLines } from "./facts";
import { createAnthropicBrief, type BriefModel } from "./model";

type Env = Readonly<Record<string, string | undefined>>;

const BRIEF_ROLES = ["owner", "admin"] as const;
/** Högst så många försök per dag (fel från API:t ger ett nytt försök vid nästa besök). */
export const BRIEF_MAX_ATTEMPTS = 3;
/** En körning som pågått längre än så räknas som avbruten. */
const RUNNING_STALE_MINUTES = 3;

export interface BriefView {
  readonly date: IsoDate;
  readonly lines: BriefLines;
}

export type BriefOutcome =
  | { readonly status: "ok"; readonly brief: BriefView; readonly fresh: boolean }
  | { readonly status: "off" | "busy" | "budget" | "gave-up" | "error" | "no-access" };

export interface BriefArgs {
  readonly viewer: Viewer;
  readonly trigger: "cron" | "visit";
  readonly now?: Date;
  readonly env?: Env;
  /** För tester: egen modell i stället för Claude API. */
  readonly model?: BriefModel;
  readonly db?: Db;
}

/** Modellen för briefen: AI_BRIEF_MODEL, annars den billiga (inte AI_ADVISOR_MODEL). */
export function briefModelFrom(env: Env): { apiKey: string; model: string } | null {
  const config = advisorConfigFrom({
    ...env,
    AI_ADVISOR_MODEL: env.AI_BRIEF_MODEL?.trim() || DEFAULT_ADVISOR_MODEL,
  });
  return config.status === "ready" ? { apiKey: config.apiKey, model: config.model } : null;
}

function lockKey(orgId: string): bigint {
  // Andra halvan av uuid:t, så att låset skiljer sig från rådgivarens.
  return BigInt.asIntN(64, BigInt(`0x${orgId.replace(/-/g, "").slice(16, 32)}`));
}

interface BriefRow {
  id: string;
  status: string;
  attempts: number;
  line_yesterday: string | null;
  line_problem: string | null;
  line_today: string | null;
}

function viewOf(date: IsoDate, row: BriefRow): BriefView | null {
  if (row.status !== "ok" || !row.line_yesterday || !row.line_problem || !row.line_today) {
    return null;
  }
  return {
    date,
    lines: { yesterday: row.line_yesterday, problem: row.line_problem, today: row.line_today },
  };
}

/** Underlaget för dagen: gårdagen mot samma veckodag veckan före och Att göra. */
export async function loadBriefFactsFor(viewer: Viewer, now: Date): Promise<BriefFacts> {
  const today = businessToday(now, viewer.organization.timezone);
  const yesterday = addDays(today, -1);
  const weekBefore = addDays(yesterday, -7);
  const [data, todos] = await Promise.all([
    loadDomainInputFor(
      viewer,
      {
        period: { start: yesterday, end: yesterday },
        compare: { start: weekBefore, end: weekBefore },
      },
      now,
    ),
    loadRankedTodoStateFor(viewer, now),
  ]);
  return buildBriefFacts({
    today,
    yesterday: data.current,
    weekBefore: data.previous,
    machines: data.machines,
    // Hela listan, så att antalen (attGora) är samma tal som Att göra visar.
    todos: todos.items,
  });
}

/**
 * Dagens brief för organisationen: läser den sparade, eller tar fram den om den saknas
 * (en gång per dag, med lås per organisation så att två besök samtidigt blir ett anrop).
 */
export async function ensureBrief(args: BriefArgs): Promise<BriefOutcome> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  const db = args.db ?? getServiceDb();
  const orgId = args.viewer.organization.id;
  const date = businessToday(now, args.viewer.organization.timezone);

  try {
    await requireRoleFor(args.viewer.user, orgId, BRIEF_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) return { status: "no-access" };
    throw error;
  }

  let model = args.model;
  if (!model) {
    if (isDemoBlocked(args.viewer.organization.slug, env)) return { status: "off" };
    const config = briefModelFrom(env);
    if (!config) return { status: "off" };
    model = createAnthropicBrief(config);
  }

  const { budgetOre, usdSek } = budgetFrom(env);
  const gate = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(orgId)})`);
    const [row] = Array.from(
      await tx.execute(
        sql`select id, status, attempts, line_yesterday, line_problem, line_today,
                   (status = 'running' and updated_at > now() - make_interval(mins => ${RUNNING_STALE_MINUTES})) as busy
            from public.ai_briefs
            where organization_id = ${orgId} and brief_date = ${date}::date`,
      ),
    ) as unknown as Array<BriefRow & { busy: boolean }>;
    if (row?.status === "ok") return { kind: "done" as const, row };
    if (row?.status === "budget") return { kind: "budget" as const };
    if (row?.busy) return { kind: "busy" as const };
    if (row && row.attempts >= BRIEF_MAX_ATTEMPTS) return { kind: "gave-up" as const };
    const spent = await monthCostOre(db, now, usdSek);
    const status = spent >= budgetOre ? "budget" : "running";
    const [saved] = Array.from(
      await tx.execute(
        sql`insert into public.ai_briefs (organization_id, brief_date, trigger, status, model)
            values (${orgId}, ${date}::date, ${args.trigger}, ${status}, ${model.model})
            on conflict (organization_id, brief_date) do update set
              status = excluded.status,
              trigger = excluded.trigger,
              model = excluded.model,
              attempts = public.ai_briefs.attempts + 1,
              error = null
            returning id`,
      ),
    ) as Array<{ id: string }>;
    return status === "budget"
      ? { kind: "budget" as const }
      : { kind: "run" as const, id: saved!.id };
  });

  if (gate.kind === "done") {
    const brief = viewOf(date, gate.row);
    return brief ? { status: "ok", brief, fresh: false } : { status: "error" };
  }
  if (gate.kind !== "run") return { status: gate.kind };

  const finish = async (fields: {
    status: "ok" | "error";
    lines?: BriefLines;
    facts?: BriefFacts;
    rejected?: BriefRejection[];
    usage?: TokenUsage;
    model?: string;
    error?: string;
  }) => {
    const usage = fields.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const usedModel = (fields.model ?? model.model).slice(0, 100);
    const cost = costOre(usedModel, usage, usdSek);
    const clip = (s: string | undefined) => (s === undefined ? null : s.slice(0, 200));
    await db.execute(
      sql`update public.ai_briefs set
            status = ${fields.status},
            model = ${usedModel},
            line_yesterday = ${clip(fields.lines?.yesterday)},
            line_problem = ${clip(fields.lines?.problem)},
            line_today = ${clip(fields.lines?.today)},
            facts = ${JSON.stringify(fields.facts ?? {})}::jsonb,
            rejected = ${JSON.stringify(fields.rejected ?? [])}::jsonb,
            input_tokens = input_tokens + ${usage.inputTokens},
            output_tokens = output_tokens + ${usage.outputTokens},
            cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
            cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
            cost_ore = cost_ore + ${cost},
            error = ${fields.error?.slice(0, 2000) ?? null}
          where organization_id = ${orgId} and id = ${gate.id}`,
    );
  };

  try {
    const facts = await loadBriefFactsFor(args.viewer, now);
    const response = await model.write({
      instructions: BRIEF_INSTRUCTIONS,
      message: briefUserMessage(facts),
    });
    if (response.toolInput === null) {
      const message =
        response.stopReason === "refusal" ? "Modellen avböjde." : "Inget svar med spara_brief.";
      await finish({
        status: "error",
        facts,
        usage: response.usage,
        model: response.model,
        error: message,
      });
      return { status: "error" };
    }
    const checked = checkBrief(response.toolInput, facts);
    await finish({
      status: "ok",
      lines: checked.lines,
      facts,
      rejected: checked.rejected,
      usage: response.usage,
      model: response.model,
    });
    return { status: "ok", brief: { date, lines: checked.lines }, fresh: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Okänt fel.";
    console.error("[morgonbrief] kunde inte tas fram:", message);
    await finish({ status: "error", error: message }).catch(() => {});
    return { status: "error" };
  }
}

/**
 * Dagens brief som den inloggade läser den (under RLS), utan att ta fram en ny. null när
 * den saknas, när rollen inte får se den eller när AI saknas.
 */
export async function readBriefFor(
  viewer: Viewer,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<BriefView | null> {
  if (!briefModelFrom(env) || isDemoBlocked(viewer.organization.slug, env)) return null;
  const date = businessToday(now, viewer.organization.timezone);
  const [row] = (await withUserDbFor(viewer.user, async (tx) =>
    Array.from(
      await tx.execute(
        sql`select id, status, attempts, line_yesterday, line_problem, line_today
            from public.ai_briefs
            where organization_id = ${viewer.organization.id} and brief_date = ${date}::date`,
      ),
    ),
  )) as unknown as BriefRow[];
  return row ? viewOf(date, row) : null;
}

// ---------------------------------------------------------------------------
// Cron: alla organisationer med försäljning senaste 30 dagarna (som rådgivaren)
// ---------------------------------------------------------------------------

export interface BriefCronResult {
  readonly organizations: { id: string; status: string }[];
}

export async function runBriefsForAll(
  options: { now?: Date; env?: Env; model?: BriefModel; db?: Db } = {},
): Promise<BriefCronResult> {
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
            and not o.is_demo
            and exists (
              select 1 from public.orders x
              where x.organization_id = o.id and x.business_date >= (${now.toISOString()}::timestamptz at time zone o.timezone)::date - 30
            )
          order by o.created_at`,
    ),
  ) as Array<{ id: string; user_id: string; email: string | null }>;

  const out: BriefCronResult["organizations"] = [];
  for (const org of orgs) {
    const user = { userId: org.user_id, email: org.email ?? "" };
    try {
      const organization = (await listOrganizationsFor(user)).find((o) => o.id === org.id);
      if (!organization) {
        out.push({ id: org.id, status: "skipped" });
        continue;
      }
      const r = await ensureBrief({
        viewer: { user, organization },
        trigger: "cron",
        now,
        db,
        ...(options.env ? { env: options.env } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      out.push({ id: org.id, status: r.status });
      if (r.status === "budget" || r.status === "off") break;
    } catch (error) {
      console.error("[morgonbrief] organisationen hoppades över:", error);
      out.push({ id: org.id, status: "error" });
    }
  }
  return { organizations: out };
}
