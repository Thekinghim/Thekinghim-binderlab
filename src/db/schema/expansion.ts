/**
 * Drizzle-schema för expansion och effekt (migrering 20261102121500_expansion_leads.sql):
 * expansion_leads, effect_measurements och effect_settings. Platsattributen på stores
 * (store_type, city, open_hours_per_week, area_sqm) står i tabellen stores i ../schema.ts.
 *
 * Filen är fristående (importerar inget från ../schema.ts) så att re-exporten därifrån
 * inte blir en cirkulär import. Uppräkningstyperna som redan finns i databasen
 * (baseline_metric, target_scope) deklareras här lokalt utan export; namnen är desamma.
 */

import { date, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { citext, ore, safeBigint } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const expansionLeadStage = pgEnum("expansion_lead_stage", [
  "lead",
  "contacted",
  "meeting",
  "agreement",
  "installed",
  "lost",
]);

export type ExpansionLeadStage = (typeof expansionLeadStage.enumValues)[number];

/** Samma typ som `baselineMetric` i ../schema.ts (deklareras här för att undvika cirkulär import). */
const effectMetric = pgEnum("baseline_metric", [
  "profit_per_machine_month",
  "stockout_days_month",
  "refill_hours_month",
  "admin_hours_month",
]);
const effectScope = pgEnum("target_scope", ["organization", "store", "machine"]);

export const expansionLeads = pgTable("expansion_leads", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  stage: expansionLeadStage("stage").notNull().default("lead"),
  /** Sätts av databasen när steget ändras. */
  stageChangedAt: ts("stage_changed_at").notNull().defaultNow(),
  storeType: text("store_type"),
  city: text("city"),
  openHoursPerWeek: integer("open_hours_per_week"),
  areaSqm: integer("area_sqm"),
  address: text("address"),
  contactName: text("contact_name"),
  contactEmail: citext("contact_email"),
  contactPhone: text("contact_phone"),
  notes: text("notes"),
  nextStep: text("next_step"),
  nextStepOn: day("next_step_on"),
  commissionBp: integer("commission_bp"),
  monthlyRentOre: ore("monthly_rent_ore"),
  purchaseOre: ore("purchase_ore"),
  installationOre: ore("installation_ore"),
  storeId: uuid("store_id"),
  archivedAt: ts("archived_at"),
  ...stamps(),
  // Runda 2, T6 (20261206000000_gissning_pa_plats.sql): gissningen när platsen blev butik.
  // Vinst per automat och månad i öre (kan vara negativ), lägsta och högsta, och dagen.
  guessProfitMonthOre: safeBigint("guess_profit_month_ore"),
  guessLowMonthOre: safeBigint("guess_low_month_ore"),
  guessHighMonthOre: safeBigint("guess_high_month_ore"),
  guessOn: day("guess_on"),
});

/** Mätvärden per månad: dagar (slutsålda dagar) eller minuter (tid). */
export const effectMeasurements = pgTable("effect_measurements", {
  id: id(),
  organizationId: orgId(),
  metric: effectMetric("metric").notNull(),
  scope: effectScope("scope").notNull().default("organization"),
  storeId: uuid("store_id"),
  machineId: uuid("machine_id"),
  month: day("month").notNull(),
  value: safeBigint("value").notNull(),
  note: text("note"),
  ...stamps(),
});

/** Timkostnad och värde per slutsåld dag. En rad per organisation. */
export const effectSettings = pgTable("effect_settings", {
  id: id(),
  organizationId: orgId(),
  hourlyCostOre: ore("hourly_cost_ore"),
  stockoutDayValueOre: ore("stockout_day_value_ore"),
  ...stamps(),
});
