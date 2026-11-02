/**
 * Indata till Marknads server actions, validerade med zod. Felmeddelandena visas för
 * användaren och är därför på svenska. Belopp skrivs i kronor ("54,90") och tolkas till
 * öre exakt, utan flyttal.
 */

import { z } from "zod";

import { isIsoDate, type IsoDate } from "@/domain";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = (label: string) =>
  z.string({ message: `${label} saknas.` }).regex(UUID, `${label} är ogiltig.`);

const optionalUuid = (label: string) =>
  z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.string().regex(UUID, `${label} är ogiltig.`).nullable(),
  );

const isoDate = (label: string) =>
  z
    .string({ message: `${label} saknas.` })
    .refine(isIsoDate, `${label} ska vara ett datum (ÅÅÅÅ-MM-DD).`)
    .transform((v) => v as IsoDate);

const optionalText = (max: number, label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max, `${label} får vara högst ${max} tecken.`).nullable().optional(),
  );

const int = (label: string, min: number, max: number) =>
  z.coerce
    .number({ message: `${label} ska vara ett tal.` })
    .int(`${label} ska vara ett heltal.`)
    .min(min, `${label} ska vara minst ${min}.`)
    .max(max, `${label} får vara högst ${max}.`);

/**
 * "54,90", "54.9", "54" eller "1 254,90" → öre (5 490). Högst två decimaler och inget
 * minus. `null` om texten inte är ett belopp.
 */
export function parseKronorToOre(text: string): number | null {
  const clean = text.replace(/[\s  ]/g, "").replace(/kr$/i, "").replace(",", ".");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/**
 * "120", "120,5" eller "95" (procent) → bp (12 000, 12 050, 9 500). `null` om ogiltig.
 */
export function parsePercentToBp(text: string): number | null {
  const clean = text.replace(/[\s %]/g, "").replace(",", ".");
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const kronor = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const ore = parseKronorToOre(String(v));
    if (ore === null) {
      ctx.addIssue({ code: "custom", message: "Priset ska vara ett belopp i kronor, t.ex. 54,90." });
      return z.NEVER;
    }
    return ore;
  });

const percentBp = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const bp = parsePercentToBp(String(v));
    if (bp === null || bp > 100_000) {
      ctx.addIssue({
        code: "custom",
        message: "Storleken ska vara en procentsats mellan 0 och 1 000, t.ex. 120.",
      });
      return z.NEVER;
    }
    return bp;
  });

const releaseFields = {
  name: z
    .string({ message: "Namn saknas." })
    .trim()
    .min(1, "Ange släppets namn.")
    .max(200, "Namnet får vara högst 200 tecken."),
  series: optionalText(200, "Serien"),
  releaseDate: isoDate("Släppdagen"),
  titleId: optionalUuid("Titeln"),
  supplierId: optionalUuid("Leverantören"),
  scalePercent: percentBp.default(10_000),
  horizonDays: int("Horisonten", 7, 91).default(28),
  boxSize: int("Pack per låda", 1, 10_000).default(1),
  minOrderQty: int("Minsta beställning", 0, 1_000_000).default(0),
  note: optionalText(2000, "Anteckningen"),
};

export const createReleaseSchema = z.object(releaseFields);
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

export const updateReleaseSchema = z.object({ id: uuid("Släppet"), ...releaseFields });
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;

export const idSchema = z.object({ id: uuid("Raden") });
export type IdInput = z.infer<typeof idSchema>;

export const releaseIdSchema = z.object({ releaseId: uuid("Släppet") });

export const createQuoteSchema = z
  .object({
    supplierId: optionalUuid("Leverantören"),
    newSupplierName: optionalText(200, "Leverantörens namn"),
    titleId: uuid("Titeln"),
    quotedOn: isoDate("Datumet"),
    validUntil: z.preprocess(
      (v) => (v === "" || v === undefined ? null : v),
      isoDate("Giltig till").nullable(),
    ),
    unitCost: kronor,
    quantity: int("Antal pack", 1, 1_000_000).default(1),
    kind: z.enum(["quote", "purchase"], { message: "Välj offert eller inköp." }).default("quote"),
    note: optionalText(2000, "Anteckningen"),
  })
  .superRefine((v, ctx) => {
    if (!v.supplierId && !v.newSupplierName) {
      ctx.addIssue({ code: "custom", path: ["supplierId"], message: "Välj eller ange leverantör." });
    }
    if (v.validUntil && v.validUntil < v.quotedOn) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Giltig till kan inte vara före datumet.",
      });
    }
  });
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const saveSlotsSchema = z
  .object({
    machineId: uuid("Automaten"),
    validFrom: isoDate("Från och med"),
    lines: z
      .array(z.object({ titleId: uuid("Titeln"), slots: int("Antal fack", 1, 100) }))
      .max(50, "Högst 50 titlar per automat."),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const l of v.lines) {
      if (seen.has(l.titleId)) {
        ctx.addIssue({ code: "custom", path: ["lines"], message: "En titel står två gånger." });
        return;
      }
      seen.add(l.titleId);
    }
    if (v.lines.reduce((s, l) => s + l.slots, 0) > 100) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "Högst 100 fack per automat." });
    }
  });
export type SaveSlotsInput = z.infer<typeof saveSlotsSchema>;

export const implementAssortmentSchema = z
  .object({
    machineId: uuid("Automaten"),
    fingerprint: z.string().min(1).max(4000),
    implementedOn: isoDate("Genomförd"),
    periodStart: isoDate("Periodens början"),
    periodEnd: isoDate("Periodens slut"),
  })
  .refine((v) => v.periodStart <= v.periodEnd, {
    message: "Perioden är ogiltig.",
    path: ["periodEnd"],
  });
export type ImplementAssortmentInput = z.infer<typeof implementAssortmentSchema>;

export const startExperimentSchema = z.object({
  proposalKey: z
    .string({ message: "Förslaget saknas." })
    .min(1)
    .max(200)
    .regex(/^price-test:/, "Förslaget är ogiltigt."),
});
export type StartExperimentInput = z.infer<typeof startExperimentSchema>;
