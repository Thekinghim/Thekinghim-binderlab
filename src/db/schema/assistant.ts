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

import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
