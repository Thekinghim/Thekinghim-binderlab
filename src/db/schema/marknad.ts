/**
 * Drizzle-schema för Marknad (fas 11). Källan till sanningen är migreringen
 * supabase/migrations/20261102122500_marknad_market_intelligence.sql; filen
 * re-exporteras från src/db/schema.ts så att katalogtestet jämför den med databasen.
 *
 * Samma konventioner som i src/db/schema.ts: belopp i öre (`ore`), andelar i bp,
 * affärsdatum som sträng 'ÅÅÅÅ-MM-DD', tider som `Date`.
 */

import { customType, date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { ore } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
/** int4[] (katalogen visar typen som "int4[]", inte "integer[]"). */
const int4Array = customType<{ data: number[]; driverData: number[] }>({
  dataType() {
    return "int4[]";
  },
});
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Ett kortsläpp i releasekalendern, med fastställt förslag (plan_*) när det låsts. */
export const releases = pgTable("releases", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  series: text("series"),
  releaseDate: day("release_date").notNull(),
  titleId: uuid("title_id"),
  supplierId: uuid("supplier_id"),
  scaleBp: integer("scale_bp").notNull().default(10_000),
  horizonDays: integer("horizon_days").notNull().default(28),
  boxSize: integer("box_size").notNull().default(1),
  minOrderQty: integer("min_order_qty").notNull().default(0),
  source: text("source").$type<"manual" | "import">().notNull().default("manual"),
  externalRef: text("external_ref"),
  note: text("note"),
  planLockedAt: ts("plan_locked_at"),
  planLockedBy: uuid("plan_locked_by"),
  planPurchaseUnits: integer("plan_purchase_units"),
  planCurveBp: int4Array("plan_curve_bp"),
  planSnapshot: jsonb("plan_snapshot").$type<Record<string, unknown>>(),
  archivedAt: ts("archived_at"),
  ...stamps(),
});

/** Fastställd fördelning per automat för ett släpp. */
export const releaseAllocations = pgTable("release_allocations", {
  id: id(),
  organizationId: orgId(),
  releaseId: uuid("release_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  units: integer("units").notNull(),
  suggestedUnits: integer("suggested_units"),
  ...stamps(),
});

/** Inköpspris från en leverantör vid ett datum (offert eller inköp utan inköpsorder). */
export const supplierPriceQuotes = pgTable("supplier_price_quotes", {
  id: id(),
  organizationId: orgId(),
  supplierId: uuid("supplier_id").notNull(),
  titleId: uuid("title_id").notNull(),
  quotedOn: day("quoted_on").notNull(),
  validUntil: day("valid_until"),
  unitCostOre: ore("unit_cost_ore").notNull(),
  quantity: integer("quantity").notNull().default(1),
  kind: text("kind").$type<"quote" | "purchase">().notNull().default("quote"),
  source: text("source").$type<"manual" | "import" | "market">().notNull().default("manual"),
  note: text("note"),
  ...stamps(),
});

/** Fackfördelning: titel med N fack i en automat under en period (inklusiva datum). */
export const machineSlots = pgTable("machine_slots", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  titleId: uuid("title_id").notNull(),
  slots: integer("slots").notNull(),
  validFrom: day("valid_from").notNull(),
  validTo: day("valid_to"),
  note: text("note"),
  ...stamps(),
});

/** En genomförd sortimentsrekommendation (uppföljningen räknas fram). */
export const assortmentChanges = pgTable("assortment_changes", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  implementedOn: day("implemented_on").notNull(),
  recommendationKey: text("recommendation_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  expectedEffectPerWeekOre: ore("expected_effect_per_week_ore").notNull(),
  changedTitleIds: uuid("changed_title_ids").array().notNull().default([]),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  ...stamps(),
});

/** Ett startat pristest (experiment) med test- och kontrollautomater. */
export const priceExperiments = pgTable("price_experiments", {
  id: id(),
  organizationId: orgId(),
  titleId: uuid("title_id").notNull(),
  proposalKey: text("proposal_key").notNull(),
  direction: text("direction").$type<"up" | "down">().notNull(),
  fromOre: ore("from_ore").notNull(),
  toOre: ore("to_ore").notNull(),
  startedOn: day("started_on").notNull(),
  testDays: integer("test_days").notNull(),
  stoppedOn: day("stopped_on"),
  testMachineIds: uuid("test_machine_ids").array().notNull(),
  controlMachineIds: uuid("control_machine_ids").array().notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  ...stamps(),
});
