/**
 * Drizzle-schema för utbetalningarna från Nayax (migreringarna 20261230000000_partneravtal.sql,
 * 20261230000100_utbetalning_tackning.sql och 20261230000200_utbetalning_fordelning.sql).
 * Re-exporteras från src/db/schema.ts. Bara ägare och admin läser och skriver; läsaren,
 * påfyllaren och butiksportalen ser inget.
 */

import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { ore } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const created = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
const stamps = () => ({
  ...created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Avtalet med partnern: inköpet tillbaka och andel av vinsten (bp). */
export const partnerAgreements = pgTable("partner_agreements", {
  id: id(),
  organizationId: orgId(),
  partnerName: text("partner_name").notNull(),
  reimburseCost: boolean("reimburse_cost").notNull().default(true),
  profitShareBp: integer("profit_share_bp").notNull().default(5000),
  validFrom: day("valid_from").notNull(),
  archivedAt: ts("archived_at"),
  ...stamps(),
});

/** "Kom ihåg filen": rubrikernas fingeravtryck → kolumnerna. */
export const payoutImportMappings = pgTable("payout_import_mappings", {
  id: id(),
  organizationId: orgId(),
  headerSignature: text("header_signature").notNull(),
  mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull(),
  ...stamps(),
});

/** Sammanfattningen per utbetalning (bara ägare och admin: partnerns och ägarens belopp). */
export const payoutSummaries = pgTable("payout_summaries", {
  id: id(),
  organizationId: orgId(),
  payoutId: uuid("payout_id").notNull(),
  summary: text("summary").notNull(),
  writtenAt: ts("written_at").notNull().defaultNow(),
  ...stamps(),
});

export type PayoutDraftSource = "csv" | "xlsx" | "pdf" | "image" | "manual";
export type PayoutDraftStatus = "open" | "confirmed" | "discarded";

/** En uppladdad rapport som väntar på "Stämmer, spara". */
export const payoutDrafts = pgTable("payout_drafts", {
  id: id(),
  organizationId: orgId(),
  source: text("source").$type<PayoutDraftSource>().notNull(),
  fileName: text("file_name"),
  storagePath: text("storage_path"),
  extracted: jsonb("extracted").$type<Record<string, unknown>>().notNull().default({}),
  extractor: text("extractor").$type<"deterministic" | "ai">().notNull().default("deterministic"),
  aiRunId: uuid("ai_run_id"),
  warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
  status: text("status").$type<PayoutDraftStatus>().notNull().default("open"),
  payoutId: uuid("payout_id"),
  ...stamps(),
});

export type PayoutAllocationStatus = "draft" | "locked";
export type PayoutRecipientKind = "store_owner" | "store" | "partner" | "vat_reserve" | "owner";

/** Uträkningen för en utbetalning; en gällande (superseded_at null) per utbetalning. */
export const payoutAllocations = pgTable("payout_allocations", {
  id: id(),
  organizationId: orgId(),
  payoutId: uuid("payout_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").$type<PayoutAllocationStatus>().notNull().default("draft"),
  ruleVersion: integer("rule_version").notNull(),
  inputsHash: text("inputs_hash").notNull(),
  amountOre: ore("amount_ore").notNull(),
  totals: jsonb("totals").$type<Record<string, unknown>>().notNull(),
  warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
  computedAt: ts("computed_at").notNull().defaultNow(),
  lockedAt: ts("locked_at"),
  supersededAt: ts("superseded_at"),
  ...stamps(),
});

/** En rad i uträkningen (append-only). */
export const payoutAllocationLines = pgTable("payout_allocation_lines", {
  id: id(),
  organizationId: orgId(),
  allocationId: uuid("allocation_id").notNull(),
  payoutId: uuid("payout_id").notNull(),
  recipientKind: text("recipient_kind").$type<PayoutRecipientKind>().notNull(),
  storeOwnerId: uuid("store_owner_id"),
  storeId: uuid("store_id"),
  partnerAgreementId: uuid("partner_agreement_id"),
  amountOre: ore("amount_ore").notNull(),
  components: jsonb("components").$type<Record<string, unknown>>().notNull().default({}),
  ...created(),
});

/** "Markera som betald" för partnern, momsen och ägaren. Ångra = arkivera. */
export const recipientPayments = pgTable("recipient_payments", {
  id: id(),
  organizationId: orgId(),
  payoutId: uuid("payout_id").notNull(),
  lineId: uuid("line_id").notNull(),
  recipientKind: text("recipient_kind").$type<"partner" | "vat_reserve" | "owner">().notNull(),
  paidOn: day("paid_on").notNull(),
  amountOre: ore("amount_ore").notNull(),
  note: text("note"),
  archivedAt: ts("archived_at"),
  ...stamps(),
});
