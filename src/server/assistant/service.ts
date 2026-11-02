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

import type { MemberRole } from "@/db/schema";
import { AuthorizationError, requireRoleFor } from "@/server/access";
import {
  businessToday,
  loadDataStartFor,
  loadMasterDataFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { ALL_ROLES, type MasterData } from "@/server/data/core/types";

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

  const ctx = toolContextFor(viewer, role, now);
  const today = ctx.today;
  const tools = toolsForRole(role);
  const client = args.client ?? clientFor(config);
  const [history, dataStart] = await Promise.all([
    loadConversationFor(viewer.user, viewer.organization.id, args.conversationId),
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
      model: client.model,
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
