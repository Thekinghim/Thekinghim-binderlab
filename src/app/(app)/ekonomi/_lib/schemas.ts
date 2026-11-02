/**
 * Validering av indata till Ekonomis server actions. Belopp skrivs i kronor ("1 234,50") och
 * tolkas till öre som text (samma tolkning som importen), aldrig som flyttal.
 */

import { z } from "zod";

import { parseAmountOre } from "@/import/amount";

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isoDate = z.string().regex(ISO_DATE, "Ange datum som ÅÅÅÅ-MM-DD.");
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ogiltig månad.");

const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(isoDate.nullable())
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/** Kronor som text → öre. */
export const kronorToOre = z
  .string()
  .trim()
  .min(1, "Ange ett belopp.")
  .transform((value, ctx) => {
    const parsed = parseAmountOre(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: `Beloppet: ${parsed.message}` });
      return z.NEVER;
    }
    return parsed.ore;
  });

export const FIXED_COST_CATEGORIES = [
  "insurance",
  "software",
  "transport",
  "storage",
  "other",
] as const;

export const fixedCostSchema = z
  .object({
    id: z.uuid().nullable().optional(),
    name: z.string().trim().min(1, "Ange ett namn.").max(200, "Namnet får vara högst 200 tecken."),
    category: z.enum(FIXED_COST_CATEGORIES),
    amount: kronorToOre,
    interval: z.enum(["month", "quarter", "year"]),
    startsOn: isoDate,
    endsOn: optionalDate,
    machineId: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .pipe(z.uuid().nullable())
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => v.endsOn === null || v.endsOn >= v.startsOn, {
    message: "Slutdagen kan inte ligga före startdagen.",
    path: ["endsOn"],
  })
  .transform((v) => ({
    id: v.id ?? null,
    name: v.name,
    category: v.category,
    amountOre: v.amount,
    interval: v.interval,
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    machineId: v.machineId,
    note: v.note ?? null,
  }));
