/**
 * Drizzle-schema för assistenten (migreringen 20261102124000_assistent_assistant_logs.sql):
 * loggen över frågor och svar. Re-exporteras från src/db/schema.ts.
 *
 * Hjälparna är lokala här för att undvika en cirkulär import med schema.ts. Uppräkningen
 * member_role finns redan i schema.ts (`memberRole`); här deklareras den lokalt och
 * exporteras inte, så att den inte räknas två gånger i katalogtesterna.
 *
 * Raderna skrivs bara via private.insert_assistant_log (migreringen
 * 20261102134800_assistent_assistant_logs_hardening.sql), aldrig med en vanlig INSERT.
 */

import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
// Samma värden som `memberRole` i schema.ts (inklusive "store"); hålls i takt med den.
const memberRoleRef = pgEnum("member_role", ["owner", "admin", "refiller", "viewer", "store"]);

export type AssistantLogStatus = "answered" | "unverified" | "refused" | "limit" | "error";
export type AssistantProviderKind = "anthropic" | "local";

/** En fråga till assistenten med svar och underlag (append-only). */
export const assistantLogs = pgTable("assistant_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  userId: uuid("user_id"),
  role: memberRoleRef("role").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull().default(""),
  status: text("status").$type<AssistantLogStatus>().notNull(),
  provider: text("provider").$type<AssistantProviderKind>().notNull(),
  model: text("model").notNull(),
  toolCalls: jsonb("tool_calls").$type<unknown[]>().notNull().default([]),
  verification: jsonb("verification").$type<Record<string, unknown>>().notNull().default({}),
  usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

// ---------------------------------------------------------------------------
// AI-rådgivaren (20261104090000_ai_radgivare.sql). Skrivs bara av servern; ägare och
// admin läser och ändrar status på förslagen.
// ---------------------------------------------------------------------------

export type AiRunTrigger = "cron" | "manual";
export type AiRunStatus = "running" | "ok" | "empty" | "budget" | "error";
export type AiSuggestionStatus = "new" | "done" | "dismissed";
export type AiConfidence = "high" | "medium" | "low";

/** En körning av rådgivaren med tokenåtgång och kostnad. */
export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  trigger: text("trigger").$type<AiRunTrigger>().notNull(),
  status: text("status").$type<AiRunStatus>().notNull().default("running"),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costOre: integer("cost_ore").notNull().default(0),
  accepted: integer("accepted").notNull().default(0),
  rejected: jsonb("rejected").$type<unknown[]>().notNull().default([]),
  error: text("error"),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Ett förslag från rådgivaren. */
export const aiSuggestions = pgTable("ai_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  runId: uuid("run_id").notNull(),
  rank: smallint("rank").notNull(),
  title: text("title").notNull(),
  why: text("why").notNull(),
  action: text("action").notNull(),
  effectSekMonth: integer("effect_sek_month").notNull(),
  confidence: text("confidence").$type<AiConfidence>().notNull(),
  status: text("status").$type<AiSuggestionStatus>().notNull().default("new"),
  statusBy: uuid("status_by"),
  statusAt: ts("status_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
