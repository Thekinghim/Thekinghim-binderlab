/**
 * Validering av indata till Datakällors server actions. Allt från klienten är
 * okontrollerat; här blir det typat eller avvisat med ett svenskt meddelande.
 */

import { z } from "zod";

import { MAX_FILE_BYTES } from "@/import/csv-table";
import { mappingOverrideSchema } from "@/import/mapping";
import { isValidTimeZone } from "@/import/zoned";

import { IMPORT_ROW_FILTERS, type ImportRowFilter } from "./constants";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1, "Välj en tidszon.")
  .max(64)
  .refine(isValidTimeZone, "Okänd tidszon.");

export const createSourceSchema = z.object({
  name: z.string().trim().min(1, "Ange ett namn.").max(200, "Namnet får vara högst 200 tecken."),
  sourceTimezone: timeZoneSchema,
});

export const updateSourceSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1, "Ange ett namn.").max(200).optional(),
  sourceTimezone: timeZoneSchema.optional(),
});

export const startUploadSchema = z.object({
  fileName: z.string().trim().min(1, "Filen saknar namn.").max(500),
  size: z
    .number()
    .int()
    .positive("Filen är tom.")
    .max(MAX_FILE_BYTES, "Filen är för stor (högst 50 MB)."),
});

export const chunkMetaSchema = z.object({
  uploadId: uuid,
  index: z.coerce.number().int().min(0).max(100_000),
});

export const previewSchema = z.object({
  uploadId: uuid,
  dataSourceId: uuid,
  mapping: mappingOverrideSchema.optional(),
});

export const commitSchema = previewSchema.extend({
  /** Kontrollsumman som förhandsvisningen visade; importen avbryts om filen inte är densamma. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "Ogiltig kontrollsumma."),
  saveMapping: z.boolean().optional(),
});

export const discardSchema = z.object({ uploadId: uuid });

export const mapMachineSchema = z.object({
  sourceMachineId: uuid,
  machineId: uuid,
});

export function parseRowFilter(value: unknown): ImportRowFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return (IMPORT_ROW_FILTERS as readonly unknown[]).includes(v)
    ? (v as ImportRowFilter)
    : "problem";
}
