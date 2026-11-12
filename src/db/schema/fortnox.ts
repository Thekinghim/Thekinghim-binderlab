/**
 * Drizzle-schema för Fortnox (migreringen 20261220000000_fortnox.sql, docs/decisions.md
 * ADR 31): kopplingen, senaste körningen och utkorgen med verifikat. Re-exporteras från
 * src/db/schema.ts. Token ligger i Supabase Vault, inte i någon tabell.
 */

import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type FortnoxConnectionStatus = "connected" | "needs_reconnect";

/** Kopplingen per organisation. Skapas och tas bort av servern; ägare och admin ändrar valen. */
export const fortnoxConnections = pgTable("fortnox_connections", {
  id: id(),
  organizationId: orgId(),
  status: text("status").$type<FortnoxConnectionStatus>().notNull().default("connected"),
  /** false = torrkörning. */
  live: boolean("live").notNull().default(false),
  startMonth: day("start_month"),
  voucherSeries: text("voucher_series").notNull().default("A"),
  mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull().default({}),
  fortnoxTenant: text("fortnox_tenant"),
  companyName: text("company_name"),
  connectedAt: ts("connected_at").notNull().defaultNow(),
  connectedBy: uuid("connected_by"),
  ...stamps(),
});

/** Senaste körningen av jobbet. Bara servern skriver. */
export const fortnoxSyncState = pgTable("fortnox_sync_state", {
  id: id(),
  organizationId: orgId(),
  lastRunAt: ts("last_run_at"),
  lastOkAt: ts("last_ok_at"),
  lastError: text("last_error"),
  failures: integer("failures").notNull().default(0),
  leaseUntil: ts("lease_until"),
  ...stamps(),
});

export type FortnoxVoucherState = "pending" | "sending" | "sent" | "blocked";

/** Utkorgen: ett verifikat per rad. Ett skickat verifikat ändras aldrig. Bara servern skriver. */
export const fortnoxVouchers = pgTable("fortnox_vouchers", {
  id: id(),
  organizationId: orgId(),
  idemKey: text("idem_key").notNull(),
  kind: text("kind").notNull(),
  sourceRef: text("source_ref").notNull(),
  version: integer("version").notNull().default(1),
  voucherDate: day("voucher_date").notNull(),
  description: text("description").notNull(),
  rows: jsonb("rows").$type<{ account: string; amountOre: number; text: string }[]>().notNull(),
  fingerprint: text("fingerprint").notNull(),
  state: text("state").$type<FortnoxVoucherState>().notNull().default("pending"),
  blockCode: text("block_code"),
  blockDetail: text("block_detail"),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: ts("claimed_at"),
  attemptSeries: text("attempt_series"),
  attemptYear: integer("attempt_year"),
  sentAt: ts("sent_at"),
  fortnoxSeries: text("fortnox_series"),
  fortnoxNumber: integer("fortnox_number"),
  fortnoxYear: integer("fortnox_year"),
  reversesId: uuid("reverses_id"),
  ...stamps(),
});
