/**
 * Drizzle-schema för Mystery packs (migreringen 20261115000000_mystery_packs.sql).
 * Re-exporteras från src/db/schema.ts. Allt skrivs via RPC:erna save_mystery_recipe,
 * pack_mystery och undo_mystery_packing; klientrollerna läser bara.
 */

import {
  boolean,
  date,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { ore } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** En version av innehållet för en egen produkt (append-only). */
export const mysteryRecipes = pgTable("mystery_recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  titleId: uuid("title_id").notNull(),
  version: integer("version").notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  batchSize: integer("batch_size").notNull(),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

/** En rad i en version av innehållet (append-only). */
export const mysteryRecipeItems = pgTable("mystery_recipe_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  recipeId: uuid("recipe_id").notNull(),
  componentTitleId: uuid("component_title_id").notNull(),
  quantity: integer("quantity").notNull(),
  isHit: boolean("is_hit").notNull().default(false),
  position: smallint("position").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

/** En packning (pack_mystery). undone_at sätts av undo_mystery_packing. */
export const mysteryPackings = pgTable("mystery_packings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  clientId: uuid("client_id").notNull(),
  titleId: uuid("title_id").notNull(),
  recipeId: uuid("recipe_id").notNull(),
  locationId: uuid("location_id").notNull(),
  batches: integer("batches").notNull(),
  packs: integer("packs").notNull(),
  costPerPackOre: ore("cost_per_pack_ore"),
  transferGroupId: uuid("transfer_group_id").notNull(),
  note: text("note").notNull(),
  packedAt: ts("packed_at").notNull().defaultNow(),
  packedBy: uuid("packed_by"),
  undoneAt: ts("undone_at"),
  undoneBy: uuid("undone_by"),
  undoGroupId: uuid("undo_group_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
