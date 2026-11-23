/**
 * Drizzle-schema för notisen vid varje försäljning (migreringen 20261227000000_saljnotis.sql).
 * Re-exporteras från src/db/schema.ts. sale_notifications skrivs bara av servern: en rad per
 * order som notisjobbet har tagit om hand (unique per organisation och order).
 */

import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const saleNotifications = pgTable("sale_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  orderId: uuid("order_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
