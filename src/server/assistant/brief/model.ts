/**
 * Anropet till Claude för morgonbriefen, bakom ett litet gränssnitt (testerna skickar in
 * en egen). Den billiga modellen, inget tänkande, ett tvingat verktygsanrop med tre
 * korta strängar, lågt max_tokens och kort tidsgräns.
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { TokenUsage } from "../advisor/pricing";

import { BRIEF_TOOL, BRIEF_TOOL_NAME } from "./check";

export interface BriefRequest {
  readonly instructions: string;
  readonly message: string;
}

export interface BriefResponse {
  /** Indata till spara_brief, eller null om modellen inte anropade verktyget. */
  readonly toolInput: unknown;
  readonly stopReason: string | null;
  readonly model: string;
  readonly usage: TokenUsage;
}

export interface BriefModel {
  readonly model: string;
  write(request: BriefRequest): Promise<BriefResponse>;
}

const MAX_TOKENS = 600;
const TIMEOUT_MS = 30_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function createAnthropicBrief(options: {
  apiKey: string;
  model: string;
  client?: Anthropic;
}): BriefModel {
  const client =
    options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  return {
    model: options.model,
    async write(request) {
      const message = await client.beta.messages.create({
        model: options.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: "low" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: [{ type: "text", text: request.instructions }],
        tools: [BRIEF_TOOL],
        tool_choice: { type: "tool", name: BRIEF_TOOL_NAME },
        messages: [{ role: "user", content: request.message }],
      });
      const call = message.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock =>
          b.type === "tool_use" && b.name === BRIEF_TOOL_NAME,
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
