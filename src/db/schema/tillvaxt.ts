/**
 * Drizzle-schema för kampanjer och gratis-pack (migreringen
 * 20261104233100_kampanjer_gratis_pack.sql). Re-exporteras från src/db/schema.ts.
 * Bara servern skriver; ägare, admin och läsare läser (koderna bara ägare och admin).
 */

import {
  bigint,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { ore } from "../types";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type CampaignImageType = "image/png" | "image/jpeg" | "image/webp";
export type CampaignMachineStatus = "scheduled" | "sending" | "shown" | "failed" | "stopped";
export type FreePackReason = "compensation" | "giveaway" | "staff" | "other";
export type FreePackStatus = "sending" | "created" | "failed";

export const campaigns = pgTable("campaigns", {
  id: id(),
  organizationId: orgId(),
  title: text("title").notNull(),
  titleId: uuid("title_id"),
  imagePath: text("image_path").notNull(),
  imageUrl: text("image_url").notNull(),
  imageType: text("image_type").$type<CampaignImageType>().notNull(),
  imageBytes: integer("image_bytes").notNull(),
  startsAt: ts("starts_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  stoppedAt: ts("stopped_at"),
  stoppedBy: uuid("stopped_by"),
  ...stamps(),
});

export const campaignMachines = pgTable("campaign_machines", {
  id: id(),
  organizationId: orgId(),
  campaignId: uuid("campaign_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  awishMachineId: text("awish_machine_id").notNull(),
  awishBannerId: text("awish_banner_id"),
  status: text("status").$type<CampaignMachineStatus>().notNull().default("scheduled"),
  error: text("error"),
  sentAt: ts("sent_at"),
  stoppedAt: ts("stopped_at"),
  ...stamps(),
});

export const freePackBatches = pgTable("free_pack_batches", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  titleId: uuid("title_id"),
  goodName: text("good_name").notNull(),
  awishMachineId: text("awish_machine_id").notNull(),
  awishProductId: text("awish_product_id").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason").$type<FreePackReason>().notNull(),
  recipient: text("recipient"),
  note: text("note"),
  unitCostOre: ore("unit_cost_ore"),
  costOre: ore("cost_ore"),
  businessDate: day("business_date").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status").$type<FreePackStatus>().notNull().default("sending"),
  error: text("error"),
  ...stamps(),
});

export const freePackCodes = pgTable("free_pack_codes", {
  id: id(),
  organizationId: orgId(),
  batchId: uuid("batch_id").notNull(),
  code: text("code").notNull(),
  awishCodeId: text("awish_code_id"),
  expiresAt: ts("expires_at"),
  ...stamps(),
});

// Digital signering (20261104233200_avtal_signering.sql). Bara servern skriver.

export const contractSigningLinks = pgTable("contract_signing_links", {
  id: id(),
  organizationId: orgId(),
  contractId: uuid("contract_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  documentSha256: text("document_sha256").notNull(),
  snapshotHtml: text("snapshot_html"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  revokedAt: ts("revoked_at"),
  ...stamps(),
});

export const contractSignatures = pgTable("contract_signatures", {
  id: id(),
  organizationId: orgId(),
  contractId: uuid("contract_id").notNull(),
  linkId: uuid("link_id").notNull(),
  signerName: text("signer_name").notNull(),
  signaturePng: bytea("signature_png").notNull(),
  documentSha256: text("document_sha256").notNull(),
  signedAt: ts("signed_at").notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  signedFilePath: text("signed_file_path"),
  signedFileSha256: text("signed_file_sha256"),
  signedFileBytes: bigint("signed_file_bytes", { mode: "number" }),
  ...stamps(),
});

/**
 * Plan för fler automater (20261104233300_tillvaxt_plan.sql): målet och förvalen. En rad
 * per organisation; null = standard. Ägare och admin skriver, läsaren läser.
 */
export const growthPlans = pgTable("growth_plans", {
  id: id(),
  organizationId: orgId().unique(),
  targetMachines: integer("target_machines").notNull().default(20),
  machinePriceOre: ore("machine_price_ore"),
  startStockOre: ore("start_stock_ore"),
  machinesPerMonth: integer("machines_per_month"),
  refillMinutesPerMachineWeek: integer("refill_minutes_per_machine_week"),
  people: integer("people").notNull().default(2),
  hoursPerPersonWeek: integer("hours_per_person_week").notNull().default(10),
  ...stamps(),
});

/**
 * Månadsavräkning per butik (20261104233400_butik_avrakning.sql): beloppet att betala ut,
 * uträkningen och när den betalades. Ägare och admin skriver, läsaren läser; butiken läser
 * sina via portal_settlements. Betald = låst.
 */
export const storeSettlements = pgTable("store_settlements", {
  id: id(),
  organizationId: orgId(),
  storeId: uuid("store_id").notNull(),
  month: day("month").notNull(),
  amountOre: ore("amount_ore").notNull(),
  statement: jsonb("statement").$type<Record<string, unknown>>().notNull(),
  calcVersion: text("calc_version").notNull(),
  computedAt: ts("computed_at").notNull().defaultNow(),
  paidOn: day("paid_on"),
  paidBy: uuid("paid_by"),
  paidMarkedAt: ts("paid_marked_at"),
  ...stamps(),
});
