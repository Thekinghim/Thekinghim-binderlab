/**
 * Drizzle-schema för morgonbriefen på Hem (20261104180000_morgonbrief.sql): tre rader per
 * organisation och dag. Skrivs bara av servern; ägare och admin läser. Re-exporteras från
 * src/db/schema.ts.
 */

import {
  date,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type AiBriefTrigger = "cron" | "visit";
export type AiBriefStatus = "running" | "ok" | "budget" | "error";

export const aiBriefs = pgTable("ai_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  briefDate: date("brief_date", { mode: "string" }).notNull(),
  trigger: text("trigger").$type<AiBriefTrigger>().notNull(),
  status: text("status").$type<AiBriefStatus>().notNull().default("running"),
  attempts: smallint("attempts").notNull().default(1),
  lineYesterday: text("line_yesterday"),
  lineProblem: text("line_problem"),
  lineToday: text("line_today"),
  facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default({}),
  rejected: jsonb("rejected").$type<unknown[]>().notNull().default([]),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costOre: integer("cost_ore").notNull().default(0),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
