/**
 * Anropet till Claude för rådgivaren, bakom ett litet gränssnitt (testerna skickar in en
 * egen). Ett anrop, inget strömmande: lågt max_tokens, tidsgräns och ett nytt försök.
 * Strukturerat svar via verktyget spara_forslag (strikt schema), cachning av
 * instruktioner och underlag, serverstyrd reserv vid avböjande.
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { ADVISOR_TOOL, ADVISOR_TOOL_NAME } from "./grounding";
import type { TokenUsage } from "./pricing";

export interface AdvisorRequest {
  readonly instructions: string;
  /** Underlaget (JSON-text). Cachas. */
  readonly snapshot: string;
  readonly message: string;
}

export interface AdvisorResponse {
  /** Indata till spara_forslag, eller null om modellen inte anropade verktyget. */
  readonly toolInput: unknown;
  readonly stopReason: string | null;
  readonly model: string;
  readonly usage: TokenUsage;
}

export interface AdvisorModel {
  readonly model: string;
  propose(request: AdvisorRequest): Promise<AdvisorResponse>;
}

/** Svaret är ett verktygsanrop med högst fem korta förslag; tänkandet ryms också. */
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 90_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function createAnthropicAdvisor(options: {
  apiKey: string;
  model: string;
  client?: Anthropic;
}): AdvisorModel {
  const client =
    options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  return {
    model: options.model,
    async propose(request) {
      const message = await client.beta.messages.create({
        model: options.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: [
          { type: "text", text: request.instructions },
          {
            type: "text",
            text: `<underlag>\n${request.snapshot}\n</underlag>`,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [ADVISOR_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: request.message }],
      });
      const call = message.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock =>
          b.type === "tool_use" && b.name === ADVISOR_TOOL_NAME,
      );
      return {
        toolInput: message.stop_reason === "max_tokens" ? null : (call?.input ?? null),
        stopReason: message.stop_reason ?? null,
        model: message.model || options.model,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
