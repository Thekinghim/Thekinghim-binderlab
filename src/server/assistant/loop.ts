/**
 * Verktygsloopen: frågan → modellen → verktyg → modellen … → svar. Varje varv strömmas;
 * verktygen körs med validerade parametrar och bara om rollen har dem. Svaret kontrolleras
 * till sist mot verktygsresultaten (verify.ts).
 *
 * Historiken skickas tillbaka oförändrad inom en fråga (assistentens innehåll, även
 * tänkandeblock, läggs till som det kom), så att modellens tänkande gäller i nästa varv.
 * Tidigare frågor i samtalet skickas bara som text (frågan och det slutliga svaret).
 *
 * Ingen databas här: verktygen får sitt sammanhang (ToolContext) och klienten är utbytbar,
 * så att hela loopen kan testas med en mockad klient.
 */

import Anthropic from "@anthropic-ai/sdk";

import { DomainError } from "@/domain";
import { AuthorizationError } from "@/server/access";

import type {
  ModelClient,
  ModelMessage,
  ModelMessageParam,
  ModelSystemBlock,
} from "./model-client";
import type {
  AssistantEvent,
  AssistantStatus,
  AssistantUsage,
  ToolCallRecord,
  ToolLink,
  Verification,
} from "./protocol";
import { ToolInputError, type AssistantTool, type ToolContext } from "./tools/common";
import { verifyNumbers } from "./verify";

/**
 * Högst så många varv (anrop till modellen) per fråga. Räcker för flerstegsfrågor
 * ("varför gick vinsten ner, och vad ska jag göra?": förändring → lönsamhet → räckvidd →
 * knappar) men är ett hårt tak mot kostnad och loopar.
 */
export const MAX_TURNS = 12;
/**
 * Högst så många utdatatokens (tänkande + text) per fråga, över alla varv. Månadstaket
 * kontrolleras före frågan; det här taket hindrar att en enda fråga drar iväg.
 */
export const MAX_OUTPUT_TOKENS_PER_QUESTION = 80_000;
/** Högst så många försök med ett varv vars verktygsparametrar inte gick att tolka. */
const MAX_JSON_RETRIES = 2;

export interface HistoryEntry {
  readonly question: string;
  readonly answer: string;
  /** Verktygsresultaten bakom svaret (räknas som underlag i kontrollen). */
  readonly sources: readonly unknown[];
}

export interface RunArgs {
  readonly client: ModelClient;
  readonly tools: readonly AssistantTool<never>[];
  readonly modelTools: readonly Anthropic.Beta.BetaTool[];
  readonly ctx: ToolContext;
  readonly system: readonly ModelSystemBlock[];
  readonly history: readonly HistoryEntry[];
  readonly question: string;
  readonly emit: (event: AssistantEvent) => void;
  readonly signal?: AbortSignal;
  readonly maxTurns?: number;
  /** Anropas för varje kört verktyg (så att anroparen kan logga dem även om loopen avbryts). */
  readonly onToolCall?: (record: ToolCallRecord) => void;
  /**
   * Verktygsresultat som hämtats i förväg (sidans sammanfattning, som modellen fick i
   * systemprompten). Räknas som underlag i kontrollen och visas i underlaget.
   */
  readonly prefetched?: readonly ToolCallRecord[];
  /** Data före frågan i användarens meddelande (sidans sammanfattning), eller utelämnad. */
  readonly questionNote?: string | null;
  /**
   * Förbrukningen räknas upp här under loopen, så att anroparen kan logga den (och räkna
   * den mot månadstaket) även när frågan avbryts eller API:t felar mitt i.
   */
  readonly usage?: MutableUsage;
}

export interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export function emptyUsage(): MutableUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
}

export interface RunResult {
  readonly status: AssistantStatus;
  readonly answer: string;
  readonly toolCalls: ToolCallRecord[];
  readonly verification: Verification;
  readonly usage: AssistantUsage;
  /** Knapparna som modellen föreslog (foresla_knapp), högst 3. */
  readonly actions: ToolLink[];
  /**
   * Modellen som svarade i sista varvet (message.model). Kan skilja sig från den
   * konfigurerade när API:t använder en reservmodell. null om inget varv blev klart.
   */
  readonly model: string | null;
}

/** Ett fel i varvet som inte är ett API-fel: parametrarna gick inte att tolka. */
function isParseFailure(error: unknown): boolean {
  return (
    !(error instanceof Anthropic.APIError) &&
    !(error instanceof Error && error.name === "AbortError")
  );
}

function textOf(message: ModelMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function errorText(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof AuthorizationError) return "Din roll får inte använda det här verktyget.";
  if (error instanceof DomainError) return error.message;
  return "Verktyget kunde inte räkna fram ett resultat (internt fel).";
}

/** Kör ett verktyg. Fel blir ett verktygsfel som modellen får se, aldrig ett avbrott. */
async function runTool(
  block: Anthropic.Beta.BetaToolUseBlock,
  args: Pick<RunArgs, "tools" | "ctx">,
): Promise<{ record: ToolCallRecord; content: string; isError: boolean }> {
  const started = Date.now();
  const tool = args.tools.find((t) => t.name === block.name);
  const rawInput =
    block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  const fail = (summary: string, extra?: unknown) => {
    const result = { fel: summary, ...(extra !== undefined ? { tips: extra } : {}) };
    return {
      record: {
        id: block.id,
        name: block.name,
        label: tool ? tool.label(rawInput as never) : block.name,
        input: rawInput,
        ok: false,
        summary,
        figures: [],
        links: [],
        result,
        durationMs: Date.now() - started,
      } satisfies ToolCallRecord,
      content: JSON.stringify(result),
      isError: true,
    };
  };

  // Rollen kontrolleras här igen: modellen kan bara ha fått rollens verktyg, men ett
  // namn utanför listan körs aldrig.
  if (!tool || !tool.roles.includes(args.ctx.role)) {
    return fail(`Verktyget ${block.name} finns inte för din roll.`);
  }
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    return fail("Ogiltiga parametrar.", {
      problem: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(parametrar)"}: ${i.message}`,
      ),
      mottaget: JSON.stringify(rawInput).slice(0, 500),
    });
  }
  try {
    const output = await tool.run(args.ctx, parsed.data as never);
    const result = { sammanfattning: output.summary, data: output.data };
    return {
      record: {
        id: block.id,
        name: tool.name,
        label: tool.label(parsed.data as never),
        input: parsed.data as Record<string, unknown>,
        ok: true,
        summary: output.summary,
        figures: output.figures,
        links: output.links,
        ...(output.actions ? { actions: output.actions } : {}),
        result,
        durationMs: Date.now() - started,
      },
      content: JSON.stringify({ ...result, lankar: output.links }),
      isError: false,
    };
  } catch (error) {
    if (!(error instanceof ToolInputError) && !(error instanceof DomainError)) {
      console.error(`[assistent] verktyget ${tool.name} misslyckades:`, error);
    }
    return fail(errorText(error), error instanceof ToolInputError ? error.hint : undefined);
  }
}

/**
 * Kör ett verktyg utan modellen (sidans sammanfattning i panelen), med samma validering och
 * rollkontroll som i loopen. Fel blir ett record med ok = false.
 */
export async function runToolDirect(
  args: Pick<RunArgs, "tools" | "ctx">,
  name: string,
  input: Record<string, unknown>,
  id: string,
): Promise<ToolCallRecord> {
  const { record } = await runTool(
    { type: "tool_use", id, name, input } as Anthropic.Beta.BetaToolUseBlock,
    args,
  );
  return { ...record, prefetched: true };
}

/** Kör loopen till ett svar. API-fel och avbrott kastas vidare (anroparen loggar dem). */
export async function runAssistant(args: RunArgs): Promise<RunResult> {
  const maxTurns = args.maxTurns ?? MAX_TURNS;
  const messages: ModelMessageParam[] = [];
  for (const h of args.history) {
    messages.push({ role: "user", content: h.question });
    messages.push({ role: "assistant", content: h.answer });
  }
  messages.push(
    args.questionNote
      ? {
          role: "user",
          content: [
            { type: "text", text: args.questionNote },
            { type: "text", text: args.question },
          ],
        }
      : { role: "user", content: args.question },
  );

  const toolCalls: ToolCallRecord[] = [];
  const usage = args.usage ?? emptyUsage();
  let status: AssistantStatus | null = null;
  let answer = "";
  let jsonRetries = 0;
  let model: string | null = null;

  for (let turn = 1; turn <= maxTurns && status === null; turn++) {
    if (turn > 1) args.emit({ type: "turn", turn });
    let message: ModelMessage;
    try {
      message = await args.client.turn(
        { system: args.system, tools: args.modelTools, messages, signal: args.signal },
        (text) => args.emit({ type: "text", text }),
      );
      jsonRetries = 0;
    } catch (error) {
      if (isParseFailure(error) && jsonRetries < MAX_JSON_RETRIES && !args.signal?.aborted) {
        jsonRetries += 1;
        // Samma varv igen. Text som redan strömmats i det misslyckade försöket ska inte
        // stå kvar: "turn" tömmer utkastet i webbläsaren innan försöket strömmar på nytt.
        args.emit({ type: "turn", turn });
        turn -= 1;
        continue;
      }
      throw error;
    }
    usage.turns += 1;
    if (message.model) model = message.model;
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    if (message.stop_reason === "refusal") {
      status = "refused";
      answer = textOf(message) || "Modellen avböjde att svara på frågan.";
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (toolUses.length === 0) {
      answer = textOf(message);
      status = message.stop_reason === "max_tokens" ? "limit" : "answered";
      break;
    }
    if (message.stop_reason === "max_tokens") {
      // Parametrarna kan vara avklippta: kör inte verktygen.
      status = "limit";
      answer = textOf(message);
      break;
    }
    if (usage.outputTokens >= MAX_OUTPUT_TOKENS_PER_QUESTION) {
      // Kostnadsspärr: inga fler varv för den här frågan.
      status = "limit";
      answer =
        textOf(message) ||
        "Frågan krävde fler steg än assistenten tillåter. Dela upp den i mindre frågor.";
      break;
    }

    messages.push({ role: "assistant", content: message.content });
    for (const block of toolUses) {
      args.emit({
        type: "tool_call",
        id: block.id,
        name: block.name,
        label:
          args.tools.find((t) => t.name === block.name)?.label(block.input as never) ?? block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const outcome = await runTool(block, args);
        args.onToolCall?.(outcome.record);
        args.emit({ type: "tool_result", call: outcome.record });
        return outcome;
      }),
    );
    toolCalls.push(...results.map((r) => r.record));
    messages.push({
      role: "user",
      content: toolUses.map((block, i) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: results[i]!.content,
        ...(results[i]!.isError ? { is_error: true } : {}),
      })),
    });
  }

  if (status === null) {
    status = "limit";
    answer =
      answer || "Frågan krävde fler steg än assistenten tillåter. Dela upp den i mindre frågor.";
  }

  const prefetched = args.prefetched ?? [];
  const sources: unknown[] = [
    args.question,
    ...prefetched.filter((c) => c.ok).map((c) => c.result),
    ...toolCalls.filter((c) => c.ok).map((c) => c.result),
    ...args.history.flatMap((h) => [h.question, ...h.sources]),
  ];
  const verification =
    status === "answered" || status === "limit"
      ? verifyNumbers(answer, sources)
      : { checked: 0, unverified: [] };
  if (status === "answered" && verification.unverified.length > 0) status = "unverified";

  const actions: ToolLink[] = [];
  for (const call of toolCalls) {
    for (const a of call.ok ? (call.actions ?? []) : []) {
      if (actions.length < 3 && !actions.some((x) => x.href === a.href)) actions.push(a);
    }
  }
  if (status === "refused") actions.length = 0;

  return {
    status,
    answer,
    toolCalls: [...prefetched, ...toolCalls],
    verification,
    usage,
    actions,
    model,
  };
}
