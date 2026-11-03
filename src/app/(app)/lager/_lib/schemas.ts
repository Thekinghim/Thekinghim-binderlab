/**
 * Validering av indata till Lagers server actions. Allt från klienten är okontrollerat;
 * här blir det typat eller avvisat med ett svenskt meddelande.
 */

import { z } from "zod";

import { formatInt } from "@/lib/format";

const uuid = z
  .string({ error: "Ogiltigt id." })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

/** Högsta antal pack i en registrering (samma gräns som register_refill). */
export const MAX_PACKS = 10_000;

const packs = (min: number, message: string) =>
  z
    .number({ error: message })
    .int("Ange ett heltal.")
    .min(min, message)
    .max(MAX_PACKS, `Högst ${formatInt(MAX_PACKS)} pack.`);

const note = z.string().trim().max(500, "Noteringen får vara högst 500 tecken.").optional();

/** Felet när anropet inte är ett objekt med rätt fält (t.ex. null eller fel form). */
const INVALID = "Ogiltig registrering. Ladda om sidan och försök igen.";

export const refillSchema = z.object(
  {
    machineId: uuid,
    titleId: uuid,
    quantity: packs(1, "Ange antal pack, minst 1."),
    fromWarehouse: z.boolean({ error: "Ange om packen tas från centrallagret." }),
    note,
  },
  { error: INVALID },
);

export const countSchema = z.discriminatedUnion(
  "location",
  [
    z.object(
      {
        location: z.literal("machine"),
        machineId: uuid,
        titleId: uuid,
        counted: packs(0, "Ange räknat antal, 0 eller mer."),
        note,
      },
      { error: INVALID },
    ),
    z.object(
      {
        location: z.literal("warehouse"),
        titleId: uuid,
        counted: packs(0, "Ange räknat antal, 0 eller mer."),
        note,
      },
      { error: INVALID },
    ),
  ],
  { error: INVALID },
);

/** Svinn i en automat: antal pack bort ur saldot, med obligatorisk anteckning (orsaken). */
export const wasteSchema = z.object(
  {
    machineId: uuid,
    titleId: uuid,
    quantity: packs(1, "Ange antal pack, minst 1."),
    note: z
      .string({ error: "Skriv orsaken." })
      .trim()
      .min(1, "Skriv orsaken.")
      .max(500, "Noteringen får vara högst 500 tecken."),
  },
  { error: INVALID },
);

/** Larmgräns för en titel i en automat. null = av. */
export const alertSchema = z.object(
  {
    machineId: uuid,
    titleId: uuid,
    alertAtUnits: z
      .number({ error: "Ange ett antal, 0 eller mer." })
      .int("Ange ett heltal.")
      .min(0, "Ange ett antal, 0 eller mer.")
      .max(MAX_PACKS, `Högst ${formatInt(MAX_PACKS)} pack.`)
      .nullable(),
  },
  { error: INVALID },
);

export type WasteInput = z.infer<typeof wasteSchema>;
export type AlertInput = z.infer<typeof alertSchema>;
export type RefillInput = z.infer<typeof refillSchema>;
export type CountInput = z.infer<typeof countSchema>;
