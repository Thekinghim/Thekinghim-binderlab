/**
 * Klienten mot språkmodellen, bakom ett litet gränssnitt så att loopen (loop.ts) kan
 * köras med Claude API, med den lokala testmodellen (local-model.ts) eller med en
 * mockad klient i testerna.
 *
 * Ett "varv" är ett anrop till Messages API med strömning: textdelar skickas till
 * `onText` medan de kommer, och hela meddelandet returneras när varvet är klart
 * (stop_reason avgör om loopen kör verktyg eller är klar).
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_ASSISTANT_EFFORT, type AssistantEffort, type AssistantModel } from "./config";

export type ModelMessage = Anthropic.Beta.BetaMessage;
export type ModelMessageParam = Anthropic.Beta.BetaMessageParam;
export type ModelTool = Anthropic.Beta.BetaTool;
export type ModelSystemBlock = Anthropic.Beta.BetaTextBlockParam;

export interface ModelTurnRequest {
  readonly system: readonly ModelSystemBlock[];
  readonly tools: readonly ModelTool[];
  readonly messages: readonly ModelMessageParam[];
  readonly signal?: AbortSignal;
}

export interface ModelClient {
  readonly provider: "anthropic" | "local";
  readonly model: string;
  /** Ett varv. `onText` får textdelarna i den ordning de genereras. */
  turn(request: ModelTurnRequest, onText: (delta: string) => void): Promise<ModelMessage>;
}

/**
 * Svarets längd per varv (tänkande + text + verktygsanrop). Strömmat, så taket orsakar inga
 * tidsgränser i SDK:n; svaren är korta, men tänkandet på hög insats behöver utrymme.
 */
const MAX_TOKENS = 32_000;
/** Serverstyrd reserv om modellen avböjer av policyskäl (samma anrop, annan modell). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude API via @anthropic-ai/sdk. Adaptivt tänkande (det enda läget på Opus 5.5),
 * strömning, cachning av systemprompt och verktyg (de är desamma i varje varv och
 * för varje fråga i samma roll) och serverstyrd reserv vid avböjande.
 */
export function createAnthropicClient(options: {
  apiKey: string;
  model: AssistantModel;
  /**
   * Insatsen (ANTHROPIC_EFFORT_CHAT, standard hög). Sätts alltid uttryckligen: Opus 5.5 har
   * medel som standard och Sonnet 5.5 hög.
   */
  effort?: AssistantEffort;
  /** För tester: egen klient. */
  client?: Anthropic;
}): ModelClient {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  return {
    provider: "anthropic",
    model: options.model,
    async turn(request, onText) {
      const stream = client.beta.messages.stream(
        {
          model: options.model,
          max_tokens: MAX_TOKENS,
          // Adaptivt tänkande är det enda läget på Opus 5.5 (disabled och budget_tokens ger 400).
          thinking: { type: "adaptive" },
          output_config: { effort: options.effort ?? DEFAULT_ASSISTANT_EFFORT },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          // Automatisk brytpunkt sist i samtalet (verktygsvarven läses ur cachen). Verktygen och
          // första systemblocket har en egen brytpunkt (prompt.ts), så att de läses ur cachen
          // även när sidans sammanhang i andra blocket byts.
          cache_control: { type: "ephemeral" },
          system: [...request.system],
          tools: [...request.tools],
          tool_choice: { type: "auto" },
          messages: [...request.messages],
        },
        { signal: request.signal },
      );
      stream.on("text", (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}
