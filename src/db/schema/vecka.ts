/**
 * Drizzle-schema för veckosammanfattningen (migreringen
 * 20261123000000_veckosammanfattning.sql). Re-exporteras från src/db/schema.ts.
 * weekly_summaries skrivs bara av servern (en rad per person och vecka); personen läser
 * sina egna rader, ägare och admin organisationens.
 */

import { date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type WeeklySummaryStatus = "pending" | "sent" | "failed";

/** Det som skickades till en person för en vecka. */
export const weeklySummaries = pgTable("weekly_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id"),
  /** Måndagen i veckan som sammanfattas ('ÅÅÅÅ-MM-DD'). */
  weekStart: date("week_start", { mode: "string" }).notNull(),
  status: text("status").$type<WeeklySummaryStatus>().notNull().default("pending"),
  locale: text("locale").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  url: text("url").notNull(),
  figures: jsonb("figures").$type<Record<string, unknown>>().notNull().default({}),
  devices: integer("devices").notNull().default(0),
  sentAt: ts("sent_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
