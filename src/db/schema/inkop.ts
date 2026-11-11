/**
 * Drizzle-schema för inköpens inskick (migreringen 20261210000000_inkop_en_gang.sql).
 * Re-exporteras från src/db/schema.ts.
 *
 * purchase_requests: en rad per inskick från ett formulär ("Beställt", "Kom fram",
 * "Köpt, har dem här", "+ Inköp"). Samma client_id två gånger ger samma svar och ingen ny
 * lagerhändelse. Skrivs av src/server/purchasing/quick.ts som användaren (ägare, admin).
 * Append-only.
 */

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type PurchaseRequestKind = "order" | "arrival";

export const purchaseRequests = pgTable("purchase_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  /** Formulärets id för inskicket. */
  clientId: uuid("client_id").notNull(),
  kind: text("kind").$type<PurchaseRequestKind>().notNull(),
  titleId: uuid("title_id").notNull(),
  /** Svaret som det första inskicket fick. */
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
