/**
 * Drizzle-schema för Värde (migreringen 20261111000000_varde.sql). Re-exporteras från
 * src/db/schema.ts. automation_log skrivs bara av servern; ägare och admin läser.
 */

import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type AutomationLogKind = "awish_push";

/** Arbete som Binderlab gjort automatiskt (append-only). */
export const automationLog = pgTable("automation_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  kind: text("kind").$type<AutomationLogKind>().notNull(),
  machineId: uuid("machine_id"),
  units: integer("units").notNull().default(0),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
