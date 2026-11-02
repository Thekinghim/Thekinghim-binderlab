/**
 * Drizzle-schema för fas 8 Drift (migreringen 20261102122143_drift_larm_arenden.sql):
 * larmprenumerationer, push-enheter, utskick och påfyllning från fältet. Re-exporteras från
 * src/db/schema.ts. (Tabellerna alerts och incidents ligger i schema.ts.)
 *
 * Hjälparna är lokala här för att undvika en cirkulär import med schema.ts. Uppräknings-
 * typen alert_severity deklareras lokalt (samma namn och värden som i schema.ts) men
 * exporteras inte, så att den inte räknas två gånger.
 */

import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const severity = pgEnum("alert_severity", ["info", "warning", "critical"]);
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Leveranstid i en prenumeration (lokal tid, 1 = måndag). */
export interface DeliveryWindowJson {
  days: number[];
  start: string;
  end: string;
}

/** En användares larmprenumeration (en per organisation). */
export const alertSubscriptions = pgTable("alert_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  /** null = alla typer. */
  kinds: text("kinds").array(),
  /** null = alla automater. */
  machineIds: uuid("machine_ids").array(),
  minSeverity: severity("min_severity").notNull().default("warning"),
  channels: text("channels")
    .array()
    .notNull()
    .default(sql`ARRAY['push', 'email']`),
  phone: text("phone"),
  quietStart: text("quiet_start"),
  quietEnd: text("quiet_end"),
  deliveryWindows: jsonb("delivery_windows").$type<DeliveryWindowJson[] | null>(),
  criticalDuringQuiet: boolean("critical_during_quiet").notNull().default(true),
  notifyResolved: boolean("notify_resolved").notNull().default(false),
  reminders: boolean("reminders").notNull().default(true),
  active: boolean("active").notNull().default(true),
  ...stamps(),
});

/** Web Push-prenumeration per webbläsare/enhet. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  authSecret: text("auth_secret").notNull(),
  userAgent: text("user_agent"),
  lastSuccessAt: ts("last_success_at"),
  lastFailureAt: ts("last_failure_at"),
  failureCount: integer("failure_count").notNull().default(0),
  disabledAt: ts("disabled_at"),
  ...stamps(),
});

/** Utskick av larm: kö (pending) och logg. Skrivs av larmjobbet. */
export const alertDeliveries = pgTable("alert_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id"),
  sendAt: ts("send_at").notNull(),
  deferred: boolean("deferred").notNull().default(false),
  status: text("status").notNull().default("pending"),
  subject: text("subject").notNull(),
  items: jsonb("items").notNull().$type<unknown[]>(),
  alertIds: uuid("alert_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  results: jsonb("results").notNull().default([]).$type<unknown[]>(),
  sentAt: ts("sent_at"),
  ...stamps(),
});

/** Påfyllning från fältet, en per klient-id (idempotent synk). Skrivs bara via register_refill_once. */
export const fieldSubmissions = pgTable("field_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  clientId: uuid("client_id").notNull(),
  kind: text("kind").notNull().default("refill"),
  machineId: uuid("machine_id").notNull(),
  titleId: uuid("title_id").notNull(),
  quantity: integer("quantity").notNull(),
  fromWarehouse: boolean("from_warehouse").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  stockEventId: uuid("stock_event_id").notNull(),
  submittedBy: uuid("submitted_by"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  ...stamps(),
});

/** En körning av larmjobbet per organisation. Skrivs av larmjobbet. */
export const alertRuns = pgTable("alert_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  ranAt: ts("ran_at").notNull(),
  status: text("status").notNull(),
  machines: integer("machines").notNull().default(0),
  candidates: integer("candidates").notNull().default(0),
  openIncidents: integer("open_incidents").notNull().default(0),
  notifications: integer("notifications").notNull().default(0),
  deliveries: integer("deliveries").notNull().default(0),
  healthSource: text("health_source").notNull().default("sales"),
  error: text("error"),
  ...stamps(),
});
