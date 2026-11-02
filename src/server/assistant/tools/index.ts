/**
 * Assistentens verktyg och urvalet per roll. Modellen får bara verktyg som rollen har,
 * och loopen kontrollerar rollen igen innan ett verktyg körs (laddarna och RLS är
 * tredje och fjärde lagret). Inget verktyg kör fri SQL: alla anropar beräkningslagret
 * och serverladdarna med validerade parametrar.
 */

import "server-only";

import { z } from "zod";

import type { MemberRole } from "@/db/schema";

import type { ModelTool } from "../model-client";
import type { AssistantTool } from "./common";
import { insightsTool, keyMetricsTool, profitabilityTool } from "./economy";
import { forecastTool, purchasingTool } from "./purchasing";
import { coverageTool, lookupTool, salesTool, stockTool, todosTool } from "./stock";

export type { AssistantTool, ToolContext, ToolOutput } from "./common";
export { ToolInputError } from "./common";

/** Alla verktyg, i den ordning modellen ser dem (fast ordning: cachen kräver det). */
export const ALL_TOOLS: readonly AssistantTool<never>[] = [
  keyMetricsTool,
  profitabilityTool,
  insightsTool,
  purchasingTool,
  forecastTool,
  salesTool,
  stockTool,
  coverageTool,
  todosTool,
  lookupTool,
] as unknown as readonly AssistantTool<never>[];

/** Verktygen som rollen får. */
export function toolsForRole(role: MemberRole): readonly AssistantTool<never>[] {
  return ALL_TOOLS.filter((t) => t.roles.includes(role));
}

/** Verktyget som API-definition (JSON Schema ur zod-schemat). */
export function toModelTool(tool: AssistantTool<never>): ModelTool {
  const schema = z.toJSONSchema(tool.input as z.ZodType, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const inputSchema = { ...schema };
  delete inputSchema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema as ModelTool["input_schema"],
    // Svaren strömmas: verktygsparametrarna valideras med zod innan verktyget körs.
    eager_input_streaming: true,
  };
}
