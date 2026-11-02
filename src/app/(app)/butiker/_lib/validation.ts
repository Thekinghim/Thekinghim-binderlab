/**
 * Indata till ändringarna på Butiker: scheman (zod) och regeln för nya avtal. Rena
 * funktioner, testas i validation.test.ts. Databasen kontrollerar samma sak en gång till
 * (överlappande avtal, minst provision eller hyra, stängda månader).
 */

import { z } from "zod";

import { addDays, isIsoDate, type IsoDate } from "@/domain";
import { parseAmountOre } from "@/import/amount";

const uuid = z.uuid({ message: "Ogiltigt id." });

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isIsoDate(v), { message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).` });

const optionalDate = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isIsoDate(v), {
      message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`,
    });

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} får vara högst ${max} tecken.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const name = z
  .string()
  .trim()
  .min(1, { message: "Ange butikens namn." })
  .max(200, { message: "Namnet får vara högst 200 tecken." });

const optionalEmail = z
  .string()
  .trim()
  .max(320, { message: "E-postadressen får vara högst 320 tecken." })
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.email().safeParse(v).success, {
    message: "Ogiltig e-postadress.",
  });

const phone = optionalText(50, "Telefonnumret").refine(
  (v) => v === null || /^[+0-9 ()-]{3,50}$/.test(v),
  { message: "Telefonnumret får bara innehålla siffror, mellanslag, +, - och parenteser." },
);

const checkbox = z
  .union([z.boolean(), z.string()])
  .optional()
  .nullable()
  .transform((v) => v === true || v === "on" || v === "true");

// ---------------------------------------------------------------------------
// Butik
// ---------------------------------------------------------------------------

export const storeSchema = z.object({
  name,
  address: optionalText(300, "Adressen"),
  city: optionalText(100, "Orten"),
  contactName: optionalText(200, "Kontaktpersonen"),
  email: optionalEmail,
  phone,
  isExample: checkbox,
});
export type StoreInput = z.infer<typeof storeSchema>;

export const updateStoreSchema = storeSchema.extend({ storeId: uuid });
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const archiveStoreSchema = z.object({ storeId: uuid, archived: z.boolean() });

// ---------------------------------------------------------------------------
// Ersättning: provision i procent och hyra i kronor, som fälten visar dem
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** "12" → 1 200 bp, "12,5 %" → 1 250, "" → null. 0–100 % med högst två decimaler. */
export function parsePercentBp(raw: string | null | undefined): Parsed<number | null> {
  const s = (raw ?? "").replace(/[\s %]/g, "");
  if (s === "") return { ok: true, value: null };
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, message: "Provisionen anges i procent, t.ex. 12 eller 12,5." };
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bp > 10_000) return { ok: false, message: "Provisionen kan vara högst 100 %." };
  return { ok: true, value: bp };
}

/** "750" → 75 000 öre, "1 500,50 kr" → 150 050, "" → null. */
export function parseRentOre(raw: string | null | undefined): Parsed<number | null> {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: true, value: null };
  const r = parseAmountOre(s);
  if (!r.ok) return { ok: false, message: `Hyran: ${r.message}` };
  if (r.ore < 0) return { ok: false, message: "Hyran kan inte vara negativ." };
  return { ok: true, value: r.ore };
}

const termsShape = {
  commission: z.string().optional().nullable(),
  rent: z.string().optional().nullable(),
  note: optionalText(500, "Anteckningen"),
};

function withTerms<T extends { commission?: string | null; rent?: string | null }>(
  v: T,
  ctx: z.RefinementCtx,
):
  | (Omit<T, "commission" | "rent"> & {
      commissionBp: number | null;
      monthlyRentOre: number | null;
    })
  | never {
  const c = parsePercentBp(v.commission);
  if (!c.ok) {
    ctx.addIssue({ code: "custom", message: c.message, path: ["commission"] });
    return z.NEVER;
  }
  const r = parseRentOre(v.rent);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.message, path: ["rent"] });
    return z.NEVER;
  }
  if (c.value === null && r.value === null) {
    ctx.addIssue({ code: "custom", message: "Ange provision, hyra eller båda." });
    return z.NEVER;
  }
  const { commission: _c, rent: _r, ...rest } = v;
  void _c;
  void _r;
  return { ...rest, commissionBp: c.value, monthlyRentOre: r.value };
}

export const newAgreementSchema = z
  .object({
    storeId: uuid,
    validFrom: isoDate("Giltig från"),
    validTo: optionalDate("Sista dagen"),
    ...termsShape,
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    message: "Avtalet kan inte sluta före det börjar.",
    path: ["validTo"],
  })
  .transform(withTerms);
export type NewAgreementInput = z.infer<typeof newAgreementSchema>;

export const updateAgreementSchema = z
  .object({
    agreementId: uuid,
    validTo: optionalDate("Sista dagen"),
    ...termsShape,
  })
  .transform(withTerms);
export type UpdateAgreementInput = z.infer<typeof updateAgreementSchema>;

// ---------------------------------------------------------------------------
// Rapportmottagare
// ---------------------------------------------------------------------------

export const recipientSchema = z.object({
  storeId: uuid,
  name: z
    .string()
    .trim()
    .min(1, { message: "Skriv mottagarens namn." })
    .max(200, { message: "Namnet får vara högst 200 tecken." }),
  email: z
    .string()
    .trim()
    .max(320, { message: "E-postadressen får vara högst 320 tecken." })
    .pipe(z.email({ message: "Ogiltig e-postadress." })),
});
export type RecipientInput = z.infer<typeof recipientSchema>;

export const updateRecipientSchema = recipientSchema
  .omit({ storeId: true })
  .extend({ recipientId: uuid, active: z.boolean() });
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

export const recipientIdSchema = z.object({ recipientId: uuid });

/** Första felmeddelandet ur ett zod-fel. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Ogiltiga uppgifter.";
}

// ---------------------------------------------------------------------------
// Nytt avtal: ersätter det som gäller, utan överlapp
// ---------------------------------------------------------------------------

/** Ett befintligt avtal (giltighet), för planeringen. */
/** Avslutande punkt, utan att dubbla punkten efter en förkortning ("1 dec."). */
function stop(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

export interface AgreementSpan {
  readonly id: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
}

export type AgreementPlan =
  | {
      readonly ok: true;
      /** Avtalet som gäller dagen före det nya och ska avslutas dagen före, eller null. */
      readonly close: { readonly id: string; readonly validTo: IsoDate } | null;
    }
  | { readonly ok: false; readonly message: string; readonly conflictId: string | null };

/**
 * Ett nytt avtal från och med `validFrom` (till och med `validTo`, null = tills vidare).
 *
 * - Ett avtal som började före `validFrom` och fortfarande gäller den dagen avslutas
 *   dagen före (avtalshistoriken behålls: villkoren ändras aldrig bakåt).
 * - Ett avtal som börjar samma dag eller senare och skulle överlappa stoppar ändringen:
 *   det ska rättas eller avslutas i stället, så att inga avtal skrivs över i tysthet.
 *
 * `formatDay` skriver datum i meddelandet ("1 okt. 2026").
 */
export function planNewAgreement(
  existing: readonly AgreementSpan[],
  validFrom: IsoDate,
  validTo: IsoDate | null,
  formatDay: (d: IsoDate) => string = (d) => d,
): AgreementPlan {
  const end = validTo ?? "9999-12-31";
  let close: { id: string; validTo: IsoDate } | null = null;
  const sorted = [...existing].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  for (const a of sorted) {
    const aEnd = a.validTo ?? "9999-12-31";
    const overlaps = a.validFrom <= end && aEnd >= validFrom;
    if (!overlaps) continue;
    if (a.validFrom < validFrom) {
      // Gäller dagen före det nya: avslutas dagen före, om det inte också täcker hela
      // det nya avtalets period och fortsätter efter (då skulle historiken klyvas).
      if (validTo !== null && a.validTo !== null && a.validTo > validTo) {
        return {
          ok: false,
          conflictId: a.id,
          message: `Avtalet från ${formatDay(a.validFrom)} gäller till ${formatDay(a.validTo)}, efter det nya avtalets slut. Ändra det avtalet i stället.`,
        };
      }
      close = { id: a.id, validTo: addDays(validFrom, -1) };
      continue;
    }
    return {
      ok: false,
      conflictId: a.id,
      message:
        a.validFrom === validFrom
          ? `Det finns redan ett avtal från ${stop(formatDay(a.validFrom))} Ändra det i stället.`
          : `Avtalet från ${formatDay(a.validFrom)} skulle överlappa. Ange en sista dag före ${formatDay(a.validFrom)} eller ändra det avtalet.`,
    };
  }
  return { ok: true, close };
}

/**
 * Kontroll vid ändring av ett avtals sista dag: får inte sluta före start och inte
 * överlappa nästa avtal. Returnerar ett meddelande, eller null om det går.
 */
export function checkAgreementEnd(
  existing: readonly AgreementSpan[],
  agreementId: string,
  validTo: IsoDate | null,
  formatDay: (d: IsoDate) => string = (d) => d,
): string | null {
  const self = existing.find((a) => a.id === agreementId);
  if (!self) return "Avtalet finns inte.";
  if (validTo !== null && validTo < self.validFrom) {
    return "Avtalet kan inte sluta före det börjar.";
  }
  const end = validTo ?? "9999-12-31";
  const next = existing
    .filter((a) => a.id !== agreementId && a.validFrom > self.validFrom)
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))[0];
  if (next && end >= next.validFrom) {
    return `Nästa avtal börjar ${stop(formatDay(next.validFrom))} Sista dagen måste vara senast ${stop(formatDay(addDays(next.validFrom, -1)))}`;
  }
  return null;
}
