/**
 * Drizzle-schema för styrningen via Awishs gRPC-API v1.2.41
 * (20261231000000_awish_styrning.sql). Re-exporteras från src/db/schema.ts.
 */

import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type AwishEndpointKind = "tls" | "plain";
export type AwishSignStatus = "unverified" | "ok" | "failed";
export type AwishWritesVia = "web" | "api" | "api_then_web";
export type AwishStoredSignMode = "present_sorted" | "full_sorted" | "present_proto_order";

/** En rad per Awish API-källa: Version, anslutning, signering och skrivvägar. */
export const awishApiState = pgTable("awish_api_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  dataSourceId: uuid("data_source_id").notNull(),
  version: text("version"),
  versionSeenAt: ts("version_seen_at"),
  previousVersion: text("previous_version"),
  versionChangedAt: ts("version_changed_at"),
  versionAcknowledgedAt: ts("version_acknowledged_at"),
  versionAcknowledgedBy: uuid("version_acknowledged_by"),
  endpoint: text("endpoint").$type<AwishEndpointKind>(),
  endpointCheckedAt: ts("endpoint_checked_at"),
  endpointError: text("endpoint_error"),
  signMode: text("sign_mode").$type<AwishStoredSignMode>(),
  signStatus: text("sign_status").$type<AwishSignStatus>().notNull().default("unverified"),
  signCheckedAt: ts("sign_checked_at"),
  signError: text("sign_error"),
  slotWritesVia: text("slot_writes_via").$type<AwishWritesVia>().notNull().default("web"),
  goodsWritesVia: text("goods_writes_via").$type<AwishWritesVia>().notNull().default("web"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type AwishActionStatus = "pending" | "ok" | "failed" | "unknown" | "blocked";

/** Granskningsloggen: varje skrivning till Awish via API:t. */
export const awishActions = pgTable("awish_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  actorId: uuid("actor_id"),
  actorRole: text("actor_role"),
  kind: text("kind").notNull(),
  machineId: uuid("machine_id"),
  awishMachineId: text("awish_machine_id"),
  targetId: text("target_id"),
  request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
  reason: text("reason"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").$type<AwishActionStatus>().notNull().default("pending"),
  awishCode: integer("awish_code"),
  awishMessage: text("awish_message"),
  errorKind: text("error_kind"),
  requestId: text("request_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

/** Automatens strömschema som det skickades till Awish. */
export const machinePowerSchedules = pgTable("machine_power_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  /** Mån..Sön, t.ex. "1111100". */
  weekdays: text("weekdays").notNull(),
  /** HH:MM */
  powerOn: text("power_on").notNull(),
  powerOff: text("power_off").notNull(),
  source: text("source").$type<"store" | "custom">().notNull(),
  status: text("status").$type<"sent" | "failed" | "cleared">().notNull(),
  sentAt: ts("sent_at"),
  sentBy: uuid("sent_by"),
  lastError: text("last_error"),
  awishActionId: uuid("awish_action_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
