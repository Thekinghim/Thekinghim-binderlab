/**
 * Drizzle-schema för Awish Chrome-tillägget (migreringarna 20261102235500_tillagg_enums.sql
 * och 20261102235600_tillagg_sync_tokens.sql). Re-exporteras från src/db/schema.ts.
 *
 * Koden i src/server/ingest läser och skriver tabellen med SQL (ägare/admin under RLS,
 * kontaktfälten som systemroll från ingest-API:t); schemat finns för katalogtesterna,
 * testfixturen och typerna. Se docs/awish-tillagg.md.
 */

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** En synk-token för tillägget: bara hashen sparas, token visas en gång. */
export const syncTokens = pgTable("sync_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  dataSourceId: uuid("data_source_id").notNull(),
  name: text("name").notNull(),
  /** sha256 (hex) av token. Token själv sparas aldrig. */
  tokenHash: text("token_hash").notNull(),
  /** De första tecknen i token, för att känna igen den i listan. */
  tokenPrefix: text("token_prefix").notNull(),
  lastSeenAt: ts("last_seen_at"),
  lastBatchAt: ts("last_batch_at"),
  lastStatus: text("last_status").$type<"ok" | "logged_out" | "error">(),
  lastError: text("last_error"),
  clientVersion: text("client_version"),
  revokedAt: ts("revoked_at"),
  revokedBy: uuid("revoked_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
