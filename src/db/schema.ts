/**
 * Drizzle-schema för Binderlab (datamodell v2).
 *
 * Källan till sanningen är SQL-migreringarna i supabase/migrations. Den här
 * filen beskriver samma tabeller, vyer och uppräkningstyper för TypeScript.
 * test/db/catalog.test.ts jämför den mot information_schema (kolumner, typer
 * och null-barhet) så att de inte glider isär.
 *
 * Konventioner:
 * - Belopp i öre: `ore()` (bigint i databasen, säkert heltal i JS).
 * - Procentsatser i baspunkter: `integer`.
 * - Tider: `timestamptz` som `Date` (absolut tidpunkt, oberoende av processens tidszon).
 * - Affärsdatum: `date` som sträng `YYYY-MM-DD` (aldrig `Date`).
 * - Datumintervall (valid_from/valid_to) är inklusiva; valid_to null = tills vidare.
 * - `business_date` räknas fram av databasen (orders: från ordered_at, stock_events:
 *   från occurred_at) i organisationens tidszon. Den är därför valfri vid insert.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { citext, ore, safeBigint } from "./types";

// ---------------------------------------------------------------------------
// Uppräkningstyper
// ---------------------------------------------------------------------------

/** "store" är butiksportalens roll (fas 10): ingen åtkomst till appen, bara portal_*-RPC:erna. */
export const memberRole = pgEnum("member_role", ["owner", "admin", "refiller", "viewer", "store"]);
export const organizationPlan = pgEnum("organization_plan", ["trial", "standard", "enterprise"]);
export const commissionBase = pgEnum("commission_base", ["net_excl_vat", "profit_after_costs"]);
export const lossTreatment = pgEnum("loss_treatment", ["zero", "proportional"]);
export const rentProration = pgEnum("rent_proration", ["daily"]);
export const machineInvestmentKind = pgEnum("machine_investment_kind", [
  "purchase",
  "installation",
  "other",
]);
export const dataSourceProvider = pgEnum("data_source_provider", [
  "awish_grpc",
  "awish_web",
  "awish_csv",
  // Awish Chrome-tillägget (20261102235500_tillagg_enums.sql).
  "awish_extension",
  // Annan automatplattform, försäljning som CSV (20261111020000_plattform_manuell_csv.sql).
  "manual_csv",
]);
export const dataSourceStatus = pgEnum("data_source_status", ["active", "paused", "error"]);
export const importTrigger = pgEnum("import_trigger", [
  "upload",
  "schedule",
  "webhook",
  // En batch från Awish Chrome-tillägget (20261102235500_tillagg_enums.sql).
  "extension",
]);
export const importStatus = pgEnum("import_status", ["pending", "running", "succeeded", "failed"]);
export const importRowStatus = pgEnum("import_row_status", ["new", "conflict", "error"]);
export const stockLocationKind = pgEnum("stock_location_kind", ["warehouse", "machine"]);
export const stockEventKind = pgEnum("stock_event_kind", [
  "refill",
  "count",
  "sale",
  "waste",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "receipt",
]);
export const purchaseOrderStatus = pgEnum("purchase_order_status", [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
]);
export const targetScope = pgEnum("target_scope", ["organization", "store", "machine"]);
export const goalMetric = pgEnum("goal_metric", ["revenue", "profit", "active_machines"]);
export const baselineMetric = pgEnum("baseline_metric", [
  "profit_per_machine_month",
  "stockout_days_month",
  "refill_hours_month",
  "admin_hours_month",
]);
export const baselineUnit = pgEnum("baseline_unit", ["ore", "days", "minutes", "count"]);
export const reportRecipientKind = pgEnum("report_recipient_kind", [
  "store",
  "accountant",
  "partner",
]);
export const reportKind = pgEnum("report_kind", [
  "store_statement",
  "owner_statement",
  "accountant_statement",
  "profitability",
]);
export const reportDeliveryStatus = pgEnum("report_delivery_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
  "bounced",
]);
export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const auditAction = pgEnum("audit_action", ["insert", "update", "delete"]);

/** Alla roller i memberships, även butiksportalens "store". */
export type MembershipRole = (typeof memberRole.enumValues)[number];
/** Appens roller. Butiksrollen ("store") når aldrig appen, bara /portal. */
export type MemberRole = Exclude<MembershipRole, "store">;
export type StockEventKind = (typeof stockEventKind.enumValues)[number];

// ---------------------------------------------------------------------------
// Gemensamma kolumner
// ---------------------------------------------------------------------------

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
/** Räknas fram av databasen; skickas som null om den inte anges. */
const derivedBusinessDate = () =>
  day("business_date")
    .notNull()
    .$defaultFn(() => sql`null`);

// ---------------------------------------------------------------------------
// 1. Organisation och åtkomst
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  timezone: text("timezone").notNull().default("Europe/Stockholm"),
  currency: text("currency").notNull().default("SEK"),
  plan: organizationPlan("plan").notNull().default("standard"),
  machineLimit: integer("machine_limit"),
  archivedAt: ts("archived_at"),
  ...stamps(),
  /** Demoorganisation (20261108000000_demo_kunder.sql). Sätts bara av servern. */
  isDemo: boolean("is_demo").notNull().default(false),
});

export const profiles = pgTable("profiles", {
  id: id(),
  organizationId: orgId(),
  userId: uuid("user_id"),
  displayName: text("display_name").notNull(),
  anonymizedAt: ts("anonymized_at"),
  ...stamps(),
});

export const memberships = pgTable("memberships", {
  id: id(),
  organizationId: orgId(),
  userId: uuid("user_id").notNull(),
  role: memberRole("role").notNull(),
  /** Butiken för en butiksanvändare (role = store), annars null. */
  storeId: uuid("store_id"),
  ...stamps(),
});

export const invitations = pgTable("invitations", {
  id: id(),
  organizationId: orgId(),
  email: citext("email").notNull(),
  role: memberRole("role").notNull(),
  /** Butiken för en inbjudan till butiksportalen (role = store), annars null. */
  storeId: uuid("store_id"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  acceptedBy: uuid("accepted_by"),
  invitedBy: uuid("invited_by"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 2. Platser och avtal
// ---------------------------------------------------------------------------

export const stores = pgTable("stores", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  address: text("address"),
  contactName: text("contact_name"),
  email: citext("email"),
  phone: text("phone"),
  isExample: boolean("is_example").notNull().default(false),
  archivedAt: ts("archived_at"),
  /** Platsattribut för likhet mellan platser (expansion). null = okänt. */
  storeType: text("store_type"),
  city: text("city"),
  /** Öppettimmar per vecka, 0–168. */
  openHoursPerWeek: integer("open_hours_per_week"),
  /** Yta i m². */
  areaSqm: integer("area_sqm"),
  /** Plats för ruttordningen (20261104170000_managerpaket_ansvar.sql). Båda eller ingen. */
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  ...stamps(),
});

export const contracts = pgTable("contracts", {
  id: id(),
  organizationId: orgId(),
  storeId: uuid("store_id").notNull(),
  validFrom: day("valid_from").notNull(),
  validTo: day("valid_to"),
  noticePeriodDays: integer("notice_period_days"),
  storagePath: text("storage_path"),
  note: text("note"),
  archivedAt: ts("archived_at"),
  // Fas 9 (20261102121731_ekonomi_payouts_costs_contracts.sql): villkor och avtalsfilen.
  title: text("title"),
  terms: text("terms"),
  renewalMonths: integer("renewal_months"),
  fileName: text("file_name"),
  fileContentType: text("file_content_type"),
  fileSizeBytes: safeBigint("file_size_bytes"),
  fileSha256: text("file_sha256"),
  noticePeriodMonths: integer("notice_period_months"),
  terminatedOn: day("terminated_on"),
  // 20261104120000_avtal_mall.sql: avtal skapade från mallen och deras status.
  template: text("template"),
  sentAt: ts("sent_at"),
  signedAt: ts("signed_at"),
  // 20261105040000_kontrakt_sarskilda_villkor.sql: fritext som skrivs in i PDF:en.
  specialTerms: text("special_terms"),
  ...stamps(),
});

export const storeAgreements = pgTable("store_agreements", {
  id: id(),
  organizationId: orgId(),
  storeId: uuid("store_id").notNull(),
  contractId: uuid("contract_id"),
  validFrom: day("valid_from").notNull(),
  validTo: day("valid_to"),
  commissionBp: integer("commission_bp"),
  monthlyRentOre: ore("monthly_rent_ore"),
  commissionBase: commissionBase("commission_base").notNull().default("net_excl_vat"),
  lossTreatment: lossTreatment("loss_treatment").notNull().default("zero"),
  vmbBeforeSplit: boolean("vmb_before_split").notNull().default(false),
  rentProration: rentProration("rent_proration").notNull().default("daily"),
  note: text("note"),
  ...stamps(),
});

export const machines = pgTable("machines", {
  id: id(),
  organizationId: orgId(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  serial: text("serial"),
  activeFrom: day("active_from"),
  activeTo: day("active_to"),
  isExample: boolean("is_example").notNull().default(false),
  archivedAt: ts("archived_at"),
  /** Vem som fyller på (20261104170000_managerpaket_ansvar.sql). null = Båda. */
  responsibleUserId: uuid("responsible_user_id"),
  ...stamps(),
});

export const machinePlacements = pgTable("machine_placements", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  storeId: uuid("store_id").notNull(),
  validFrom: day("valid_from").notNull(),
  validTo: day("valid_to"),
  note: text("note"),
  ...stamps(),
});

export const machineInvestments = pgTable("machine_investments", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  kind: machineInvestmentKind("kind").notNull(),
  amountOre: ore("amount_ore").notNull(),
  investedOn: day("invested_on").notNull(),
  depreciationMonths: integer("depreciation_months"),
  note: text("note"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 3. Titlar och priser
// ---------------------------------------------------------------------------

export const titles = pgTable("titles", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  series: text("series"),
  mergedIntoId: uuid("merged_into_id"),
  archivedAt: ts("archived_at"),
  ...stamps(),
  /** Egen produkt: vi packar den själva (Packa i stället för Beställ). */
  ownProduct: boolean("own_product").notNull().default(false),
});

export const titleAliases = pgTable("title_aliases", {
  id: id(),
  organizationId: orgId(),
  titleId: uuid("title_id").notNull(),
  alias: text("alias").notNull(),
  aliasNormalized: text("alias_normalized")
    .notNull()
    .generatedAlwaysAs(sql`lower(btrim(regexp_replace(normalize(alias, NFKC), '\\s+', ' ', 'g')))`),
  ...stamps(),
});

export const purchasePrices = pgTable("purchase_prices", {
  id: id(),
  organizationId: orgId(),
  titleId: uuid("title_id").notNull(),
  unitCostOre: ore("unit_cost_ore").notNull(),
  validFrom: day("valid_from").notNull(),
  note: text("note"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 4. Datakällor och import
// ---------------------------------------------------------------------------

export const dataSources = pgTable("data_sources", {
  id: id(),
  organizationId: orgId(),
  provider: dataSourceProvider("provider").notNull(),
  name: text("name").notNull(),
  sourceTimezone: text("source_timezone").notNull().default("Asia/Shanghai"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretRef: text("secret_ref"),
  cursor: text("cursor"),
  lastSyncedAt: ts("last_synced_at"),
  status: dataSourceStatus("status").notNull().default("active"),
  archivedAt: ts("archived_at"),
  /** Merchant.expired_at, läst av synken högst en gång per dygn (20261110000000_awish_online_konto.sql). */
  awishExpiresAt: ts("awish_expires_at"),
  awishMerchantCheckedAt: ts("awish_merchant_checked_at"),
  ...stamps(),
});

export const sourceMachines = pgTable("source_machines", {
  id: id(),
  organizationId: orgId(),
  dataSourceId: uuid("data_source_id").notNull(),
  externalId: text("external_id").notNull(),
  externalDeviceNo: text("external_device_no"),
  externalName: text("external_name"),
  machineId: uuid("machine_id"),
  /** Anslutningen enligt Awish Machines, skriven av synken (20261110000000_awish_online_konto.sql). */
  awishOnline: boolean("awish_online"),
  awishStatus: text("awish_status"),
  awishSeenAt: ts("awish_seen_at"),
  awishOnlineAt: ts("awish_online_at"),
  awishOfflineSince: ts("awish_offline_since"),
  awishBackOnlineAt: ts("awish_back_online_at"),
  awishLastOfflineFrom: ts("awish_last_offline_from"),
  ...stamps(),
});

export const imports = pgTable("imports", {
  id: id(),
  organizationId: orgId(),
  dataSourceId: uuid("data_source_id").notNull(),
  trigger: importTrigger("trigger").notNull(),
  fileName: text("file_name"),
  fileSha256: text("file_sha256"),
  storagePath: text("storage_path"),
  parserVersion: text("parser_version").notNull(),
  mapping: jsonb("mapping").$type<Record<string, unknown>>(),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsNew: integer("rows_new").notNull().default(0),
  rowsDuplicate: integer("rows_duplicate").notNull().default(0),
  rowsConflict: integer("rows_conflict").notNull().default(0),
  rowsError: integer("rows_error").notNull().default(0),
  status: importStatus("status").notNull().default("pending"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  ...stamps(),
});

/** Append-only. */
export const importRows = pgTable("import_rows", {
  id: id(),
  organizationId: orgId(),
  importId: uuid("import_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  status: importRowStatus("status").notNull(),
  message: text("message"),
  orderId: uuid("order_id"),
  ...created(),
});

export const orders = pgTable("orders", {
  id: id(),
  organizationId: orgId(),
  dataSourceId: uuid("data_source_id").notNull(),
  externalId: text("external_id").notNull(),
  rawTitle: text("raw_title").notNull(),
  titleId: uuid("title_id"),
  orderedAt: ts("ordered_at").notNull(),
  businessDate: derivedBusinessDate(),
  amountOre: ore("amount_ore").notNull(),
  paymentMethod: text("payment_method"),
  sourceMachineId: uuid("source_machine_id"),
  machineId: uuid("machine_id"),
  importId: uuid("import_id"),
  sourceHash: text("source_hash").notNull(),
  lateInClosedPeriod: boolean("late_in_closed_period").notNull().default(false),
  /**
   * Markerad som testköp (null = vanlig order). Räknas inte i intäkt, vinst, avräkning,
   * bokföring eller rapporter. Sätts bara via set_test_purchase(); vem står i audit_log.
   */
  testPurchaseAt: ts("test_purchase_at"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 5. Lager
// ---------------------------------------------------------------------------

export const stockLocations = pgTable("stock_locations", {
  id: id(),
  organizationId: orgId(),
  kind: stockLocationKind("kind").notNull(),
  machineId: uuid("machine_id"),
  name: text("name").notNull(),
  /** Standardlagret (ett per organisation, aldrig arkiverat). */
  isCentral: boolean("is_central").notNull().default(false),
  archivedAt: ts("archived_at"),
  /** Automatens "Fylls på från" (ett eget lager), null = standardlagret. */
  refillSourceId: uuid("refill_source_id"),
  /** Senaste gången Awish-synken läste automatens fack. Bara synken skriver. */
  awishSyncedAt: ts("awish_synced_at"),
  /** Awish fack per titel vid senaste läsningen (Fyll på). Skrivs bara av synken. */
  awishFill:
    jsonb("awish_fill").$type<
      { title_id: string; units: number; capacity: number; channels: number; empty: number }[]
    >(),
  ...stamps(),
});

/** Append-only. quantity är förändringen, utom vid 'count' (räknat antal). */
export const stockEvents = pgTable("stock_events", {
  id: id(),
  organizationId: orgId(),
  /** Ordningsnummer per organisation. Sätts alltid av databasen (triggern). */
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  locationId: uuid("location_id").notNull(),
  titleId: uuid("title_id").notNull(),
  kind: stockEventKind("kind").notNull(),
  quantity: integer("quantity").notNull(),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  businessDate: derivedBusinessDate(),
  performedBy: uuid("performed_by").default(sql`auth.uid()`),
  orderId: uuid("order_id"),
  transferGroupId: uuid("transfer_group_id"),
  note: text("note"),
  /** Inventeringens källa: null = Binderlab, "awish" = Awish-synken. */
  source: text("source"),
  ...created(),
});

// ---------------------------------------------------------------------------
// 6. Inköp
// ---------------------------------------------------------------------------

export const suppliers = pgTable("suppliers", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: citext("email"),
  phone: text("phone"),
  defaultLeadTimeDays: integer("default_lead_time_days"),
  archivedAt: ts("archived_at"),
  ...stamps(),
});

export const supplierItems = pgTable("supplier_items", {
  id: id(),
  organizationId: orgId(),
  supplierId: uuid("supplier_id").notNull(),
  titleId: uuid("title_id").notNull(),
  packSize: integer("pack_size").notNull().default(1),
  minOrderQty: integer("min_order_qty").notNull().default(1),
  leadTimeDays: integer("lead_time_days"),
  unitCostOre: ore("unit_cost_ore").notNull(),
  ...stamps(),
});

export const purchaseOrders = pgTable("purchase_orders", {
  id: id(),
  organizationId: orgId(),
  supplierId: uuid("supplier_id").notNull(),
  status: purchaseOrderStatus("status").notNull().default("draft"),
  orderedOn: day("ordered_on"),
  expectedOn: day("expected_on"),
  receivedOn: day("received_on"),
  note: text("note"),
  ...stamps(),
});

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: id(),
  organizationId: orgId(),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  titleId: uuid("title_id").notNull(),
  quantity: integer("quantity").notNull(),
  unitCostOre: ore("unit_cost_ore").notNull(),
  receivedQuantity: integer("received_quantity").notNull().default(0),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 7. Mål och utgångsläge
// ---------------------------------------------------------------------------

export const goals = pgTable("goals", {
  id: id(),
  organizationId: orgId(),
  scope: targetScope("scope").notNull(),
  storeId: uuid("store_id"),
  machineId: uuid("machine_id"),
  month: day("month").notNull(),
  metric: goalMetric("metric").notNull(),
  /** Öre för revenue/profit, antal för active_machines. */
  target: safeBigint("target").notNull(),
  ...stamps(),
});

export const baselines = pgTable("baselines", {
  id: id(),
  organizationId: orgId(),
  scope: targetScope("scope").notNull(),
  storeId: uuid("store_id"),
  machineId: uuid("machine_id"),
  metric: baselineMetric("metric").notNull(),
  /** Heltal i enheten `unit`. */
  value: safeBigint("value").notNull(),
  unit: baselineUnit("unit").notNull(),
  measuredFrom: day("measured_from"),
  measuredTo: day("measured_to"),
  source: text("source"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 8. Perioder
// ---------------------------------------------------------------------------

/** Skrivs bara via close_period()/reopen_period(). */
export const periodCloses = pgTable("period_closes", {
  id: id(),
  organizationId: orgId(),
  month: day("month").notNull(),
  closedAt: ts("closed_at").notNull().defaultNow(),
  closedBy: uuid("closed_by"),
  reopenedAt: ts("reopened_at"),
  reopenedBy: uuid("reopened_by"),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 9. Rapporter
// ---------------------------------------------------------------------------

export const reportRecipients = pgTable("report_recipients", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  email: citext("email").notNull(),
  kind: reportRecipientKind("kind").notNull(),
  storeId: uuid("store_id"),
  active: boolean("active").notNull().default(true),
  ...stamps(),
});

export const reports = pgTable("reports", {
  id: id(),
  organizationId: orgId(),
  kind: reportKind("kind").notNull(),
  periodStart: day("period_start").notNull(),
  periodEnd: day("period_end").notNull(),
  storeId: uuid("store_id"),
  storagePath: text("storage_path"),
  generatedBy: uuid("generated_by"),
  generatedAt: ts("generated_at").notNull().defaultNow(),
  dataSnapshot: jsonb("data_snapshot").$type<Record<string, unknown>>().notNull(),
  calcVersion: text("calc_version").notNull(),
  ...stamps(),
});

/** Append-only. */
export const reportDeliveries = pgTable("report_deliveries", {
  id: id(),
  organizationId: orgId(),
  reportId: uuid("report_id").notNull(),
  recipientId: uuid("recipient_id"),
  email: citext("email").notNull(),
  status: reportDeliveryStatus("status").notNull(),
  sentAt: ts("sent_at"),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  ...created(),
});

// ---------------------------------------------------------------------------
// 10. Inställningar och ägande
// ---------------------------------------------------------------------------

export const organizationSettings = pgTable("organization_settings", {
  id: id(),
  organizationId: orgId(),
  vatRateBp: integer("vat_rate_bp").notNull().default(0),
  cardFeeBp: integer("card_fee_bp").notNull().default(0),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  /** Företagsuppgifter i kontrakt (20261106050000_foretagsuppgifter.sql). null = tom rad. */
  companyName: text("company_name"),
  orgNumber: text("org_number"),
  companyAddress: text("company_address"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  ...stamps(),
});

export const ownerShares = pgTable("owner_shares", {
  id: id(),
  organizationId: orgId(),
  memberUserId: uuid("member_user_id"),
  holderName: text("holder_name").notNull(),
  shareBp: integer("share_bp").notNull(),
  validFrom: day("valid_from").notNull(),
  ...stamps(),
});

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: id(),
  organizationId: orgId(),
  key: text("key").notNull(),
  basAccount: text("bas_account").notNull(),
  name: text("name").notNull(),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 11. Senare faser
// ---------------------------------------------------------------------------

export const alerts = pgTable("alerts", {
  id: id(),
  organizationId: orgId(),
  kind: text("kind").notNull(),
  severity: alertSeverity("severity").notNull(),
  machineId: uuid("machine_id"),
  storeId: uuid("store_id"),
  titleId: uuid("title_id"),
  message: text("message"),
  triggeredAt: ts("triggered_at").notNull().defaultNow(),
  acknowledgedAt: ts("acknowledged_at"),
  acknowledgedBy: uuid("acknowledged_by"),
  // Fas 8 (20261102122143_drift_larm_arenden.sql): incidentens tillstånd (@/analytics/alerts).
  incidentKey: text("incident_key"),
  alertGroup: text("alert_group"),
  status: text("status").notNull().default("open"),
  title: text("title"),
  evidence: jsonb("evidence").notNull().default({}).$type<Record<string, unknown>>(),
  link: text("link"),
  lastSeenAt: ts("last_seen_at"),
  closedAt: ts("closed_at"),
  lastNotifiedAt: ts("last_notified_at"),
  notifiedSeverity: alertSeverity("notified_severity"),
  notifyCount: integer("notify_count").notNull().default(0),
  occurrences: integer("occurrences").notNull().default(1),
  reopenCount: integer("reopen_count").notNull().default(0),
  oneShot: boolean("one_shot").notNull().default(false),
  resolvedNotifiedAt: ts("resolved_notified_at"),
  suppressedBy: text("suppressed_by"),
  ...stamps(),
});

export const incidents = pgTable("incidents", {
  id: id(),
  organizationId: orgId(),
  machineId: uuid("machine_id").notNull(),
  kind: text("kind").notNull(),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  description: text("description"),
  actionTaken: text("action_taken"),
  // Fas 8: kundärenden (status, ansvarig, order, titel, återbetalning i öre).
  status: text("status").notNull().default("open"),
  assigneeId: uuid("assignee_id"),
  orderId: uuid("order_id"),
  titleId: uuid("title_id"),
  refundedOre: ore("refunded_ore").notNull().default(0),
  refundedOn: day("refunded_on"),
  customerContact: text("customer_contact"),
  ...stamps(),
});

// ---------------------------------------------------------------------------
// 12. Ändringslogg (append-only, skrivs bara av triggern private.audit())
// ---------------------------------------------------------------------------

export const auditLog = pgTable("audit_log", {
  id: id(),
  organizationId: orgId(),
  tableName: text("table_name").notNull(),
  rowId: uuid("row_id").notNull(),
  action: auditAction("action").notNull(),
  actorId: uuid("actor_id"),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
});

// ---------------------------------------------------------------------------
// Vyer (security_invoker = true: RLS gäller den som frågar)
// ---------------------------------------------------------------------------

/** Saldo per lagerplats och titel: senaste inventering plus händelserna efter. */
export const stockLevels = pgView("stock_levels", {
  organizationId: uuid("organization_id").notNull(),
  locationId: uuid("location_id").notNull(),
  titleId: uuid("title_id").notNull(),
  quantity: integer("quantity").notNull(),
  lastCountedAt: ts("last_counted_at"),
  lastEventAt: ts("last_event_at"),
}).existing();

/** stock_levels för alla aktiva egna lager (kind 'warehouse'). */
export const warehouseStock = pgView("warehouse_stock", {
  organizationId: uuid("organization_id").notNull(),
  locationId: uuid("location_id").notNull(),
  titleId: uuid("title_id").notNull(),
  quantity: integer("quantity").notNull(),
  lastCountedAt: ts("last_counted_at"),
  lastEventAt: ts("last_event_at"),
}).existing();

/** Prisperioder per titel. valid_to är sista dagen (inklusive), null = tills vidare. */
export const purchasePricePeriods = pgView("purchase_price_periods", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  titleId: uuid("title_id").notNull(),
  unitCostOre: ore("unit_cost_ore").notNull(),
  validFrom: day("valid_from").notNull(),
  validTo: day("valid_to"),
}).existing();

// Fas 9 Ekonomi: utbetalningar, avvikelser och fasta kostnader.
export * from "./schema/ekonomi";

// Expansion och effekt (expansion_leads, effect_measurements, effect_settings).
export * from "./schema/expansion";

// Fas 6 Rapporter: godkännande av rapporter.
export * from "./schema/rapporter";

// Fas 6b Assistent: logg över frågor och svar.
export * from "./schema/assistant";

// Fas 8 Drift: larmprenumerationer, push, utskick och påfyllning från fältet.
export * from "./schema/drift";

// Fas 11 Marknad: releaser, leverantörspriser, fackfördelning, sortiment och pristester.
export * from "./schema/marknad";

// Fas 2 Datakällor: mellanlagring av uppladdade orderlistor.
export * from "./schema/datakallor";

// Fas 3 Att göra: avbockade punkter.
export * from "./schema/att-gora";

// Awish Chrome-tillägget (borttaget): synk-tokens, tabellen ligger kvar oanvänd.
export * from "./schema/tillagg";

// Bokföring: kontoplanen, månader markerade som skickade och kvitton.
export * from "./schema/bokforing";

// Managerpaket 5: morgonbriefen på Hem.
export * from "./schema/brief";
// Tillväxt: kampanjer på automaternas skärm och gratis-pack-koder.
export * from "./schema/tillvaxt";
// Värde: logg över automatiskt arbete (Awish-push).
export * from "./schema/varde";

// Granskning och oberoende: logg över "Exportera all data".
export * from "./schema/granskning";

// Daglig kontroll (20261114000000_daglig_kontroll.sql).
export * from "./schema/kontroll";
