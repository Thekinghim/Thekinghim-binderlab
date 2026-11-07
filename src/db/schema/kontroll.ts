/**
 * Drizzle-schema för Daglig kontroll (migreringen 20261114000000_daglig_kontroll.sql).
 * Re-exporteras från src/db/schema.ts. self_check_runs skrivs bara av servern; ägare och
 * admin läser. Kontrollernas form: src/analytics/self-check.
 */

import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type SelfCheckTrigger = "schedule" | "manual";
export type SelfCheckRunStatus = "ok" | "warning" | "failed" | "error";

/** En körning av kontrollen (append-only). */
export const selfCheckRuns = pgTable("self_check_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  ranAt: ts("ran_at").notNull().defaultNow(),
  trigger: text("trigger").$type<SelfCheckTrigger>().notNull(),
  status: text("status").$type<SelfCheckRunStatus>().notNull(),
  failed: integer("failed").notNull().default(0),
  warnings: integer("warnings").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  checks: jsonb("checks").$type<unknown[]>().notNull().default([]),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
