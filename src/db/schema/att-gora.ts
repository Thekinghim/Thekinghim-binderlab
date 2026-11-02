/**
 * Drizzle-schema för avbockningar i Att göra (migreringarna
 * 20261102113602_att_gora_todo_dismissals.sql och 20261102141800_att_gora_dismissal_title.sql).
 * Re-exporteras från src/db/schema.ts.
 *
 * Koden i src/app/(app)/att-gora/_lib/service.ts och src/server/data/core/queries.ts läser och
 * skriver tabellen med SQL som användaren (RLS); schemat finns för katalogtesterna,
 * testfixturen och typerna.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** En avbockad punkt i Att göra: döljs så länge orsakens fingerprint är detsamma. */
export const todoDismissals = pgTable("todo_dismissals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  todoKey: text("todo_key").notNull(),
  /** Genererad kopia av todo_key (läses av de gemensamma laddarna). */
  key: text("key").generatedAlwaysAs(sql`todo_key`),
  fingerprint: text("fingerprint").notNull(),
  /** Rubriken när punkten bockades av (för listan Avbockade). Inga belopp. */
  title: text("title"),
  dismissedBy: uuid("dismissed_by"),
  dismissedAt: ts("dismissed_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
