/**
 * Drizzle-schema för hälsan per Awish-väg (migreringen 20261229000000_awish_halsa.sql).
 * Re-exporteras från src/db/schema.ts. Skrivs bara av servern (src/server/awish/health.ts).
 */

import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const awishPathHealth = pgTable("awish_path_health", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  dataSourceId: uuid("data_source_id").notNull(),
  path: text("path").notNull(),
  activeRoute: text("active_route").notNull().default("ingen"),
  lastSuccessAt: ts("last_success_at"),
  lastSuccessRoute: text("last_success_route"),
  lastAttemptAt: ts("last_attempt_at"),
  lastErrorAt: ts("last_error_at"),
  lastErrorKind: text("last_error_kind"),
  lastErrorCode: integer("last_error_code"),
  lastErrorText: text("last_error_text"),
  failingSince: ts("failing_since"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  breakerRoute: text("breaker_route"),
  breakerOpenUntil: ts("breaker_open_until"),
  alertedAt: ts("alerted_at"),
  recoveredAt: ts("recovered_at"),
  webIdsVerifiedAt: ts("web_ids_verified_at"),
  // 20261229200000_kontroll_awish_vagar.sql (trigger): på reservvägen sedan.
  fallbackSince: ts("fallback_since"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
