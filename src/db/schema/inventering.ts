/**
 * Drizzle-schema för Inventering (migreringen 20261121000000_inventering.sql).
 * Re-exporteras från src/db/schema.ts. Skrivs bara via RPC:n save_stock_count;
 * klientrollerna läser bara (ägare, admin, läsare).
 */

import { integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** En rad i en sparad inventering: vad appen trodde och vad som räknades. */
export interface StockCountLineJson {
  titleId: string;
  name: string;
  previous: number;
  counted: number;
  eventId: string;
}

/** En sparad inventering av ett eget lager (append-only). */
export const stockCounts = pgTable("stock_counts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  clientId: uuid("client_id").notNull(),
  locationId: uuid("location_id").notNull(),
  lineCount: integer("line_count").notNull(),
  changedCount: integer("changed_count").notNull(),
  lines: jsonb("lines").$type<StockCountLineJson[]>().notNull(),
  countedAt: ts("counted_at").notNull().defaultNow(),
  countedBy: uuid("counted_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
