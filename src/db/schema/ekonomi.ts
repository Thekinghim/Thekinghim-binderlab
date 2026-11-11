/**
 * Drizzle-schema för fas 9 Ekonomi (migreringen 20261102121731_ekonomi_payouts_costs_contracts.sql):
 * utbetalningar från automatleverantören, leverantörens specifikation per order, importloggen
 * för utbetalningsfiler, utredda avvikelser, fasta kostnader och leveranser av verifikationer
 * (20261102142000_ekonomi_review_fixes.sql). Re-exporteras från
 * src/db/schema.ts. (Avtalens nya kolumner ligger på `contracts` i schema.ts.)
 *
 * Samma konventioner som schema.ts: belopp i öre som `ore()`, affärsdatum som sträng.
 * Hjälparna är lokala här för att undvika en cirkulär import med schema.ts.
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

/** En uppladdad utbetalningsfil (append-only). */
export const payoutImports = pgTable("payout_imports", {
  id: id(),
  organizationId: orgId(),
  dataSourceId: uuid("data_source_id"),
  fileName: text("file_name").notNull(),
  fileSha256: text("file_sha256").notNull(),
  storagePath: text("storage_path"),
  format: text("format").$type<"payouts" | "lines">().notNull(),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsNew: integer("rows_new").notNull().default(0),
  rowsDuplicate: integer("rows_duplicate").notNull().default(0),
  rowsConflict: integer("rows_conflict").notNull().default(0),
  rowsError: integer("rows_error").notNull().default(0),
  messages: jsonb("messages").$type<string[]>().notNull().default([]),
  ...created(),
});

/** En utbetalning från leverantören. Ändras aldrig (bara arkivering och anteckning). */
export const payouts = pgTable("payouts", {
  id: id(),
  organizationId: orgId(),
  dataSourceId: uuid("data_source_id"),
  importId: uuid("import_id"),
  reference: text("reference").notNull(),
  periodStart: day("period_start").notNull(),
  periodEnd: day("period_end").notNull(),
  paidOn: day("paid_on"),
  amountOre: ore("amount_ore").notNull(),
  feesOre: ore("fees_ore").notNull().default(0),
  refundsOre: ore("refunds_ore"),
  currency: text("currency").notNull().default("SEK"),
  sourceHash: text("source_hash").notNull(),
  note: text("note"),
  archivedAt: ts("archived_at"),
  /** T5: inskriven för hand på Ekonomi (20261205000200_utbetalning_for_hand.sql). */
  manual: boolean("manual").notNull().default(false),
  ...stamps(),
});

/** Leverantörens specifikation per order (append-only). */
export const payoutLines = pgTable("payout_lines", {
  id: id(),
  organizationId: orgId(),
  payoutId: uuid("payout_id").notNull(),
  importId: uuid("import_id"),
  externalId: text("external_id").notNull(),
  amountOre: ore("amount_ore").notNull(),
  ...created(),
});

/** Loggen över utredda och återöppnade avvikelser (append-only; senaste raden gäller). */
export const deviationReviews = pgTable("deviation_reviews", {
  id: id(),
  organizationId: orgId(),
  deviationKey: text("deviation_key").notNull(),
  fingerprint: text("fingerprint"),
  action: text("action").$type<"investigated" | "reopened">().notNull(),
  note: text("note"),
  ...created(),
});

export type FixedCostCategory = "insurance" | "software" | "transport" | "storage" | "other";
export type FixedCostIntervalDb = "month" | "quarter" | "year";

/** Fasta kostnader. Arkiveras i stället för att raderas. */
export const fixedCosts = pgTable("fixed_costs", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  category: text("category").$type<FixedCostCategory>().notNull().default("other"),
  amountOre: ore("amount_ore").notNull(),
  interval: text("interval").$type<FixedCostIntervalDb>().notNull(),
  startsOn: day("starts_on").notNull(),
  endsOn: day("ends_on"),
  machineId: uuid("machine_id"),
  note: text("note"),
  archivedAt: ts("archived_at"),
  ...stamps(),
});

export type VoucherProvider = "local" | "fortnox" | "visma_enet" | "bokio";

/**
 * Verifikationer som skickats till bokföringsprogrammet (20261102142000_ekonomi_review_fixes.sql).
 * Append-only; en månad skickas en gång per program, och numren ligger fast.
 */
export const voucherDeliveries = pgTable("voucher_deliveries", {
  id: id(),
  organizationId: orgId(),
  month: day("month").notNull(),
  provider: text("provider").$type<VoucherProvider>().notNull(),
  series: text("series").notNull(),
  firstNumber: integer("first_number").notNull(),
  lastNumber: integer("last_number").notNull(),
  verificationCount: integer("verification_count").notNull(),
  fileSha256: text("file_sha256").notNull(),
  externalReference: text("external_reference"),
  ...created(),
});
