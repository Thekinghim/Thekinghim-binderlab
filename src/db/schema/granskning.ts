/**
 * Drizzle-schema för loggen över dataexporter (migreringen
 * 20261111020100_granskning_dataexport.sql). Re-exporteras från src/db/schema.ts.
 *
 * Raderna skrivs bara av RPC:n start_data_export (ägaren, högst 3 per timme) och läses
 * med SQL som användaren (RLS) i src/server/export; schemat finns för katalogtesterna och
 * typerna.
 */

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** En export av organisationens data (Inställningar → Exportera all data). Append-only. */
export const dataExports = pgTable("data_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  format: text("format").$type<"zip-csv">().notNull().default("zip-csv"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
