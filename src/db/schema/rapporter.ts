/**
 * Drizzle-schema för fas 6 Rapporter (migreringarna 20261102104410_rapporter_report_approvals.sql
 * och 20261102145500_rapporter_review_fixes.sql): godkännandet av en skapad rapport och
 * markeringen att rapportens PDF har sparats. Re-exporteras från src/db/schema.ts. (Tabellerna
 * reports, report_recipients och report_deliveries ligger i schema.ts.)
 *
 * Hjälparna är lokala här för att undvika en cirkulär import med schema.ts.
 */

import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Godkännande av en rapport (append-only, en per rapport). Vem och när sätts av databasen. */
export const reportApprovals = pgTable("report_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  reportId: uuid("report_id").notNull(),
  approvedBy: uuid("approved_by"),
  approvedAt: ts("approved_at").notNull().defaultNow(),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

/**
 * En sparad fil för en rapport (append-only, en per rapport och filtyp). Skrivs först när
 * filen finns i lagringen; arkivets "PDF finns" läser härifrån.
 */
export const reportFiles = pgTable("report_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  reportId: uuid("report_id").notNull(),
  kind: text("kind").$type<"pdf">().notNull(),
  storagePath: text("storage_path").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
