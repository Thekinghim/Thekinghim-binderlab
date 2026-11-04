/**
 * En fråga till assistenten från början till slut: inställningar, roll (läst ur
 * databasen), verktyg för rollen, historik i samtalet, loopen, kontroll av talen och
 * loggen. Händelserna skickas till `emit` (route-handlern strömmar dem som NDJSON).
 *
 * Oberoende av Next: anroparen skickar in den inloggade användaren och organisationen
 * (Viewer), så att allt kan testas mot testdatabasen med en mockad klient.
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { periodChoices } from "@/components/shell/period-state";
import type { MemberRole } from "@/db/schema";
import type { IsoDate } from "@/domain";
import { AuthorizationError, requireRoleFor } from "@/server/access";
import {
  businessToday,
  loadCostLinesFor,
  loadDataStartFor,
  loadMasterDataFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { resolveAppPeriod } from "@/server/data/core/period";
import { ALL_ROLES, type MasterData } from "@/server/data/core/types";

import { budgetState, isDemoBlocked } from "./advisor/service";
import { getAssistantConfig, type AssistantConfig } from "./config";
import { createLocalModelClient } from "./local-model";
import { insertLogFor, loadConversationFor } from "./log";
import { emptyUsage, runAssistant, runToolDirect, type RunResult } from "./loop";
import { createAnthropicClient, type ModelClient } from "./model-client";
import { pagePromptText, pageSummaryNote, summaryCallFor, type PageContext } from "./page-context";
import { systemBlocks } from "./prompt";
import { QUESTION_MAX_LENGTH, type AssistantEvent, type ToolCallRecord } from "./protocol";
import { toModelTool, toolsForRole, type AssistantTool, type ToolContext } from "./tools";
import { periodText } from "./tools/common";

export interface AskArgs {
  readonly viewer: Viewer;
  readonly question: string;
  readonly conversationId: string;
  readonly emit: (event: AssistantEvent) => void;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  /** För tester: inställningar i stället för miljövariablerna. */
  readonly config?: AssistantConfig;
  /** För tester: klient i stället för den som inställningarna anger. */
  readonly client?: ModelClient;
  /** För tester: hoppa över månadstaket (AI_MONTHLY_BUDGET_SEK). */
  readonly skipBudget?: boolean;
  /**
   * Skalets periodval ur sidans URL (period, from, to). Ger modellen perioden som är vald
   * i panelen, som gäller när frågan inte anger någon. Utelämnad: ingen vald period.
   */
  readonly shellParams?: Readonly<Record<string, string>>;
  /**
   * Sidan frågan ställdes från (AI-panelen): rutt, period, filter, VMB och detaljsida.
   * Ger modellen sidans sammanhang och en sammanfattning av vad sidan visar.
   */
  readonly page?: PageContext | null;
}

/** Perioden som är vald i panelen, tolkad som på sidorna (i organisationens tidszon). */
export function shellPeriodFor(
  params: Readonly<Record<string, string>> | undefined,
  options: { timeZone: string; dataStart: IsoDate | null; now: Date },
): { label: string; start: IsoDate; end: IsoDate } | null {
  if (!params) return null;
  const p = resolveAppPeriod(params, {
    timeZone: options.timeZone,
    dataStart: options.dataStart,
    now: options.now,
  });
  const label = periodChoices.find((c) => c.key === p.key)?.label ?? p.key;
  return { label, start: p.period.start, end: p.period.end };
}

export interface AskResult {
  readonly logId: string | null;
  readonly status: RunResult["status"] | "not-configured";
}

/** Klienten som inställningarna anger. */
export function clientFor(config: AssistantConfig & { status: "ready" }): ModelClient {
  return config.provider === "local"
    ? createLocalModelClient()
    : createAnthropicClient({
        apiKey: config.apiKey,
        model: config.model,
        effort: config.effort,
      });
}

/** Svenskt felmeddelande för ett fel från Claude API (utan nycklar eller detaljer). */
export function upstreamMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude API nekade nyckeln (401). Kontrollera ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "Nyckeln saknar behörighet till modellen (403). Kontrollera ANTHROPIC_MODEL och kontot.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return "Modellen finns inte för kontot (404). Kontrollera ANTHROPIC_MODEL.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "För många frågor just nu (429). Försök igen om en stund.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return "Claude API godtog inte frågan (400).";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Kunde inte nå Claude API. Kontrollera nätverket.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude API svarade med fel ${error.status ?? ""}.`.replace(" .", ".");
  }
  return "Assistenten stannade på ett internt fel.";
}

/** Normaliserar frågan: trimmad, högst QUESTION_MAX_LENGTH tecken. null om den är tom. */
export function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/\s+/g, " ").trim();
  if (!q || q.length > QUESTION_MAX_LENGTH) return null;
  return q;
}

/** Verktygens sammanhang för en fråga: stamdata läses en gång. */
export function toolContextFor(
  viewer: Viewer,
  role: MemberRole,
  now: Date,
  vmb = false,
): ToolContext {
  let masterPromise: Promise<MasterData> | null = null;
  return {
    viewer,
    role,
    now,
    vmb,
    today: businessToday(now, viewer.organization.timezone),
    timeZone: viewer.organization.timezone,
    master: () => (masterPromise ??= loadMasterDataFor(viewer, now)),
  };
}

export async function askAssistant(args: AskArgs): Promise<AskResult> {
  const started = Date.now();
  const now = args.now ?? new Date();
  const { viewer, emit } = args;
  const config = args.config ?? getAssistantConfig();

  if (config.status !== "ready") {
    emit({ type: "error", code: "not-configured", message: config.message });
    return { logId: null, status: "not-configured" };
  }

  // Rollen läses ur databasen (under RLS), inte ur sessionen.
  let role: MemberRole;
  try {
    role = await requireRoleFor(viewer.user, viewer.organization.id, ALL_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      emit({ type: "error", code: "forbidden", message: error.message });
      return { logId: null, status: "error" };
    }
    throw error;
  }

  // Månadstaket gäller bara Claude API (inte den lokala testmodellen eller testklienter).
  let budgetLeft: number | null = null;
  if (config.provider === "anthropic" && !args.client && !args.skipBudget) {
    // Kan taket inte läsas skickas inget till Claude.
    let exceeded = true;
    budgetLeft = null;
    if (isDemoBlocked(viewer.organization.slug, process.env)) {
      console.warn("[assistent] demoorganisationen anropar inte Claude i produktion.");
    } else {
      try {
        const budget = await budgetState(undefined, now);
        exceeded = budget.exceeded;
        budgetLeft = budgetLeftShare(budget);
        if (exceeded) {
          console.warn(
            `[assistent] månadens AI-budget (${Math.round(budget.budgetOre / 100)} kr) är slut; höj AI_MONTHLY_BUDGET_SEK.`,
          );
        }
      } catch (error) {
        console.error("[assistent] AI-budgeten kunde inte läsas:", error);
      }
    }
    if (exceeded) {
      emit({ type: "error", code: "budget", message: "Månadens AI-budget är slut." });
      return { logId: null, status: "error" };
    }
  }

  const ctx = toolContextFor(viewer, role, now, args.page?.vmb === true);
  const today = ctx.today;
  const tools = toolsForRole(role);
  const client = args.client ?? clientFor(config);
  const shellParams = args.page ? args.page.shell : args.shellParams;
  const [history, dataStart, costLines] = await Promise.all([
    // Bara rader som rollen får se nu: en nedgraderad användare får ingen ekonomihistorik.
    loadConversationFor(viewer.user, viewer.organization.id, args.conversationId, { role }),
    loadDataStartFor(viewer),
    // Hyra och fasta kostnader: utan dem pratar assistenten inte om dem (bara ekonomiroller).
    role === "refiller" ? null : loadCostLinesFor(viewer).catch(() => null),
  ]);

  emit({
    type: "start",
    conversationId: args.conversationId,
    provider: client.provider,
    model: client.model,
    tools: tools.map((t) => ({ name: t.name, label: t.title })),
  });

  const shellPeriod = shellPeriodFor(shellParams, {
    timeZone: viewer.organization.timezone,
    dataStart,
    now,
  });
  const pageContext = args.page
    ? await pageContextFor(args.page, { ctx, tools, period: shellPeriod })
    : null;
  for (const record of pageContext?.records ?? []) emit({ type: "tool_result", call: record });

  let result: RunResult;
  let failure: string | null = null;
  const executed: ToolCallRecord[] = [];
  // Räknas upp under loopen: även en avbruten fråga loggas med det den kostade.
  const usage = emptyUsage();
  try {
    result = await runAssistant({
      client,
      tools,
      modelTools: tools.map(toModelTool),
      ctx,
      system: systemBlocks({
        organizationName: viewer.organization.name,
        role,
        today,
        timeZone: viewer.organization.timezone,
        dataStart,
        shellPeriod,
        page: pageContext?.text ?? null,
        costLines,
      }),
      prefetched: pageContext?.records ?? [],
      questionNote: pageContext?.summary ? pageSummaryNote(pageContext.summary) : null,
      history,
      question: args.question,
      emit,
      signal: args.signal,
      onToolCall: (record) => executed.push(record),
      usage,
    });
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) {
      console.error("[assistent] frågan avbröts:", error);
    }
    failure = args.signal?.aborted ? "Frågan avbröts." : upstreamMessage(error);
    result = {
      status: "error",
      answer: "",
      toolCalls: [...(pageContext?.records ?? []), ...executed],
      verification: { checked: 0, unverified: [] },
      usage: { ...usage },
      actions: [],
      model: null,
    };
  }

  const durationMs = Date.now() - started;
  let logId: string | null = null;
  try {
    logId = await insertLogFor(viewer.user, {
      organizationId: viewer.organization.id,
      conversationId: args.conversationId,
      role,
      question: args.question,
      answer: result.answer,
      status: result.status,
      provider: client.provider,
      // Modellen som faktiskt svarade (reservmodell vid fallbacks), annars den konfigurerade.
      model: result.model ?? client.model,
      toolCalls: result.toolCalls,
      verification: result.verification,
      usage: result.usage,
      error: failure,
      durationMs,
    });
  } catch (error) {
    console.error("[assistent] loggen kunde inte sparas:", error);
  }

  if (failure !== null) {
    emit({ type: "error", code: "upstream", message: failure, logId });
  } else {
    emit({
      type: "done",
      logId,
      status: result.status,
      answer: result.answer,
      verification: result.verification,
      usage: result.usage,
      durationMs,
      actions: result.actions,
      budgetLeft,
    });
  }
  return { logId, status: result.status };
}

/** Andel av budgeten kvar (0–1), bara när mindre än 20 % är kvar; annars null. */
export function budgetLeftShare(budget: { spentOre: number; budgetOre: number }): number | null {
  if (budget.budgetOre <= 0) return 0;
  const left = Math.max(0, budget.budgetOre - budget.spentOre) / budget.budgetOre;
  return left < BUDGET_WARN ? Math.round(left * 100) / 100 : null;
}
const BUDGET_WARN = 0.2;

/**
 * Sidans sammanhang: namn på filter och detaljsida, och sammanfattningen från verktyget
 * som sidan motsvarar (körd i förväg med sidans period och filter). Fel stoppar aldrig
 * frågan: då får modellen bara sidans namn.
 */
async function pageContextFor(
  page: PageContext,
  args: {
    ctx: ToolContext;
    tools: readonly AssistantTool<never>[];
    period: { label: string; start: IsoDate; end: IsoDate } | null;
  },
): Promise<{ text: string; summary: string | null; records: ToolCallRecord[] }> {
  const { ctx, tools } = args;
  const master = await ctx.master();
  const store = page.storeId ? master.stores.find((s) => s.id === page.storeId) : null;
  const machine = page.machineId ? master.machines.find((m) => m.id === page.machineId) : null;
  let detailName: string | null = null;
  if (page.detail?.kind === "automat") {
    const ref = page.detail.ref.toLowerCase();
    const m = master.machines.find((x) => x.code.toLowerCase() === ref || x.id === ref);
    detailName = m ? `automaten ${m.name} (${m.code})` : null;
  } else if (page.detail?.kind === "butik") {
    const st = master.stores.find((x) => x.id === page.detail!.ref);
    detailName = st ? `butiken ${st.name}` : null;
  } else if (page.detail?.kind === "titel") {
    const t = master.titles.find((x) => x.id === page.detail!.ref);
    detailName = t ? `titeln ${t.name}` : null;
  }
  const period = args.period ?? { label: "", start: ctx.today, end: ctx.today };
  const call = summaryCallFor(page, ctx.role, period);
  const records: ToolCallRecord[] = [];
  if (call && tools.some((t) => t.name === call.tool)) {
    try {
      const record = await runToolDirect({ tools, ctx }, call.tool, call.input, "sidan_1");
      if (record.ok) records.push(record);
    } catch (error) {
      console.error("[assistent] sidans sammanfattning kunde inte räknas:", error);
    }
  }
  const summary = records[0]
    ? [records[0].summary, ...records[0].figures.map((f) => `${f.label}: ${f.value}`)].join(" · ")
    : null;
  return {
    text: pagePromptText({
      page,
      periodText: args.period
        ? `${args.period.label}, ${periodText({ start: args.period.start, end: args.period.end })} (${args.period.start} till ${args.period.end})`
        : null,
      storeName: store?.name ?? null,
      machineName: machine ? `${machine.name} (${machine.code})` : null,
      detailName,
      summary,
    }),
    summary,
    records,
  };
}
