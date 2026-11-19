/**
 * Drizzle-schema för butiksägare (migreringen 20261219000000_butiksagare.sql).
 * Re-exporteras från src/db/schema.ts. Butikens ägare står i stores.owner_id.
 * Ägare och admin skriver, läsare läser; påfyllare och butiksportalen ser inget.
 */

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { citext } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Bolaget som äger en eller flera butiker. Arkiveras, raderas aldrig. */
export const storeOwners = pgTable("store_owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  legalName: text("legal_name").notNull(),
  /** NNNNNN-NNNN. */
  orgNumber: text("org_number").notNull(),
  /** SE + 10 siffror + 01, eller null. */
  vatNumber: text("vat_number"),
  fTax: boolean("f_tax").notNull().default(false),
  streetAddress: text("street_address"),
  /** NNN NN. */
  postalCode: text("postal_code"),
  city: text("city"),
  contactName: text("contact_name"),
  email: citext("email"),
  phone: text("phone"),
  /** E-post för leverantörsfakturor. */
  invoiceEmail: citext("invoice_email"),
  /** NNN-NNNN eller NNNN-NNNN. */
  bankgiro: text("bankgiro"),
  note: text("note"),
  archivedAt: ts("archived_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
