/**
 * Byggstenar för klienter som inte anropar Claude API: den lokala testmodellen
 * (local-model.ts) och de mockade klienterna i testerna. Bygger meddelanden med samma
 * form som Messages API returnerar.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { ModelMessage, ModelMessageParam } from "./model-client";

let counter = 0;

/** Ett assistentmeddelande som API:t skulle ha returnerat det. */
export function scriptedMessage(
  model: string,
  content: Anthropic.Beta.BetaContentBlock[],
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = content.some(
    (b) => b.type === "tool_use",
  )
    ? "tool_use"
    : "end_turn",
): ModelMessage {
  counter += 1;
  return {
    id: `msg_lokal_${counter}`,
    type: "message",
    role: "assistant",
    model,
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as ModelMessage["usage"],
  };
}

export function textBlock(text: string): Anthropic.Beta.BetaTextBlock {
  return { type: "text", text, citations: null };
}

export function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_lokal_${++counter}`,
): Anthropic.Beta.BetaToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** Verktygsresultaten i det senaste användarmeddelandet (tomt om det är en fråga). */
export function lastToolResults(
  messages: readonly ModelMessageParam[],
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.flatMap((block) =>
    block.type === "tool_result"
      ? [
          {
            toolUseId: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : (block.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""),
            isError: block.is_error === true,
          },
        ]
      : [],
  );
}

/** Den senaste frågan i klartext (sista textblocket när frågan har data före sig). */
export function lastQuestion(messages: readonly ModelMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (m.content.some((b) => b.type === "tool_result")) continue;
    const texts = m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    if (texts.length > 0) return texts[texts.length - 1]!;
  }
  return "";
}

/** Sant om meddelandet är en fråga (text), inte verktygsresultat. */
export function isQuestion(m: ModelMessageParam): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b) => b.type === "tool_result");
}
