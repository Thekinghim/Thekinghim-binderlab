/**
 * Indata för butiksägare (bolaget som äger butikerna): zod-scheman och texterna. Rena
 * funktioner, testas i owner-validation.test.ts. Databasen kontrollerar formaten en gång
 * till (20261219000000_butiksagare.sql).
 */

import { z } from "zod";

import { parseBankgiro, parseOrgNumber, parsePostalCode, parseVatNumber } from "@/lib/swedish-ids";

const uuid = z.uuid({ message: "Ogiltigt id." });

export const OWNER_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra butiksägare.",
  notFound: "Butiksägaren finns inte.",
  archived: "Butiksägaren är arkiverad. Återställ den först.",
  duplicate: "Det finns redan en butiksägare med det organisationsnumret.",
  storeNotFound: "Butiken finns inte.",
} as const;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} får vara högst ${max} tecken.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const optionalEmail = (label: string) =>
  z
    .string()
    .trim()
    .max(254, { message: `${label} får vara högst 254 tecken.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || z.email().safeParse(v).success, {
      message: `${label} ser inte rätt ut.`,
    });

/** Kör en tolkare (IdParse) i zod: felet blir fältets meddelande. */
function parsed<T>(
  fn: (raw: string | null | undefined) => { ok: true; value: T } | { ok: false; message: string },
) {
  return z
    .string()
    .optional()
    .nullable()
    .transform((raw, ctx) => {
      const r = fn(raw);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.message });
        return z.NEVER;
      }
      return r.value;
    });
}

const checkbox = z
  .union([z.boolean(), z.string()])
  .optional()
  .nullable()
  .transform((v) => v === true || v === "on" || v === "true");

export const ownerSchema = z.object({
  legalName: z
    .string()
    .trim()
    .min(1, { message: "Ange bolagets namn." })
    .max(200, { message: "Namnet får vara högst 200 tecken." }),
  orgNumber: parsed(parseOrgNumber),
  vatNumber: parsed(parseVatNumber),
  fTax: checkbox,
  streetAddress: optionalText(200, "Gatuadressen"),
  postalCode: parsed(parsePostalCode),
  city: optionalText(100, "Orten"),
  contactName: optionalText(200, "Kontaktpersonen"),
  email: optionalEmail("E-postadressen"),
  phone: optionalText(50, "Telefonnumret").refine(
    (v) => v === null || /^[+0-9 ()-]{3,50}$/.test(v),
    { message: "Telefonnumret får bara innehålla siffror, mellanslag, +, - och parenteser." },
  ),
  invoiceEmail: optionalEmail("Fakturaadressen"),
  bankgiro: parsed(parseBankgiro),
  note: optionalText(2000, "Anteckningen"),
});
export type OwnerInput = z.infer<typeof ownerSchema>;

const optionalId = z
  .union([uuid, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

/** Ny ägare; med `storeId` blir den också butikens ägare ("Ny ägare" på butikens sida). */
export const newOwnerSchema = ownerSchema.extend({ storeId: optionalId });

export const updateOwnerSchema = ownerSchema.extend({ ownerId: uuid });

export const archiveOwnerSchema = z.object({ ownerId: uuid, archived: z.boolean() });

/** Butikens ägare: ett id, eller null/tomt för ingen ägare. */
export const storeOwnerSchema = z.object({
  storeId: uuid,
  ownerId: optionalId,
});
