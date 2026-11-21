/**
 * Drizzle-schema för V2 (docs/design/v2/byggplan.md, avsnitt 3.2–3.4). Re-exporteras från
 * src/db/schema.ts. Migreringarna:
 *
 *   20261223000000_v2_rutt.sql        route_day_changes (+ kolumner på organization_settings
 *                                     och stock_locations, som står i schema.ts)
 *   20261223000100_v2_produktbyte.sql product_swaps
 */

import { date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Ändringar i dagens rutt. */
export type RouteDayChangeKind = "skip" | "add" | "later";

/**
 * Ändringar i dagens rutt: hoppa över, lägg till, till i morgon. Skrivs av ägare, admin och
 * påfyllare; ångras med undone_at (raden står kvar). Högst en gällande ändring per automat
 * och dag.
 */
export const routeDayChanges = pgTable("route_day_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  machineId: uuid("machine_id").notNull(),
  change: text("change").$type<RouteDayChangeKind>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  undoneAt: ts("undone_at"),
  undoneBy: uuid("undone_by"),
});

/**
 * Produktbyten i Awish-fack (append-only, inga belopp). Bara saldosynken skriver; alla
 * medlemmar läser.
 */
export const productSwaps = pgTable("product_swaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  channel: text("channel").notNull(),
  fromTitleId: uuid("from_title_id").notNull(),
  toTitleId: uuid("to_title_id").notNull(),
  returnedUnits: integer("returned_units").notNull(),
  takenUnits: integer("taken_units").notNull(),
  sourceLocationId: uuid("source_location_id"),
  transferGroupId: uuid("transfer_group_id"),
  occurredAt: ts("occurred_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
