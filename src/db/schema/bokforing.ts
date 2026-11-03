/**
 * Drizzle-schema för Bokföring (migreringen 20261103210000_bokforing.sql): kontoplanen och
 * inställningarna, månader markerade som skickade och kvitton. Re-exporteras från
 * src/db/schema.ts. Ingen koppling till Fortnox: underlaget laddas ned och skickas in.
 */

import { bigint, date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { ore } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type PurchaseBasis = "received_purchases" | "cost_of_goods";

export const bookkeepingSettings = pgTable("bookkeeping_settings", {
  id: id(),
  organizationId: orgId(),
  accountPlan: jsonb("account_plan").$type<Record<string, unknown>>().notNull(),
  voucherSeries: text("voucher_series").notNull().default("BL"),
  orgNumber: text("org_number"),
  purchaseBasis: text("purchase_basis").$type<PurchaseBasis>().notNull(),
  openingCarryOre: ore("opening_carry_ore").notNull(),
  ...stamps(),
});

export const bookkeepingMonths = pgTable("bookkeeping_months", {
  id: id(),
  organizationId: orgId(),
  month: day("month").notNull(),
  sentAt: ts("sent_at"),
  sentBy: uuid("sent_by"),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  ...stamps(),
});

export const bookkeepingReceipts = pgTable("bookkeeping_receipts", {
  id: id(),
  organizationId: orgId(),
  month: day("month").notNull(),
  storagePath: text("storage_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  fileSha256: text("file_sha256").notNull(),
  archivedAt: ts("archived_at"),
  ...stamps(),
});

export type PackageStatus = "final" | "preliminary";

/** Sparade månadspaket (20261104130000_bokforing_paket.sql). Bara servern skriver. */
export const bookkeepingPackages = pgTable("bookkeeping_packages", {
  id: id(),
  organizationId: orgId(),
  month: day("month").notNull(),
  version: integer("version").notNull(),
  status: text("status").$type<PackageStatus>().notNull(),
  reason: text("reason"),
  fingerprint: text("fingerprint").notNull(),
  storagePath: text("storage_path").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  fileSha256: text("file_sha256").notNull(),
  generatedAt: ts("generated_at").notNull().defaultNow(),
  ...stamps(),
});
