/**
 * Validering av indata till inköpens server actions. Allt från klienten är okontrollerat;
 * här blir det typat eller avvisat med ett svenskt meddelande. Belopp kommer i öre.
 */

import { z } from "zod";

import { isIsoDate } from "@/domain";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} får vara högst ${max} tecken.`)
    .nullish()
    .transform((v) => (v ? v : null));

const isoDate = z.string().refine(isIsoDate, "Ogiltigt datum.");

const days = (label: string) =>
  z
    .number({ error: `${label} måste vara ett tal.` })
    .int(`${label} måste vara hela dagar.`)
    .min(0, `${label} kan inte vara negativ.`)
    .max(365, `${label} får vara högst 365 dagar.`);

const ore = z
  .number({ error: "Ange ett pris." })
  .int("Priset måste anges i hela ören.")
  .min(0, "Priset kan inte vara negativt.")
  .max(100_000_000, "Priset är orimligt högt.");

const packs = (label: string, min = 1) =>
  z
    .number({ error: `${label} måste vara ett tal.` })
    .int(`${label} måste vara ett heltal.`)
    .min(min, `${label} måste vara minst ${min}.`)
    .max(100_000, `${label} får vara högst 100 000.`);

export const supplierSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Ange leverantörens namn.")
    .max(200, "Namnet får vara högst 200 tecken."),
  contactName: optionalText(200, "Kontaktpersonen"),
  email: z
    .string()
    .trim()
    .max(320)
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Ogiltig e-postadress."),
  phone: optionalText(50, "Telefonnumret"),
  defaultLeadTimeDays: days("Ledtiden").nullable(),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const updateSupplierSchema = supplierSchema.extend({ id: uuid });
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const archiveSupplierSchema = z.object({ id: uuid, archived: z.boolean() });

export const supplierItemSchema = z.object({
  id: uuid.optional(),
  supplierId: uuid,
  titleId: uuid,
  packSize: packs("Pack per box"),
  minOrderQty: packs("Minsta order"),
  leadTimeDays: days("Ledtiden").nullable(),
  unitCostOre: ore,
});
export type SupplierItemInput = z.infer<typeof supplierItemSchema>;

export const idSchema = z.object({ id: uuid });

export const createPurchaseOrderSchema = z
  .object({
    supplierId: uuid,
    /** 'ordered' = beställd i dag; 'draft' = utkast. */
    status: z.enum(["draft", "ordered"]),
    expectedOn: isoDate.nullish().transform((v) => v ?? null),
    note: optionalText(1000, "Anteckningen"),
    lines: z
      .array(z.object({ titleId: uuid, quantity: packs("Antal"), unitCostOre: ore }))
      .min(1, "Lägg till minst en rad.")
      .max(500, "Högst 500 rader."),
  })
  .refine((v) => new Set(v.lines.map((l) => l.titleId)).size === v.lines.length, {
    message: "Samma titel står på flera rader. Slå ihop dem.",
  });
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const markOrderedSchema = z.object({
  id: uuid,
  expectedOn: isoDate.nullish().transform((v) => v ?? null),
});

export const receiveSchema = z.object({
  id: uuid,
  lines: z
    .array(z.object({ lineId: uuid, quantity: packs("Mottaget antal", 0) }))
    .min(1, "Ange minst en rad.")
    .max(500),
});
export type ReceiveInput = z.infer<typeof receiveSchema>;
