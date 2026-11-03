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
import { runAssistant, type RunResult } from "./loop";
import { createAnthropicClient, type ModelClient } from "./model-client";
import { systemBlocks } from "./prompt";
import { QUESTION_MAX_LENGTH, type AssistantEvent, type ToolCallRecord } from "./protocol";
import { toModelTool, toolsForRole, type ToolContext } from "./tools";

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
    : createAnthropicClient({ apiKey: config.apiKey, model: config.model });
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
export function toolContextFor(viewer: Viewer, role: MemberRole, now: Date): ToolContext {
  let masterPromise: Promise<MasterData> | null = null;
  return {
    viewer,
    role,
    now,
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
  if (config.provider === "anthropic" && !args.client && !args.skipBudget) {
    // Kan taket inte läsas skickas inget till Claude.
    let exceeded = true;
    if (isDemoBlocked(viewer.organization.slug, process.env)) {
      console.warn("[assistent] demoorganisationen anropar inte Claude i produktion.");
    } else {
      try {
        const budget = await budgetState(undefined, now);
        exceeded = budget.exceeded;
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

  const ctx = toolContextFor(viewer, role, now);
  const today = ctx.today;
  const tools = toolsForRole(role);
  const client = args.client ?? clientFor(config);
  const [history, dataStart] = await Promise.all([
    // Bara rader som rollen får se nu: en nedgraderad användare får ingen ekonomihistorik.
    loadConversationFor(viewer.user, viewer.organization.id, args.conversationId, { role }),
    loadDataStartFor(viewer),
  ]);

  emit({
    type: "start",
    conversationId: args.conversationId,
    provider: client.provider,
    model: client.model,
    tools: tools.map((t) => ({ name: t.name, label: t.title })),
  });

  let result: RunResult;
  let failure: string | null = null;
  const executed: ToolCallRecord[] = [];
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
        shellPeriod: shellPeriodFor(args.shellParams, {
          timeZone: viewer.organization.timezone,
          dataStart,
          now,
        }),
      }),
      history,
      question: args.question,
      emit,
      signal: args.signal,
      onToolCall: (record) => executed.push(record),
    });
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) {
      console.error("[assistent] frågan avbröts:", error);
    }
    failure = args.signal?.aborted ? "Frågan avbröts." : upstreamMessage(error);
    result = {
      status: "error",
      answer: "",
      toolCalls: executed,
      verification: { checked: 0, unverified: [] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 },
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
    });
  }
  return { logId, status: result.status };
}
