/**
 * Drizzle-schema för Datakällors mellanlagring av uppladdningar (migreringen
 * 20261102133644_datakallor_import_uploads.sql). Re-exporteras från src/db/schema.ts.
 *
 * Raderna är tillfälliga: en uppladdning i bitar som förhandsvisas och importeras,
 * och som sedan tas bort. Koden i src/app/(app)/datakallor/_lib/staging.ts läser och
 * skriver dem med SQL som användaren (RLS); schemat finns för katalogtesterna och typerna.
 */

import { bigint, customType, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const stamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** En pågående uppladdning (filnamn, storlek och hur mycket som tagits emot). */
export const importUploads = pgTable("import_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
  nextIndex: integer("next_index").notNull().default(0),
  ...stamps(),
});

/** En bit av en uppladdning (högst 1 MB), i ordning efter chunk_index. */
export const importUploadChunks = pgTable("import_upload_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  uploadId: uuid("upload_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  data: bytea("data").notNull(),
  ...stamps(),
});
